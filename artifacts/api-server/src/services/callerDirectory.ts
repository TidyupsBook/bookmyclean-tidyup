import { and, eq, ne, sql } from "drizzle-orm";
import {
  callersTable,
  clientsTable,
  callsTable,
  bookingsTable,
  db,
} from "@workspace/db";
import { toE164 } from "../lib/quo";
import { logger } from "../lib/logger";
import { syncCallerByIdToQuo } from "./quoContactSync";

const isUsefulName = (name: string | null | undefined) =>
  Boolean(name?.trim() && !/^(unknown|anonymous|n\/a)$/i.test(name.trim()));

/**
 * Keep one directory identity per dialable external number. `isNewCall` comes
 * from the call's Quo-id conflict result, so replayed webhooks never inflate
 * the aggregate.
 */
export async function recordCaller(
  companyId: number,
  input: {
    phone: string;
    name?: string | null;
    startedAt: Date;
    callId: number;
    isNewCall: boolean;
    syncContact?: boolean;
  },
): Promise<void> {
  const phone = input.phone.trim();
  const phoneE164 = toE164(phone);
  if (!phoneE164) return;
  try {
    const [client] = await db
      .select({
        id: clientsTable.id,
        name: clientsTable.name,
        quoContactId: clientsTable.quoContactId,
        quoSyncedAt: clientsTable.quoSyncedAt,
        quoSyncError: clientsTable.quoSyncError,
      })
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.companyId, companyId),
          eq(clientsTable.phoneE164, phoneE164),
        ),
      )
      .limit(1);
    // A known local client is the authoritative display name on every future
    // call; Quo's participant string is only a phone number.
    const name =
      client?.name ?? (isUsefulName(input.name) ? input.name!.trim() : phone);
    const [caller] = await db
      .insert(callersTable)
      .values({
        companyId,
        phone,
        phoneE164,
        bestName: name,
        firstCallAt: input.startedAt,
        latestCallAt: input.startedAt,
        callCount: input.isNewCall ? 1 : 0,
        clientId: client?.id ?? null,
        quoContactId: client?.quoContactId ?? null,
        quoSyncedAt: client?.quoSyncedAt ?? null,
        quoSyncError: client?.quoSyncError ?? null,
      })
      .onConflictDoUpdate({
        target: [callersTable.companyId, callersTable.phoneE164],
        set: {
          phone,
          bestName:
            client?.name ??
            (isUsefulName(input.name)
              ? input.name!.trim()
              : sql`${callersTable.bestName}`),
          firstCallAt: sql`least(${callersTable.firstCallAt}, excluded.first_call_at)`,
          latestCallAt: sql`greatest(${callersTable.latestCallAt}, excluded.latest_call_at)`,
          callCount: input.isNewCall
            ? sql`${callersTable.callCount} + 1`
            : sql`${callersTable.callCount}`,
          clientId: client?.id ?? sql`${callersTable.clientId}`,
          quoContactId:
            client?.quoContactId ?? sql`${callersTable.quoContactId}`,
          quoSyncedAt: client?.quoSyncedAt ?? sql`${callersTable.quoSyncedAt}`,
          quoSyncError:
            client?.quoSyncError ?? sql`${callersTable.quoSyncError}`,
        },
      })
      .returning({ id: callersTable.id });
    await db
      .update(callsTable)
      .set({ callerId: caller!.id, callerName: name })
      .where(
        and(
          eq(callsTable.id, input.callId),
          eq(callsTable.companyId, companyId),
        ),
      );
    if (input.syncContact !== false) {
      void syncCallerByIdToQuo(companyId, caller!.id);
    }
  } catch (err) {
    logger.warn(
      { err, companyId, callId: input.callId },
      "Caller directory update failed",
    );
  }
}

