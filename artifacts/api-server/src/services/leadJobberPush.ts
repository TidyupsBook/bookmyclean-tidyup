/**
 * Pushing a website-form lead into Jobber the moment it is submitted.
 *
 * A lead used to reach Jobber only when somebody turned it into a booking —
 * too late twice over: the owner's CRM (Privyr) picks enquiries up *from*
 * Jobber, so an unconverted lead never reached it at all, and the owner
 * wants the request visible in Jobber the moment it comes in, exactly as
 * the old Jobber form delivered it.
 *
 * The rules mirror the booking push, with one deliberate difference:
 *
 *   - ALWAYS a new Jobber client. An ad enquiry is never matched onto an
 *     existing customer by phone number — a silent merge can't be seen or
 *     undone, where two clients merged inside Jobber can. The only client
 *     ever reused is the one a previous attempt at THIS lead created.
 *   - One push at a time per lead: the push claims `jobber_request_id` with
 *     a "pending:" marker before any Jobber call, so a retry racing the
 *     original (or a restart) cannot mint two requests.
 *   - Each id is written back the moment Jobber returns it, so a failure
 *     halfway through never abandons a client we then re-create on retry.
 *   - An interrupted attempt reconciles against Jobber before creating
 *     anything: if the lead's own client already carries a request, that
 *     request is adopted, never re-created — Jobber is the only party that
 *     can prove what an attempt that died mid-flight actually achieved.
 *   - Every state write is conditioned on still holding the claim. An
 *     attempt that outlives its lease stops at the next checkpoint and
 *     archives whatever it created after the claim was taken, so a slow
 *     worker racing a retry cannot leave two active records.
 *   - Website-form and ad-sheet leads use the same push path. Sheet leads are
 *     scheduled after their import is durable, so the sheet read itself never
 *     waits on Jobber.
 *
 * Runs on the same per-company queue as the booking push — Jobber's rate
 * budget is shared, and serializing the two is also what lets a booking
 * converted from a still-in-flight lead adopt the lead's ids instead of
 * racing it into a second client (see adoptLeadJobberState in jobberPush).
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  bookingsTable,
  activityTable,
  type Lead,
  type Company,
} from "@workspace/db";
import {
  getValidAccessToken,
  createJobberClient,
  ensureJobberProperty,
  createJobberRequest,
  tryAttachRequestNote,
  listJobberClientRequests,
  findLeadOrphanClient,
  tryArchiveJobberClient,
  tryArchiveJobberRequest,
  type JobberAddress,
  type JobberProperty,
} from "../lib/jobber";
import {
  PUSH_CLAIM_PREFIX,
  PUSH_CLAIM_STALE_MS,
  isClaim,
  claimAge,
  REAUTH_REASON,
  jobberBlockNeedsOwnerAction,
  runQueuedForCompany,
  deleteEchoLeads,
} from "./jobberPush";
import { recordClientContact } from "./clientDirectory";
import { logger } from "../lib/logger";

export type LeadJobberPushResult =
  | { status: "synced"; lead: Lead }
  | { status: "skipped"; reason: string; lead: Lead }
  | { status: "failed"; error: string; lead: Lead };

/**
 * The claim was taken from under us mid-push. Whoever holds it now owns the
 * outcome; report the row as they left it and change nothing.
 */
async function supersededResult(lead: Lead): Promise<LeadJobberPushResult> {
  const [row] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, lead.id));
  return {
    status: "skipped",
    reason: "Another sync finished this lead first.",
    lead: row ?? lead,
  };
}

