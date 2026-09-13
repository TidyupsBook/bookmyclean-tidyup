/**
 * The owed-text queue: texts the app has promised somebody but may not have
 * managed to send yet.
 *
 * This generalises the quoNotifyPending pattern (see lib/company.ts): the
 * retry state lives apart from whatever state change earned the text. The
 * approval that let a cleaner in has already happened and stays happened —
 * a failed "you're in" text must not undo it, and must not be lost either.
 *
 * Delivery claims the row by deleting it (one winner under concurrency),
 * attempts the send over the platform Quo workspace, and re-inserts the row
 * on failure or skip so the hourly health check keeps retrying. Skips
 * (configuration gaps — no platform key, no owner number) are retried too:
 * they go out on their own once the configuration is fixed.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import {
  db,
  pendingTextsTable,
  companiesTable,
  activityTable,
  teamMembersTable,
  leadsTable,
  clientsTable,
  pendingTextSourceSchema,
  type Company,
  type PendingText,
  type PendingTextSource,
} from "@workspace/db";
import { sendPlatformText } from "./ownerNotify";
import { logger } from "./logger";
import { toE164 } from "./quo";

export function parsePendingTextSource(
  value: unknown,
): PendingTextSource | null {
  const parsed = pendingTextSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Record an owed text and try to send it right away. Never throws: the state
 * change that earned this text has already been committed, and a texting
 * problem must not turn it into an error for the person who caused it.
 *
 * `to` is an E.164 number, or null meaning "the company's owner", resolved at
 * send time so a text queued before the owner fixed their number still lands.
 */
export async function queueText(
  company: Company,
  input: {
    to: string | null;
    kind: string;
    content: string;
    source?: PendingTextSource;
  },
): Promise<void> {
  try {
    const [row] = await db
      .insert(pendingTextsTable)
      .values({
        companyId: company.id,
        toPhone: input.to,
        kind: input.kind,
        content: input.content,
        source: input.source,
      })
      .returning();
    await deliverPendingText(company, row!);
  } catch (err) {
    logger.error(
      { companyId: company.id, kind: input.kind, err },
      "[pendingTexts] could not queue text; it will not be sent",
    );
  }
}

/**
 * Create a text from the source record's current phone number. Future messages
 * use a correction saved by the resend flow instead of a stale value captured
 * by the caller.
 */
export async function queueTextToSource(
  company: Company,
  source: PendingTextSource,
  input: { kind: string; content: string },
): Promise<void> {
  let phone: string | null = null;
  if (source.type === "team_member") {
    const [row] = await db
      .select({ phone: teamMembersTable.phone })
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.id, source.id),
          eq(teamMembersTable.companyId, company.id),
        ),
      );
    phone = row?.phone ?? null;
  } else if (source.type === "lead") {
    const [row] = await db
      .select({
        phoneE164: leadsTable.phoneE164,
        phone: leadsTable.phoneNumber,
      })
      .from(leadsTable)
      .where(
        and(eq(leadsTable.id, source.id), eq(leadsTable.companyId, company.id)),
      );
    phone = row?.phoneE164 ?? row?.phone ?? null;
  } else {
    const [row] = await db
      .select({ phoneE164: clientsTable.phoneE164, phone: clientsTable.phone })
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.id, source.id),
          eq(clientsTable.companyId, company.id),
        ),
      );
    phone = row?.phoneE164 ?? row?.phone ?? null;
  }

  const to = phone ? toE164(phone) : null;
  if (!to) return;
  await queueText(company, { ...input, to, source });
}

/**
 * Attempt one owed text. The conditional delete is the claim: only the caller
 * that actually removed the row sends, so an overlapping retry pass can't
 * double-text anyone. Anything but "sent" puts the row back for the next pass.
 */
export async function deliverPendingText(
  company: Company,
  row: PendingText,
): Promise<void> {
  const [claimed] = await db
    .delete(pendingTextsTable)
    .where(eq(pendingTextsTable.id, row.id))
    .returning();
  if (!claimed) return;

  const outcome = await sendPlatformText(company, {
    to: claimed.toPhone,
    what: claimed.kind,
    content: claimed.content,
  });
  if (outcome === "sent") return;

  // Not delivered — put it back so the hourly sweep retries. A fresh insert
  // (new id) is fine: the claim above already guaranteed a single sender.
  await db.insert(pendingTextsTable).values({
    companyId: claimed.companyId,
    toPhone: claimed.toPhone,
    kind: claimed.kind,
    content: claimed.content,
    source: claimed.source,
    createdAt: claimed.createdAt,
  });
  logger.warn(
    { companyId: company.id, kind: claimed.kind, outcome },
    "[pendingTexts] text not delivered; kept so it is retried on the next health check",
  );
}

/**
 * How long an owed text stays worth sending. A "you're in" or "somebody's
 * waiting" text landing weeks after the fact is worse than not landing at
 * all, so the sweep gives up after this window instead of retrying forever.
 */
export const PENDING_TEXT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Owner-facing wording for a dropped text. The source row that earned the
 * text may be long gone, so this works from the queue row alone.
 */
function describeGivenUpText(row: PendingText): string {
  const who = row.toPhone ? row.toPhone : "the owner's number";
  return `Gave up on a "${row.kind.replace(/_/g, " ")}" text to ${who} after 3 days of failed sends. You may want to reach out directly.`;
}

/**
 * Retry every owed text. Called by the hourly health check. Texts older than
 * the expiry window are dropped (with a log line), not sent: whatever they
 * announced has long since stopped being news.
 */
export async function retryPendingTexts(): Promise<void> {
  const cutoff = new Date(Date.now() - PENDING_TEXT_MAX_AGE_MS);
  // Drop and announce atomically: the owner-visible activity entry is the
  // whole point of the drop, so if it can't be written the rows stay queued
  // and the next sweep tries the whole thing again.
  try {
    await db.transaction(async (tx) => {
      const expired = await tx
        .delete(pendingTextsTable)
        .where(lt(pendingTextsTable.createdAt, cutoff))
        .returning();
      for (const row of expired) {
        const source = parsePendingTextSource(row.source);
        await tx.insert(activityTable).values({
          companyId: row.companyId,
          type: "text_given_up",
          message: describeGivenUpText(row),
          // Keep everything needed to re-queue the text: the pending row is
          // gone, and the owner may want to resend once the underlying
          // problem (missing key, missing number) is fixed.
          textPayload: {
            toPhone: row.toPhone,
            kind: row.kind,
            content: row.content,
            source,
          },
        });
        logger.warn(
          {
            companyId: row.companyId,
            kind: row.kind,
            createdAt: row.createdAt,
          },
          "[pendingTexts] dropped expired text instead of sending it weeks late",
        );
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "[pendingTexts] could not drop expired texts with an activity entry; kept for the next sweep",
    );
  }

  // Only retry texts still inside the window. If the drop above failed, the
  // expired rows are still here — they must not be sent weeks late either;
  // they wait for a later sweep to drop-and-announce them.
  const rows = await db
    .select({ text: pendingTextsTable, company: companiesTable })
    .from(pendingTextsTable)
    .innerJoin(
      companiesTable,
      eq(pendingTextsTable.companyId, companiesTable.id),
    )
    .where(gte(pendingTextsTable.createdAt, cutoff))
    .orderBy(pendingTextsTable.id);
  for (const row of rows) {
    await deliverPendingText(row.company, row.text);
  }
}
