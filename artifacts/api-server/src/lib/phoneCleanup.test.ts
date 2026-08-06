import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The startup cleanup pass must normalize fixable numbers in place, move
 * undialable ones into the `...Rejected` columns (clearing the live column),
 * and leave already-valid rows untouched so repeat boots are no-ops.
 */

type CompanyRow = {
  id: number;
  ringThroughNumber: string | null;
  notificationNumber: string | null;
  ringThroughNumberRejected: string | null;
  notificationNumberRejected: string | null;
};

let store: Map<number, CompanyRow>;
let updateCalls: number;

vi.mock("@workspace/db", () => {
  const companiesTable = { id: { __col: "id" } };
  const db = {
    select: () => ({
      from: async () => Array.from(store.values()).map((r) => ({ ...r })),
    }),
    update: () => ({
      set: (values: Partial<CompanyRow>) => ({
        where: async (cond: { eq: [{ __col: string }, number] }) => {
          updateCalls++;
          const row = store.get(cond.eq[1]);
          if (row) Object.assign(row, values);
          return [];
        },
      }),
    }),
  };
  return { db, companiesTable };
});

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { cleanupStoredPhoneNumbers } from "./phoneCleanup";

function row(partial: Partial<CompanyRow> & { id: number }): CompanyRow {
  return {
    ringThroughNumber: null,
    notificationNumber: null,
    ringThroughNumberRejected: null,
    notificationNumberRejected: null,
    ...partial,
  };
}

beforeEach(() => {
  store = new Map();
  updateCalls = 0;
});

describe("cleanupStoredPhoneNumbers", () => {
  it("normalizes fixable numbers to E.164 in place", async () => {
    store.set(1, row({ id: 1, notificationNumber: "555-123-4567" }));
    await cleanupStoredPhoneNumbers();
    const r = store.get(1)!;
    expect(r.notificationNumber).toBe("+15551234567");
    expect(r.notificationNumberRejected).toBeNull();
  });

  it("clears undialable numbers and preserves the raw value", async () => {
    store.set(
      1,
      row({ id: 1, ringThroughNumber: "555-12", notificationNumber: "abc" }),
    );
    await cleanupStoredPhoneNumbers();
    const r = store.get(1)!;
    expect(r.ringThroughNumber).toBeNull();
    expect(r.ringThroughNumberRejected).toBe("555-12");
    expect(r.notificationNumber).toBeNull();
    expect(r.notificationNumberRejected).toBe("abc");
  });

  it("leaves already-valid and empty rows untouched (idempotent)", async () => {
    store.set(
      1,
      row({ id: 1, notificationNumber: "+15551234567", ringThroughNumber: "" }),
    );
    store.set(2, row({ id: 2 }));
    await cleanupStoredPhoneNumbers();
    expect(updateCalls).toBe(0);
    expect(store.get(1)!.notificationNumber).toBe("+15551234567");
  });

  it("handles mixed fields on one row with a single update", async () => {
    store.set(
      1,
      row({
        id: 1,
        ringThroughNumber: "(555) 987 6543",
        notificationNumber: "00000",
      }),
    );
    await cleanupStoredPhoneNumbers();
    expect(updateCalls).toBe(1);
    const r = store.get(1)!;
    expect(r.ringThroughNumber).toBe("+15559876543");
    expect(r.notificationNumber).toBeNull();
    expect(r.notificationNumberRejected).toBe("00000");
  });
});
