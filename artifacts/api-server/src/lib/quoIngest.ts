import { and, eq, sql } from "drizzle-orm";
import {
  db,
  callsTable,
  bookingsTable,
  activityTable,
  type Company,
  type TranscriptSegment,
  type ExtractedAnswer,
} from "@workspace/db";
import * as quo from "./quo";
import { logger } from "./logger";
import { scheduleJobberPush } from "../services/jobberPush";
import { recordCaller } from "../services/callerDirectory";

/**
 * Quo identifies each transcript turn by phone number. Anything spoken from
 * one of the workspace's own Quo numbers is Sona (or a teammate); everything
 * else is the caller.
 */
function toTranscript(
  dialogue: quo.QuoTranscriptDialogue[],
  ourNumbers: Set<string>,
): TranscriptSegment[] {
  return dialogue.map((d) => ({
    speaker:
      (d.identifier && ourNumbers.has(d.identifier)) || d.userId
        ? ("ai" as const)
        : ("caller" as const),
    text: d.content,
    offsetSeconds: Math.round(d.start ?? 0),
  }));
}

const FIELD_PATTERNS: Array<{ field: string; re: RegExp }> = [
  {
    field: "address",
    re: /\b(\d{1,6}\s+[A-Za-z][A-Za-z0-9.'\- ]{3,40}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|way|boulevard|blvd|terrace|place|pl)\b)/i,
  },
  { field: "home size", re: /\b(\d\s*(?:bed|bedroom|br)\b[^.!?]{0,40})/i },
  {
    field: "pets",
    re: /\b((?:no pets|one dog|a dog|two dogs|a cat|cats?|dogs?)[^.!?]{0,30})/i,
  },
  {
    field: "preferred date",
    re: /\b((?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)[^.!?]{0,30})/i,
  },
  {
    field: "service type",
    re: /\b((?:deep|move[- ]?out|move[- ]?in|standard|recurring|post[- ]construction|airbnb)[a-z ]{0,20}clean(?:ing)?)/i,
  },
  { field: "budget", re: /(\$\s?\d{2,5}(?:\s?-\s?\$?\d{2,5})?)/ },
];

/**
 * Pull structured answers out of what the caller said. Sona's own prompts are
 * skipped so we only capture the customer's words.
 */
function extractAnswers(transcript: TranscriptSegment[]): ExtractedAnswer[] {
  const callerText = transcript
    .filter((t) => t.speaker === "caller")
    .map((t) => t.text)
    .join(" ");

  const answers: ExtractedAnswer[] = [];
  for (const { field, re } of FIELD_PATTERNS) {
    const m = callerText.match(re);
    if (m?.[1]) answers.push({ field, value: m[1].trim() });
  }
  return answers;
}

function summaryToText(summary: quo.QuoSummary | null): string | null {
  if (!summary?.summary) return null;
  if (Array.isArray(summary.summary)) return summary.summary.join(" ");
  return String(summary.summary);
}

export function callerNumberOf(
  call: quo.QuoCall,
  ourNumbers: Set<string>,
): string | null {
  const owned = new Set(
    [...ourNumbers]
      .map((number) => quo.toE164(number))
      .filter((number): number is string => Boolean(number)),
  );
  // A participant is a caller only when it is a dialable number and not one
  // of the company's lines. Labels, "Unknown", and a second owned line must
  // never turn into people in the directory.
  return (
    call.participants?.find((participant) => {
      const normalized = quo.toE164(participant);
      return Boolean(normalized && !owned.has(normalized));
    }) ?? null
  );
}

export function directoryCallerNumberOf(
  call: quo.QuoCall,
  ourNumbers: Set<string>,
): string | null {
  return call.direction === "incoming"
    ? callerNumberOf(call, ourNumbers)
    : null;
}

export type UpsertResult = { callRowId: number; created: boolean };

/**
 * Insert or update the local record for a Quo call. Safe to call repeatedly —
 * webhooks for the same call arrive multiple times (ringing, completed,
 * transcript, summary).
 */
export async function upsertCall(
  company: Company,
  call: quo.QuoCall,
  ourNumbers: Set<string>,
  syncCallerContact = true,
): Promise<UpsertResult> {
  const callerPhone = callerNumberOf(call, ourNumbers);
  const directoryCallerPhone = directoryCallerNumberOf(call, ourNumbers);
  const storedPhone = callerPhone ?? "Unknown";
  const isRinging = call.status === "ringing" || !call.completedAt;
  const status = isRinging ? "in_progress" : "completed";
  const startedAt = call.createdAt ? new Date(call.createdAt) : new Date();

  // Conflict-safe: webhooks for one call arrive repeatedly (ringing, completed,
  // transcript, summary) and can overlap, so a select-then-insert would race.
  const [row] = await db
    .insert(callsTable)
    .values({
      companyId: company.id,
      callerName: storedPhone,
      callerPhone: storedPhone,
      status,
      startedAt,
      durationSeconds: Math.round(call.duration ?? 0),
      isTest: false,
      quoCallId: call.id,
      quoPhoneNumberId: call.phoneNumberId,
      direction: call.direction,
      transcript: [],
      extractedAnswers: [],
    })
    .onConflictDoUpdate({
      target: callsTable.quoCallId,
      set: {
        // Never downgrade a booked call back to completed.
        status: sql`case when ${callsTable.status} = 'booked' then ${callsTable.status} else excluded.status end`,
        durationSeconds: sql`greatest(${callsTable.durationSeconds}, excluded.duration_seconds)`,
        direction: sql`coalesce(excluded.direction, ${callsTable.direction})`,
        quoPhoneNumberId: sql`coalesce(excluded.quo_phone_number_id, ${callsTable.quoPhoneNumberId})`,
        // Later deliveries often have a complete participant list. Repair a
        // placeholder from the ringing webhook, but never replace a real
        // caller with Unknown from a sparse delivery.
        callerPhone: sql`case when excluded.caller_phone <> 'Unknown' then excluded.caller_phone else ${callsTable.callerPhone} end`,
        callerName: sql`case when excluded.caller_name <> 'Unknown' then excluded.caller_name else ${callsTable.callerName} end`,
      },
      // A call belongs to exactly one tenant; never let another company's
      // delivery take over an existing row.
      setWhere: eq(callsTable.companyId, company.id),
    })
    // `xmax = 0` marks a freshly inserted row; anything else was an update.
    .returning({
      id: callsTable.id,
      isNew: sql<boolean>`(xmax = 0)`,
    });

  if (!row) {
    throw new Error(
      `Quo call ${call.id} is already owned by a different company`,
    );
  }

  if (row.isNew) {
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "call_answered",
      message: `${call.direction === "outgoing" ? "Outgoing call to" : "Call from"} ${storedPhone}.`,
      callId: row.id,
    });
  }
  // The caller directory is specifically people who called the company.
  // Outgoing recipients still keep their real number on the call record, but
  // do not become callers merely because the company dialed them.
  if (directoryCallerPhone) {
    await recordCaller(company.id, {
      phone: directoryCallerPhone,
      name: directoryCallerPhone,
      startedAt,
      callId: row.id,
      isNewCall: row.isNew,
      syncContact: syncCallerContact,
    });
  }

  return { callRowId: row.id, created: row.isNew };
}

