import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const syncClientByIdToQuo = vi.hoisted(() => vi.fn());
vi.mock("./quoContactSync", () => ({
  syncClientByIdToQuo,
  syncCallerByIdToQuo: vi.fn(),
}));

import {
  callersTable,
  callsTable,
  clientsTable,
  companiesTable,
  db,
  pool,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { recordClientContact } from "./clientDirectory";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `automatic_client_sync_${runId}`,
      name: `Automatic Client Sync ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;
});

afterAll(async () => {
  await db.delete(callsTable).where(eq(callsTable.companyId, companyId));
  await db.delete(callersTable).where(eq(callersTable.companyId, companyId));
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("automatic client directory Quo sync", () => {
  it("schedules Quo sync when a booking creates and later updates a client", async () => {
    await recordClientContact(companyId, {
      name: "Automatic Customer",
      phone: "780-555-0188",
      source: "booking",
    });
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.companyId, companyId));
    expect(syncClientByIdToQuo).toHaveBeenCalledWith(companyId, client!.id);

    syncClientByIdToQuo.mockClear();
    await recordClientContact(companyId, {
      name: "Automatic Customer Updated",
      phone: "780-555-0188",
      email: "customer@example.com",
      source: "jobber",
    });
    expect(syncClientByIdToQuo).toHaveBeenCalledWith(companyId, client!.id);
  });

  it("immediately relinks a matching caller discovered before the client", async () => {
    const phone = "+17805550190";
    const [call] = await db
      .insert(callsTable)
      .values({
        companyId,
        callerName: phone,
        callerPhone: phone,
        status: "completed",
        startedAt: new Date(),
        direction: "incoming",
      })
      .returning();
    const [caller] = await db
      .insert(callersTable)
      .values({
        companyId,
        phone,
        phoneE164: phone,
        bestName: phone,
        firstCallAt: new Date(),
        latestCallAt: new Date(),
        callCount: 1,
      })
      .returning();
    await db
      .update(callsTable)
      .set({ callerId: caller!.id })
      .where(eq(callsTable.id, call!.id));

    await recordClientContact(companyId, {
      name: "Newly Known Customer",
      phone,
      source: "booking",
    });

    const [client] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.phoneE164, phone));
    const [linkedCaller] = await db
      .select()
      .from(callersTable)
      .where(eq(callersTable.id, caller!.id));
    const [renamedCall] = await db
      .select()
      .from(callsTable)
      .where(eq(callsTable.id, call!.id));
    expect(linkedCaller).toMatchObject({
      clientId: client!.id,
      bestName: "Newly Known Customer",
    });
    expect(renamedCall!.callerName).toBe("Newly Known Customer");
  });
});
