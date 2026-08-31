import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  leadSyncStateTable,
  bookingsTable,
  activityTable,
  callsTable,
  type Lead,
} from "@workspace/db";
import {
  ListLeadsResponse,
  GetLeadResponse,
  DismissLeadResponse,
  BulkDismissLeadsBody,
  BulkDismissLeadsResponse,
  ConvertLeadBody,
  ConvertLeadResponse,
  SyncLeadsResponse,
  GetLeadSyncStatusResponse,
  SyncLeadToJobberResponse,
  UpdateLeadContactBody,
  UpdateLeadContactResponse,
  UpdateLeadTagBody,
  UpdateLeadTagParams,
  UpdateLeadTagResponse,
  SaveCallAsLeadParams,
  SaveCallAsLeadResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";
import {
  isLeadsSyncStale,
  leadsCompanyId,
  previewLeadsSync,
  refreshLeadsSyncIfStale,
  runLeadsSync,
  safeInboxUrl,
} from "../services/leadsSync";
import { isClaim, REAUTH_REASON } from "../services/jobberPush";
import { toE164 } from "../lib/quo";
import {
  queueLeadPush,
  leadJobberPushBlockedReason,
} from "../services/leadJobberPush";
import { logger } from "../lib/logger";
import { setCustomerTag } from "../lib/customerTag";
import { syncLeadContactToQuo } from "../services/quoContactSync";
import { loadUnplaceableAddressKeys } from "../services/geocodeBackfill";
import { geocodeCacheKey } from "../services/geocode";

const router: IRouter = Router();

router.use(requireAuth);

function triggerStaleLeadsCatchUp(companyId: number): void {
  void refreshLeadsSyncIfStale(companyId).catch((err) => {
    logger.error({ err, companyId }, "[leads] stale catch-up sync failed");
  });
}

/**
 * Lead ads carry names, phone numbers and addresses, so the whole surface is
 * owner/dispatcher — same audience as Calls. Guards are per-route, never
 * router-level: routers all mount at `/`, and a `router.use(requireRole)`
 * here would guard other routers' routes too.
 */
const dispatchOnly = requireRole("owner", "dispatcher");

/**
 * The most recent call from each phone number in this company's call
 * history, keyed by normalized E.164. Caller phones are stored as they
 * arrived (webhook E.164, live-capture free text), so each side is
 * normalized before comparing; a number that can't normalize identifies
 * nobody and is skipped. Test calls are the owner phoning themselves to
 * try the receptionist — they are not a customer conversation, so they
 * never light the badge.
 */
interface CallMatch {
  date: Date;
  id: number;
}

async function lastCallByPhone(
  companyId: number,
): Promise<Map<string, CallMatch>> {
  // Subquery: for each caller phone, find the startedAt of the most recent
  // non-test call. Then join back to pick up the id of that specific row.
  const sub = db
    .select({
      phone: callsTable.callerPhone,
      lastAt: sql<string | Date>`max(${callsTable.startedAt})`.as("last_at"),
    })
    .from(callsTable)
    .where(
      and(eq(callsTable.companyId, companyId), eq(callsTable.isTest, false)),
    )
    .groupBy(callsTable.callerPhone)
    .as("sub");

  const rows = await db
    .select({
      phone: callsTable.callerPhone,
      id: callsTable.id,
      lastAt: sub.lastAt,
    })
    .from(callsTable)
    .innerJoin(
      sub,
      and(
        eq(callsTable.callerPhone, sub.phone),
        eq(callsTable.startedAt, sub.lastAt),
      ),
    )
    .where(
      and(eq(callsTable.companyId, companyId), eq(callsTable.isTest, false)),
    );

  const map = new Map<string, CallMatch>();
  for (const row of rows) {
    const key = toE164(row.phone);
    if (!key) continue;
    const when =
      row.lastAt instanceof Date ? row.lastAt : new Date(row.lastAt as string);
    const prev = map.get(key);
    if (!prev || when > prev.date) map.set(key, { date: when, id: row.id });
  }
  return map;
}

/** The most recent matching call for one lead; null when there is none. */
async function lastCallForLead(
  companyId: number,
  lead: Lead,
): Promise<CallMatch | null> {
  if (!lead.phoneE164) return null;
  const byPhone = await lastCallByPhone(companyId);
  return byPhone.get(lead.phoneE164) ?? null;
}

function serializeLead(
  l: Lead,
  lastCall: CallMatch | null = null,
  geocodingFailed = false,
) {
  return {
    id: l.id,
    externalId: l.externalId,
    source: l.source,
    sourceTab: l.sourceTab,
    status: l.status,
    name: [l.firstName ?? "", l.lastName ?? ""].filter(Boolean).join(" "),
    phoneDisplay: l.phoneNumber ?? "",
    phoneE164: l.phoneE164 ?? null,
    // Whether this lead has ever been on the phone with the company, decided
    // server-side so web and mobile can never disagree about it.
    hasCalled: lastCall != null,
    lastCallAt: lastCall ? lastCall.date.toISOString() : null,
    lastCallId: lastCall ? lastCall.id : null,
    firstName: l.firstName ?? null,
    lastName: l.lastName ?? null,
    email: l.email ?? null,
    service: l.service ?? null,
    bedrooms: l.bedrooms ?? null,
    bathrooms: l.bathrooms ?? null,
    dateOfServiceRequested: l.dateOfServiceRequested ?? null,
    streetAddress: l.streetAddress ?? null,
    city: l.city ?? null,
    province: l.province ?? null,
    postCode: l.postCode ?? null,
    platform: l.platform ?? null,
    campaignName: l.campaignName ?? null,
    adName: l.adName ?? null,
    formName: l.formName ?? null,
    // Re-checked at the door as well as at import, so rows written before the
    // sanitizer existed can never hand the browser a javascript: link.
    inboxUrl: safeInboxUrl(l.inboxUrl),
    sheetLeadStatus: l.sheetLeadStatus ?? null,
    heardAbout: l.heardAbout ?? null,
    message: l.message ?? null,
    createdTime: l.createdTime ?? null,
    lat: l.lat ?? null,
    lng: l.lng ?? null,
    geocodingFailed,
    tag: l.tag ?? null,
    convertedBookingId: l.convertedBookingId ?? null,
    convertedAt: l.convertedAt ? l.convertedAt.toISOString() : null,
    callId: l.callId ?? null,
    // The card's Jobber link — captured at import for jobber-source leads,
    // written back by OUR push for form leads. jobberRequestId itself stays
    // server-side: it may hold a transient claim marker, and the card only
    // needs the link. jobberSynced means "our push succeeded", never "this
    // lead came from Jobber" — `source` tells that.
    jobberSynced: l.jobberSynced,
    jobberWebUri: l.jobberWebUri ?? null,
    jobberPushError: l.jobberPushError ?? null,
    jobberPushErrorAt: l.jobberPushErrorAt
      ? l.jobberPushErrorAt.toISOString()
      : null,
    createdAt: l.createdAt.toISOString(),
  };
}

const LEAD_STATUSES = new Set(["new", "converted", "dismissed"]);

router.get("/leads", dispatchOnly, async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.json(ListLeadsResponse.parse([]));
    return;
  }
  if ((await leadsCompanyId()) === company.id) {
    triggerStaleLeadsCatchUp(company.id);
  }
  const status =
    typeof req.query.status === "string" && LEAD_STATUSES.has(req.query.status)
      ? req.query.status
      : null;
  const scope = status
    ? and(eq(leadsTable.companyId, company.id), eq(leadsTable.status, status))
    : eq(leadsTable.companyId, company.id);
  const rows = await db
    .select()
    .from(leadsTable)
    .where(scope)
    .orderBy(desc(leadsTable.createdAt), desc(leadsTable.id));
  // One grouped query over the company's calls covers every lead in the
  // list — the match is a map lookup per row, not a query per row.
  const callsByPhone = await lastCallByPhone(company.id);
  const unplaceableAddressKeys = await loadUnplaceableAddressKeys(
    rows.map((lead) =>
      [lead.streetAddress, lead.city, lead.province, lead.postCode]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(", "),
    ),
  );
  res.json(
    ListLeadsResponse.parse(
      rows.map((l) =>
        serializeLead(
          l,
          l.phoneE164 ? (callsByPhone.get(l.phoneE164) ?? null) : null,
          l.lat === null &&
            l.lng === null &&
            unplaceableAddressKeys.has(
              geocodeCacheKey(
                [l.streetAddress, l.city, l.province, l.postCode]
                  .map((part) => part?.trim())
                  .filter(Boolean)
                  .join(", "),
              ),
            ),
        ),
      ),
    ),
  );
});

