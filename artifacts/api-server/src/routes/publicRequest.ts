import { Router, type IRouter, type Request } from "express";
import { randomBytes } from "node:crypto";
import { db, leadsTable, activityTable, companiesTable } from "@workspace/db";
import {
  SubmitPublicRequestBody,
  SubmitPublicRequestResponse,
} from "@workspace/api-zod";
import { leadsCompanyId } from "../services/leadsSync";
import { allowRequest } from "../lib/rateLimit";
import { toE164 } from "../lib/quo";
import { logger } from "../lib/logger";
import { queueText } from "../lib/pendingTexts";
import { eq } from "drizzle-orm";

/**
 * The public request form's intake — where ad traffic becomes a lead.
 *
 * Deliberately NOT behind requireAuth: the person submitting is a stranger
 * clicking an ad, and they must never see a sign-in screen. The submission
 * becomes a row in the existing Leads inbox, attributed to the same company
 * the sheet sync feeds (one deployment, one inbox) rather than guessed from
 * the request host.
 *
 * Everything the customer typed is stored verbatim — the office should see
 * "sometime next weekend?" exactly as written, never a guess at what it
 * meant. The one derived value is the normalized E.164 phone, computed the
 * same way the sheet sync computes it.
 */
const router: IRouter = Router();

/** The sourceTab label form leads carry — shown on lead cards like a tab name. */
export const FORM_SOURCE_TAB = "Website request form";

/**
 * Per-address submission ceiling. A real customer submits once, maybe twice
 * after a typo; a bot hammers. The key prefix keeps this window entirely
 * separate from any signed-in dashboard limit — an owner using the dashboard
 * from the same café wifi as a customer must never eat the customer's quota.
 */
const RATE_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 };

/**
 * The address a submission came from. Behind the deployment proxy the
 * visitor's address is the LAST X-Forwarded-For entry — that one was written
 * by our own proxy. The first entries are whatever the client claimed, and a
 * bot that could pick its own bucket by inventing addresses would never hit
 * the limit at all. Direct requests fall back to the socket; "unknown" still
 * rate-limits, just as one shared bucket — better than an unlimited hole.
 */
function clientAddress(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const flat = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  const last = flat?.split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "unknown";
}

/** Empty-ish strings become null so the lead card hides the row entirely. */
function keep(value: string | undefined): string | null {
  return value && value.trim() !== "" ? value : null;
}

