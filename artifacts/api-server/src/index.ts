import { runMigrations as runStripeMigrations } from "stripe-replit-sync";
import app, { STRIPE_WEBHOOK_PATH } from "./app";
import { logger } from "./lib/logger";
import { writeBootFatal } from "./lib/bootFatal";
import { stripeWebhookUrl } from "./lib/publicUrl";
import { runMigrations } from "./lib/migrate";
import { startQuoHealthCheck } from "./lib/quoHealth";
import { startGeocodeBackfill } from "./services/geocodeBackfill";
import { startJobberCalendarSync } from "./services/jobberCalendarSync";
import { startLateSweep } from "./services/lateSweep";
import { startLeadsSync } from "./services/leadsSync";
import { startLeadJobberRetry } from "./services/leadJobberRetry";
import { startBookingJobberRetry } from "./services/bookingJobberRetry";
import { getStripeSync } from "./lib/stripeClient";

const rawPort = process.env["PORT"];

if (!rawPort) {
  writeBootFatal("PORT environment variable is required but was not provided.");
  process.exit(1);
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  writeBootFatal(`Invalid PORT value: "${rawPort}"`);
  process.exit(1);
}

logger.info({ port }, "API server starting");

// Apply any pending schema migrations before accepting traffic so that the
// database is always in sync with the deployed code, including on first boot
// or after a schema-changing deploy.
//
// Anything fatal before listen() must reach stderr synchronously: pino's
// worker-thread transports lose buffered lines on an instant crash, which is
// how a failed publish used to die with zero app output in the deploy log.
try {
  await runMigrations();
} catch (err) {
  writeBootFatal(
    "Startup failed before the server could listen — database migrations did not complete. This publish cannot start.",
    err,
  );
  process.exit(1);
}

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

    // Canonical pin first, inferred host otherwise — see stripeWebhookUrl.
    const webhookUrl = stripeWebhookUrl(STRIPE_WEBHOOK_PATH);
    if (webhookUrl) {
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
      logger.warn(
        "No public host available; skipping Stripe webhook registration",
      );
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

// Nothing below this line may block the port from opening. A deployment is
// killed if the container does not start listening within about a minute, and
// everything that follows talks to somebody else's API — Stripe having a slow
// minute must never be the reason a release fails to go out.
app.listen(port, (err) => {
  if (err) {
    writeBootFatal(`Error listening on port ${port}`, err);
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Normalize owner phone numbers saved before validation existed; undialable
  // ones are cleared and surfaced in settings instead of failing silently
  // during an outage. Idempotent, so running on every boot is a no-op after
  // the first pass.
  void (async () => {
    try {
      const { cleanupStoredPhoneNumbers } = await import("./lib/phoneCleanup");
      await cleanupStoredPhoneNumbers();
    } catch (err) {
      logger.error({ err }, "Phone number cleanup failed");
    }
  })();

  void initStripe();

  // If the canonical domain changed since webhooks were registered, re-point
  // every company's Quo webhooks at the new base URL. Best-effort: a Quo
  // hiccup must not affect boot, and the old registration keeps working until
  // the move succeeds.
  void (async () => {
    try {
      const { reconcileQuoWebhookUrls } =
        await import("./lib/quoWebhookReconcile");
      await reconcileQuoWebhookUrls();
    } catch (err) {
      logger.error({ err }, "Quo webhook URL reconcile failed");
    }
  })();

  // Hourly background check so a revoked Quo key flips quoNeedsReauth even
  // while no webhooks or dashboard traffic touch Quo.
  startQuoHealthCheck();

  // Geocode upcoming bookings in the background so the live map loads pins from
  // the DB. Degrades quietly when GOOGLE_MAPS_API_KEY is absent.
  startGeocodeBackfill();

  // Pull scheduled work out of Jobber so an owner who books there still sees
  // those addresses on the map. No-ops for companies that skipped Jobber.
  startJobberCalendarSync();

  // Minutely lateness sweep: raises a "running late" activity feed entry from
  // the same route legs as /map/routes, so dispatch hears about a slipping
  // arrival even when nobody has the map open.
  startLateSweep();

  // Pull new Facebook/Instagram lead-ad rows from the leads Google Sheet
  // onto the Leads page. Read-only against the sheet; degrades to an error
  // shown on the Leads page when the connection is unavailable.
  startLeadsSync();

  // Retry failed website-form pushes after Jobber recovers. Production owns
  // the shared Jobber grant; the dev workspace uses the manual inbox action.
  startLeadJobberRetry();

  // Retry failed booking pushes and contact corrections with bounded backoff.
  // The owner's manual action remains available after automatic retries stop.
  startBookingJobberRetry();
});