router.post("/leads/sync", dispatchOnly, async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.json(
      SyncLeadsResponse.parse({ imported: 0, error: null, tabStatuses: [] }),
    );
    return;
  }
  if ((await leadsCompanyId()) !== company.id) {
    res.json(
      SyncLeadsResponse.parse({ imported: 0, error: null, tabStatuses: [] }),
    );
    return;
  }
  const result = await runLeadsSync();
  res.json(
    SyncLeadsResponse.parse({
      imported: result.imported,
      error: result.error,
      tabStatuses: result.tabStatuses,
    }),
  );
});

router.get(
  "/leads/sync-preview",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.json({ tabs: [] });
      return;
    }
    if ((await leadsCompanyId()) !== company.id) {
      res.json({ tabs: [] });
      return;
    }
    try {
      res.json({ tabs: await previewLeadsSync() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  },
);

router.get(
  "/leads/sync-status",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    const empty = {
      configured: false,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastError: null,
      warning: null,
      tabStatuses: [],
      stale: false,
    };
    if (!company) {
      res.json(GetLeadSyncStatusResponse.parse(empty));
      return;
    }
    const destinationCompanyId = await leadsCompanyId();
    if (destinationCompanyId !== company.id) {
      res.json(GetLeadSyncStatusResponse.parse(empty));
      return;
    }
    const [state] = await db
      .select()
      .from(leadSyncStateTable)
      .where(eq(leadSyncStateTable.companyId, company.id));
    const stale = isLeadsSyncStale(state?.lastSyncAt);
    if (stale) triggerStaleLeadsCatchUp(company.id);
    res.json(
      GetLeadSyncStatusResponse.parse(
        state
          ? {
              configured: true,
              lastSyncAt: state.lastSyncAt?.toISOString() ?? null,
              lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
              lastError: state.lastError ?? null,
              warning: state.lastWarning ?? null,
              tabStatuses: state.tabStatuses ?? [],
              stale,
            }
          : { ...empty, configured: true, stale: true },
      ),
    );
  },
);

