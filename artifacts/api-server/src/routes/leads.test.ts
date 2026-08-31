/**
 * Leads inbox integration tests.
 *
 * Same live-app-against-real-DB style as the other route tests: Clerk is the
 * only thing mocked (caller id via x-test-user). The sheet itself is never
 * touched — rows are inserted through the same importLeadRows helper the
 * sync uses, which is what makes its idempotency testable without network.
 *
 * The two things worth pinning hardest:
 *  1. Re-importing the same sheet rows never duplicates a lead.
 *  2. Converting is a one-shot claim — the second attempt gets 409, and a
 *     a lead can be archived without altering any linked booking.
 */
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type http from "node:http";

const { leadsCompanyIdMock, refreshLeadsSyncIfStaleMock } = vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  return {
    leadsCompanyIdMock: vi.fn<() => Promise<number | null>>(),
    refreshLeadsSyncIfStaleMock: vi.fn<(companyId: number) => Promise<void>>(
      async () => {},
    ),
  };
});

vi.mock("../services/leadsSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/leadsSync")>();
  return {
    ...actual,
    leadsCompanyId: leadsCompanyIdMock,
    refreshLeadsSyncIfStale: refreshLeadsSyncIfStaleMock,
  };
});

vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, unknown> }) => ({
    userId: (req.headers["x-test-user"] as string | undefined) ?? null,
    sessionClaims: {},
  }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: {
    users: {
      getUser: async () => ({
        emailAddresses: [],
        firstName: "Test",
        lastName: "User",
      }),
    },
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getClerkProxyHost: () => null,
}));

import app from "../app";
import {
  db,
  pool,
  companiesTable,
  teamMembersTable,
  bookingsTable,
  leadsTable,
  leadSyncStateTable,
  activityTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { importLeadRows, rowsFromValues } from "../services/leadsSync";

const runId = `${Date.now()}_${process.pid}`;
const USERS = {
  owner: `leads_owner_${runId}`,
  otherOwner: `leads_other_owner_${runId}`,
  dispatcher: `leads_dispatcher_${runId}`,
  cleaner: `leads_cleaner_${runId}`,
};

let server: http.Server;
let baseUrl: string;
let companyId: number;
let otherCompanyId: number;
let bookingId: number;
let otherCompanyBookingId: number;

type JsonResponse = Omit<Response, "json"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

async function call(
  method: string,
  path: string,
  opts: { as?: keyof typeof USERS | null; body?: unknown } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = USERS[opts.as];
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`${baseUrl}/api${path}`, { method, headers, body });
}

/** Sheet-shaped values: header row + data rows, as the Sheets API returns. */
function sheetValues(rows: string[][]): string[][] {
  return [
    [
      "id",
      "created_time",
      "campaign_name",
      "platform",
      "service",
      "bedrooms",
      "bathrooms",
      "date_of_service_requested",
      "first_name",
      "last_name",
      "phone_number",
      "email",
      "street_address",
      "city",
      "province",
      "post_code",
      "inbox_url",
      "lead_status",
    ],
    ...rows,
  ];
}

const LEAD_A = `fb_${runId}_a`;
const LEAD_B = `fb_${runId}_b`;