/** The name the office (and Jobber) will recognise this enquiry by. */
export function leadLabel(lead: Lead): string {
  const name = [lead.firstName ?? "", lead.lastName ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || lead.phoneNumber?.trim() || "Website request";
}

/**
 * Whether this lead is one we may send. Separate from the push itself so the
 * retry endpoint can explain the situation instead of failing.
 */
export function leadJobberPushBlockedReason(
  company: Company,
  lead: Lead,
): string | null {
  if (lead.source !== "form" && lead.source !== "sheet") {
    return "Only website form and ad-sheet leads are sent to Jobber.";
  }
  if (lead.jobberSynced) {
    return "This request is already in Jobber.";
  }
  if (lead.status === "converted") {
    // The booking carries the Jobber work forward from here (it adopted
    // whatever this lead's push had produced). A late lead retry alongside
    // the booking's own push is exactly how one enquiry becomes two clients.
    return "This lead became a booking — sync the booking instead.";
  }
  if (company.jobberNeedsReauth) {
    return REAUTH_REASON;
  }
  if (!company.jobberConnected || !company.jobberRefreshToken) {
    return "Connect Jobber before syncing leads";
  }
  return null;
}

/**
 * Write a push failure onto the lead and into the activity feed, the same
 * shape booking sync failures take: one note on the card, one line in the
 * feed. The lead itself is untouched otherwise — Jobber being down must
 * never lose or hide a lead.
 */
async function recordLeadPushFailure(
  company: Company,
  lead: Lead,
  message: string,
): Promise<Lead> {
  try {
    const [updated] = await db
      .update(leadsTable)
      .set({
        jobberPushError: message,
        jobberPushErrorAt: new Date(),
        jobberPushAttempts: sql`${leadsTable.jobberPushAttempts} + 1`,
        jobberPushPending: false,
      })
      .where(eq(leadsTable.id, lead.id))
      .returning();
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "jobber_sync_failed",
      message: `Jobber sync failed for ${leadLabel(lead)}'s website request: ${message}`,
    });
    return updated ?? lead;
  } catch (err) {
    logger.error({ err }, "Failed to record lead Jobber push failure");
    return lead;
  }
}

function leadAddress(lead: Lead): JobberAddress {
  return {
    street1: lead.streetAddress,
    street2: null,
    city: lead.city,
    province: lead.province,
    postalCode: lead.postCode,
  };
}

/**
 * The request note: the customer's own words, verbatim. "1 or 2" bedrooms
 * and "sometime next weekend?" go over exactly as typed — the office reads
 * this in Jobber and should see what was actually said, never a guess.
 */
function buildLeadRequestNote(lead: Lead): string {
  const address = [lead.streetAddress, lead.city, lead.province, lead.postCode]
    .filter(Boolean)
    .join(", ");
  return [
    "Request submitted on the Book My Cleaning website form.",
    ...(lead.phoneNumber ? [`Phone: ${lead.phoneNumber}`] : []),
    ...(lead.email ? [`Email: ${lead.email}`] : []),
    ...(address ? [`Address: ${address}`] : []),
    ...(lead.service ? [`Service: ${lead.service}`] : []),
    ...(lead.bedrooms ? [`Bedrooms: ${lead.bedrooms}`] : []),
    ...(lead.bathrooms ? [`Bathrooms: ${lead.bathrooms}`] : []),
    ...(lead.dateOfServiceRequested
      ? [`Requested time (as written): ${lead.dateOfServiceRequested}`]
      : []),
    ...(lead.heardAbout ? [`Heard about us: ${lead.heardAbout}`] : []),
  ].join("\n");
}

/**
 * Send one lead to Jobber as a new client + work request.
 *
 * Returns rather than throws: this runs on its own after the form intake
 * answers the customer, and "Jobber said no" is a state the lead carries,
 * not a crash — the office retries it from the inbox.
 */