/**
 * Attach a Sona transcript to a call, derive the caller's answers, and open a
 * pending booking when the conversation looks like a real job request.
 */
export async function applyTranscript(
  apiKey: string,
  company: Company,
  quoCallId: string,
  ourNumbers: Set<string>,
): Promise<boolean> {
  const transcript = await quo.getTranscript(apiKey, quoCallId);
  if (!transcript?.dialogue?.length) return false;

  const [call] = await db
    .select()
    .from(callsTable)
    .where(
      and(
        eq(callsTable.companyId, company.id),
        eq(callsTable.quoCallId, quoCallId),
      ),
    );
  if (!call) return false;

  const segments = toTranscript(transcript.dialogue, ourNumbers);
  const answers = extractAnswers(segments);
  const summary = summaryToText(await quo.getSummary(apiKey, quoCallId));

  const serviceRequested =
    answers.find((a) => a.field === "service type")?.value ?? null;
  const preferredTime =
    answers.find((a) => a.field === "preferred date")?.value ?? null;

  await db
    .update(callsTable)
    .set({
      transcript: segments,
      extractedAnswers: answers,
      summary,
      serviceRequested,
      preferredTime,
      // Quo reports transcript duration as a float (e.g. 134.42613); the
      // column is an integer.
      durationSeconds:
        transcript.duration != null
          ? Math.round(transcript.duration)
          : call.durationSeconds,
    })
    .where(eq(callsTable.id, call.id));

  const address = answers.find((a) => a.field === "address")?.value ?? null;

  // Only open a booking when the caller actually described a job: either they
  // named a service, or they gave both where and when. Two arbitrary matches
  // (say, pets plus a budget) is not a booking.
  const looksLikeJob = Boolean(serviceRequested || (address && preferredTime));

  if (looksLikeJob) {
    // `bookings.call_id` is unique, so a concurrent transcript and summary
    // delivery for the same call cannot both create one.
    const [booking] = await db
      .insert(bookingsTable)
      .values({
        companyId: company.id,
        callId: call.id,
        customerName: call.callerName,
        customerPhone: call.callerPhone,
        customerAddress: address,
        service: serviceRequested ?? "Cleaning inquiry",
        scheduledFor: call.startedAt,
        status: "pending",
      })
      .onConflictDoNothing({ target: bookingsTable.callId })
      .returning();

    if (booking) {
      await db
        .update(callsTable)
        .set({ bookingId: booking.id, status: "booked" })
        .where(eq(callsTable.id, call.id));

      await db.insert(activityTable).values({
        companyId: company.id,
        type: "booking_created",
        message: `Sona captured a ${booking.service} request from ${call.callerPhone}.`,
        bookingId: booking.id,
      });

      // A job the receptionist took off a call reaches Jobber the same way a
      // job typed in at the desk does — the owner works out of Jobber, and a
      // booking only he can see is a booking he will miss.
      void scheduleJobberPush(company, booking);
    }
  }

  logger.info(
    { quoCallId, segments: segments.length, answers: answers.length },
    "Applied Quo transcript",
  );
  return true;
}

