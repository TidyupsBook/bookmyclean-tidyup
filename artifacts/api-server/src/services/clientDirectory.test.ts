/**
 * Client directory upsert tests.
 *
 * What matters here is identity and memory: the same customer seen twice must
 * stay one row, a sighting that knows less must not erase what an earlier one
 * knew, and a Jobber id learned later must attach to the row the phone number
 * already created — because that is exactly the order things happen in (desk
 * books first, Jobber push answers with the id a moment later).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

import { db, pool, companiesTable, clientsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { recordClientContact } from "./clientDirectory";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

/** Run-unique phone digits so a crashed earlier run can't collide. */
const runDigits = `${Date.now()}`.slice(-7);
function phone(n: number) {
  return `403${runDigits}`.slice(0, 10 - 1) + `${n}`;
}

async function rows() {
  return db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.companyId, companyId));
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `cd_owner_${runId}`,
      name: `Client Directory Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = row!.id;
});

afterAll(async () => {
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("recordClientContact", () => {
  it("creates a row keyed by the normalized phone", async () => {
    await recordClientContact(companyId, {
      name: "Dana Reed",
      phone: `(${phone(1).slice(0, 3)}) ${phone(1).slice(3, 6)}-${phone(1).slice(6)}`,
      email: "dana@example.com",
      source: "booking",
    });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("Dana Reed");
    expect(all[0]!.phoneE164).toBe(`+1${phone(1)}`);
    expect(all[0]!.email).toBe("dana@example.com");
  });

  it("a second sighting of the same phone updates, never duplicates — and fills blanks without erasing", async () => {
    await recordClientContact(companyId, {
      name: "Dana Reed-Smith", // corrected spelling follows the newest sighting
      phone: phone(1), // same number, formatted differently
      email: null, // knowing less must not erase the email
      streetAddress: "12 Main St",
      city: "Calgary",
      province: "AB",
      postalCode: "T2P 1J9",
      source: "jobber",
    });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("Dana Reed-Smith");
    expect(all[0]!.email).toBe("dana@example.com");
    expect(all[0]!.streetAddress).toBe("12 Main St");
    expect(all[0]!.city).toBe("Calgary");
  });

  it("adopts a Jobber id onto the row the phone already created", async () => {
    await recordClientContact(companyId, {
      name: "Dana Reed-Smith",
      phone: phone(1),
      jobberClientId: `client_${runId}_dana`,
      source: "booking",
    });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.jobberClientId).toBe(`client_${runId}_dana`);
  });

  it("matches by Jobber id first, even when the phone changed", async () => {
    await recordClientContact(companyId, {
      name: "Dana Reed-Smith",
      phone: phone(2), // new number, same person per Jobber
      jobberClientId: `client_${runId}_dana`,
      source: "jobber",
    });
    const all = await rows();
    expect(all).toHaveLength(1);
    // The original number stays — fill, never overwrite.
    expect(all[0]!.phoneE164).toBe(`+1${phone(1)}`);
  });

  it("refuses a bare name with nothing to identify the person by", async () => {
    await recordClientContact(companyId, {
      name: "Somebody Anonymous",
      source: "booking",
    });
    const all = await rows();
    expect(all.map((c) => c.name)).not.toContain("Somebody Anonymous");
  });

  it('treats a digit-less "phone" like no phone at all', async () => {
    await recordClientContact(companyId, {
      name: "Mystery Caller",
      phone: "Unknown",
      source: "booking",
    });
    const all = await rows();
    expect(all.map((c) => c.name)).not.toContain("Mystery Caller");
  });

  it("keeps undialable numbers as typed, matched verbatim on re-sighting", async () => {
    await recordClientContact(companyId, {
      name: "Front Desk",
      phone: "ext. 4021", // not a dialable number
      source: "booking",
    });
    await recordClientContact(companyId, {
      name: "Front Desk",
      phone: "ext. 4021",
      email: "desk@example.com",
      source: "booking",
    });
    const desk = (await rows()).filter((c) => c.phone === "ext. 4021");
    expect(desk).toHaveLength(1);
    expect(desk[0]!.phoneE164).toBeNull();
    expect(desk[0]!.email).toBe("desk@example.com");
  });

  it("never throws, even on nonsense input", async () => {
    await expect(
      recordClientContact(companyId, {
        name: "   ",
        phone: phone(3),
        source: "booking",
      }),
    ).resolves.toBeUndefined();
  });

  it("scopes lookups to the company", async () => {
    const [other] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `cd_owner2_${runId}`,
        name: `Client Directory Other Co ${runId}`,
        timezone: "America/Edmonton",
      })
      .returning();
    try {
      await recordClientContact(other!.id, {
        name: "Dana In Another Company",
        phone: phone(1),
        source: "booking",
      });
      const [mine] = await db
        .select()
        .from(clientsTable)
        .where(
          and(
            eq(clientsTable.companyId, companyId),
            eq(clientsTable.phoneE164, `+1${phone(1)}`),
          ),
        );
      // The other company's sighting must not touch this company's row.
      expect(mine!.name).toBe("Dana Reed-Smith");
    } finally {
      await db
        .delete(clientsTable)
        .where(eq(clientsTable.companyId, other!.id));
      await db.delete(companiesTable).where(eq(companiesTable.id, other!.id));
    }
  });
});