export async function pushLeadToJobber(
  company: Company,
  lead: Lead,
): Promise<LeadJobberPushResult> {
  // The caller's Lead is a snapshot, and this runs queued behind other
  // Jobber work — by the time it's our turn, the desk may have converted
  // the lead, or another retry may have finished it. Working from the stale
  // snapshot is exactly how one enquiry becomes two clients, so every guard
  // below judges the row as it is NOW.
  const [current] = await db
    .select()
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, lead.id), eq(leadsTable.companyId, company.id)),
    );
  if (!current) {
    return { status: "skipped", reason: "Lead not found", lead };
  }
  lead = current;

  const blocked = leadJobberPushBlockedReason(company, lead);
  if (blocked) return { status: "skipped", reason: blocked, lead };

  // A booking wearing this lead's id owns the Jobber sync from the moment it
  // exists — the desk creates the booking BEFORE the convert call flips the
  // lead's status, so status alone can't be trusted here. The booking's push
  // adopts whatever this lead's push already produced; if we went to Jobber
  // now, the two would race into two clients.
  const [claimingBooking] = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.leadId, lead.id),
        eq(bookingsTable.companyId, company.id),
      ),
    )
    .limit(1);
  if (claimingBooking) {
    return {
      status: "skipped",
      reason: "This lead became a booking — sync the booking instead.",
      lead,
    };
  }

  const age = claimAge(lead.jobberRequestId);
  if (age !== null && age > Date.now() - PUSH_CLAIM_STALE_MS) {
    return {
      status: "skipped",
      reason: "This request is already being sent to Jobber.",
      lead,
    };
  }

  // Claim BEFORE calling Jobber, pinning the exact value we read — only one
  // caller wins even if two arrive at the same instant.
  const claim = `${PUSH_CLAIM_PREFIX}${Date.now()}`;
  const priorRequestId = lead.jobberRequestId;
  const claimed = await db
    .update(leadsTable)
    .set({ jobberRequestId: claim })
    .where(
      and(
        eq(leadsTable.id, lead.id),
        eq(leadsTable.companyId, company.id),
        eq(leadsTable.jobberSynced, false),
        // Belt to the booking check above: a conversion that lands between
        // the read and this write loses us the claim outright.
        ne(leadsTable.status, "converted"),
        priorRequestId === null
          ? isNull(leadsTable.jobberRequestId)
          : eq(leadsTable.jobberRequestId, priorRequestId),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    return {
      status: "skipped",
      reason: "This request is already being sent to Jobber.",
      lead,
    };
  }

  try {
    const accessToken = await getValidAccessToken(company);

    // ── Reconcile before creating anything ─────────────────────────────
    // A recorded client means an earlier attempt got at least that far — and
    // may have got further than the row admits: a crash (or timeout) between
    // Jobber accepting the request and us writing it down leaves a lead that
    // looks unsynced while the request already exists. The client is this
    // lead's alone, so Jobber itself is asked: any request on it is ours,
    // and it is adopted rather than created "again".
    if (lead.jobberClientId) {
      const existing = await listJobberClientRequests(
        accessToken,
        lead.jobberClientId,
      );
      const recovered = existing[0];
      if (recovered) {
        const [updated] = await db
          .update(leadsTable)
          .set({
            jobberSynced: true,
            jobberRequestId: recovered.id,
            jobberWebUri: recovered.jobberWebUri,
            jobberPushError: null,
            jobberPushErrorAt: null,
            jobberPushAttempts: 0,
            jobberPushPending: false,
          })
          .where(
            and(
              eq(leadsTable.id, lead.id),
              eq(leadsTable.jobberRequestId, claim),
            ),
          )
          .returning();
        if (!updated) return await supersededResult(lead);
        // The recovered request fired REQUEST_CREATE like any other; take
        // back the echo lead the webhook may have imported meanwhile.
        await deleteEchoLeads(company.id, recovered.id);
        await db.insert(activityTable).values({
          companyId: company.id,
          type: "jobber_synced",
          message: `${leadLabel(lead)}'s website request was sent to Jobber as a new client and work request.`,
        });
        return { status: "synced", lead: updated };
      }
    }

    const address = leadAddress(lead);

    // ALWAYS a new client — never findJobberClient here. An ad enquiry
    // landing silently on top of an existing customer is a merge the owner
    // never agreed to; they would rather see two clients and merge them in
    // Jobber, where it can be undone. The only reuse is our own: the client
    // a previous attempt at this same lead already created.
    let clientId = lead.jobberClientId;
    let properties: JobberProperty[] = [];
    if (!clientId) {
      // The one irreversible gap the claim can't cover: a crash (or timeout)
      // after Jobber accepted clientCreate but before the id write leaves an
      // orphan client the row knows nothing about. When there is durable
      // evidence of an earlier attempt — a stale claim we took over, or a
      // recorded failure — ask Jobber for an exact double of what that
      // attempt would have created (same name/phone/email, zero requests)
      // and finish with it instead of minting a second one. A fresh lead
      // never searches, so the no-phone-matching rule holds for every first
      // push.
      const priorAttempt =
        isClaim(priorRequestId) || lead.jobberPushError !== null;
      const orphan = priorAttempt
        ? await findLeadOrphanClient(accessToken, {
            name: leadLabel(lead),
            phone: lead.phoneNumber ?? "",
            email: lead.email,
          })
        : null;
      let createdFresh = false;
      if (orphan) {
        logger.info(
          { leadId: lead.id, clientId: orphan.id },
          "Lead push recovered the client an interrupted attempt created",
        );
        clientId = orphan.id;
        properties = orphan.properties;
      } else {
        const created = await createJobberClient(accessToken, {
          name: leadLabel(lead),
          phone: lead.phoneNumber ?? "",
          email: lead.email,
          address,
        });
        clientId = created.id;
        properties = created.properties;
        createdFresh = true;
      }
      // Store the client the moment we have one — but only while the claim
      // is still ours. If it isn't, another attempt owns this lead now and
      // has (or will make) its own client; recording ours would corrupt its
      // state, so a freshly created client is archived instead of
      // remembered. A recovered orphan is left alone — the winner's own
      // recovery pass is entitled to find it.
      const saved = await db
        .update(leadsTable)
        .set({ jobberClientId: clientId })
        .where(
          and(
            eq(leadsTable.id, lead.id),
            eq(leadsTable.jobberRequestId, claim),
          ),
        )
        .returning();
      if (saved.length === 0) {
        if (createdFresh) {
          logger.warn(
            { leadId: lead.id, clientId },
            "Lead push lost its claim after creating a client; archiving the orphan",
          );
          await tryArchiveJobberClient(accessToken, clientId);
        }
        return await supersededResult(lead);
      }
    }
    // The client directory learns the Jobber id the moment we do. Never
    // throws.
    await recordClientContact(company.id, {
      name: leadLabel(lead),
      phone: lead.phoneNumber,
      email: lead.email,
      streetAddress: lead.streetAddress,
      city: lead.city,
      province: lead.province,
      postalCode: lead.postCode,
      jobberClientId: clientId,
      source: "lead",
    });

    let propertyId = lead.jobberPropertyId;
    if (!propertyId) {
      propertyId = await ensureJobberProperty(accessToken, {
        clientId,
        existing: properties,
        address,
      });
      if (propertyId) {
        const saved = await db
          .update(leadsTable)
          .set({ jobberPropertyId: propertyId })
          .where(
            and(
              eq(leadsTable.id, lead.id),
              eq(leadsTable.jobberRequestId, claim),
            ),
          )
          .returning();
        // The property hangs off a client the row already records, so there
        // is nothing to clean up — but a lost claim still means stop here.
        if (saved.length === 0) return await supersededResult(lead);
      }
    }

    // Last look before the one mutation the owner's CRM will surface. The
    // conditional writes above catch a stolen claim at every checkpoint;
    // this closes the gap for a lead that reused its client and property.
    const [owned] = await db
      .select({ jobberRequestId: leadsTable.jobberRequestId })
      .from(leadsTable)
      .where(eq(leadsTable.id, lead.id));
    if (owned?.jobberRequestId !== claim) return await supersededResult(lead);

    const request = await createJobberRequest(accessToken, {
      clientId,
      propertyId,
      title: `${(lead.service ?? "").trim() || "Cleaning"} — ${leadLabel(lead)} (website request)`,
    });

    await tryAttachRequestNote(
      accessToken,
      request.id,
      buildLeadRequestNote(lead),
    );

    const [updated] = await db
      .update(leadsTable)
      .set({
        jobberSynced: true,
        jobberRequestId: request.id,
        jobberClientId: clientId,
        jobberPropertyId: propertyId,
        jobberWebUri: request.jobberWebUri,
        jobberPushError: null,
        jobberPushErrorAt: null,
        jobberPushAttempts: 0,
        jobberPushPending: false,
      })
      // Only if we still hold the claim: anything else touching this row
      // means our view is stale and the write is not ours to make.
      .where(
        and(eq(leadsTable.id, lead.id), eq(leadsTable.jobberRequestId, claim)),
      )
      .returning();

    if (!updated) {
      logger.warn(
        { leadId: lead.id, requestId: request.id },
        "Jobber request created but the lead's claim was taken; archiving it",
      );
      // The winner's request is the one on record; ours would sit in Jobber
      // as a second enquiry for the same customer. Best-effort archive.
      await tryArchiveJobberRequest(accessToken, request.id);
      return await supersededResult(lead);
    }

    // Our request fires Jobber's REQUEST_CREATE webhook like a form
    // submission would; if that webhook outran the write-back above, its
    // import is now an echo lead — take it back out. (The importer also
    // re-checks from its side, so the race is closed in both orders.)
    await deleteEchoLeads(company.id, request.id);

    await db.insert(activityTable).values({
      companyId: company.id,
      type: "jobber_synced",
      message: `${leadLabel(lead)}'s website request was sent to Jobber as a new client and work request.`,
    });

    return { status: "synced", lead: updated };
  } catch (err) {
    logger.error({ err, leadId: lead.id }, "Jobber lead push failed");
    // Release the claim so a retry — by the office, or by the convert flow —
    // isn't locked out for five minutes. Conditioned on the claim still
    // being ours: if it was taken while we were failing, the new owner's
    // outcome stands and our error is not this row's truth.
    const released = await db
      .update(leadsTable)
      .set({ jobberRequestId: priorRequestId })
      .where(
        and(eq(leadsTable.id, lead.id), eq(leadsTable.jobberRequestId, claim)),
      )
      .returning();
    if (released.length === 0) return await supersededResult(lead);
    const message = err instanceof Error ? err.message : "Unknown error";
    const updated = await recordLeadPushFailure(company, lead, message);
    return { status: "failed", error: message, lead: updated };
  }
}

