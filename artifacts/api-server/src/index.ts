import { runMigrations as runStripeMigrations } from "stripe-replit-sync";
import app, { STRIPE_WEBHOOK_PATH } from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { startQuoHealthCheck } from "./lib/quoHealth";
import { startGeocodeBackfill } from "./services/geocodeBackfill";
import { startJobberCalendarSync } from "./services/jobberCalendarSync";
import { getStripeSync } from "./lib/stripeClient";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Apply any pending schema migrations before accepting traffic so that the
// database is always in sync with the deployed code, including on first boot
// or after a schema-changing deploy.
await runMigrations();

// Normalize owner phone numbers saved before validation existed; undialable
// ones are cleared and surfaced in settings instead of failing silently
// during an outage. Idempotent, so running on every boot is a no-op after
// the first pass.
const { cleanupStoredPhoneNumbers } = await import("./lib/phoneCleanup");
await cleanupStoredPhoneNumbers();

/**
 * Set up the Stripe mirror: create the `stripe` schema, register the managed
 * webhook, then backfill.
 *
 * Deliberately non-fatal. This server also runs the dispatcher dashboard, the
 * call feed and the Quo webhooks; taking all of that down because Stripe had a
 * bad minute would be a far worse outage than deposits being briefly
 * uncollectable.
 */
async function initStripe(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    logger.warn("No DATABASE_URL; skipping Stripe setup");
    return;
  }

  try {
    // The target schema is not configurable — the library hardcodes "stripe".
    await runStripeMigrations({ databaseUrl });

    const stripeSync = await getStripeSync();

    // Correct at runtime: in a deployment REPLIT_DOMAINS is the production
    // host, and in the workspace it is the dev domain, so each environment
    // registers a webhook pointing at itself.
    const host = process.env["REPLIT_DOMAINS"]?.split(",")[0];
    if (host) {
      const webhookUrl = `https://${host}${STRIPE_WEBHOOK_PATH}`;
      let webhookResult: Awaited<
        ReturnType<typeof stripeSync.findOrCreateManagedWebhook>
      >;
      try {
        webhookResult = await stripeSync.findOrCreateManagedWebhook(webhookUrl);
      } catch (webhookErr) {
        // The managed-webhook table may contain a stale row from a different
        // Stripe mode (e.g. a test-mode webhook ID that live keys can't see).
        // Clear the table so the next attempt creates a fresh webhook.
        logger.warn(
          { err: webhookErr },
          "Webhook setup failed; clearing stale managed-webhook rows and retrying",
        );
        const { pool: dbPool } = await import("@workspace/db");
        await dbPool.query('DELETE FROM stripe."_managed_webhooks"');
        webhookResult = await stripeSync.findOrCreateManagedWebhook(webhookUrl);
      }
      logger.info(
        { url: webhookResult?.url },
        "Stripe managed webhook configured",
      );
    } else {
      logger.warn("No REPLIT_DOMAINS; skipping Stripe webhook registration");
    }

    // Backgrounded: a full backfill must not hold up the port opening.
    stripeSync
      .syncBackfill()
      .then(() => logger.info("Stripe data synced"))
      .catch((err) => logger.error({ err }, "Stripe backfill failed"));
  } catch (err) {
    logger.error(
      { err },
      "Stripe setup failed; deposit payments will be unavailable",
    );
  }
}

await initStripe();

// Hourly background check so a revoked Quo key flips quoNeedsReauth even
// while no webhooks or dashboard traffic touch Quo.
startQuoHealthCheck();

// Geocode upcoming bookings in the background so the live map loads pins from
// the DB. Degrades quietly when GOOGLE_MAPS_API_KEY is absent.
startGeocodeBackfill();

// Pull scheduled work out of Jobber so an owner who books there still sees
// those addresses on the map. No-ops for companies that skipped Jobber.
startJobberCalendarSync();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