beforeAll(async () => {
  const companies = await db
    .insert(companiesTable)
    .values([
      {
        ownerUserId: USERS.owner,
        name: `Leads Co ${runId}`,
        timezone: "America/Toronto",
      },
      {
        ownerUserId: USERS.otherOwner,
        name: `Other Co ${runId}`,
        timezone: "America/Toronto",
      },
    ])
    .returning();
  companyId = companies[0]!.id;
  otherCompanyId = companies[1]!.id;

  await db.insert(teamMembersTable).values([
    {
      companyId,
      name: "Dispatch Dana",
      email: `leads_disp_${runId}@test.invalid`,
      role: "dispatcher",
      status: "active",
      clerkUserId: USERS.dispatcher,
    },
    {
      companyId,
      name: "Cleaner Cass",
      email: `leads_cleaner_${runId}@test.invalid`,
      role: "cleaner",
      status: "active",
      clerkUserId: USERS.cleaner,
    },
  ]);

  const bookings = await db
    .insert(bookingsTable)
    .values([
      {
        companyId,
        callId: null,
        customerName: "Lead Customer",
        customerPhone: "+15550009999",
        service: "Deep clean",
        scheduledFor: new Date("2030-05-01T17:00:00Z"),
        status: "confirmed",
      },
      {
        companyId: otherCompanyId,
        callId: null,
        customerName: "Not Your Customer",
        customerPhone: "+15550008888",
        service: "Deep clean",
        scheduledFor: new Date("2030-05-02T17:00:00Z"),
        status: "confirmed",
      },
    ])
    .returning();
  bookingId = bookings[0]!.id;
  otherCompanyBookingId = bookings[1]!.id;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

beforeEach(() => {
  leadsCompanyIdMock.mockResolvedValue(companyId);
  refreshLeadsSyncIfStaleMock.mockClear();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(activityTable)
    .where(inArray(activityTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(leadsTable)
    .where(inArray(leadsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(bookingsTable)
    .where(inArray(bookingsTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(teamMembersTable)
    .where(inArray(teamMembersTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(leadSyncStateTable)
    .where(inArray(leadSyncStateTable.companyId, [companyId, otherCompanyId]));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, [companyId, otherCompanyId]));
  await pool.end();
});

describe("sheet row import", () => {
  it("imports rows verbatim, normalizes only the phone, and is idempotent", async () => {
    const values = sheetValues([
      [
        LEAD_A,
        "2026-08-10T14:03:00+0000",
        "August Promo",
        "ig",
        "Deep clean",
        "1 or 2",
        "2",
        "sometime this weekend?",
        "Pat",
        "Lee",
        " (780) 555-0123 ",
        "pat@example.com",
        "12 Birch Ave",
        "Edmonton",
        "Canada",
        "T5J 0K1",
        "https://business.facebook.com/inbox/1",
        "new",
      ],
      // A padding row without the unique lead id must be skipped, not stored.
      ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ]);
    const rows = rowsFromValues(values);
    expect(rows).toHaveLength(2);

    const first = await importLeadRows(companyId, "Aug Leads V1", rows);
    expect(first).toBe(1);
    // Same rows again — a re-sync — inserts nothing.
    const second = await importLeadRows(companyId, "Aug Leads V1", rows);
    expect(second).toBe(0);

    const [stored] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.externalId, LEAD_A));
    // Raw values are verbatim — the messy ones especially.
    expect(stored!.bedrooms).toBe("1 or 2");
    expect(stored!.province).toBe("Canada");
    expect(stored!.phoneNumber).toBe(" (780) 555-0123 ");
    expect(stored!.dateOfServiceRequested).toBe("sometime this weekend?");
    // The one derived value: a dialable E.164.
    expect(stored!.phoneE164).toBe("+17805550123");
    expect(stored!.status).toBe("new");
    // Sheet rows come out marked as sheet leads — the request form's rows
    // carry "form" instead, and nothing here changes for them existing.
    expect(stored!.source).toBe("sheet");
    // New sheet rows retain a durable handoff until their automatic Jobber
    // push reaches a terminal outcome; a restart cannot silently abandon it.
    expect(stored!.jobberPushPending).toBe(true);
    // The one exception to "verbatim": the inbox link is the only sheet value
    // that becomes clickable, so only https Meta URLs survive.
    expect(stored!.inboxUrl).toBe("https://business.facebook.com/inbox/1");
  });

  it("imports a Google-shaped row without an id column once, keyed by fingerprint", async () => {
    // A Google Ads export: no `id` column at all. Two data rows plus a blank
    // padding row, imported twice — each real row lands exactly once.
    const values = [
      [
        "created_time",
        "campaign_name",
        "first_name",
        "last_name",
        "phone_number",
        "email",
        "city",
      ],
      [
        "2026-08-12T10:00:00+0000",
        "Google Search Aug",
        "Gina",
        `Adwords_${runId}`,
        "780-555-0777",
        `gina_${runId}@example.com`,
        "Edmonton",
      ],
      [
        "2026-08-12T11:30:00+0000",
        "Google Search Aug",
        "Greg",
        `Adwords_${runId}`,
        "780-555-0778",
        "",
        "Edmonton",
      ],
      ["", "", "", "", "", "", ""],
    ];
    const rows = rowsFromValues(values);
    expect(rows).toHaveLength(3);

    const first = await importLeadRows(companyId, "Aug Google Ads Leads", rows);
    expect(first).toBe(2);
    // A re-sync of the same tab inserts nothing — the fingerprint is stable.
    const second = await importLeadRows(
      companyId,
      "Aug Google Ads Leads",
      rows,
    );
    expect(second).toBe(0);

    const stored = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.lastName, `Adwords_${runId}`));
    expect(stored).toHaveLength(2);
    for (const lead of stored) {
      expect(lead.externalId).toMatch(/^fp_[0-9a-f]{64}$/);
    }
    expect(stored[0]!.externalId).not.toBe(stored[1]!.externalId);
  });

  it("maps the live tabs' long form-question headers onto service/bedrooms/bathrooms/date", async () => {
    // The real Aug tabs (FB and Google Ads alike) use these exact headers,
    // including the stray ".?" suffixes. A rename back to the short forms is
    // covered by the other tests; this one pins the live shape.
    const values = [
      [
        "id",
        "created_time",
        "campaign_name",
        "platform",
        "please_select_the_service_your_interested_in?",
        "how_many_bedrooms_do_you_have.?",
        "how_many_bathrooms_do_you_have.?",
        "date_of_service_requested.?",
        "first_name",
        "last_name",
        "phone_number",
        "email",
      ],
      [
        `glead_${runId}_1`,
        "2026-08-13T08:00:00+0000",
        "Google Search Aug",
        "google",
        "Deep Cleaning",
        "3",
        "2",
        "Next Friday",
        "Gail",
        `Longform_${runId}`,
        "780-555-0791",
        `gail_${runId}@example.com`,
      ],
    ];
    const inserted = await importLeadRows(
      companyId,
      "Aug Google Ads Leads",
      rowsFromValues(values),
    );
    expect(inserted).toBe(1);
    const [stored] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.externalId, `glead_${runId}_1`));
    expect(stored!.service).toBe("Deep Cleaning");
    expect(stored!.bedrooms).toBe("3");
    expect(stored!.bathrooms).toBe("2");
    expect(stored!.dateOfServiceRequested).toBe("Next Friday");
    expect(stored!.firstName).toBe("Gail");
    expect(stored!.phoneE164).toBe("+17805550791");
  });

  it("keeps Google's sample lead out while importing the real rows around it", async () => {
    // Google's boilerplate test row ships in every Google Ads export: a
    // gclid-style id ending in the literal `SaMple`, tester filler for every
    // field. Fully populated, it reads like a real lead — so it's skipped at
    // the door while a real row in the same tab imports untouched.
    const values = [
      [
        "id",
        "created_time",
        "campaign_name",
        "first_name",
        "last_name",
        "phone_number",
        "email",
        "city",
      ],
      [
        "CjwKCAiAjeSABhAPEiwAqfxURXEFjY32040Dx_JFOBWrV2MCdm1TOkwwlLyMx52bTWtFoz2JhWSZpBoCQvUQAvD_SaMple",
        "2026-08-13T00:00:00+0000",
        "Google Search Aug",
        "FirstName",
        "LastName",
        "1 (650) 555-0123",
        "test@example.com",
        "Mountain View",
      ],
      [
        `gclid_real_${runId}`,
        "2026-08-13T09:00:00+0000",
        "Google Search Aug",
        "Rhea",
        `RealGoogle_${runId}`,
        "780-555-0793",
        `rhea_${runId}@example.com`,
        "Edmonton",
      ],
    ];
    const rows = rowsFromValues(values);
    expect(rows).toHaveLength(2);

    const inserted = await importLeadRows(
      companyId,
      "Aug Google Ads Leads",
      rows,
    );
    // Only the real lead lands; the sample row never becomes a lead.
    expect(inserted).toBe(1);

    const real = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.externalId, `gclid_real_${runId}`));
    expect(real).toHaveLength(1);
    expect(real[0]!.firstName).toBe("Rhea");

    // Scoped to this test's company: the live sync may have imported the
    // sample row for the founding company before this skip existed (the
    // cleanup migration removes those).
    const sample = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.companyId, companyId),
          eq(
            leadsTable.externalId,
            "CjwKCAiAjeSABhAPEiwAqfxURXEFjY32040Dx_JFOBWrV2MCdm1TOkwwlLyMx52bTWtFoz2JhWSZpBoCQvUQAvD_SaMple",
          ),
        ),
      );
    expect(sample).toHaveLength(0);
  });

  it("skips non-empty rows that aren't leads (no phone, email, or name)", async () => {
    // Every tab gets polled, including ones that aren't lead exports:
    // title rows, footers, totals. Non-empty but person-less rows stay out.
    const values = [
      ["created_time", "campaign_name", "first_name", "phone_number", "email"],
      ["", `Totals ${runId}: 27 leads this month`, "", "", ""],
      // A stray note under the name column, with no phone, email, address,
      // or any other lead detail, is furniture — not a person.
      ["2026-08-12T09:00:00+0000", "Header repeated", "notes only", "", ""],
    ];
    const rows = rowsFromValues(values);
    expect(rows).toHaveLength(2);
    const inserted = await importLeadRows(companyId, "Random Tab", rows);
    expect(inserted).toBe(0);
  });

  it("imports a hand-typed row that has a name but no phone or email", async () => {
    // The owner types walk-in/referral leads straight into the sheet, often
    // with just a name and an address — those are leads, not furniture.
    const values = [
      ["first_name", "last_name", "phone_number", "email", "street_address"],
      [`Sara ${runId}`, "Chags", "", "", "4470 Prowse Road SW, Edmonton"],
    ];
    const inserted = await importLeadRows(
      companyId,
      "Anywhere Leads",
      rowsFromValues(values),
    );
    expect(inserted).toBe(1);
    // Idempotent: the same row on the next poll must not duplicate.
    const again = await importLeadRows(
      companyId,
      "Anywhere Leads",
      rowsFromValues(values),
    );
    expect(again).toBe(0);
  });

  it("keeps two id-less rows apart when they differ outside the contact fields", async () => {
    // Same person-ish fields (created time, phone, email, name) but a
    // different campaign: the fingerprint covers the whole row, so both
    // import — and a mutable lead_status change does NOT re-import.
    const mk = (campaign: string, status: string) => [
      [
        "created_time",
        "campaign_name",
        "first_name",
        "phone_number",
        "lead_status",
      ],
      [
        "2026-08-12T15:00:00+0000",
        campaign,
        `Twin_${runId}`,
        "780-555-0790",
        status,
      ],
    ];
    expect(
      await importLeadRows(
        companyId,
        "Aug Google Ads Leads",
        rowsFromValues(mk("Campaign One", "new")),
      ),
    ).toBe(1);
    expect(
      await importLeadRows(
        companyId,
        "Aug Google Ads Leads",
        rowsFromValues(mk("Campaign Two", "new")),
      ),
    ).toBe(1);
    // Only the sheet's own status flipped — same lead, nothing new inserted.
    expect(
      await importLeadRows(
        companyId,
        "Aug Google Ads Leads",
        rowsFromValues(mk("Campaign One", "contacted")),
      ),
    ).toBe(0);
    const stored = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.firstName, `Twin_${runId}`));
    expect(stored).toHaveLength(2);
  });

  it("prefers a Google-provided unique id over the fingerprint", async () => {
    const values = [
      ["lead_id", "created_time", "first_name", "phone_number"],
      [`gads_${runId}_1`, "2026-08-12T12:00:00+0000", "Gwen", "780-555-0779"],
    ];
    const first = await importLeadRows(
      companyId,
      "Aug Google Ads Leads",
      rowsFromValues(values),
    );
    expect(first).toBe(1);
    const [stored] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.externalId, `gads_${runId}_1`));
    expect(stored).toBeDefined();
    // Re-import keyed by the same lead_id inserts nothing.
    const second = await importLeadRows(
      companyId,
      "Aug Google Ads Leads",
      rowsFromValues(values),
    );
    expect(second).toBe(0);
  });

  it("refuses to store an inbox link that isn't an https Meta URL", async () => {
    for (const [i, bad] of [
      "javascript:alert(document.cookie)",
      "data:text/html,<script>1</script>",
      "http://business.facebook.com/inbox/1",
      "https://evil.example.com/facebook.com",
      "not a url at all",
    ].entries()) {
      const values = sheetValues([
        [
          `${LEAD_A}-inbox-${i}`,
          "2026-08-10T14:03:00+0000",
          "August Promo",
          "ig",
          "Deep clean",
          "2",
          "1",
          "friday",
          "Pat",
          "Lee",
          "(780) 555-0123",
          "pat@example.com",
          "12 Birch Ave",
          "Edmonton",
          "AB",
          "T5J 0K1",
          bad,
          "new",
        ],
      ]);
      await importLeadRows(companyId, "Aug Leads V1", rowsFromValues(values));
      const [stored] = await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.externalId, `${LEAD_A}-inbox-${i}`));
      expect(stored!.inboxUrl).toBeNull();
    }
  });

  it("scrubs a poisoned link already in the database at read time", async () => {
    // Rows written before the sanitizer existed: the API must not serve them.
    await db
      .update(leadsTable)
      .set({ inboxUrl: "javascript:alert(1)" })
      .where(eq(leadsTable.externalId, LEAD_A));
    const res = await call("GET", "/leads", { as: "owner" });
    expect(res.status).toBe(200);
    const leads = await res.json();
    const lead = leads.find(
      (l: { externalId: string }) => l.externalId === LEAD_A,
    );
    expect(lead.inboxUrl).toBeNull();
  });
});