router.get("/leads/:id", dispatchOnly, async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  const id = Number(req.params.id);
  if (!company || !Number.isInteger(id)) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.companyId, company.id)));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(
    GetLeadResponse.parse(
      serializeLead(lead, await lastCallForLead(company.id, lead)),
    ),
  );
});

/**
 * Add or correct a lead's phone number or email. A missing phone blocks the
 * "text a quote" flow, so the office needs a way to fill it in on the card
 * without converting the lead first.
 */
router.patch("/leads/:id", dispatchOnly, async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  const id = Number(req.params.id);
  const body = UpdateLeadContactBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!company || !Number.isInteger(id)) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.companyId, company.id)));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const update: Partial<typeof leadsTable.$inferInsert> = {};

  if (body.data.phone !== undefined) {
    const raw = (body.data.phone ?? "").trim();
    if (raw === "") {
      update.phoneNumber = null;
      update.phoneE164 = null;
    } else {
      const e164 = toE164(raw);
      if (!e164) {
        res.status(400).json({
          error: `"${raw}" isn't a phone number we can text. Enter a full dialable number like 555-123-4567, or leave it blank.`,
        });
        return;
      }
      update.phoneNumber = raw;
      update.phoneE164 = e164;
    }
  }

  if (body.data.email !== undefined) {
    update.email = (body.data.email ?? "").trim() || null;
  }

  if (Object.keys(update).length === 0) {
    res.json(
      UpdateLeadContactResponse.parse(
        serializeLead(lead, await lastCallForLead(company.id, lead)),
      ),
    );
    return;
  }

  const [updated] = await db
    .update(leadsTable)
    .set(update)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.companyId, company.id)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  void syncLeadContactToQuo(company, {
    id: updated.id,
    firstName: updated.firstName,
    lastName: updated.lastName,
    phone: updated.phoneNumber,
    email: updated.email,
  });
  // Re-evaluated against the NEW number — correcting a phone can light (or
  // clear) the "they called" badge in the same response.
  res.json(
    UpdateLeadContactResponse.parse(
      serializeLead(updated, await lastCallForLead(company.id, updated)),
    ),
  );
});