/** Push a lead, waiting behind any other Jobber work for the same company. */
export function queueLeadPush(
  company: Company,
  lead: Lead,
): Promise<LeadJobberPushResult> {
  return runQueuedForCompany(company.id, () => pushLeadToJobber(company, lead));
}

/**
 * Fire-and-forget push used by website-form intake and sheet imports. The lead
 * must be saved and the customer answered whatever Jobber does next, so this
 * never blocks either path and never throws — a failure is recorded on the
 * lead and shown in the feed, and the office retries from the inbox.
 *
 * The returned promise exists for tests; production callers ignore it.
 */
export function scheduleLeadJobberPush(
  company: Company,
  lead: Lead,
): Promise<void> {
  const blocked = leadJobberPushBlockedReason(company, lead);
  if (blocked) {
    // A refusal the owner has to act on (an expired grant, a lost refresh
    // token) is written onto the lead exactly as a failure is — the owner
    // believes their enquiries are flowing into Jobber and they are not. A
    // company that never connected Jobber just isn't using this: quiet.
    if (
      (lead.source === "form" || lead.source === "sheet") &&
      !lead.jobberSynced &&
      lead.status !== "converted" &&
      jobberBlockNeedsOwnerAction(company)
    ) {
      return recordLeadPushFailure(company, lead, blocked).then(
        () => undefined,
      );
    }
    // A pushed or converted row can retain the durable sheet handoff marker
    // only if another worker beat us to its outcome. Clear it now: its next
    // owner is the booking, never a later sheet poll.
    if (
      lead.jobberPushPending &&
      (lead.jobberSynced || lead.status === "converted")
    ) {
      return db
        .update(leadsTable)
        .set({ jobberPushPending: false })
        .where(eq(leadsTable.id, lead.id))
        .then(() => undefined);
    }
    return Promise.resolve();
  }
  return queueLeadPush(company, lead)
    .then(async (result) => {
      if (result.status === "failed") {
        logger.warn(
          { leadId: lead.id, error: result.error },
          "Automatic lead Jobber push failed",
        );
      }
      if (
        result.status === "skipped" &&
        result.lead.jobberPushPending &&
        (result.lead.jobberSynced || result.lead.status === "converted")
      ) {
        await db
          .update(leadsTable)
          .set({ jobberPushPending: false })
          .where(eq(leadsTable.id, result.lead.id));
      }
    })
    .catch((err) => {
      logger.error(
        { err, leadId: lead.id },
        "Automatic lead Jobber push threw",
      );
    });
}
