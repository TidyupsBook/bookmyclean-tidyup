import {
  callersTable,
  clientsTable,
  companiesTable,
  db,
  type Client,
  type Company,
} from "@workspace/db";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { companyQuoKey } from "../lib/company";
import { createContact, listContacts, toE164, updateContact } from "../lib/quo";
import { logger } from "../lib/logger";

/** Quo is a mirror: failure is logged and deliberately never blocks local work. */
export async function syncContactToQuo(
  company: Company,
  client: Client,
): Promise<void> {
  const key = companyQuoKey(company);
  if (!key) return;
  try {
    await db.transaction(async (tx) => {
      // Hold one durable, transaction-scoped lock across remote lookup/create.
      // A waiter re-reads the row after acquiring it and sees the saved Quo id.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${company.id}::int, hashtext(${"client:" + client.id})::int)`,
      );
      const [freshClient] = await tx
        .select()
        .from(clientsTable)
        .where(
          and(
            eq(clientsTable.id, client.id),
            eq(clientsTable.companyId, company.id),
          ),
        )
        .limit(1);
      if (!freshClient?.name.trim()) return;
      const phone = freshClient.phone ? toE164(freshClient.phone) : null;
      const [firstName, ...rest] = freshClient.name.trim().split(/\s+/);
      const externalId = `bmc:${company.id}:client:${freshClient.id}`;
      const payload = {
        firstName: firstName!,
        lastName: rest.join(" "),
        phone,
        email: freshClient.email,
        externalId,
        source: "book-my-cleaning",
      };
      const [matchingCaller] =
        !freshClient.quoContactId && freshClient.phoneE164
          ? await tx
              .select({ quoContactId: callersTable.quoContactId })
              .from(callersTable)
              .where(
                and(
                  eq(callersTable.companyId, company.id),
                  eq(callersTable.phoneE164, freshClient.phoneE164),
                  isNotNull(callersTable.quoContactId),
                ),
              )
              .orderBy(desc(callersTable.latestCallAt))
              .limit(1)
          : [];
      const knownContactId =
        freshClient.quoContactId ?? matchingCaller?.quoContactId ?? null;
      let saved;
      if (knownContactId) {
        saved = await updateContact(key, knownContactId, payload);
      } else {
        const existing = (await listContacts(key, [externalId]))[0];
        saved = existing?.id
          ? await updateContact(key, existing.id, payload)
          : await createContact(key, payload);
      }
      await tx
        .update(clientsTable)
        .set({
          quoContactId: saved.id,
          quoSyncedAt: new Date(),
          quoSyncError: null,
        })
        .where(eq(clientsTable.id, freshClient.id));
      if (phone) {
        await tx
          .update(callersTable)
          .set({
            quoContactId: saved.id,
            quoSyncedAt: new Date(),
            quoSyncError: null,
          })
          .where(
            and(
              eq(callersTable.companyId, company.id),
              eq(callersTable.phoneE164, phone),
            ),
          );
      }
    });
  } catch (err) {
    await db
      .update(clientsTable)
      .set({
        quoSyncError: (err as Error).message.slice(0, 1000),
      })
      .where(eq(clientsTable.id, client.id))
      .catch(() => {});
    const phone = client.phone ? toE164(client.phone) : null;
    if (phone) {
      await db
        .update(callersTable)
        .set({ quoSyncError: (err as Error).message.slice(0, 1000) })
        .where(
          and(
            eq(callersTable.companyId, company.id),
            eq(callersTable.phoneE164, phone),
          ),
        )
        .catch(() => {});
    }
    logger.warn({ err, companyId: company.id }, "Quo contact sync failed");
  }
}

/** Mirror a directory client discovered by bookings, Jobber, quotes, or leads. */
export async function syncClientByIdToQuo(
  companyId: number,
  clientId: number,
): Promise<void> {
  try {
    const [[company], [client]] = await Promise.all([
      db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, companyId))
        .limit(1),
      db
        .select()
        .from(clientsTable)
        .where(
          and(
            eq(clientsTable.id, clientId),
            eq(clientsTable.companyId, companyId),
          ),
        )
        .limit(1),
    ]);
    if (company && client) await syncContactToQuo(company, client);
  } catch (err) {
    logger.warn({ err, companyId, clientId }, "Quo client sync lookup failed");
  }
}