/** Rebuild derived counts/timestamps after a manual Quo repair/backfill. */
export async function rebuildCallerAggregates(
  companyId: number,
  ourNumbers: Set<string>,
): Promise<void> {
  const ownedNumbers = new Set(
    [...ourNumbers]
      .map((number) => toE164(number))
      .filter((number): number is string => Boolean(number)),
  );
  await db
    .update(callsTable)
    .set({ callerId: null })
    .where(eq(callsTable.companyId, companyId));
  await db
    .update(callersTable)
    .set({
      callCount: 0,
      firstCallAt: new Date("9999-12-31T23:59:59.999Z"),
      latestCallAt: new Date("1970-01-01T00:00:00.000Z"),
    })
    .where(eq(callersTable.companyId, companyId));
  const calls = await db
    .select({
      id: callsTable.id,
      callerPhone: callsTable.callerPhone,
      callerName: callsTable.callerName,
      startedAt: callsTable.startedAt,
      direction: callsTable.direction,
      bookingPhone: bookingsTable.customerPhone,
      bookingName: bookingsTable.customerName,
    })
    .from(callsTable)
    .leftJoin(bookingsTable, eq(callsTable.bookingId, bookingsTable.id))
    .where(
      and(eq(callsTable.companyId, companyId), eq(callsTable.isTest, false)),
    );
  for (const call of calls) {
    if (call.direction !== "incoming") continue;
    // A booking was deliberately created from this call, so its customer
    // details are a trustworthy recovery source for old "Unknown" rows.
    const recoveredPhone = toE164(call.callerPhone)
      ? call.callerPhone
      : call.bookingPhone;
    const normalizedPhone = recoveredPhone ? toE164(recoveredPhone) : null;
    if (!normalizedPhone || ownedNumbers.has(normalizedPhone)) continue;
    const recoveredName =
      isUsefulName(call.callerName) && call.callerName !== "Unknown"
        ? call.callerName
        : call.bookingName;
    if (recoveredPhone && recoveredPhone !== call.callerPhone) {
      await db
        .update(callsTable)
        .set({
          callerPhone: recoveredPhone,
          callerName: recoveredName ?? recoveredPhone,
        })
        .where(
          and(eq(callsTable.id, call.id), eq(callsTable.companyId, companyId)),
        );
    }
    await recordCaller(companyId, {
      phone: recoveredPhone!,
      name: recoveredName,
      startedAt: call.startedAt,
      callId: call.id,
      isNewCall: true,
      syncContact: false,
    });
  }
  await db
    .delete(callersTable)
    .where(
      and(eq(callersTable.companyId, companyId), eq(callersTable.callCount, 0)),
    );
  // Backfills may contain many calls for one person. Sync each rebuilt caller
  // once, sequentially, rather than launching one Quo request per call.
  const rebuiltCallers = await db
    .select({ id: callersTable.id })
    .from(callersTable)
    .where(eq(callersTable.companyId, companyId));
  for (const caller of rebuiltCallers) {
    await syncCallerByIdToQuo(companyId, caller.id);
  }
}

/** Make a newly known customer immediately visible on historical call cards. */
export async function relinkClientCallers(client: {
  id: number;
  companyId: number;
  name: string;
  phoneE164: string | null;
  quoContactId?: string | null;
  quoSyncedAt?: Date | null;
  quoSyncError?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Clear only identities on the client's previous phone. Keeping the
    // matching row intact lets its Quo contact be adopted without a gap.
    const linkedToOldPhone = and(
      eq(callersTable.companyId, client.companyId),
      eq(callersTable.clientId, client.id),
      ...(client.phoneE164
        ? [ne(callersTable.phoneE164, client.phoneE164)]
        : []),
    );
    await tx
      .update(callersTable)
      .set({
        clientId: null,
        quoContactId: null,
        quoSyncedAt: null,
        quoSyncError: null,
      })
      .where(linkedToOldPhone);
    if (!client.phoneE164) return;
    const callers = await tx
      .update(callersTable)
      .set({
        clientId: client.id,
        bestName: client.name,
        quoContactId: client.quoContactId ?? sql`${callersTable.quoContactId}`,
        quoSyncedAt: client.quoSyncedAt ?? sql`${callersTable.quoSyncedAt}`,
        quoSyncError: client.quoSyncError ?? sql`${callersTable.quoSyncError}`,
      })
      .where(
        and(
          eq(callersTable.companyId, client.companyId),
          eq(callersTable.phoneE164, client.phoneE164),
        ),
      )
      .returning({ id: callersTable.id });
    for (const caller of callers) {
      await tx
        .update(callsTable)
        .set({ callerName: client.name, callerId: caller.id })
        .where(
          and(
            eq(callsTable.companyId, client.companyId),
            eq(callsTable.callerId, caller.id),
          ),
        );
    }
  });
}
