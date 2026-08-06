import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  teamMembersTable,
  activityTable,
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
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser, serializeCompany } from "../lib/company";
import { ownerEmailFor } from "../lib/callerRole";
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
  tokenExpiry,
} from "../lib/jobber";
import { syncCompanyCalendar } from "../services/jobberCalendarSync";
import { runGeocodeBackfill } from "../services/geocodeBackfill";
import { encryptJobberToken } from "../lib/secretBox";
import { flagShiftedBookings } from "../lib/timezoneReview";
import { normalizePhoneField } from "../lib/phoneField";
import { logger } from "../lib/logger";
import crypto from "node:crypto";
import { publicBaseUrl } from "../lib/publicUrl";

const router: IRouter = Router();

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
    await db
      .update(companiesTable)
      .set({
        jobberConnected: true,
        // Connecting later overrides an earlier "skip" choice.
        jobberSkipped: false,
        jobberAccountId: account.id,
        jobberAccountName: account.name,
        // Tokens are encrypted at rest; decrypted only inside getValidAccessToken
        // and the disconnect flow — never returned to the browser.
        jobberAccessToken: encryptJobberToken(tokens.access_token),
        jobberRefreshToken: encryptJobberToken(tokens.refresh_token),
        jobberTokenExpiresAt: tokenExpiry(tokens.expires_in),
        jobberOauth: null,
        jobberNeedsReauth: false,
      })
      .where(eq(companiesTable.id, company.id));
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "jobber_synced",
      message: `Jobber account "${account.name}" connected.`,
    });
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

    // Stamp the creator's verified address on the company. This is what lets
    // them back in if the login behind it ever stops existing.
    const ownerEmail = await ownerEmailFor(req.userId!);

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
      name: "You",
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
    if (company.jobberNeedsReauth) {
      res.status(400).json({
        error: "Jobber access has expired — reconnect Jobber to keep syncing.",
      });
      return;
    }

    try {
      const result = await syncCompanyCalendar(company);
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

export default router;
