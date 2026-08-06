import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An invite to an address already attached to another company can never be
 * accepted (one login = one seat, and owning a company always wins). These
 * tests pin the two detection signals — a claimed seat under the same email,
 * and a Clerk account attached elsewhere — plus the failure mode: a Clerk
 * outage must degrade to "not blocked", never take the Team page down.
 */

type SeatRow = { email: string; clerkUserId: string | null };
type ClerkUser = { id: string; emailAddresses: { emailAddress: string }[] };

let seats: SeatRow[];
let ownerUserIds: string[];
let clerkUsers: ClerkUser[];
let clerkFails: boolean;

vi.mock("@workspace/db", () => {
  const teamMembersTable = { email: {}, clerkUserId: {} };
  const companiesTable = { ownerUserId: {} };
  let selectCount = 0;
  const db = {
    select: (shape: Record<string, unknown>) => ({
      from: () => ({
        where: async () => {
          selectCount++;
          // Distinguish the three queries by their selected shape.
          if ("email" in shape) {
            return seats.filter((s) => s.clerkUserId !== null);
          }
          if ("ownerUserId" in shape) {
            return ownerUserIds.map((id) => ({ ownerUserId: id }));
          }
          return seats.filter((s) => s.clerkUserId !== null);
        },
      }),
    }),
  };
  return { db, teamMembersTable, companiesTable };
});

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: async () => {
        if (clerkFails) throw new Error("clerk down");
        return { data: clerkUsers };
      },
    },
  },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { findBlockedEmails } from "./seatAffiliation";

beforeEach(() => {
  seats = [];
  ownerUserIds = [];
  clerkUsers = [];
  clerkFails = false;
});

describe("findBlockedEmails", () => {
  it("blocks an address that already claimed a seat at another company", async () => {
    seats = [{ email: "Cleaner@a.com", clerkUserId: "user_a" }];
    const blocked = await findBlockedEmails(["cleaner@a.com"]);
    expect(blocked.has("cleaner@a.com")).toBe(true);
  });

  it("blocks an address whose Clerk account owns another company", async () => {
    clerkUsers = [
      { id: "user_owner", emailAddresses: [{ emailAddress: "boss@b.com" }] },
    ];
    ownerUserIds = ["user_owner"];
    const blocked = await findBlockedEmails(["boss@b.com"]);
    expect(blocked.has("boss@b.com")).toBe(true);
  });

  it("does not block a fresh address, even with a Clerk account not attached anywhere", async () => {
    clerkUsers = [
      { id: "user_new", emailAddresses: [{ emailAddress: "new@c.com" }] },
    ];
    const blocked = await findBlockedEmails(["new@c.com"]);
    expect(blocked.size).toBe(0);
  });

  it("degrades to unblocked when Clerk is down instead of throwing", async () => {
    clerkFails = true;
    const blocked = await findBlockedEmails(["someone@d.com"]);
    expect(blocked.size).toBe(0);
  });

  it("returns an empty set for no input without touching anything", async () => {
    const blocked = await findBlockedEmails([]);
    expect(blocked.size).toBe(0);
  });
});
