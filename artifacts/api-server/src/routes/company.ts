import { Router, type IRouter } from "express";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  teamMembersTable,
  activityTable,
  jobberConnectionsTable,
} from "@workspace/db";
import {
  CreateCompanyBody,
  UpdateCompanyBody,
  GetCompanyResponse,
  CreateCompanyResponse,
  UpdateCompanyResponse,
  ConnectJobberResponse,
  DisconnectJobberResponse,
  SetJobberSkippedBody,
  SetJobberSkippedResponse,
  SyncJobberCalendarResponse,
  GoLiveResponse,
  UpdateJobberConnectionBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { newCompaniesAllowedForHost } from "../lib/signupMode";
import { requestHost } from "../lib/requestHost";
import { getCompanyForUser, serializeCompany } from "../lib/company";
import { ownerProfileFor } from "../lib/callerRole";
import {
  getJobberCredentials,
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchJobberAccount,
  friendlyTokenExchangeError,
  JobberTokenError,
  disconnectJobberApp,
  getValidAccessToken,
  getValidConnectionToken,
  tokenExpiry,
  jobberEnvironmentLabel,
} from "../lib/jobber";
import { syncCompanyCalendar } from "../services/jobberCalendarSync";
import { syncCompanyTimeSheets } from "../services/jobberTimeSheetSync";
import { syncCompanyJobberQuotes } from "../services/jobberQuoteSync";
import { syncCompanyJobberInvoices } from "../services/jobberInvoiceSync";
import { runJobberHistoryCatchup } from "../services/jobberHistoryCatchup";
import { syncCompanyJobberRequests } from "../services/jobberRequestSync";
import { sweepJobberRequestLeads } from "../services/jobberRequestLeads";
import { runGeocodeBackfill } from "../services/geocodeBackfill";
import { encryptJobberToken } from "../lib/secretBox";
import { flagShiftedBookings } from "../lib/timezoneReview";
import { normalizePhoneField } from "../lib/phoneField";
import { logger } from "../lib/logger";
import crypto from "node:crypto";
import { publicBaseUrl } from "../lib/publicUrl";
import {
  CompanyRepairGuardError,
  getCompanyRepairAudit,
  isAuthorizedLiveRepairOwner,
  repairTestCompanies,
} from "../services/companyRepair";
import { COMPANY_REPAIR_REVIEW_PAGE } from "../services/companyRepairPage";
import { z } from "zod/v4";

const router: IRouter = Router();
const MAX_JOBBER_CONNECTIONS = 20;

/**
 * Constrain a configured frontend base path to a same-origin path prefix.
 * Anything not starting with a single "/" (or "//", which browsers treat as
 * protocol-relative) is discarded so it can never rewrite the redirect host.
 */
function safePathPrefix(value: string | undefined): string {
  if (!value) return "";
  if (!value.startsWith("/") || value.startsWith("//")) return "";
  return value.replace(/\/+$/, "");
}

// OAuth callback — hit by a browser redirect from Jobber; identified by the
// `state` value we generated at connect time, not by a session.
router.get("/company/jobber/callback", async (req, res): Promise<void> => {
  const {
    code,
    state,
    error: oauthError,
  } = req.query as { code?: string; state?: string; error?: string };
  // Build the absolute frontend URL from server-side configuration only.
  // Request headers (X-Forwarded-Host / -Proto / -Prefix) are attacker
  // controllable on this unauthenticated endpoint and must not influence
  // where we redirect (open-redirect risk).
  const frontendBase = safePathPrefix(process.env.FRONTEND_BASE_PATH);
  const setupUrl = `${publicBaseUrl()}${frontendBase}/setup`;

  const fail = (reason: string) => {
    logger.warn({ reason }, "Jobber OAuth callback failed");
    res.redirect(`${setupUrl}?jobber_error=${encodeURIComponent(reason)}`);
  };

  // Jobber sends ?error=access_denied when the owner clicks "Deny".
  if (oauthError === "access_denied") {
    fail("You declined access in Jobber. Connect again whenever you're ready.");
    return;
  }
  if (oauthError) {
    fail(`Jobber reported a problem (${oauthError}). Please try again.`);
    return;
  }
  if (!code || !state) {
    fail("Jobber did not return an authorization code.");
    return;
  }
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(sql`${companiesTable.jobberOauth} ->> 'state' = ${state}`);
  if (!company || !company.jobberOauth) {
    fail("Unknown or expired connect attempt. Please try connecting again.");
    return;
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      redirectUri: company.jobberOauth.redirectUri,
      codeVerifier: company.jobberOauth.verifier,
    });
    const account = await fetchJobberAccount(tokens.access_token);

    const encAccess = encryptJobberToken(tokens.access_token);
    const encRefresh = encryptJobberToken(tokens.refresh_token);
    const expiry = tokenExpiry(tokens.expires_in);

    // A callback can arrive twice (browser retry) or at the same time from
    // two owner devices. The company-scoped advisory lock makes "count, then
    // insert" atomic without rejecting a reauthorization of an existing
    // account when all twenty slots are already occupied.
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${company.id})`);
      const connections = await tx
        .select({
          id: jobberConnectionsTable.id,
          accountId: jobberConnectionsTable.accountId,
          isPrimary: jobberConnectionsTable.isPrimary,
        })
        .from(jobberConnectionsTable)
        .where(eq(jobberConnectionsTable.companyId, company.id));
      const existingConn = connections.find(
        (connection) => connection.accountId === account.id,
      );
      if (!existingConn && connections.length >= MAX_JOBBER_CONNECTIONS) {
        // This callback is a terminal outcome too. Consume the state so an
        // already-authorized Jobber URL cannot be retried after a slot opens.
        await tx
          .update(companiesTable)
          .set({ jobberOauth: null })
          .where(eq(companiesTable.id, company.id));
        return { limitReached: true };
      }

      // Primary rules (exactly one primary per company at all times):
      //  • First connection ever              → primary
      //  • Reconnect of the existing primary  → primary stays, tokens refresh
      //  • New secondary account              → companies table stays untouched
      const existingPrimary = connections.find(
        (connection) => connection.isPrimary,
      );
      const willBePrimary =
        !existingPrimary || existingPrimary.accountId === account.id;

      // Only mirror the new tokens into companies.jobber_* when this
      // connection is primary. Secondary credentials must never overwrite
      // callers that still use getValidAccessToken().
      if (willBePrimary) {
        await tx
          .update(companiesTable)
          .set({
            jobberConnected: true,
            jobberSkipped: false,
            jobberAccountId: account.id,
            jobberAccountName: account.name,
            jobberAccessToken: encAccess,
            jobberRefreshToken: encRefresh,
            jobberTokenExpiresAt: expiry,
            jobberOauth: null,
            jobberNeedsReauth: false,
          })
          .where(eq(companiesTable.id, company.id));
      } else {
        // Secondary: only clear the in-flight OAuth state so it can't replay.
        await tx
          .update(companiesTable)
          .set({ jobberOauth: null })
          .where(eq(companiesTable.id, company.id));
      }

      if (existingConn) {
        await tx
          .update(jobberConnectionsTable)
          .set({
            accountName: account.name,
            accessToken: encAccess,
            refreshToken: encRefresh,
            tokenExpiresAt: expiry,
            needsReauth: false,
            isPrimary: willBePrimary,
          })
          .where(eq(jobberConnectionsTable.id, existingConn.id));
      } else {
        await tx.insert(jobberConnectionsTable).values({
          companyId: company.id,
          accountId: account.id,
          accountName: account.name,
          accessToken: encAccess,
          refreshToken: encRefresh,
          tokenExpiresAt: expiry,
          needsReauth: false,
          isPrimary: willBePrimary,
        });
      }
      await tx.insert(activityTable).values({
        companyId: company.id,
        type: "jobber_synced",
        message: `Jobber account "${account.name}" connected.`,
      });
      return { limitReached: false };
    });
    if (outcome.limitReached) {
      fail(
        `You can connect up to ${MAX_JOBBER_CONNECTIONS} Jobber accounts. Remove one before connecting another.`,
      );
      return;
    }
    res.redirect(`${setupUrl}?jobber=connected`);
  } catch (err) {
    logger.error({ err }, "Jobber token exchange failed");
    if (err instanceof JobberTokenError) {
      fail(friendlyTokenExchangeError(err));
    } else {
      fail(
        "Connected to Jobber, but we couldn't finish setting up your account. Please try again.",
      );
    }
  }
});

router.use(requireAuth);

const TestCompanyRepairBody = z.object({
  confirmation: z.literal("REMOVE SYNTHETIC TEST COMPANIES"),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  companyIds: z.array(z.number().int().positive()).min(1),
});

async function requireLiveRepairOwner(
  req: Parameters<Parameters<typeof router.get>[1]>[0],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
) {
  const company = await getCompanyForUser(req.userId!);
  if (!company || !isAuthorizedLiveRepairOwner(company, req.userId!)) {
    // Do not reveal that a maintenance route exists to another company owner.
    res.status(404).json({ error: "Not found" });
    return undefined;
  }
  return company;
}

/**
 * Review-only inventory for the one-time live cleanup. It is intentionally
 * owner-authenticated and returns every company plus dependent-row counts,
 * including rows reached through booking assignments and saved-route stops.
 */
router.get(
  "/company/repair/test-companies/review",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    if (!(await requireLiveRepairOwner(req, res))) return;
    res.type("html").send(COMPANY_REPAIR_REVIEW_PAGE);
  },
);

router.get(
  "/company/repair/test-companies",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    if (!(await requireLiveRepairOwner(req, res))) return;
    res.json({
      status: "review_required",
      confirmation: "REMOVE SYNTHETIC TEST COMPANIES",
      ...(await getCompanyRepairAudit()),
    });
  },
);

/**
 * Destructive half of the two-step cleanup. The caller must submit the exact
 * company set and digest returned by the review endpoint. The service repeats
 * all fingerprints in a transaction and verifies the protected company's
 * complete inventory is unchanged before committing.
 */
router.post(
  "/company/repair/test-companies",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    if (!(await requireLiveRepairOwner(req, res))) return;
    const parsed = TestCompanyRepairBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await repairTestCompanies(
        req.userId!,
        parsed.data.reviewDigest,
        parsed.data.companyIds,
      );
      res.json({ status: "completed", ...result });
    } catch (error) {
      if (error instanceof CompanyRepairGuardError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.get("/company", async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.status(404).json({ error: "No company yet" });
    return;
  }
  res.json(GetCompanyResponse.parse(await serializeCompany(company)));
});

router.post(
  "/company",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const parsed = CreateCompanyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // Same guard as PATCH: a bogus zone would silently skew every booking time.
    if (
      parsed.data.timezone !== undefined &&
      !isValidTimezone(parsed.data.timezone)
    ) {
      res
        .status(400)
        .json({ error: `Unknown time zone: ${parsed.data.timezone}` });
      return;
    }

    const existing = await getCompanyForUser(req.userId!);
    if (existing) {
      res
        .status(201)
        .json(CreateCompanyResponse.parse(await serializeCompany(existing)));
      return;
    }

    // A single-company site. Checked after the idempotent return above, so
    // closing the door never locks out the company already living here.
    // Per-host: a closed deployment may still have one designated signup
    // address (SIGNUP_HOST) where a new owner is allowed through.
    if (!newCompaniesAllowedForHost(requestHost(req))) {
      res.status(403).json({
        error:
          "This site belongs to one cleaning company. If you work here, ask for the join code instead of creating a company.",
      });
      return;
    }

    // Stamp the creator's verified address on the company. This is what lets
    // them back in if the login behind it ever stops existing.
    const { email: ownerEmail, name: ownerName } = await ownerProfileFor(
      req.userId!,
    );

    const [company] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: req.userId!,
        ...(ownerEmail ? { ownerEmail } : {}),
        name: parsed.data.name,
        ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
        greeting: `Thanks for calling ${parsed.data.name}! How can I help you today?`,
        collectFields: ["name", "address", "service type", "preferred date"],
        customQuestions: [],
      })
      .returning();

    await db.insert(teamMembersTable).values({
      companyId: company!.id,
      // The card is what TEAMMATES see on the map, in chat and on the team
      // page — so it carries the owner's real name from their login profile.
      // "You" is only the last resort when Clerk has no name on file, and the
      // Team page can fix it after the fact.
      name: ownerName ?? "You",
      email: "owner@company.com",
      role: "owner",
      status: "active",
    });

    res
      .status(201)
      .json(CreateCompanyResponse.parse(await serializeCompany(company!)));
  },
);

/** True when the runtime's own timezone database knows this IANA zone. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.patch(
  "/company",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const parsed = UpdateCompanyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // The spec can only say "non-empty string"; a bogus zone like "America/Foo"
    // would silently make every rendered booking time wrong, so check it against
    // the runtime's own timezone database before storing it.
    if (
      parsed.data.timezone !== undefined &&
      !isValidTimezone(parsed.data.timezone)
    ) {
      res
        .status(400)
        .json({ error: `Unknown time zone: ${parsed.data.timezone}` });
      return;
    }
    // Normalize phone numbers to E.164 before storing — a typo like "555-12"
    // would otherwise sit silently until an outage text can't be delivered.
    // Empty string is still allowed: it clears the number.
    for (const field of ["notificationNumber", "ringThroughNumber"] as const) {
      const label =
        field === "notificationNumber"
          ? "notification number"
          : "ring-through number";
      const result = normalizePhoneField(parsed.data[field], label);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      if (result.value !== undefined) parsed.data[field] = result.value;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    // Saving a phone field (valid or cleared) resolves any warning about an
    // old undialable value the startup cleanup pass removed.
    const rejectedClears = {
      ...(parsed.data.notificationNumber !== undefined
        ? { notificationNumberRejected: null }
        : {}),
      ...(parsed.data.ringThroughNumber !== undefined
        ? { ringThroughNumberRejected: null }
        : {}),
    };

    const touchesConfig =
      parsed.data.greeting !== undefined ||
      parsed.data.collectFields !== undefined ||
      parsed.data.customQuestions !== undefined ||
      parsed.data.ringThroughNumber !== undefined;

    const [updated] = await db
      .update(companiesTable)
      .set({
        ...parsed.data,
        ...rejectedClears,
        ...(touchesConfig ? { receptionistConfigured: true } : {}),
      })
      .where(eq(companiesTable.id, company.id))
      .returning();

    // A timezone switch instantly re-renders every booking in the new zone.
    // Upcoming bookings whose displayed hour just moved may have been entered
    // as wall-clock agreements under the old zone, so flag them for the owner
    // to confirm or adjust.
    if (
      parsed.data.timezone !== undefined &&
      company.timezone &&
      updated!.timezone !== company.timezone
    ) {
      await flagShiftedBookings(
        company.id,
        company.timezone,
        updated!.timezone!,
      );
    }

    res.json(UpdateCompanyResponse.parse(await serializeCompany(updated!)));
  },
);

router.post(
  "/company/jobber/connect",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const creds = getJobberCredentials();
    if (!creds) {
      res.status(503).json({
        error:
          "Jobber API credentials are not configured. Add JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET first.",
      });
      return;
    }

    const state = crypto.randomBytes(24).toString("base64url");
    const { verifier, challenge } = generatePkcePair();
    const redirectUri = `${publicBaseUrl()}/api/company/jobber/callback`;

    await db
      .update(companiesTable)
      .set({
        jobberOauth: {
          state,
          verifier,
          redirectUri,
          createdAt: new Date().toISOString(),
        },
      })
      .where(eq(companiesTable.id, company.id));

    const authorizeUrl = buildAuthorizeUrl({
      clientId: creds.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
    });
    res.json(ConnectJobberResponse.parse({ authorizeUrl }));
  },
);

router.post(
  "/company/jobber/disconnect",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    if (company.jobberAccessToken) {
      try {
        const accessToken = await getValidAccessToken(company);
        await disconnectJobberApp(accessToken);
      } catch (err) {
        logger.warn(
          { err },
          "Jobber appDisconnect failed; clearing tokens anyway",
        );
      }
    }
    const [updated] = await db
      .update(companiesTable)
      .set({
        jobberConnected: false,
        jobberAccountName: null,
        jobberAccountId: null,
        jobberAccessToken: null,
        jobberRefreshToken: null,
        jobberTokenExpiresAt: null,
        jobberOauth: null,
        jobberNeedsReauth: false,
      })
      .where(eq(companiesTable.id, company.id))
      .returning();

    res.json(DisconnectJobberResponse.parse(await serializeCompany(updated!)));
  },
);

// "Sync now" for the owner who just added a job in Jobber and wants it on the
// map without waiting for the ten-minute poller.
router.post(
  "/company/jobber/sync-calendar",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    if (!company.jobberConnected) {
      res.status(400).json({ error: "Jobber isn't connected yet." });
      return;
    }
    const connections = await db
      .select()
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, company.id));
    // The legacy company-level grant can be stale. Named connections carry
    // their own state, so one failed primary cannot stop a healthy secondary.
    if (connections.length === 0 && company.jobberNeedsReauth) {
      // Name the environment: dev and production share one Jobber account,
      // and a stale grant here usually means the other copy rotated the
      // token away and is still connected.
      res.status(400).json({
        error: `Jobber authorization has expired in ${jobberEnvironmentLabel()} — reconnect Jobber here to keep syncing.`,
      });
      return;
    }

    try {
      // Every connected Jobber account owns an independent calendar. Keep
      // going if one stale secondary grant fails: a healthy account should
      // still refresh the owner's map, and the failing connection marks itself
      // as needing reconnection while it is attempted.
      const syncsToRun = connections.length > 0 ? connections : [null];
      let completedSyncs = 0;
      let lastSyncError: unknown;
      let result = {
        imported: 0,
        updated: 0,
        canceled: 0,
        skipped: 0,
        jobberCount: 0,
        hitPageLimit: false,
        pullComplete: true,
        persistFailures: 0,
      };

      for (const connection of syncsToRun) {
        try {
          const synced = await syncCompanyCalendar(company, connection);
          completedSyncs++;
          result = {
            imported: result.imported + synced.imported,
            updated: result.updated + synced.updated,
            canceled: result.canceled + synced.canceled,
            skipped: result.skipped + synced.skipped,
            jobberCount: result.jobberCount + synced.jobberCount,
            hitPageLimit: result.hitPageLimit || synced.hitPageLimit,
            // History catch-up is safe only when EVERY successfully selected
            // account completed its pull. A partial multi-account refresh must
            // never certify the company-wide calendar as complete.
            pullComplete: result.pullComplete && synced.pullComplete,
            persistFailures: result.persistFailures + synced.persistFailures,
          };
        } catch (err) {
          lastSyncError = err;
          logger.warn(
            {
              err,
              companyId: company.id,
              connectionId: connection?.id ?? null,
            },
            "Manual Jobber calendar sync failed for one connection",
          );
        }
      }
      if (completedSyncs === 0 && lastSyncError) throw lastSyncError;
      // Hours clocked in Jobber's own timer come in on the same "sync now".
      // Best effort: a timer read failing must not lose the calendar import
      // the owner actually pressed the button for.
      try {
        const hours = await syncCompanyTimeSheets(company);
        if (hours.imported || hours.updated) {
          logger.info(
            { companyId: company.id, ...hours },
            "Jobber time sheet sync complete",
          );
        }
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber time sheet sync failed during manual sync",
        );
      }
      // The Leads safety net runs ahead of the request pull on purpose: a
      // brand-new Jobber-form enquiry whose webhook never arrived must
      // become a lead BEFORE the request sync can claim it as a pending
      // booking. Best effort, same as time sheets.
      try {
        const leadSweep = await sweepJobberRequestLeads(company);
        if (leadSweep.imported) {
          logger.info(
            { companyId: company.id, ...leadSweep },
            "Jobber lead sweep complete during manual sync",
          );
        }
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber lead sweep failed during manual sync",
        );
      }
      // Open requests written in Jobber come over on the same button too,
      // ahead of quotes so a quote raised from a just-imported request lands
      // on that request's booking. Best effort, same as time sheets.
      try {
        const requests = await syncCompanyJobberRequests(company);
        if (requests.imported || requests.updated || requests.canceled) {
          logger.info(
            { companyId: company.id, ...requests },
            "Jobber request sync complete during manual sync",
          );
        }
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber request sync failed during manual sync",
        );
      }
      // Quotes written in Jobber come over on the same button too — dev has
      // no background poller (the shared grant is pinned to one environment),
      // so "Sync now" is the only way they arrive here. Best effort, same as
      // time sheets.
      try {
        const quotes = await syncCompanyJobberQuotes(company);
        if (quotes.imported || quotes.updated) {
          logger.info(
            { companyId: company.id, ...quotes },
            "Jobber quote sync complete during manual sync",
          );
        }
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber quote sync failed during manual sync",
        );
      }
      // Invoices ride the same button — dev has no background poller, so
      // "Sync now" is the only way paid/pending standing arrives here.
      try {
        const invoices = await syncCompanyJobberInvoices(company);
        if (invoices.imported || invoices.updated) {
          logger.info(
            { companyId: company.id, ...invoices },
            "Jobber invoice sync complete during manual sync",
          );
        }
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber invoice sync failed during manual sync",
        );
      }
      // One-time history catch-up (pinned Aug 2026 floor): dev has no
      // background poller, so "Sync now" is how the gap fills here — one
      // import-only slice per press, no-op once done. Best effort. The
      // forever done-stamp is only allowed off a certified rolling pull.
      try {
        const catchup = await runJobberHistoryCatchup(company, {
          rollingPullComplete:
            result.pullComplete && result.persistFailures === 0,
        });
        if (catchup.ranSlice) {
          logger.info(
            { companyId: company.id, ...catchup },
            "Jobber history catch-up slice ran during manual sync",
          );
        }
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber history catch-up failed during manual sync",
        );
      }
      // Newly imported addresses have no coordinates yet. Nudge the geocoder
      // rather than making the owner wait out its next cycle for pins.
      if (result.imported > 0 || result.updated > 0) {
        void runGeocodeBackfill().catch((err) =>
          logger.warn({ err }, "Geocode pass after Jobber sync failed"),
        );
      }
      res.json(SyncJobberCalendarResponse.parse(result));
    } catch (err) {
      logger.warn(
        { err, companyId: company.id },
        "Manual Jobber calendar sync failed",
      );
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : "We couldn't reach Jobber. Try again in a moment.",
      });
    }
  },
);

// Jobber is optional. Skipping keeps the whole product usable — quotes,
// scheduling and bookings just live here instead of being pushed across.
router.post(
  "/company/jobber/skip",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const parsed = SetJobberSkippedBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    // Skipping while connected would leave the UI claiming both at once.
    if (parsed.data.skipped && company.jobberConnected) {
      res.status(409).json({
        error: "Disconnect Jobber first if you want to run without it.",
      });
      return;
    }

    const [updated] = await db
      .update(companiesTable)
      .set({ jobberSkipped: parsed.data.skipped })
      .where(eq(companiesTable.id, company.id))
      .returning();

    res.json(SetJobberSkippedResponse.parse(await serializeCompany(updated!)));
  },
);

router.post(
  "/company/go-live",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const [updated] = await db
      .update(companiesTable)
      .set({ isLive: true })
      .where(eq(companiesTable.id, company.id))
      .returning();

    await db.insert(activityTable).values({
      companyId: company.id,
      type: "call_answered",
      message: `${company.name} is live — the AI receptionist is now answering calls.`,
    });

    res.json(GoLiveResponse.parse(await serializeCompany(updated!)));
  },
);

/* ─────────────── Jobber multi-connection management ─────────────── */

function serializeConnection(c: typeof jobberConnectionsTable.$inferSelect) {
  return {
    id: c.id,
    companyId: c.companyId,
    displayName: c.displayName ?? null,
    accountId: c.accountId ?? null,
    accountName: c.accountName ?? null,
    needsReauth: c.needsReauth,
    createdAt: c.createdAt.toISOString(),
  };
}

/** All Jobber connections for the caller's company (owner + dispatcher). */
router.get(
  "/company/jobber-connections",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const rows = await db
      .select()
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, company.id));
    res.json(rows.map(serializeConnection));
  },
);

/** Rename a connection (owner only). */
router.patch(
  "/company/jobber-connections/:id",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const connId = Number(req.params["id"]);
    if (!Number.isFinite(connId)) {
      res.status(400).json({ error: "Invalid connection id" });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const [conn] = await db
      .select()
      .from(jobberConnectionsTable)
      .where(
        and(
          eq(jobberConnectionsTable.id, connId),
          eq(jobberConnectionsTable.companyId, company.id),
        ),
      )
      .limit(1);
    if (!conn) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    const parsed = UpdateJobberConnectionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const displayName =
      typeof parsed.data.displayName === "string"
        ? parsed.data.displayName.trim() || null
        : (parsed.data.displayName ?? conn.displayName);
    const [updated] = await db
      .update(jobberConnectionsTable)
      .set({ displayName })
      .where(eq(jobberConnectionsTable.id, connId))
      .returning();
    res.json(serializeConnection(updated!));
  },
);

/**
 * Disconnect and remove one Jobber connection (owner only).
 *
 * Best-effort calls Jobber's appDisconnect mutation, then removes the row.
 * Staff assigned to this connection are left with jobberConnectionId = null,
 * so they fall back to the remaining primary connection automatically.
 */
router.delete(
  "/company/jobber-connections/:id",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const connId = Number(req.params["id"]);
    if (!Number.isFinite(connId)) {
      res.status(400).json({ error: "Invalid connection id" });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const [conn] = await db
      .select()
      .from(jobberConnectionsTable)
      .where(
        and(
          eq(jobberConnectionsTable.id, connId),
          eq(jobberConnectionsTable.companyId, company.id),
        ),
      )
      .limit(1);
    if (!conn) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    // Best-effort: revoke the grant in Jobber. A failure here doesn't block
    // the delete — the owner still has the Jobber dashboard for that.
    if (conn.accessToken) {
      try {
        const accessToken = await getValidConnectionToken(conn);
        await disconnectJobberApp(accessToken);
      } catch (err) {
        logger.warn(
          { err, connId },
          "Jobber appDisconnect failed for connection",
        );
      }
    }

    // Serialize every lifecycle mutation with OAuth callbacks. In particular,
    // two near-simultaneous deletes must not both choose a primary that the
    // other request is about to remove.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${company.id})`);
      const [lockedConn] = await tx
        .select()
        .from(jobberConnectionsTable)
        .where(
          and(
            eq(jobberConnectionsTable.id, connId),
            eq(jobberConnectionsTable.companyId, company.id),
          ),
        )
        .limit(1);
      if (!lockedConn) return;

      if (lockedConn.isPrimary) {
        const [nextPrimary] = await tx
          .select()
          .from(jobberConnectionsTable)
          .where(
            and(
              eq(jobberConnectionsTable.companyId, company.id),
              ne(jobberConnectionsTable.id, connId),
            ),
          )
          .orderBy(asc(jobberConnectionsTable.createdAt))
          .limit(1);

        if (nextPrimary) {
          await tx
            .update(jobberConnectionsTable)
            .set({ isPrimary: true })
            .where(eq(jobberConnectionsTable.id, nextPrimary.id));
          await tx
            .update(companiesTable)
            .set({
              jobberAccountId: nextPrimary.accountId,
              jobberAccountName: nextPrimary.accountName,
              jobberAccessToken: nextPrimary.accessToken,
              jobberRefreshToken: nextPrimary.refreshToken,
              jobberTokenExpiresAt: nextPrimary.tokenExpiresAt,
              jobberNeedsReauth: nextPrimary.needsReauth,
            })
            .where(eq(companiesTable.id, company.id));
        } else {
          await tx
            .update(companiesTable)
            .set({
              jobberConnected: false,
              jobberAccountId: null,
              jobberAccountName: null,
              jobberAccessToken: null,
              jobberRefreshToken: null,
              jobberTokenExpiresAt: null,
              jobberNeedsReauth: false,
            })
            .where(eq(companiesTable.id, company.id));
        }
      }

      await tx
        .update(teamMembersTable)
        .set({ jobberConnectionId: null })
        .where(eq(teamMembersTable.jobberConnectionId, connId));
      await tx
        .delete(jobberConnectionsTable)
        .where(eq(jobberConnectionsTable.id, connId));
    });

    res.sendStatus(204);
  },
);

export default router;
