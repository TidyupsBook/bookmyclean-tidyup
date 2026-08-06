import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * setQuoNeedsReauth must claim the healthy → needs-reauth transition with a
 * conditional UPDATE so that when the hourly health check and a webhook flag
 * the same company concurrently, exactly one caller sends the owner
 * notification — and clearing the flag re-arms it for the next outage.
 *
 * The notification itself is decoupled from the flag via quoNotifyPending:
 * the flag flips (and stays) on first detection even if the text can't be
 * delivered, and sendPendingQuoNotification retries the owed text until it
 * goes out.
 *
 * The db mock emulates Postgres's atomicity: each conditional UPDATE's
 * check-and-set happens in one synchronous step against a shared row store,
 * so concurrent claims can never both succeed — mirroring the row-level
 * guarantee the real queries rely on.
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
    quoNeedsReauth: { __col: "quoNeedsReauth" },
    quoNotifyPending: { __col: "quoNotifyPending" },
  };
  type Cond =
    { eq: [{ __col: string }, unknown] } | { isNull: { __col: string } };
  const db = {
    update: () => ({
      set: (values: Partial<CompanyRow>) => ({
        where: (cond: { and: Cond[] }) => {
          // Atomic conditional update: check + write in one step.
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
          // Like drizzle, the update is awaitable directly (marker restore)
          // or via .returning() (claim attempt).
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
    select: () => {
      throw new Error("not used in these tests");
    },
  };
  return { db, companiesTable, teamMembersTable: {} };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
}));

vi.mock("./quo", () => ({
  QuoError: class QuoError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  listPhoneNumbers: vi.fn(),
}));

vi.mock("./secretBox", () => ({ decryptQuoKey: vi.fn(() => null) }));

const notifyOwnerQuoKeyDead = vi.fn(async (): Promise<string> => "sent");
const notifyOwnerQuoRestored = vi.fn(async (): Promise<string> => "sent");
vi.mock("./ownerNotify", () => ({
  notifyOwnerQuoKeyDead: (...args: unknown[]) =>
    notifyOwnerQuoKeyDead(...(args as [])),
  notifyOwnerQuoRestored: (...args: unknown[]) =>
    notifyOwnerQuoRestored(...(args as [])),
}));

import { sendPendingQuoNotification, setQuoNeedsReauth } from "./company";
import type { Company } from "@workspace/db";

/**
 * Each caller (health check, webhook) holds its own in-memory snapshot of the
 * company row, both still believing the key is healthy — that is exactly the
 * racy situation the conditional update must resolve.
 */
const snapshot = (
  id: number,
  quoNeedsReauth = false,
  quoNotifyPending: string | null = null,
): Company => ({ id, quoNeedsReauth, quoNotifyPending }) as unknown as Company;

beforeEach(() => {
  store = new Map([
    [1, { id: 1, quoNeedsReauth: false, quoNotifyPending: null }],
  ]);
  notifyOwnerQuoKeyDead.mockClear();
  notifyOwnerQuoKeyDead.mockImplementation(async () => "sent");
  notifyOwnerQuoRestored.mockClear();
  notifyOwnerQuoRestored.mockImplementation(async () => "sent");
});

describe("setQuoNeedsReauth", () => {
  it("notifies the owner exactly once when two callers flag the same outage concurrently", async () => {
    const healthCheckView = snapshot(1);
    const webhookView = snapshot(1);
    await Promise.all([
      setQuoNeedsReauth(healthCheckView, true),
      setQuoNeedsReauth(webhookView, true),
    ]);
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    expect(store.get(1)!.quoNeedsReauth).toBe(true);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
    // Both callers' snapshots reflect the new state either way.
    expect(healthCheckView.quoNeedsReauth).toBe(true);
    expect(webhookView.quoNeedsReauth).toBe(true);
  });

  it("does not notify again on repeated flagging of an already-dead key", async () => {
    await setQuoNeedsReauth(snapshot(1), true);
    // Later hourly checks see the flag already set in the DB (and often in
    // their own snapshot too — cover both paths).
    await setQuoNeedsReauth(snapshot(1, true), true); // in-memory short-circuit
    await setQuoNeedsReauth(snapshot(1, false), true); // stale snapshot, DB claim fails
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the flag is cleared: a second outage notifies again", async () => {
    await setQuoNeedsReauth(snapshot(1), true);
    // Key fixed — flag cleared (restored notification, not a dead-key one).
    await setQuoNeedsReauth(snapshot(1, true), false);
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    expect(notifyOwnerQuoRestored).toHaveBeenCalledTimes(1);
    expect(store.get(1)!.quoNeedsReauth).toBe(false);
    // Key dies a second time.
    await setQuoNeedsReauth(snapshot(1), true);
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(2);
  });

  it("notifies the restored text exactly once when clearing the flag", async () => {
    store.get(1)!.quoNeedsReauth = true;
    await setQuoNeedsReauth(snapshot(1, true), false);
    // Repeated clears (in-memory short-circuit and stale-snapshot claim miss)
    // stay silent.
    await setQuoNeedsReauth(snapshot(1, false), false); // in-memory short-circuit
    await setQuoNeedsReauth(snapshot(1, true), false); // stale snapshot, DB claim fails
    expect(notifyOwnerQuoKeyDead).not.toHaveBeenCalled();
    expect(notifyOwnerQuoRestored).toHaveBeenCalledTimes(1);
  });

  it("keeps the flag set when the dead-key text fails, and retries via the pending marker", async () => {
    notifyOwnerQuoKeyDead.mockImplementationOnce(async () => "failed");
    await setQuoNeedsReauth(snapshot(1), true);
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    // The dashboard warning must not lie: the flag stays set even though the
    // text didn't go out — only the pending marker records the owed text.
    expect(store.get(1)!.quoNeedsReauth).toBe(true);
    expect(store.get(1)!.quoNotifyPending).toBe("dead");
    // Next hourly check: the flag transition is spent (no re-notify from
    // setQuoNeedsReauth)…
    await setQuoNeedsReauth(snapshot(1, false), true);
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    // …but the pending-marker retry delivers the text.
    await sendPendingQuoNotification(snapshot(1, true, "dead"));
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(2);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
    expect(store.get(1)!.quoNeedsReauth).toBe(true);
  });

  it("keeps the flag cleared when the back-online text fails, and retries via the pending marker", async () => {
    store.get(1)!.quoNeedsReauth = true;
    notifyOwnerQuoRestored.mockImplementationOnce(async () => "failed");
    await setQuoNeedsReauth(snapshot(1, true), false);
    expect(notifyOwnerQuoRestored).toHaveBeenCalledTimes(1);
    expect(store.get(1)!.quoNeedsReauth).toBe(false);
    expect(store.get(1)!.quoNotifyPending).toBe("restored");
    // Next healthy check retries the recovery text via the pending marker.
    await sendPendingQuoNotification(snapshot(1, false, "restored"));
    expect(notifyOwnerQuoRestored).toHaveBeenCalledTimes(2);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
    expect(store.get(1)!.quoNeedsReauth).toBe(false);
  });

  it("keeps the flag and the pending marker when the text was skipped for configuration reasons", async () => {
    // e.g. no ring-through number: the flag must stay accurate for the
    // dashboard, and the owed text survives until the configuration is fixed.
    notifyOwnerQuoKeyDead.mockImplementation(async () => "skipped");
    await setQuoNeedsReauth(snapshot(1), true);
    expect(store.get(1)!.quoNeedsReauth).toBe(true);
    expect(store.get(1)!.quoNotifyPending).toBe("dead");
    await setQuoNeedsReauth(snapshot(1, false), true); // stale snapshot, claim fails
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    // Once the configuration gap is fixed, the retry finally delivers.
    notifyOwnerQuoKeyDead.mockImplementation(async () => "sent");
    await sendPendingQuoNotification(snapshot(1, true, "dead"));
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(2);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
  });

  it("never notifies restored on routine healthy → healthy checks", async () => {
    await setQuoNeedsReauth(snapshot(1, false), false);
    await setQuoNeedsReauth(snapshot(1, false), false);
    expect(notifyOwnerQuoRestored).not.toHaveBeenCalled();
    expect(notifyOwnerQuoKeyDead).not.toHaveBeenCalled();
  });
});

describe("sendPendingQuoNotification", () => {
  it("is a no-op when nothing is pending", async () => {
    await sendPendingQuoNotification(snapshot(1, true, null));
    expect(notifyOwnerQuoKeyDead).not.toHaveBeenCalled();
    expect(notifyOwnerQuoRestored).not.toHaveBeenCalled();
  });

  it("sends at most once when two retriers race on the same pending marker", async () => {
    store.get(1)!.quoNeedsReauth = true;
    store.get(1)!.quoNotifyPending = "dead";
    await Promise.all([
      sendPendingQuoNotification(snapshot(1, true, "dead")),
      sendPendingQuoNotification(snapshot(1, true, "dead")),
    ]);
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
    expect(store.get(1)!.quoNotifyPending).toBe(null);
  });

  it("restores the marker on failure without clobbering a newer transition", async () => {
    store.get(1)!.quoNeedsReauth = true;
    store.get(1)!.quoNotifyPending = "dead";
    notifyOwnerQuoKeyDead.mockImplementationOnce(async () => {
      // While this send is in flight, the key recovers and the restored
      // transition records a newer owed text.
      store.get(1)!.quoNeedsReauth = false;
      store.get(1)!.quoNotifyPending = "restored";
      return "failed";
    });
    await sendPendingQuoNotification(snapshot(1, true, "dead"));
    // The stale "dead" marker must not overwrite the newer "restored" one.
    expect(store.get(1)!.quoNotifyPending).toBe("restored");
  });

  it("does not re-arm a stale text after a newer opposite transition already sent and cleared", async () => {
    store.get(1)!.quoNeedsReauth = true;
    store.get(1)!.quoNotifyPending = "dead";
    notifyOwnerQuoKeyDead.mockImplementationOnce(async () => {
      // While the dead text is in flight, the key recovers AND the restored
      // text goes out and clears its own marker.
      store.get(1)!.quoNeedsReauth = false;
      store.get(1)!.quoNotifyPending = null;
      return "failed";
    });
    const view = snapshot(1, true, "dead");
    await sendPendingQuoNotification(view);
    // The slot is empty but the health flag no longer matches "dead" — the
    // obsolete outage text must stay dead, or the owner would later be told
    // their healthy key is broken.
    expect(store.get(1)!.quoNotifyPending).toBe(null);
    expect(view.quoNotifyPending).toBe(null);
    // No further retry fires.
    await sendPendingQuoNotification(snapshot(1, false, null));
    expect(notifyOwnerQuoKeyDead).toHaveBeenCalledTimes(1);
  });
});
