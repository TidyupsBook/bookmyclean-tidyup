/**
 * Jobber calendar pull tests.
 *
 * The Jobber API itself is stubbed; what's being proved here is the part that
 * can quietly ruin an owner's day — that the import only ever touches rows it
 * created, that a moved address drops its old pin, that a visit disappearing
 * from Jobber cancels rather than deletes, that the switch from job-keyed to
 * visit-keyed rows adopts the old rows instead of duplicating them, and that
 * Jobber's assignees land on the right roster members (or on nobody, never on
 * the wrong somebody).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

const graphqlMock = vi.fn();
vi.mock("../lib/jobber", () => ({
  getValidAccessToken: vi.fn(async () => "test-token"),
  getValidConnectionToken: vi.fn(async () => "test-token"),
  jobberGraphql: (...args: unknown[]) => graphqlMock(...args),
}));

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  bookingAssignmentsTable,
  bookingTimeEntriesTable,
  teamMembersTable,
  jobberConnectionsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  syncCompanyCalendar,
  startJobberCalendarSync,
  formatJobberAddress,
  jobberCustomerName,
  jobberDurationMinutes,
  normalizeStaffName,
  matchAssigneesToRoster,
  resolveAssigneesToRoster,
  type JobberCalendarVisit,
} from "./jobberCalendarSync";

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;
/** Roster ids by the name they were created with. */
const roster: Record<string, number> = {};

function visit(
  n: number,
  over: Partial<JobberCalendarVisit> = {},
): JobberCalendarVisit {
  return {
    id: `visit_${runId}_${n}`,
    title: "Move-out clean",
    startAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    endAt: new Date(
      Date.now() + 3 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
    ).toISOString(),
    completedAt: null,
    assignedUsers: { nodes: [] },
    job: {
      id: `job_${runId}_${n}`,
      client: {
        id: `client_${runId}_${n}`,
        firstName: "Dana",
        lastName: "Reed",
        phone: "+15550001234",
      },
      property: {
        address: {
          street: "12 Main St",
          city: "Calgary",
          province: "AB",
          postalCode: "T2P 1J9",
        },
      },
    },
    ...over,
  };
}

function assignee(name: string) {
  return { id: `user_${name}`, name: { full: name } };
}

/** Make the stubbed Jobber account return exactly these visits, one page. */
function respondWith(visits: JobberCalendarVisit[]): void {
  graphqlMock.mockReset();
  graphqlMock.mockResolvedValue({
    visits: {
      nodes: visits,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
}

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function importedByVisit(jobberVisitId: string) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.jobberVisitId, jobberVisitId));
  return row;
}

async function crewOf(bookingId: number): Promise<number[]> {
  const rows = await db
    .select({ teamMemberId: bookingAssignmentsTable.teamMemberId })
    .from(bookingAssignmentsTable)
    .where(eq(bookingAssignmentsTable.bookingId, bookingId));
  return rows.map((r) => r.teamMemberId).sort((a, b) => a - b);
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jcs_owner_${runId}`,
      name: `Jobber Sync Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;

  // The real roster this matcher was built against, decorations and all.
  const names = [
    "Sergine",
    "Jen & Bryan",
    "Joseph",
    "Joseph Juma",
    "Joel Djankam",
    "Richard",
    "Richard “BOSS”",
  ];
  for (const name of names) {
    const [member] = await db
      .insert(teamMembersTable)
      .values({ companyId, name, role: "cleaner", active: true })
      .returning();
    roster[name] = member!.id;
  }
  const [inactive] = await db
    .insert(teamMembersTable)
    .values({ companyId, name: "Parker Bench", role: "cleaner", active: false })
    .returning();
  roster["Parker Bench"] = inactive!.id;
});