describe("listing and reading", () => {
  it("reports a designated company with no poll watermark as configured and stale", async () => {
    await db
      .delete(leadSyncStateTable)
      .where(eq(leadSyncStateTable.companyId, companyId));

    const res = await call("GET", "/leads/sync-status", { as: "owner" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastError: null,
      warning: null,
      tabStatuses: [],
      stale: true,
    });
    expect(refreshLeadsSyncIfStaleMock).toHaveBeenCalledWith(companyId);
  });

  it("does not expose or wake sheet sync state for a non-recipient company", async () => {
    await db
      .insert(leadSyncStateTable)
      .values({
        companyId: otherCompanyId,
        lastSyncAt: new Date(Date.now() - 60 * 60 * 1000),
        lastSuccessAt: null,
        lastError: "private connector failure",
        lastWarning: "private sheet warning",
        tabStatuses: [
          { name: "Private Tab", status: "failed", error: "private error" },
        ],
      })
      .onConflictDoUpdate({
        target: leadSyncStateTable.companyId,
        set: {
          lastSyncAt: new Date(Date.now() - 60 * 60 * 1000),
          lastSuccessAt: null,
          lastError: "private connector failure",
          lastWarning: "private sheet warning",
          tabStatuses: [
            { name: "Private Tab", status: "failed", error: "private error" },
          ],
        },
      });

    const statusRes = await call("GET", "/leads/sync-status", {
      as: "otherOwner",
    });
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({
      configured: false,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastError: null,
      warning: null,
      tabStatuses: [],
      stale: false,
    });

    const listRes = await call("GET", "/leads", { as: "otherOwner" });
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([]);

    const syncRes = await call("POST", "/leads/sync", { as: "otherOwner" });
    expect(syncRes.status).toBe(200);
    expect(await syncRes.json()).toEqual({
      imported: 0,
      error: null,
      tabStatuses: [],
    });

    const previewRes = await call("GET", "/leads/sync-preview", {
      as: "otherOwner",
    });
    expect(previewRes.status).toBe(200);
    expect(await previewRes.json()).toEqual({ tabs: [] });
    expect(refreshLeadsSyncIfStaleMock).not.toHaveBeenCalled();
  });

  it("reports a stale watermark for the designated company", async () => {
    await db
      .insert(leadSyncStateTable)
      .values({
        companyId,
        lastSyncAt: new Date(Date.now() - 60 * 60 * 1000),
        lastSuccessAt: new Date(Date.now() - 60 * 60 * 1000),
        lastError: null,
        lastWarning: null,
        tabStatuses: [],
      })
      .onConflictDoUpdate({
        target: leadSyncStateTable.companyId,
        set: {
          lastSyncAt: new Date(Date.now() - 60 * 60 * 1000),
          lastSuccessAt: new Date(Date.now() - 60 * 60 * 1000),
          lastError: null,
        },
      });

    const res = await call("GET", "/leads/sync-status", { as: "owner" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      stale: true,
      lastError: null,
    });
  });

  it("lists leads for dispatch, filtered by status, and refuses crew", async () => {
    await importLeadRows(
      companyId,
      "Aug Leads V2",
      rowsFromValues(
        sheetValues([
          [
            LEAD_B,
            "2026-08-11T09:00:00+0000",
            "August Promo",
            "fb",
            "Move-out clean",
            "3",
            "1.5",
            "Aug 20",
            "Sam",
            "Roy",
            "780-555-0456",
            "",
            "",
            "",
            "",
            "",
            "",
            "new",
          ],
        ]),
      ),
    );

    const asCleaner = await call("GET", "/leads", { as: "cleaner" });
    expect(asCleaner.status).toBe(403);

    const res = await call("GET", "/leads?status=new", { as: "dispatcher" });
    expect(res.status).toBe(200);
    const leads = await res.json();
    const ids = leads.map((l: { externalId: string }) => l.externalId);
    expect(ids).toContain(LEAD_A);
    expect(ids).toContain(LEAD_B);
    const a = leads.find(
      (l: { externalId: string }) => l.externalId === LEAD_A,
    );
    expect(a.name).toBe("Pat Lee");
    expect(a.sourceTab).toBe("Aug Leads V1");
  });

  it("serves one lead in full for the booking-form prefill", async () => {
    const list = await (
      await call("GET", "/leads?status=new", { as: "owner" })
    ).json();
    const a = list.find((l: { externalId: string }) => l.externalId === LEAD_A);
    const res = await call("GET", `/leads/${a.id}`, { as: "owner" });
    expect(res.status).toBe(200);
    const lead = await res.json();
    expect(lead.bedrooms).toBe("1 or 2");
    expect(lead.phoneE164).toBe("+17805550123");
  });
});

