import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const quoMocks = vi.hoisted(() => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
}));

vi.mock("../lib/company", () => ({ companyQuoKey: () => "company-key" }));
vi.mock("../lib/quo", () => ({
  toE164: (value: string) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    return digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  },
  ...quoMocks,
}));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  callersTable,
  clientsTable,
  companiesTable,
  db,
  pool,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  syncCallerByIdToQuo,
  syncContactToQuo,
  syncLeadContactToQuo,
} from "./quoContactSync";
import { relinkClientCallers } from "./callerDirectory";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `quo_sync_owner_${runId}`,
      name: `Quo Sync Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;
});

beforeEach(() => {
  quoMocks.listContacts.mockReset();
  quoMocks.createContact.mockReset();
  quoMocks.updateContact.mockReset();
});

afterAll(async () => {
  await db.delete(callersTable).where(eq(callersTable.companyId, companyId));
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("Quo contact sync", () => {
  it("does not reject the local operation when Quo is unavailable", async () => {
    quoMocks.listContacts.mockRejectedValue(new Error("Quo unavailable"));
    await expect(
      syncLeadContactToQuo({ id: companyId } as never, {
        id: 3,
        firstName: "Pat",
        lastName: "Customer",
        phone: "555-123-4567",
        email: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("creates and persists a stable Quo contact for an unknown caller", async () => {
    quoMocks.listContacts.mockResolvedValue([]);
    quoMocks.createContact.mockResolvedValue({ id: "quo-caller-1" });
    const [caller] = await db
      .insert(callersTable)
      .values({
        companyId,
        phone: "(587) 555-0137",
        phoneE164: "+15875550137",
        bestName: "(587) 555-0137",
        firstCallAt: new Date(),
        latestCallAt: new Date(),
        callCount: 1,
      })
      .returning();

    await syncCallerByIdToQuo(companyId, caller!.id);

    expect(quoMocks.createContact).toHaveBeenCalledWith(
      "company-key",
      expect.objectContaining({
        phone: "+15875550137",
        externalId: `bmc:${companyId}:caller:${caller!.id}`,
      }),
    );
    const [saved] = await db
      .select()
      .from(callersTable)
      .where(eq(callersTable.id, caller!.id));
    expect(saved!.quoContactId).toBe("quo-caller-1");
    expect(saved!.quoSyncedAt).toBeInstanceOf(Date);
    expect(saved!.quoSyncError).toBeNull();
  });

  it("claims concurrent sync attempts so a caller creates one Quo contact", async () => {
    quoMocks.listContacts.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([]), 25);
        }),
    );
    quoMocks.createContact.mockResolvedValue({ id: "quo-concurrent-caller" });
    const [caller] = await db
      .insert(callersTable)
      .values({
        companyId,
        phone: "+15875550139",
        phoneE164: "+15875550139",
        bestName: "+15875550139",
        firstCallAt: new Date(),
        latestCallAt: new Date(),
        callCount: 3,
      })
      .returning();

    await Promise.all([
      syncCallerByIdToQuo(companyId, caller!.id),
      syncCallerByIdToQuo(companyId, caller!.id),
      syncCallerByIdToQuo(companyId, caller!.id),
    ]);

    expect(quoMocks.listContacts).toHaveBeenCalledTimes(1);
    expect(quoMocks.createContact).toHaveBeenCalledTimes(1);
    const [saved] = await db
      .select()
      .from(callersTable)
      .where(eq(callersTable.id, caller!.id));
    expect(saved!.quoContactId).toBe("quo-concurrent-caller");
    expect(saved!.quoSyncError).toBeNull();
  });

  it("serializes concurrent client creation behind the persisted contact id", async () => {
    const [client] = await db
      .insert(clientsTable)
      .values({
        companyId,
        name: "Concurrent Client",
        phone: "+15875550144",
        phoneE164: "+15875550144",
        source: "booking",
      })
      .returning();
    let remoteId: string | null = null;
    quoMocks.listContacts.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(remoteId ? [{ id: remoteId }] : []), 25);
        }),
    );
    quoMocks.createContact.mockImplementation(async () => {
      remoteId = "quo-concurrent-client";
      return { id: remoteId };
    });
    quoMocks.updateContact.mockResolvedValue({ id: "quo-concurrent-client" });
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));

    await Promise.all([
      syncContactToQuo(company!, client!),
      syncContactToQuo(company!, client!),
    ]);

    expect(quoMocks.createContact).toHaveBeenCalledTimes(1);
    const [saved] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, client!.id));
    expect(saved!.quoContactId).toBe("quo-concurrent-client");
  });

  it("serializes concurrent lead lookup and creation by stable identity", async () => {
    let remoteId: string | null = null;
    quoMocks.listContacts.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(remoteId ? [{ id: remoteId }] : []), 25);
        }),
    );
    quoMocks.createContact.mockImplementation(async () => {
      remoteId = "quo-concurrent-lead";
      return { id: remoteId };
    });
    quoMocks.updateContact.mockResolvedValue({ id: "quo-concurrent-lead" });
    const lead = {
      id: 991337,
      firstName: "Concurrent",
      lastName: "Lead",
      phone: "+15875550145",
      email: null,
    };
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));

    await Promise.all([
      syncLeadContactToQuo(company!, lead),
      syncLeadContactToQuo(company!, lead),
    ]);

    expect(quoMocks.createContact).toHaveBeenCalledTimes(1);
    expect(quoMocks.updateContact).toHaveBeenCalledTimes(1);
  });

  it("separates an old caller identity when a client changes phone", async () => {
    const oldPhone = "+15875550141";
    const newPhone = "+15875550142";
    const [client] = await db
      .insert(clientsTable)
      .values({
        companyId,
        name: "Moved Customer",
        phone: newPhone,
        phoneE164: newPhone,
        source: "manual",
        quoContactId: "shared-contact",
        quoSyncedAt: new Date(),
      })
      .returning();
    const [oldCaller] = await db
      .insert(callersTable)
      .values({
        companyId,
        phone: oldPhone,
        phoneE164: oldPhone,
        bestName: "Moved Customer",
        firstCallAt: new Date(),
        latestCallAt: new Date(),
        callCount: 1,
        clientId: client!.id,
        quoContactId: "shared-contact",
        quoSyncedAt: new Date(),
      })
      .returning();

    await relinkClientCallers(client!);
    quoMocks.updateContact.mockResolvedValue({ id: "shared-contact" });
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    await syncContactToQuo(company!, client!);

    const [detached] = await db
      .select()
      .from(callersTable)
      .where(eq(callersTable.id, oldCaller!.id));
    expect(detached).toMatchObject({
      clientId: null,
      quoContactId: null,
      quoSyncedAt: null,
      quoSyncError: null,
    });
    expect(quoMocks.updateContact).toHaveBeenCalledWith(
      "company-key",
      "shared-contact",
      expect.objectContaining({ phone: newPhone }),
    );

    quoMocks.listContacts.mockResolvedValue([]);
    quoMocks.createContact.mockResolvedValue({ id: "independent-old-caller" });
    await syncCallerByIdToQuo(companyId, oldCaller!.id);
    const [resynced] = await db
      .select()
      .from(callersTable)
      .where(eq(callersTable.id, oldCaller!.id));
    expect(resynced!.quoContactId).toBe("independent-old-caller");
    expect(quoMocks.createContact).toHaveBeenCalledWith(
      "company-key",
      expect.objectContaining({ phone: oldPhone }),
    );
  });

  it("also separates the old caller when a client's phone is removed", async () => {
    const phone = "+15875550143";
    const [client] = await db
      .insert(clientsTable)
      .values({
        companyId,
        name: "No Phone Customer",
        source: "manual",
        quoContactId: "removed-phone-contact",
      })
      .returning();
    const [caller] = await db
      .insert(callersTable)
      .values({
        companyId,
        phone,
        phoneE164: phone,
        bestName: "No Phone Customer",
        firstCallAt: new Date(),
        latestCallAt: new Date(),
        callCount: 1,
        clientId: client!.id,
        quoContactId: "removed-phone-contact",
      })
      .returning();

    await relinkClientCallers(client!);

    const [detached] = await db
      .select()
      .from(callersTable)
      .where(eq(callersTable.id, caller!.id));
    expect(detached).toMatchObject({
      clientId: null,
      quoContactId: null,
      quoSyncedAt: null,
      quoSyncError: null,
    });
  });
});