afterAll(async () => {
  // Assignments and time entries cascade with their bookings.
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db
    .delete(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId));
  await db
    .delete(jobberConnectionsTable)
    .where(eq(jobberConnectionsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("field mapping", () => {
  it("builds a one-line address a geocoder can use", () => {
    expect(formatJobberAddress(visit(1))).toBe(
      "12 Main St, Calgary, AB T2P 1J9",
    );
  });

  it("returns no address rather than an empty string", () => {
    expect(formatJobberAddress(visit(1, { job: null }))).toBeNull();
    expect(
      formatJobberAddress(
        visit(1, {
          job: {
            id: `job_${runId}_1`,
            client: null,
            property: {
              address: {
                street: null,
                city: null,
                province: null,
                postalCode: null,
              },
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("falls back to the visit title when there's no client on the job", () => {
    expect(jobberCustomerName(visit(1, { job: null }))).toBe("Move-out clean");
    expect(jobberCustomerName(visit(1, { job: null, title: null }))).toBe(
      "Jobber visit",
    );
  });

  it("reads the visit length from start and end", () => {
    expect(jobberDurationMinutes(visit(1))).toBe(120);
    expect(jobberDurationMinutes(visit(1, { endAt: null }))).toBeNull();
    // An end before the start is nonsense, not a negative duration.
    expect(
      jobberDurationMinutes(
        visit(1, {
          endAt: "2020-01-01T00:00:00Z",
          startAt: "2030-01-01T00:00:00Z",
        }),
      ),
    ).toBeNull();
  });
});

describe("matching Jobber staff to the roster", () => {
  const realRoster = [
    { id: 1, name: "Richard “BOSS”" },
    { id: 2, name: "Joseph" },
    { id: 3, name: "joe" },
    { id: 4, name: "Richard" },
    { id: 5, name: "Sergine" },
    { id: 6, name: "Cindy" },
    { id: 7, name: "Jasmin" },
    { id: 8, name: "Jen & Bryan" },
    { id: 9, name: "Joseph Juma" },
    { id: 10, name: "Joel Djankam" },
    { id: 11, name: "Melissa Clarke" },
    { id: 12, name: "Stacey Whitty" },
  ];

  it("folds decorations, digits and accents out of a name", () => {
    expect(normalizeStaffName("Richard “BOSS”")).toBe("richard boss");
    expect(normalizeStaffName("1 Joseph Juma")).toBe("joseph juma");
    expect(normalizeStaffName("Sergine Ngongang wétie")).toBe(
      "sergine ngongang wetie",
    );
    expect(normalizeStaffName("Jen & Bryan")).toBe("jen bryan");
  });

  it("prefers an exact name over a shared first name", () => {
    // "1 Joseph Juma" must land on Joseph Juma, never on plain Joseph.
    expect(
      matchAssigneesToRoster(["1 Joseph Juma"], realRoster).matchedIds,
    ).toEqual([9]);
  });

  it("matches a roster short-name as a prefix of Jobber's full name", () => {
    const { matchedIds, unmatched } = matchAssigneesToRoster(
      ["Sergine Ngongang wetie", "Jen & Bryan Cabugon", "Richard Tanguay"],
      realRoster,
    );
    // Richard Tanguay is plain "Richard" — “BOSS” doesn't prefix his name.
    expect(matchedIds.sort((a, b) => a - b)).toEqual([4, 5, 8]);
    expect(unmatched).toEqual([]);
  });

  it("falls back to the first name when the surname is spelled differently", () => {
    expect(
      matchAssigneesToRoster(["Joel MBATCHOU"], realRoster).matchedIds,
    ).toEqual([10]);
  });

  it("refuses an ambiguous first name rather than guessing", () => {
    const twins = [
      { id: 21, name: "Melissa Clarke" },
      { id: 22, name: "Melissa Smith" },
    ];
    const { matchedIds, unmatched } = matchAssigneesToRoster(
      ["Melissa Jones"],
      twins,
    );
    expect(matchedIds).toEqual([]);
    expect(unmatched).toEqual(["Melissa Jones"]);
  });

  it("reports a stranger once, not once per visit", () => {
    const { matchedIds, unmatched } = matchAssigneesToRoster(
      ["Taylor New", "Taylor New", "Sergine Ngongang wetie"],
      realRoster,
    );
    expect(matchedIds).toEqual([5]);
    expect(unmatched).toEqual(["Taylor New"]);
  });
});

describe("resolving assignees by stored link", () => {
  const member = (id: number, name: string, jobberUserId: string | null) => ({
    id,
    name,
    jobberUserId,
  });

  it("a stored link beats an exact name match on somebody else", () => {
    // Jobber user usr_joel is NAMED like member 2 — but he IS member 1.
    const [r] = resolveAssigneesToRoster(
      [{ id: "usr_joel", name: "Joel Mbatchou" }],
      [member(1, "Joel Djankam", "usr_joel"), member(2, "Joel Mbatchou", null)],
    );
    expect(r).toMatchObject({ teamMemberId: 1, via: "link" });
  });

  it("a linked member's name never grabs a different Jobber user", () => {
    // Melissa Clarke is spoken for, so this OTHER Melissa's first-name tier
    // sees only Melissa Smith — one candidate, unambiguous.
    const [r] = resolveAssigneesToRoster(
      [{ id: "usr_other_mel", name: "Melissa Jones" }],
      [
        member(1, "Melissa Clarke", "usr_mel"),
        member(2, "Melissa Smith", null),
      ],
    );
    expect(r).toMatchObject({ teamMemberId: 2, via: "name" });
  });

  it("an ambiguous first name still matches nobody", () => {
    const [r] = resolveAssigneesToRoster(
      [{ id: "usr_x", name: "Melissa Jones" }],
      [member(1, "Melissa Clarke", null), member(2, "Melissa Smith", null)],
    );
    expect(r).toMatchObject({ teamMemberId: null, via: null });
  });

  it("two Jobber users sharing a name match nobody — and nothing is adopted", () => {
    // Two different people both called Alex in Jobber, one Alex seat here:
    // the name proves nothing about which of them she is. Neither may take
    // the seat, or the arbitrary winner becomes a durable (wrong) link.
    const rs = resolveAssigneesToRoster(
      [
        { id: "usr_alex_a", name: "Alex Chen" },
        { id: "usr_alex_b", name: "Alex Barnes" },
      ],
      [member(1, "Alex", null)],
    );
    expect(rs.map((r) => r.teamMemberId)).toEqual([null, null]);
    expect(rs.map((r) => r.via)).toEqual([null, null]);
  });

  it("the same Jobber user appearing twice is one person, not a collision", () => {
    const rs = resolveAssigneesToRoster(
      [
        { id: "usr_alex_a", name: "Alex Chen" },
        { id: "usr_alex_a", name: "Alex Chen" },
      ],
      [member(1, "Alex", null)],
    );
    expect(rs.map((r) => r.teamMemberId)).toEqual([1, 1]);
  });

  it("unlinking restores the name fallback", () => {
    const assignee = [{ id: "usr_new", name: "Joel Mbatchou" }];
    // While Joel's seat is linked to a DIFFERENT Jobber user, usr_new gets
    // nobody: the seat's identity is already settled.
    const [linked] = resolveAssigneesToRoster(assignee, [
      member(1, "Joel Djankam", "usr_old"),
    ]);
    expect(linked).toMatchObject({ teamMemberId: null, via: null });
    // Unlink the seat and the same name matches again.
    const [unlinked] = resolveAssigneesToRoster(assignee, [
      member(1, "Joel Djankam", null),
    ]);
    expect(unlinked).toMatchObject({ teamMemberId: 1, via: "name" });
  });
});

describe("syncCompanyCalendar", () => {
  it("imports a visit, colours it by the matched cleaner, then updates instead of duplicating", async () => {
    respondWith([
      visit(1, {
        assignedUsers: { nodes: [assignee("Sergine Ngongang wetie")] },
      }),
    ]);
    const first = await syncCompanyCalendar(await company());
    expect(first.imported).toBe(1);
    expect(first.updated).toBe(0);

    const booking = await importedByVisit(`visit_${runId}_1`);
    expect(booking).toBeTruthy();
    expect(booking!.customerName).toBe("Dana Reed");
    expect(booking!.customerAddress).toBe("12 Main St, Calgary, AB T2P 1J9");
    expect(booking!.status).toBe("confirmed");
    expect(booking!.durationMinutes).toBe(120);
    expect(booking!.jobberSyncedJobId).toBe(`job_${runId}_1`);
    expect(await crewOf(booking!.id)).toEqual([roster["Sergine"]!]);

    // Jobber reassigns the visit: the crew here follows it exactly.
    respondWith([
      visit(1, {
        title: "Deep clean",
        assignedUsers: {
          nodes: [assignee("Jen & Bryan Cabugon"), assignee("1 Joseph Juma")],
        },
      }),
    ]);
    const second = await syncCompanyCalendar(await company());
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);

    const all = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.jobberVisitId, `visit_${runId}_1`));
    expect(all).toHaveLength(1);
    expect(all[0]!.service).toBe("Deep clean");
    expect(await crewOf(all[0]!.id)).toEqual(
      [roster["Jen & Bryan"]!, roster["Joseph Juma"]!].sort((a, b) => a - b),
    );
  });

  it("leaves a hand-picked crew alone when Jobber names nobody usable", async () => {
    const booking = (await importedByVisit(`visit_${runId}_1`))!;

    // Nobody assigned in Jobber: whatever crew is on the row stays.
    respondWith([visit(1, { title: "Deep clean" })]);
    await syncCompanyCalendar(await company());
    expect(await crewOf(booking.id)).toEqual(
      [roster["Jen & Bryan"]!, roster["Joseph Juma"]!].sort((a, b) => a - b),
    );

    // A stranger and an inactive member are both unusable — still no change.
    respondWith([
      visit(1, {
        title: "Deep clean",
        assignedUsers: {
          nodes: [assignee("Totally Unknown"), assignee("Parker Bench")],
        },
      }),
    ]);
    await syncCompanyCalendar(await company());
    expect(await crewOf(booking.id)).toEqual(
      [roster["Jen & Bryan"]!, roster["Joseph Juma"]!].sort((a, b) => a - b),
    );
  });

  it("drops the old pin when the address moves", async () => {
    await db
      .update(bookingsTable)
      .set({ lat: 51.04, lng: -114.07, geocodedAt: new Date() })
      .where(eq(bookingsTable.jobberVisitId, `visit_${runId}_1`));

    respondWith([
      visit(1, {
        job: {
          id: `job_${runId}_1`,
          client: {
            id: `client_${runId}_1`,
            firstName: "Dana",
            lastName: "Reed",
            phone: "+15550001234",
          },
          property: {
            address: {
              street: "99 Elsewhere Ave",
              city: "Calgary",
              province: "AB",
              postalCode: "T2P 1J9",
            },
          },
        },
      }),
    ]);
    await syncCompanyCalendar(await company());

    const booking = await importedByVisit(`visit_${runId}_1`);
    expect(booking!.customerAddress).toContain("99 Elsewhere Ave");
    // Stale coordinates would send the crew to the previous house.
    expect(booking!.lat).toBeNull();
    expect(booking!.lng).toBeNull();
    expect(booking!.geocodedAt).toBeNull();
  });

  it("skips a visit Jobber hasn't scheduled", async () => {
    // The already-imported visit rides along, otherwise the cancellation
    // sweep would (correctly) decide it had left Jobber.
    respondWith([visit(1), visit(9, { startAt: null })]);
    const result = await syncCompanyCalendar(await company());
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await importedByVisit(`visit_${runId}_9`)).toBeUndefined();
  });

  it("adopts the job-keyed row a recurring client left behind, hours and all", async () => {
    // What the old job-keyed sync left: one row for the whole job, with a
    // clocked stretch attached to it.
    const [legacy] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        callId: null,
        customerName: "Legacy Client",
        customerPhone: "+15551110000",
        customerAddress: `88 Legacy Way ${runId}, Calgary, AB`,
        service: "Recurring clean",
        scheduledFor: new Date(Date.now() + 24 * 3600 * 1000),
        status: "confirmed",
        jobberSynced: true,
        jobberSyncedJobId: `job_${runId}_5`,
      })
      .returning();
    const [entry] = await db
      .insert(bookingTimeEntriesTable)
      .values({
        companyId,
        bookingId: legacy!.id,
        teamMemberId: null,
        startedAt: new Date(Date.now() - 3 * 3600 * 1000),
        endedAt: new Date(Date.now() - 1 * 3600 * 1000),
      })
      .returning();

    // The same job now shows up as two visits.
    const early = visit(51, {
      startAt: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      endAt: new Date(
        Date.now() + 5 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
      ).toISOString(),
    });
    early.job!.id = `job_${runId}_5`;
    const late = visit(52, {
      startAt: new Date(Date.now() + 12 * 24 * 3600 * 1000).toISOString(),
      endAt: new Date(
        Date.now() + 12 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
      ).toISOString(),
    });
    late.job!.id = `job_${runId}_5`;

    respondWith([visit(1), early, late]);
    const result = await syncCompanyCalendar(await company());
    expect(result.imported).toBe(1); // only the late visit is a new row

    // The earliest visit claimed the legacy row rather than duplicating it.
    const adopted = await importedByVisit(`visit_${runId}_51`);
    expect(adopted!.id).toBe(legacy!.id);
    const [heldEntry] = await db
      .select()
      .from(bookingTimeEntriesTable)
      .where(eq(bookingTimeEntriesTable.id, entry!.id));
    expect(heldEntry!.bookingId).toBe(legacy!.id);

    const jobRows = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, companyId),
          eq(bookingsTable.jobberSyncedJobId, `job_${runId}_5`),
        ),
      );
    expect(jobRows).toHaveLength(2);
  });

  it("cancels a job-era leftover once no visit is left to claim it", async () => {
    await db.insert(bookingsTable).values({
      companyId,
      callId: null,
      customerName: "Gone Client",
      customerPhone: "+15552220000",
      customerAddress: `9 Vanished Ct ${runId}, Calgary, AB`,
      service: "One-time clean",
      scheduledFor: new Date(Date.now() + 48 * 3600 * 1000),
      status: "confirmed",
      jobberSynced: true,
      jobberSyncedJobId: `job_${runId}_6`,
    });

    // A complete pull that knows nothing of job 6 — but still contains the
    // visits from the adoption test, which must not get swept as collateral.
    const early = visit(51, {
      startAt: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
    });
    early.job!.id = `job_${runId}_5`;
    const late = visit(52, {
      startAt: new Date(Date.now() + 12 * 24 * 3600 * 1000).toISOString(),
    });
    late.job!.id = `job_${runId}_5`;
    respondWith([visit(1), early, late]);
    await syncCompanyCalendar(await company());

    const [leftover] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.jobberSyncedJobId, `job_${runId}_6`));
    expect(leftover!.status).toBe("canceled");
    expect((await importedByVisit(`visit_${runId}_51`))!.status).toBe(
      "confirmed",
    );
  });

  it("cancels an imported visit that left Jobber, and never a local booking", async () => {
    const [local] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        callId: null,
        customerName: "Booked by phone",
        customerPhone: "+15559998888",
        customerAddress: "3 Local Rd",
        service: "Standard clean",
        scheduledFor: new Date(Date.now() + 2 * 24 * 3600 * 1000),
        status: "confirmed",
      })
      .returning();

    // Jobber now reports no visits at all in the window.
    respondWith([]);
    const result = await syncCompanyCalendar(await company());
    expect(result.canceled).toBeGreaterThanOrEqual(1);

    expect((await importedByVisit(`visit_${runId}_1`))!.status).toBe(
      "canceled",
    );
    const [untouched] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, local!.id));
    expect(untouched!.status).toBe("confirmed");

    await db
      .delete(bookingsTable)
      .where(inArray(bookingsTable.id, [local!.id]));
  });

  it("only cancels visits from the Jobber account being reconciled", async () => {
    const [accountA] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId,
        accountId: `account-a-${runId}`,
        accountName: "Account A",
        accessToken: "enc",
        refreshToken: "enc",
      })
      .returning();
    const [accountB] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId,
        accountId: `account-b-${runId}`,
        accountName: "Account B",
        accessToken: "enc",
        refreshToken: "enc",
      })
      .returning();

    const fromA = visit(801);
    const fromB = visit(802);
    respondWith([fromA]);
    await syncCompanyCalendar(await company(), accountA!);
    respondWith([fromB]);
    await syncCompanyCalendar(await company(), accountB!);

    // Account A has now removed its visit, but Account B has not.
    respondWith([]);
    await syncCompanyCalendar(await company(), accountA!);

    expect((await importedByVisit(fromA.id))!.status).toBe("canceled");
    const retained = await importedByVisit(fromB.id);
    expect(retained!.status).toBe("confirmed");
    expect(retained!.jobberConnectionId).toBe(accountB!.id);
  });

  it("still syncs a named connection when the legacy company grant is stale", async () => {
    const [connection] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId,
        accountId: `healthy-${runId}`,
        accountName: "Healthy secondary",
        accessToken: "enc",
        refreshToken: "enc",
      })
      .returning();

    respondWith([visit(803)]);
    const result = await syncCompanyCalendar(
      { ...(await company()), jobberNeedsReauth: true },
      connection!,
    );

    expect(result.imported).toBe(1);
    expect((await importedByVisit(`visit_${runId}_803`))!.status).toBe(
      "confirmed",
    );
  });

  it("claims and reconciles legacy rows only for their matching primary account", async () => {
    const accountId = `legacy-primary-${runId}`;
    const [connection] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId,
        accountId,
        accountName: "Reconnected legacy primary",
        accessToken: "enc",
        refreshToken: "enc",
        isPrimary: true,
      })
      .returning();
    await db
      .update(companiesTable)
      .set({ jobberAccountId: accountId })
      .where(eq(companiesTable.id, companyId));

    const legacyVisit = visit(804);
    await db.insert(bookingsTable).values({
      companyId,
      callId: null,
      customerName: "Legacy imported customer",
      customerPhone: "+15550002222",
      service: "Legacy imported clean",
      scheduledFor: new Date(legacyVisit.startAt!),
      status: "confirmed",
      jobberSynced: true,
      jobberVisitId: legacyVisit.id,
      jobberSyncedJobId: legacyVisit.job!.id,
    });

    respondWith([legacyVisit]);
    await syncCompanyCalendar(await company(), connection!);
    expect((await importedByVisit(legacyVisit.id))!.jobberConnectionId).toBe(
      connection!.id,
    );

    // Once claimed, the matching primary's complete pull can safely reconcile
    // it. A new secondary can never reach this legacy source path.
    respondWith([]);
    await syncCompanyCalendar(await company(), connection!);
    expect((await importedByVisit(legacyVisit.id))!.status).toBe("canceled");
  });

  it("brings a cancelled visit back when it reappears in Jobber", async () => {
    respondWith([visit(1)]);
    await syncCompanyCalendar(await company());
    expect((await importedByVisit(`visit_${runId}_1`))!.status).toBe(
      "confirmed",
    );
  });

  it("keeps a finished job finished", async () => {
    await db
      .update(bookingsTable)
      .set({ status: "completed" })
      .where(eq(bookingsTable.jobberVisitId, `visit_${runId}_1`));
    respondWith([visit(1)]);
    await syncCompanyCalendar(await company());
    expect((await importedByVisit(`visit_${runId}_1`))!.status).toBe(
      "completed",
    );
  });

  it("never cancels off a pull that came back incomplete", async () => {
    // Jobber hands back a first page promising more, then a page with no
    // payload. We've seen none of the real inventory, so "missing from the
    // pull" cannot mean "cancelled in Jobber" — the window spans months and
    // getting this wrong would wipe the calendar.
    graphqlMock.mockReset();
    graphqlMock
      .mockResolvedValueOnce({
        visits: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
        },
      })
      .mockResolvedValueOnce({ visits: null });

    const result = await syncCompanyCalendar(await company());

    expect(result.canceled).toBe(0);
    expect((await importedByVisit(`visit_${runId}_1`))!.status).not.toBe(
      "canceled",
    );
  });

  it("does nothing when Jobber access needs reconnecting", async () => {
    graphqlMock.mockReset();
    const disconnected = { ...(await company()), jobberNeedsReauth: true };
    const result = await syncCompanyCalendar(disconnected);
    expect(result.imported).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("skips a visit that arrives without its parent job", async () => {
    // No job id means clocked hours could never be tied back to the row —
    // and a payload that half-formed is nothing to key a calendar row on.
    respondWith([visit(70, { job: null })]);
    const result = await syncCompanyCalendar(await company());
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await importedByVisit(`visit_${runId}_70`)).toBeUndefined();
  });

  it("leaves a row alone when its visit comes back malformed", async () => {
    respondWith([visit(71)]);
    await syncCompanyCalendar(await company());
    expect((await importedByVisit(`visit_${runId}_71`))!.status).toBe(
      "confirmed",
    );

    // Same visit id, but the payload lost its job. The row is neither
    // rewritten nor — because every id Jobber returned counts as seen —
    // cancelled by the sweep.
    respondWith([visit(71, { job: null })]);
    const result = await syncCompanyCalendar(await company());
    expect(result.skipped).toBe(1);
    expect((await importedByVisit(`visit_${runId}_71`))!.status).toBe(
      "confirmed",
    );
  });

  it("refuses a second row for the same visit at the database", async () => {
    // The sync's row-exists check can be raced by a second sync process
    // (rolling deploys run two at once); the partial unique index is the
    // backstop that turns that race into a no-op instead of a double chip.
    const dupe = {
      companyId,
      customerName: "Dupe Guard",
      customerPhone: "+15550009999",
      service: "Backstop clean",
      scheduledFor: new Date(),
      status: "confirmed",
      jobberVisitId: `visit_${runId}_dupe`,
      jobberConnectionId: 9_999_999,
    };
    await db.insert(bookingsTable).values(dupe);
    await expect(db.insert(bookingsTable).values(dupe)).rejects.toThrow();

    const legacyDupe = {
      ...dupe,
      jobberVisitId: `visit_${runId}_legacy_dupe`,
      jobberConnectionId: null,
    };
    await db.insert(bookingsTable).values(legacyDupe);
    await expect(db.insert(bookingsTable).values(legacyDupe)).rejects.toThrow();
  });

  describe("Jobber-completed visits", () => {
    it("imports a visit Jobber already finished as completed", async () => {
      respondWith([visit(80, { completedAt: new Date().toISOString() })]);
      await syncCompanyCalendar(await company());
      expect((await importedByVisit(`visit_${runId}_80`))!.status).toBe(
        "completed",
      );
    });

    it("marks the job done when Jobber finishes it later, and never reopens it", async () => {
      respondWith([visit(81)]);
      await syncCompanyCalendar(await company());
      expect((await importedByVisit(`visit_${runId}_81`))!.status).toBe(
        "confirmed",
      );

      respondWith([visit(81, { completedAt: new Date().toISOString() })]);
      await syncCompanyCalendar(await company());
      expect((await importedByVisit(`visit_${runId}_81`))!.status).toBe(
        "completed",
      );

      // Jobber "un-completing" a visit must not quietly reopen it here.
      respondWith([visit(81, { completedAt: null })]);
      await syncCompanyCalendar(await company());
      expect((await importedByVisit(`visit_${runId}_81`))!.status).toBe(
        "completed",
      );
    });

    it("keeps a completed job on the books when Jobber later omits it", async () => {
      // Archived or deleted in Jobber after the fact — the work still
      // happened. The cancellation sweep must never rewrite completed
      // history (or this month's revenue) to "canceled".
      respondWith([visit(82, { completedAt: new Date().toISOString() })]);
      await syncCompanyCalendar(await company());
      expect((await importedByVisit(`visit_${runId}_82`))!.status).toBe(
        "completed",
      );

      // A complete, non-empty pull that no longer mentions visit 82.
      respondWith([visit(83)]);
      await syncCompanyCalendar(await company());
      expect((await importedByVisit(`visit_${runId}_82`))!.status).toBe(
        "completed",
      );
      expect((await importedByVisit(`visit_${runId}_83`))!.status).toBe(
        "confirmed",
      );
    });
  });
});

