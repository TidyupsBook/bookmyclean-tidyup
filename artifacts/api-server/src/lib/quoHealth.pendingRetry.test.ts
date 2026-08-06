import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hourly health check must retry an owed owner text (quoNotifyPending)
 * for *every* company — including the "key no longer decryptable" branch,
 * where setQuoNeedsReauth short-circuits because the flag is already set. A
 * failed dead-key text must never be stranded just because the outage is of
 * the undecryptable-key kind.
 */

type CompanyRow = {
  id: number;
  quoNeedsReauth: boolean;
  quoNotifyPending: string | null;
};

let store: Map<number, CompanyRow>;

vi.mock("@workspace/db", () => {
  const companiesTable = {
    id: { __col: "id" },
    quoConnected: { __col: "quoConnected" },
    quoApiKeyEncrypted: { __col: "quoApiKeyEncrypted" },
    quoNeedsReauth: { __col: "quoNeedsReauth" },
    quoNotifyPending: { __col: "quoNotifyPending" },
  };
  type Cond =
    { eq: [{ __col: string }, unknown] } | { isNull: { __col: string } };
  const db = {
    select: () => ({
      from: () => ({
        // The health check's company query — return snapshots of the store.
        where: async () =>
          Array.from(store.values()).map((row) => ({
            ...row,
            quoApiKeyEncrypted: "enc",
          })),
      }),
    }),
    update: () => ({
      set: (values: Partial<CompanyRow>) => ({
        where: (cond: { and: Cond[] }) => {
          const exec = () => {
            let row: CompanyRow | undefined;
            for (const c of cond.and) {
              if ("eq" in c && c.eq[0].__col === "id") {
                row = store.get(c.eq[1] as number);
              }
            }
            if (!row) return [];
            for (const c of cond.and) {
              if ("eq" in c) {
                const col = c.eq[0].__col as keyof CompanyRow;
                if (col !== "id" && row[col] !== c.eq[1]) return [];
              } else {
                const col = c.isNull.__col as keyof CompanyRow;
                if (row[col] !== null) return [];
              }
            }
            Object.assign(row, values);
            return [{ id: row.id }];
          };
          return {
            returning: async () => exec(),
            then: (
              resolve: (rows: Array<{ id: number }>) => void,
              _reject?: unknown,
            ) => resolve(exec()),
          };
        },
      }),
    }),
  };
  return { db, companiesTable, teamMembersTable: {} };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  isNotNull: (a: unknown) => ({ isNotNull: a }),
}));

const listPhoneNumbers = vi.fn();
vi.mock("./quo", () => ({
  QuoError: class QuoError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  listPhoneNumbers: (...args: unknown[]) => listPhoneNumbers(...(args as [])),
}));

// Key present but no longer decryptable — the branch under test.
vi.mock("./secretBox", () => ({ decryptQuoKey: vi.fn(() => null) }));

const notifyOwnerQuoKeyDead = vi.fn(async (): Promise<string> => "sent");
const notifyOwnerQuoRestored = vi.fn(async (): Promise<string> => "sent");
vi.mock("./ownerNotify", () => ({
  notifyOwnerQuoKeyDead: (...args: unknown[]) =>
    notifyOwnerQuoKeyDead(...(args as [])),
  notifyOwnerQuoRestored: (...args: unknown[]) =>
    notifyOwnerQuoRestored(...(args as [])),
}));

import { runQuoHealthCheck } from "./quoHealth";

beforeEach(() => {
  store = new Map();
  notifyOwnerQuoKeyDead.mockClear();
  notifyOwnerQuoKeyDead.mockImplementation(async () => "sent");
  notifyOwnerQuoRestored.mockClear();
});

describe("runQuoHealthCheck pending-notification retry", () => {
  it("retries and clears a stranded dead-key text for an undecryptable key", async () => {
    // Earlier detection already flipped the flag, but the text failed to
    // send, leaving the pending marker set.
    store.set(1, { id: 1, quoNeedsReauth: true, quoNotifyPending: "dead" });
    await runQuoHealthCheck();
    // setQuoNeedsReauth short-circuits (flag already true), but the pending
    // retry still delivers the owed text and clears the marker.
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
    expect(store.get(1)!.quoNeedsReauth).toBe(true);
  });

  it("keeps the marker (and the flag) when the retried text fails again", async () => {
    store.set(1, { id: 1, quoNeedsReauth: true, quoNotifyPending: "dead" });
    notifyOwnerQuoKeyDead.mockImplementationOnce(async () => "failed");
    await runQuoHealthCheck();
    expect(store.get(1)!.quoNotifyPending).toBe("dead");
    expect(store.get(1)!.quoNeedsReauth).toBe(true);
    // The following hour succeeds.
    await runQuoHealthCheck();
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(2);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
  });

  it("flags and notifies on first detection of an undecryptable key", async () => {
    store.set(1, { id: 1, quoNeedsReauth: false, quoNotifyPending: null });
    await runQuoHealthCheck();
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    expect(store.get(1)!.quoNeedsReauth).toBe(true);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
  });
});