describe("convert and dismiss", () => {
  it("converts once, 409s the second attempt, and writes the activity entry", async () => {
    const list = await (
      await call("GET", "/leads?status=new", { as: "dispatcher" })
    ).json();
    const a = list.find((l: { externalId: string }) => l.externalId === LEAD_A);

    // A booking belonging to another company must not be linkable.
    const cross = await call("POST", `/leads/${a.id}/convert`, {
      as: "dispatcher",
      body: { bookingId: otherCompanyBookingId },
    });
    expect(cross.status).toBe(404);

    // Simulate a sheet import whose queued Jobber handoff is still pending.
    // Conversion must clear it atomically with taking ownership for the
    // booking, not leave it for a later sheet poll to clean up.
    await db
      .update(leadsTable)
      .set({ jobberPushPending: true })
      .where(eq(leadsTable.id, a.id));

    const first = await call("POST", `/leads/${a.id}/convert`, {
      as: "dispatcher",
      body: { bookingId },
    });
    expect(first.status).toBe(200);
    const converted = await first.json();
    expect(converted.status).toBe("converted");
    expect(converted.convertedBookingId).toBe(bookingId);
    const [convertedRow] = await db
      .select({ jobberPushPending: leadsTable.jobberPushPending })
      .from(leadsTable)
      .where(eq(leadsTable.id, a.id));
    expect(convertedRow?.jobberPushPending).toBe(false);

    const second = await call("POST", `/leads/${a.id}/convert`, {
      as: "owner",
      body: { bookingId },
    });
    expect(second.status).toBe(409);

    // Archiving the lead must not erase the link to the booking.
    const dismiss = await call("POST", `/leads/${a.id}/dismiss`, {
      as: "owner",
    });
    expect(dismiss.status).toBe(200);
    expect((await dismiss.json()).status).toBe("dismissed");

    const feed = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, companyId));
    const entry = feed.find((f) => f.type === "lead_converted");
    expect(entry).toBeDefined();
    expect(entry!.bookingId).toBe(bookingId);
  });

  it("auto-archives a new lead when it is marked spam", async () => {
    const list = await (
      await call("GET", "/leads?status=new", { as: "dispatcher" })
    ).json();
    const b = list.find((l: { externalId: string }) => l.externalId === LEAD_B);
    const res = await call("PATCH", `/leads/${b.id}/tag`, {
      as: "dispatcher",
      body: { tag: "spam" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("dismissed");

    const newView = await (
      await call("GET", "/leads?status=new", { as: "dispatcher" })
    ).json();
    expect(
      newView.some((l: { externalId: string }) => l.externalId === LEAD_B),
    ).toBe(false);

    const dismissedView = await (
      await call("GET", "/leads?status=dismissed", { as: "dispatcher" })
    ).json();
    expect(
      dismissedView.some(
        (l: { externalId: string }) => l.externalId === LEAD_B,
      ),
    ).toBe(true);
  });
});

describe("a booking worked from a lead", () => {
  it("remembers which lead it came from, and refuses another company's", async () => {
    const [mine] = await db
      .insert(leadsTable)
      .values({
        companyId,
        externalId: `fb_${runId}_origin`,
        sourceTab: "Aug FB Leads V1",
        firstName: "Rosa",
        lastName: "Klein",
        phoneNumber: "780-555-0199",
      })
      .returning();
    const [theirs] = await db
      .insert(leadsTable)
      .values({
        companyId: otherCompanyId,
        externalId: `fb_${runId}_origin_other`,
        sourceTab: "Aug FB Leads V1",
        firstName: "Someone",
        lastName: "Else",
      })
      .returning();

    // The id comes off a query string in the browser, so it gets the same
    // treatment as a crew id: another company's lead must not attach.
    const cross = await call("POST", "/bookings", {
      as: "dispatcher",
      body: {
        customerName: "Rosa Klein",
        scheduledFor: "2026-09-01T15:00:00.000Z",
        leadId: theirs!.id,
      },
    });
    expect(cross.status).toBe(400);

    const res = await call("POST", "/bookings", {
      as: "dispatcher",
      body: {
        customerName: "Rosa Klein",
        customerPhone: "780-555-0199",
        scheduledFor: "2026-09-01T15:00:00.000Z",
        leadId: mine!.id,
      },
    });
    expect(res.status).toBe(201);
    const created = await res.json();

    // This is what keeps an ad enquiry off an existing Jobber client: the
    // origin is on the booking at creation, which is when the push reads it —
    // the convert call that follows would be too late.
    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, created.id));
    expect(row!.leadId).toBe(mine!.id);
  });
});