describe("assignment sync by stored link", () => {
  it("keeps a name match provisional until the owner confirms the link", async () => {
    const [priya] = await db
      .insert(teamMembersTable)
      .values({ companyId, name: "Priya Kaur", role: "cleaner", active: true })
      .returning();
    const jobberUserId = `user_priya_${runId}`;

    // First sight: matched by name (roster "Priya Kaur" prefixes Jobber's
    // full name), but the sync must not create a durable link.
    respondWith([
      visit(40, {
        assignedUsers: {
          nodes: [{ id: jobberUserId, name: { full: "Priya Kaur Gill" } }],
        },
      }),
    ]);
    await syncCompanyCalendar(await company());
    const booking = await importedByVisit(`visit_${runId}_40`);
    expect(await crewOf(booking!.id)).toEqual([priya!.id]);
    const [beforeConfirmation] = await db
      .select({ jobberUserId: teamMembersTable.jobberUserId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, priya!.id));
    expect(beforeConfirmation!.jobberUserId).toBeNull();

    // The owner confirms the suggested match from the Team page. Both sides
    // can then rename without breaking the assignment.
    await db
      .update(teamMembersTable)
      .set({ jobberUserId })
      .where(eq(teamMembersTable.id, priya!.id));
    await db
      .update(teamMembersTable)
      .set({ name: "P. Kaur-Gill (Team Lead)" })
      .where(eq(teamMembersTable.id, priya!.id));
    respondWith([
      visit(40, {
        assignedUsers: {
          nodes: [{ id: jobberUserId, name: { full: "Preethi Gill" } }],
        },
      }),
    ]);
    await syncCompanyCalendar(await company());
    expect(await crewOf(booking!.id)).toEqual([priya!.id]);
  });

  it("two same-named Jobber users on different visits never grab one seat or a link", async () => {
    const [avery] = await db
      .insert(teamMembersTable)
      .values({ companyId, name: "Avery", role: "cleaner", active: true })
      .returning();

    // The collision spans visits: each visit alone looks unambiguous, only
    // the run as a whole can see there are two Averys. Neither may colour a
    // booking or be adopted as Avery's link.
    respondWith([
      visit(45, {
        assignedUsers: {
          nodes: [
            { id: `user_avery_a_${runId}`, name: { full: "Avery Stone" } },
          ],
        },
      }),
      visit(46, {
        assignedUsers: {
          nodes: [
            { id: `user_avery_b_${runId}`, name: { full: "Avery Brooks" } },
          ],
        },
      }),
    ]);
    await syncCompanyCalendar(await company());

    const first = await importedByVisit(`visit_${runId}_45`);
    const second = await importedByVisit(`visit_${runId}_46`);
    expect(await crewOf(first!.id)).toEqual([]);
    expect(await crewOf(second!.id)).toEqual([]);

    const [seat] = await db
      .select({ jobberUserId: teamMembersTable.jobberUserId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, avery!.id));
    expect(seat!.jobberUserId).toBeNull();
  });
});

/**
 * Background polling is production-only: dev and the published site share one
 * Jobber account, and Jobber rotates the refresh token on every renewal, so
 * two pollers take turns invalidating each other's grant. The pin
 * (PUBLIC_APP_URL) is what distinguishes the published site.
 */
describe("startJobberCalendarSync environment gate", () => {
  const savedPin = process.env.PUBLIC_APP_URL;

  afterAll(() => {
    if (savedPin === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = savedPin;
  });

  it("does not start the poller without a PUBLIC_APP_URL pin (dev workspace)", () => {
    delete process.env.PUBLIC_APP_URL;
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      startJobberCalendarSync();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("starts the poller when PUBLIC_APP_URL is pinned (published site)", () => {
    process.env.PUBLIC_APP_URL = "https://bookmycleaning.net";
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      startJobberCalendarSync();
      expect(spy).toHaveBeenCalledTimes(1);
      // Second call is a no-op: the timer already exists.
      startJobberCalendarSync();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