router.patch(
  "/leads/:id/tag",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const params = UpdateLeadTagParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpdateLeadTagBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    // Conditional update scoped by company: another company's lead is
    // unreachable, and 0 rows back is a plain 404.
    const [updated] = await db
      .update(leadsTable)
      .set(
        body.data.tag === "spam"
          ? { tag: body.data.tag, status: "dismissed" }
          : { tag: body.data.tag },
      )
      .where(
        and(
          eq(leadsTable.id, params.data.id),
          eq(leadsTable.companyId, company.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    await setCustomerTag(
      company.id,
      { kind: "lead", id: updated.id },
      body.data.tag,
    );
    res.json(
      UpdateLeadTagResponse.parse(
        serializeLead(updated, await lastCallForLead(company.id, updated)),
      ),
    );
  },
);

/**
 * Dismiss several leads at once. Converted leads are silently skipped —
 * they move to the skip count, not an error — so a bulk triage after an
 * import works even if one lead was converted in the background. The
 * response tells the client how many actually moved vs. were skipped.
 */
router.post(
  "/leads/bulk-dismiss",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const body = BulkDismissLeadsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const ids = body.data.ids;
    if (ids.length === 0) {
      res.status(400).json({ error: "No ids provided" });
      return;
    }

    // One update per lead so we can distinguish "dismissed" from "skipped
    // because already converted". We run them concurrently — the set is
    // bounded by what the user ticked (a reasonable number of checkboxes).
    const results = await Promise.all(
      ids.map(async (id) => {
        const [updated] = await db
          .update(leadsTable)
          .set({ status: "dismissed" })
          .where(
            and(
              eq(leadsTable.id, id),
              eq(leadsTable.companyId, company.id),
              ne(leadsTable.status, "converted"),
            ),
          )
          .returning({ id: leadsTable.id });
        return updated ? "dismissed" : "skipped";
      }),
    );

    const dismissed = results.filter((r) => r === "dismissed").length;
    const skipped = results.filter((r) => r === "skipped").length;

    res.json(BulkDismissLeadsResponse.parse({ dismissed, skipped }));
  },
);

router.post(
  "/leads/:id/dismiss",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    const id = Number(req.params.id);
    if (!company || !Number.isInteger(id)) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    // Archiving a lead does not alter any booking it may have created.
    const [updated] = await db
      .update(leadsTable)
      .set({ status: "dismissed" })
      .where(and(eq(leadsTable.id, id), eq(leadsTable.companyId, company.id)))
      .returning();
    if (!updated) {
      const [existing] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(eq(leadsTable.id, id), eq(leadsTable.companyId, company.id)),
        );
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(
      DismissLeadResponse.parse(
        serializeLead(updated, await lastCallForLead(company.id, updated)),
      ),
    );
  },
);

/**
 * Retry sending a website-form or ad-sheet lead into Jobber. Both lead sources
 * push automatically now, so this button exists for the failure case: it either
 * finishes a push that failed partway (reusing any client Jobber already
 * created — never minting a second one), or reports that Jobber already has
 * the request.
 */
router.post(
  "/leads/:id/sync-jobber",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    const id = Number(req.params.id);
    if (!company || !Number.isInteger(id)) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, id), eq(leadsTable.companyId, company.id)));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    // Refusals the office can do something about get told straight; a lead
    // that's already over there just comes back as-is, like the booking
    // sync button does.
    if (lead.source !== "form" && lead.source !== "sheet") {
      res.status(400).json({
        error: "Only website form and ad-sheet leads are sent to Jobber.",
      });
      return;
    }
    if (!lead.jobberSynced && lead.status !== "converted") {
      if (company.jobberNeedsReauth) {
        res.status(400).json({ error: REAUTH_REASON });
        return;
      }
      if (!company.jobberConnected || !company.jobberRefreshToken) {
        res.status(400).json({ error: "Connect Jobber before syncing leads" });
        return;
      }
    }
    const result = await queueLeadPush(company, lead);
    if (result.status === "failed") {
      res.status(502).json({ error: `Jobber sync failed: ${result.error}` });
      return;
    }
    res.json(
      SyncLeadToJobberResponse.parse(
        serializeLead(
          result.lead,
          await lastCallForLead(company.id, result.lead),
        ),
      ),
    );
  },
);