/** Mirror an unknown caller, or reuse the canonical client contact if known. */
export async function syncCallerByIdToQuo(
  companyId: number,
  callerId: number,
): Promise<void> {
  try {
    const [[company], [caller]] = await Promise.all([
      db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, companyId))
        .limit(1),
      db
        .select()
        .from(callersTable)
        .where(
          and(
            eq(callersTable.id, callerId),
            eq(callersTable.companyId, companyId),
          ),
        )
        .limit(1),
    ]);
    if (!company || !caller) return;
    // A successfully mirrored caller is unchanged by webhook replays.
    if (caller.quoContactId && caller.quoSyncedAt && !caller.quoSyncError)
      return;
    const key = companyQuoKey(company);
    if (!key) return;
    // Atomically claim this caller before any Quo lookup/create. Multiple API
    // processes and overlapping webhook deliveries may all reach this point;
    // only one may mirror the caller during the retry window.
    const attemptStartedAt = new Date();
    const retryBefore = new Date(attemptStartedAt.getTime() - 5 * 60 * 1000);
    const [claimed] = await db
      .update(callersTable)
      .set({ quoSyncedAt: attemptStartedAt, quoSyncError: null })
      .where(
        and(
          eq(callersTable.id, callerId),
          eq(callersTable.companyId, companyId),
          or(
            isNull(callersTable.quoSyncedAt),
            lt(callersTable.quoSyncedAt, retryBefore),
          ),
        ),
      )
      .returning({ id: callersTable.id });
    if (!claimed) return;
    if (caller.clientId) {
      await syncClientByIdToQuo(companyId, caller.clientId);
      return;
    }
    const phone = toE164(caller.phone);
    const name = caller.bestName.trim();
    if (!key || !phone || !name) return;
    const [firstName, ...rest] = name.split(/\s+/);
    const externalId = `bmc:${company.id}:caller:${caller.id}`;
    const payload = {
      firstName: firstName!,
      lastName: rest.join(" "),
      phone,
      email: null,
      externalId,
      source: "book-my-cleaning",
    };
    let saved;
    if (caller.quoContactId) {
      saved = await updateContact(key, caller.quoContactId, payload);
    } else {
      const existing = (await listContacts(key, [externalId]))[0];
      saved = existing?.id
        ? await updateContact(key, existing.id, payload)
        : await createContact(key, payload);
    }
    await db
      .update(callersTable)
      .set({
        quoContactId: saved.id,
        quoSyncedAt: new Date(),
        quoSyncError: null,
      })
      .where(eq(callersTable.id, caller.id));
  } catch (err) {
    await db
      .update(callersTable)
      .set({ quoSyncError: (err as Error).message.slice(0, 1000) })
      .where(
        and(
          eq(callersTable.id, callerId),
          eq(callersTable.companyId, companyId),
        ),
      )
      .catch(() => {});
    logger.warn({ err, companyId, callerId }, "Quo caller sync failed");
  }
}

/** Leads have no Quo id column, but still mirror safely by stable external id. */
export async function syncLeadContactToQuo(
  company: Company,
  lead: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
  },
): Promise<void> {
  const key = companyQuoKey(company);
  const phone = lead.phone ? toE164(lead.phone) : null;
  const firstName = lead.firstName?.trim();
  if (!key || !phone || !firstName) return;
  const payload = {
    firstName,
    lastName: lead.lastName?.trim() ?? "",
    phone,
    email: lead.email,
    externalId: `bmc:${company.id}:lead:${lead.id}`,
    source: "book-my-cleaning",
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${company.id}::int, hashtext(${"lead:" + lead.id})::int)`,
      );
      const existing = (await listContacts(key, [payload.externalId]))[0];
      if (existing?.id) await updateContact(key, existing.id, payload);
      else await createContact(key, payload);
    });
  } catch (err) {
    logger.warn(
      { err, companyId: company.id, leadId: lead.id },
      "Quo lead contact sync failed",
    );
  }
}