router.post("/request", async (req, res): Promise<void> => {
  const body = SubmitPublicRequestBody.safeParse(req.body);
  if (!body.success) {
    // Field size caps and the required phone live in the schema; the message
    // stays generic because the form itself explains what's missing.
    res.status(400).json({
      error: "Please check the form — we need at least a phone number.",
    });
    return;
  }

  // Honeypot: the real form renders `website` hidden and never fills it, so
  // a value here is a bot filling every field. Answer success and store
  // nothing — an error would just teach the bot which field to skip.
  if (keep(body.data.website)) {
    logger.warn("[request-form] honeypot tripped; submission discarded");
    res.status(201).json(SubmitPublicRequestResponse.parse({ ok: true }));
    return;
  }

  if (!allowRequest(`public-request:${clientAddress(req)}`, RATE_LIMIT)) {
    res.status(429).json({
      error:
        "That's a few requests in a row — give it a little while and try again, or just call us.",
    });
    return;
  }

  // Phone is the one genuinely required field: a lead the office can't call
  // back isn't a lead. Required means "typed something", not "typed a number
  // we could normalize" — a real customer with an odd format must get
  // through, so phoneE164 staying null is fine.
  const phone = keep(body.data.phone);
  if (!phone) {
    res.status(400).json({
      error: "Please give us a phone number so we can reach you.",
    });
    return;
  }

  // Same company resolution as the sheet sync: the deployment's founding
  // company owns the inbox. Never inferred from the request host.
  const companyId = await leadsCompanyId();
  if (companyId === null) {
    res.status(503).json({
      error: "We can't take requests right now. Please call us instead.",
    });
    return;
  }

  const [lead] = await db
    .insert(leadsTable)
    .values({
      companyId,
      source: "form",
      // Random, not a content fingerprint: two genuine submissions with the
      // same answers (a couple booking separately, a re-submit after we
      // called) are two leads. Double-click junk is the rate limit's job.
      externalId: `form_${randomBytes(16).toString("base64url")}`,
      sourceTab: FORM_SOURCE_TAB,
      firstName: keep(body.data.firstName),
      lastName: keep(body.data.lastName),
      phoneNumber: phone,
      email: keep(body.data.email),
      streetAddress: keep(body.data.streetAddress),
      city: keep(body.data.city),
      province: keep(body.data.province),
      postCode: keep(body.data.postCode),
      service: keep(body.data.service),
      bedrooms: keep(body.data.bedrooms),
      bathrooms: keep(body.data.bathrooms),
      // Free text, never parsed into an appointment time.
      dateOfServiceRequested: keep(body.data.dateOfServiceRequested),
      heardAbout: keep(body.data.heardAbout),
      phoneE164: toE164(phone),
    })
    .returning();

  // Feed entry after the durable insert — the inbox row is the record, the
  // feed line is a courtesy that must never fail the customer's submission.
  const name =
    [lead!.firstName ?? "", lead!.lastName ?? ""].filter(Boolean).join(" ") ||
    "A new customer";
  try {
    await db.insert(activityTable).values({
      companyId,
      type: "lead_request_received",
      message: `${name} sent a cleaning request through the website form`,
    });
  } catch (err) {
    logger.error(
      { err, leadId: lead!.id },
      "[request-form] activity write failed",
    );
  }

  // Text the owner the moment a form lead arrives — ad leads go cold fast.
  // Goes through the owed-texts queue so an outage retries rather than drops.
  // Must never fail the customer's submission, hence the wrapping try/catch.
  try {
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    if (company) {
      const phone = lead!.phoneE164 ?? lead!.phoneNumber ?? "unknown";
      await queueText(company, {
        to: null,
        kind: "form_lead_notify",
        content: `New website request from ${name} — ${phone} — check the Leads inbox.`,
      });
    }
  } catch (err) {
    logger.error(
      { err, leadId: lead!.id },
      "[request-form] owner notify queue failed",
    );
  }

  // Straight into Jobber as a new client + work request, after the customer
  // has their answer — their confirmation must never wait on Jobber, and a
  // Jobber failure is recorded on the lead for the office to retry from the
  // inbox. NEVER in tests: the suite shares the dev DB, and the founding
  // company there may hold a real Jobber connection this would call out to.
  if (process.env["NODE_ENV"] !== "test") {
    void (async () => {
      const [company] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, companyId));
      if (company) {
        const { scheduleLeadJobberPush } =
          await import("../services/leadJobberPush");
        await scheduleLeadJobberPush(company, lead!);
      }
    })().catch((err) =>
      logger.warn({ err }, "[request-form] post-submit Jobber push failed"),
    );
  }

  // Nudge the geocoder so the new lead lands on the Leads map within
  // moments, not whenever the ten-minute backfill next wakes up.
  // Fire-and-forget: pin placement must never fail the submission. NEVER in
  // tests: the suite shares the dev DB and injects a null-returning stub
  // geocoder — letting this run there would cache "unplaceable" for every
  // real lead address for a month.
  if (process.env["NODE_ENV"] !== "test") {
    void import("../services/geocodeBackfill").then(({ runGeocodeBackfill }) =>
      runGeocodeBackfill().catch((err) =>
        logger.warn({ err }, "[request-form] post-submit geocode pass failed"),
      ),
    );
  }

  res.status(201).json(SubmitPublicRequestResponse.parse({ ok: true }));
});

export default router;