/**
 * Backfill: walk recent conversations on the watched lines and import any
 * calls (with transcripts) we have not seen yet. Webhooks only cover calls
 * that happen after setup, so this fills in history.
 */
export async function backfillCalls(
  apiKey: string,
  company: Company,
  ourNumbers: Set<string>,
): Promise<{ callsImported: number; transcriptsImported: number }> {
  const watched = company.quoNumberIds;
  if (watched.length === 0) return { callsImported: 0, transcriptsImported: 0 };

  const conversations = await quo.listConversations(apiKey, watched, 50);
  let callsImported = 0;
  let transcriptsImported = 0;

  for (const conv of conversations) {
    const participant = callerNumberOf(
      { ...conv, status: "", direction: "incoming", createdAt: "" },
      ourNumbers,
    );
    if (!participant) continue;

    let calls: quo.QuoCall[] = [];
    try {
      calls = await quo.listCallsWithParticipant(
        apiKey,
        conv.phoneNumberId,
        participant,
        10,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, conversationId: conv.id },
        "Skipping conversation during Quo backfill",
      );
      continue;
    }

    for (const call of calls) {
      const { created } = await upsertCall(company, call, ourNumbers, false);
      if (created) callsImported += 1;
      const applied = await applyTranscript(
        apiKey,
        company,
        call.id,
        ourNumbers,
      );
      if (applied) transcriptsImported += 1;
    }
  }

  return { callsImported, transcriptsImported };
}