/**
 * Turn a phone call into a lead with one tap.
 *
 * Creates a lead pre-filled with the caller's name and phone. The lead
 * immediately carries the Called badge because its number matches the call by
 * construction. Guards against duplicates: if any lead already exists with the
 * same E.164 phone number, returns 409 so the UI can tell the owner "already
 * in your leads". The externalId `call_<callId>` makes the insert idempotent:
 * a rapid double-tap races to the unique index instead of minting two rows.
 *
 * Accessible to owner/dispatcher — the same people who see the call log.
 */
router.post(
  "/calls/:id/save-as-lead",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const params = SaveCallAsLeadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Call not found" });
      return;
    }

    // Load the call scoped to this company.
    const [call] = await db
      .select()
      .from(callsTable)
      .where(
        and(
          eq(callsTable.id, params.data.id),
          eq(callsTable.companyId, company.id),
        ),
      );
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }

    // Test calls are the owner calling themselves to try the receptionist —
    // they are not customer conversations and must not land on the Leads page.
    if (call.isTest) {
      res.status(400).json({ error: "Test calls cannot be saved as leads." });
      return;
    }

    // If the call already produced a booking there is nothing left to capture
    // as a lead — the booking IS the conversion.
    if (call.bookingId) {
      res
        .status(400)
        .json({ error: "This call already has a booking linked to it." });
      return;
    }

    // A dialable phone is required — without it we can't match the lead to
    // future calls and can't text a quote.
    const phoneE164 = toE164(call.callerPhone);
    if (!phoneE164) {
      res.status(400).json({
        error: "This call has no dialable phone number to save.",
      });
      return;
    }

    // Split the caller name into first/last (best effort from a single string).
    const parts = (call.callerName ?? "").trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? null;
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;

    // Atomic deduplication: serialize concurrent saves for the same
    // (company, phone) pair with a Postgres advisory transaction lock, so
    // two different calls from the same caller that arrive simultaneously
    // cannot both insert. The lock is scoped to the transaction; it releases
    // on COMMIT/ROLLBACK automatically.
    let lead;
    let duplicate = false;
    try {
      await db.transaction(async (tx) => {
        // Two-integer advisory lock: (companyId, hashtext(phone)).
        // hashtext() returns int4, which is the right type for the second
        // argument of pg_advisory_xact_lock(int4, int4).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${company.id}::int, hashtext(${phoneE164})::int)`,
        );

        // Inside the lock: check for an existing lead with this phone.
        const [existing] = await tx
          .select({ id: leadsTable.id })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.companyId, company.id),
              eq(leadsTable.phoneE164, phoneE164),
            ),
          );
        if (existing) {
          duplicate = true;
          return; // rolls back the transaction; no row written
        }

        [lead] = await tx
          .insert(leadsTable)
          .values({
            companyId: company.id,
            source: "call",
            sourceTab: "Phone call",
            // call_<callId> makes repeat saves of the SAME call idempotent
            // (the unique index on (companyId, externalId) catches any
            // concurrent request that slips past the phone check).
            externalId: `call_${call.id}`,
            firstName,
            lastName,
            phoneNumber: call.callerPhone,
            phoneE164,
            status: "new",
            // Record the originating call so the card can link straight to its
            // transcript/recording, even after newer calls from the same number
            // push lastCallId forward.
            callId: call.id,
          })
          .returning();
      });
    } catch (err: unknown) {
      // Unique-constraint violation on (companyId, externalId): the same
      // call was saved twice so fast the advisory lock didn't help (both
      // requests found no existing lead before either inserted). Treat as
      // the idempotent "already saved" case.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "23505"
      ) {
        duplicate = true;
      } else {
        throw err;
      }
    }

    if (duplicate) {
      res.status(409).json({
        error: "A lead already exists for this caller's phone number.",
      });
      return;
    }

    if (!lead) {
      res.status(500).json({ error: "Failed to create lead." });
      return;
    }

    // The lead was just created from this call, so it has definitely called.
    res
      .status(201)
      .json(
        SaveCallAsLeadResponse.parse(
          serializeLead(lead, { date: call.startedAt, id: call.id }),
        ),
      );
  },
);

router.post(
  "/leads/:id/convert",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    const id = Number(req.params.id);
    const body = ConvertLeadBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (!company || !Number.isInteger(id)) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    // The booking being linked must be this company's own — a guessed id
    // must not let a lead point at another company's job.
    const [booking] = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.id, body.data.bookingId),
          eq(bookingsTable.companyId, company.id),
        ),
      );
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    // The conditional update IS the claim: only the request that flips the
    // status away from "converted" wins, so a double click (or two
    // dispatchers) cannot convert the same lead twice.
    const [updated] = await db
      .update(leadsTable)
      .set({
        status: "converted",
        convertedBookingId: booking.id,
        convertedAt: new Date(),
        jobberPushPending: false,
      })
      .where(
        and(
          eq(leadsTable.id, id),
          eq(leadsTable.companyId, company.id),
          ne(leadsTable.status, "converted"),
        ),
      )
      .returning();
    if (!updated) {
      const [existing] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(eq(leadsTable.id, id), eq(leadsTable.companyId, company.id)),
        );
      res.status(existing ? 409 : 404).json({
        error: existing ? "Lead already converted" : "Lead not found",
      });
      return;
    }
    // Record the origin on the booking too, if it isn't already there. The
    // desk sends it at creation — that is the copy the Jobber push reads — but
    // an older phone build may not, and without it a later manual re-send
    // would match this ad enquiry onto an existing Jobber client.
    await db
      .update(bookingsTable)
      .set({ leadId: updated.id })
      .where(
        and(eq(bookingsTable.id, booking.id), isNull(bookingsTable.leadId)),
      );
    // And whatever the lead's own push already created in Jobber, so the
    // booking's push finds it even on that older path. Conditional on the
    // booking having no Jobber state of its own (and no claim in flight) —
    // nothing a real push wrote is ever stepped on. Outbound columns only,
    // never jobberSyncedRequestId: the booking must not look imported, or it
    // couldn't quote and schedule later.
    const leadRequestId =
      updated.jobberRequestId && !isClaim(updated.jobberRequestId)
        ? updated.jobberRequestId
        : null;
    if (leadRequestId || updated.jobberClientId) {
      await db
        .update(bookingsTable)
        .set(
          leadRequestId
            ? {
                jobberSynced: true,
                jobberJobId: leadRequestId,
                jobberClientId: updated.jobberClientId,
                jobberPropertyId: updated.jobberPropertyId,
                jobberWebUri: updated.jobberWebUri,
              }
            : {
                jobberClientId: updated.jobberClientId,
                jobberPropertyId: updated.jobberPropertyId,
              },
        )
        .where(
          and(
            eq(bookingsTable.id, booking.id),
            eq(bookingsTable.jobberSynced, false),
            isNull(bookingsTable.jobberClientId),
            isNull(bookingsTable.jobberJobId),
          ),
        );
    }
    // Feed entry after the durable claim, so a lost race never announces.
    try {
      const name =
        [updated.firstName ?? "", updated.lastName ?? ""]
          .filter(Boolean)
          .join(" ") || "A lead";
      await db.insert(activityTable).values({
        companyId: company.id,
        type: "lead_converted",
        message: `${name} was converted into a booking from the Leads inbox`,
        bookingId: booking.id,
      });
    } catch (err) {
      logger.error({ err, leadId: id }, "[leads] activity write failed");
    }
    res.json(
      ConvertLeadResponse.parse(
        serializeLead(updated, await lastCallForLead(company.id, updated)),
      ),
    );
  },
);

export default router;
