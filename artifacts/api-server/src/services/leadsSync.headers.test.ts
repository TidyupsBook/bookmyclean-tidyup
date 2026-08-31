/**
 * The next header rename must announce itself, not just blank out fields.
 *
 * The lead sheet's headers are hand-managed and have already changed shape
 * once (short "how_many_bedrooms?" vs the live
 * "how_many_bedrooms_do_you_have.?"). When a header renames again, the lead
 * still imports via fingerprint but the renamed field silently goes blank —
 * the only symptom is emptier lead cards. These tests pin that a sync pass
 * which sees a non-empty header it can't map records a warning in lead sync
 * state (once per tab, not per row), and that a clean pass clears it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { proxy, scheduleLeadJobberPush } = vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  return { proxy: vi.fn(), scheduleLeadJobberPush: vi.fn() };
});

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {
    proxy = proxy;
  },
}));
vi.mock("./leadJobberPush", () => ({
  scheduleLeadJobberPush: scheduleLeadJobberPush,
}));

import { asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  leadSyncStateTable,
  leadsTable,
} from "@workspace/db";
import {
  leadQuestionField,
  importLeadRows,
  rowsFromValues,
  runLeadsSync,
  summarizePreviewAnswer,
  unmappedHeaders,
} from "./leadsSync";

function sheetsResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  proxy.mockReset();
  scheduleLeadJobberPush.mockReset();
});

afterAll(async () => {
  await pool.end();
});

describe("unmappedHeaders", () => {
  it("flags a non-empty header that maps to no stored field, once per tab", () => {
    const rows = rowsFromValues([
      ["id", "how_many_bedrooms_in_your_home.?", "phone_number"],
      ["l1", "3", "555-0101"],
      ["l2", "2", "555-0102"],
    ]);
    // One entry despite two rows carrying it.
    expect(unmappedHeaders(rows)).toEqual(["how_many_bedrooms_in_your_home.?"]);
  });

  it("says nothing about known headers, in any casing", () => {
    const rows = rowsFromValues([
      ["ID", "Phone_Number", "how_many_bedrooms_do_you_have.?", "Lead_Status"],
      ["l1", "555-0101", "3", "contacted"],
    ]);
    expect(unmappedHeaders(rows)).toEqual([]);
  });

  it("catches a column added past Z — the read is the whole tab, not A:Z", () => {
    // 26 known-or-empty columns, then the 27th (AA) is a new question.
    const headers = [
      "id",
      "phone_number",
      ...Array.from({ length: 24 }, () => ""),
      "do_you_have_pets.?",
    ];
    const rows = rowsFromValues([
      headers,
      ["l1", "555-0101", ...Array(24).fill(""), "two cats"],
    ]);
    expect(unmappedHeaders(rows)).toEqual(["do_you_have_pets.?"]);
  });

  it("ignores an unknown column nobody fills — legacy columns linger empty", () => {
    const rows = rowsFromValues([
      ["id", "old_unused_question?", "phone_number"],
      ["l1", "", "555-0101"],
      ["l2", "   ", "555-0102"],
    ]);
    expect(unmappedHeaders(rows)).toEqual([]);
  });

  it("recognizes renamed actionable questions but still warns on metadata", () => {
    const rows = rowsFromValues([
      [
        "id",
        "what_type_of_cleaning_service_do_you_need?",
        "number_of_bedrooms",
        "number_of_bathrooms",
        "preferred_cleaning_date",
        "do_you_have_pets.?",
        "phone_number",
      ],
      ["l1", "Move out clean", "3", "2", "next Saturday", "No", "555-0101"],
    ]);
    expect(unmappedHeaders(rows)).toEqual(["do_you_have_pets.?"]);
  });

  it("preserves the short bedroom and bathroom aliases", () => {
    expect(leadQuestionField("how_many_bedrooms?")).toBe("bedrooms");
    expect(leadQuestionField("how_many_bathrooms?")).toBe("bathrooms");
  });
});

describe("preview answer examples", () => {
  it("compacts whitespace and truncates long answers", () => {
    const answer = `  Move-out clean\nwith a very detailed answer ${"x".repeat(90)}  `;
    const summary = summarizePreviewAnswer(answer);

    expect(summary).toHaveLength(80);
    expect(summary).toMatch(/^Move-out clean with a very detailed answer/);
    expect(summary).toMatch(/…$/);
  });

  it("does not expose empty answers", () => {
    expect(summarizePreviewAnswer(" \n\t ")).toBeUndefined();
  });
});

describe("a sync pass with an unrecognized column", () => {
  async function leadsCompanyId(): Promise<number> {
    const [company] = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .orderBy(asc(companiesTable.id))
      .limit(1);
    if (!company) throw new Error("dev DB has no company to sync into");
    return company.id;
  }

  function mockSheet(headers: string[], row: string[]) {
    proxy.mockImplementation(async (_connector: string, path: string) => {
      if (path.includes("fields=sheets.properties.title")) {
        return sheetsResponse({
          sheets: [{ properties: { title: "Header Warning Test Tab" } }],
        });
      }
      return sheetsResponse({ values: [headers, row] });
    });
  }

  it("imports renamed form questions into the lead fields without changing answers", async () => {
    const companyId = await leadsCompanyId();
    const externalId = `renamed-form-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const headers = [
      "id",
      "phone_number",
      "what_type_of_cleaning_service_do_you_need?",
      "number_of_bedrooms",
      "number_of_bathrooms",
      "preferred_cleaning_date",
      "do_you_have_pets.?",
    ];
    const row = [
      externalId,
      "555-0197",
      "Move out clean (please quote)",
      "3 or 4",
      "2 full + 1 half",
      "next Saturday after 2pm",
      "No",
    ];
    mockSheet(headers, row);
    try {
      const result = await runLeadsSync();
      expect(result.error).toBeNull();
      const [lead] = await db
        .select({
          service: leadsTable.service,
          bedrooms: leadsTable.bedrooms,
          bathrooms: leadsTable.bathrooms,
          dateOfServiceRequested: leadsTable.dateOfServiceRequested,
        })
        .from(leadsTable)
        .where(eq(leadsTable.externalId, externalId));
      expect(lead).toEqual({
        service: "Move out clean (please quote)",
        bedrooms: "3 or 4",
        bathrooms: "2 full + 1 half",
        dateOfServiceRequested: "next Saturday after 2pm",
      });
      const [state] = await db
        .select({ lastWarning: leadSyncStateTable.lastWarning })
        .from(leadSyncStateTable)
        .where(eq(leadSyncStateTable.companyId, companyId));
      expect(state?.lastWarning).toContain("do_you_have_pets.?");
    } finally {
      await db.delete(leadsTable).where(eq(leadsTable.externalId, externalId));
    }
  });

  it("imports the legacy short bedroom and bathroom questions", async () => {
    const companyId = await leadsCompanyId();
    const externalId = `legacy-form-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await importLeadRows(
        companyId,
        "Legacy aliases",
        rowsFromValues([
          ["id", "phone_number", "how_many_bedrooms?", "how_many_bathrooms?"],
          [externalId, "555-0196", "2", "1"],
        ]),
      );
      const [lead] = await db
        .select({
          bedrooms: leadsTable.bedrooms,
          bathrooms: leadsTable.bathrooms,
        })
        .from(leadsTable)
        .where(eq(leadsTable.externalId, externalId));
      expect(lead).toEqual({ bedrooms: "2", bathrooms: "1" });
    } finally {
      await db.delete(leadsTable).where(eq(leadsTable.externalId, externalId));
    }
  });

  it("recovers a durable sheet-to-Jobber handoff after a restart, even when no row is new", async () => {
    const companyId = await leadsCompanyId();
    const recoveryId = `jobber-sheet-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [pending] = await db
      .insert(leadsTable)
      .values({
        companyId,
        source: "sheet",
        externalId: recoveryId,
        sourceTab: "Pre-restart sheet sync",
        phoneNumber: "555-0199",
        jobberPushPending: true,
      })
      .returning();
    scheduleLeadJobberPush.mockImplementation(async (_company, lead) => {
      await db
        .update(leadsTable)
        .set({ jobberPushPending: false })
        .where(eq(leadsTable.id, lead.id));
    });
    // The row already exists, so this pass has nothing new to insert.
    mockSheet(["id", "phone_number"], ["", ""]);
    try {
      const sync = await runLeadsSync();
      expect(sync).toMatchObject({
        imported: 0,
        error: null,
        tabStatuses: [
          {
            name: "Header Warning Test Tab",
            status: "read",
            rowsSeen: 0,
            eligibleRows: 0,
            importedRows: 0,
            duplicateRows: 0,
            skippedRows: 0,
          },
        ],
      });
      await vi.waitFor(() =>
        expect(scheduleLeadJobberPush).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ id: pending!.id, externalId: recoveryId }),
        ),
      );
      const [after] = await db
        .select({ jobberPushPending: leadsTable.jobberPushPending })
        .from(leadsTable)
        .where(eq(leadsTable.id, pending!.id));
      expect(after?.jobberPushPending).toBe(false);
    } finally {
      await db.delete(leadsTable).where(eq(leadsTable.externalId, recoveryId));
    }
  });

  it("schedules each newly imported sheet lead once, without re-scheduling a repeat poll", async () => {
    const companyId = await leadsCompanyId();
    const syncId = `jobber-sheet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const historicalId = `jobber-sheet-historical-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db.insert(leadsTable).values({
      companyId,
      source: "sheet",
      externalId: historicalId,
      sourceTab: "Before automatic sheet pushes",
      phoneNumber: "555-0198",
      // The schema default is false: enabling this feature must never send
      // an old lead that pre-dated it.
    });
    scheduleLeadJobberPush.mockClear();
    scheduleLeadJobberPush.mockImplementation(async (_company, lead) => {
      await db
        .update(leadsTable)
        .set({ jobberPushPending: false })
        .where(eq(leadsTable.id, lead.id));
    });
    mockSheet(["id", "phone_number"], [syncId, "555-0199"]);
    try {
      const first = await runLeadsSync();
      expect(first.error).toBeNull();
      expect(first.tabStatuses[0]).toMatchObject({
        rowsSeen: 1,
        eligibleRows: 1,
        importedRows: 1,
        duplicateRows: 0,
        skippedRows: 0,
      });
      await vi.waitFor(() =>
        expect(scheduleLeadJobberPush).toHaveBeenCalledTimes(1),
      );
      expect(scheduleLeadJobberPush.mock.calls[0]?.[1]).toMatchObject({
        externalId: syncId,
        source: "sheet",
      });

      const second = await runLeadsSync();
      expect(second.error).toBeNull();
      expect(second.tabStatuses[0]).toMatchObject({
        rowsSeen: 1,
        eligibleRows: 1,
        importedRows: 0,
        duplicateRows: 1,
        skippedRows: 0,
      });
      expect(scheduleLeadJobberPush).toHaveBeenCalledTimes(1);
    } finally {
      await db.delete(leadsTable).where(eq(leadsTable.externalId, syncId));
      await db
        .delete(leadsTable)
        .where(eq(leadsTable.externalId, historicalId));
    }
  });

  // Run-unique so re-runs and crashed runs never collide on the unique index.
  const uniqueId = `hdr-warn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it("records the warning in lead sync state, and a clean pass clears it", async () => {
    const companyId = await leadsCompanyId();
    try {
      // Pass 1: the sheet grew a column the import doesn't map.
      mockSheet(
        ["id", "phone_number", "which_rooms_need_cleaning.?"],
        [uniqueId, "555-0199", "kitchen"],
      );
      const first = await runLeadsSync();
      expect(first.error).toBeNull();

      const [afterWarn] = await db
        .select()
        .from(leadSyncStateTable)
        .where(eq(leadSyncStateTable.companyId, companyId));
      expect(afterWarn?.lastWarning).toContain("which_rooms_need_cleaning.?");
      expect(afterWarn?.lastWarning).toContain("Header Warning Test Tab");
      // The lead itself still imported — the warning is additive, not fatal.
      const [lead] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(eq(leadsTable.externalId, uniqueId));
      expect(lead).toBeTruthy();

      // Pass 2: the mapping caught up (header now recognized as absent).
      mockSheet(["id", "phone_number"], [uniqueId, "555-0199"]);
      const second = await runLeadsSync();
      expect(second.error).toBeNull();

      const [afterClean] = await db
        .select()
        .from(leadSyncStateTable)
        .where(eq(leadSyncStateTable.companyId, companyId));
      expect(afterClean?.lastWarning).toBeNull();
    } finally {
      await db.delete(leadsTable).where(eq(leadsTable.externalId, uniqueId));
    }
  });

  it("reads the whole tab, not a fixed A:Z window", async () => {
    mockSheet(["id", "phone_number"], [uniqueId, "555-0199"]);
    try {
      await runLeadsSync();
      const valuesCall = proxy.mock.calls
        .map(([, path]) => path as string)
        .find((p) => p.includes("/values/"));
      expect(valuesCall).toBeDefined();
      // A quoted sheet name alone means "everything on the tab" — a column
      // window like A:Z would hide any header added past Z.
      expect(valuesCall).not.toContain(encodeURIComponent("!A:Z"));
      expect(valuesCall).toContain(
        encodeURIComponent("'Header Warning Test Tab'"),
      );
    } finally {
      await db.delete(leadsTable).where(eq(leadsTable.externalId, uniqueId));
    }
  });

  it("a failed pass never clears a standing warning — it proved nothing", async () => {
    const companyId = await leadsCompanyId();
    try {
      // Establish the warning with a clean pass that sees an unknown column.
      mockSheet(
        ["id", "phone_number", "which_rooms_need_cleaning.?"],
        [uniqueId, "555-0199", "kitchen"],
      );
      await runLeadsSync();

      // Next pass: even the tab list is unreadable.
      proxy.mockImplementation(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "boom",
      }));
      const failed = await runLeadsSync();
      expect(failed.error).not.toBeNull();

      const [state] = await db
        .select()
        .from(leadSyncStateTable)
        .where(eq(leadSyncStateTable.companyId, companyId));
      expect(state?.lastError).not.toBeNull();
      expect(state?.lastWarning).toContain("which_rooms_need_cleaning.?");

      // Partial failure: one tab reads fine (with a *different* unknown
      // column), the tab holding the standing warning's column doesn't.
      // The pass proved nothing about that tab, so the warning stands.
      proxy.mockImplementation(async (_c: string, path: string) => {
        if (path.includes("fields=sheets.properties.title")) {
          return sheetsResponse({
            sheets: [
              { properties: { title: "Readable Tab" } },
              { properties: { title: "Header Warning Test Tab" } },
            ],
          });
        }
        if (path.includes(encodeURIComponent("'Readable Tab'"))) {
          return sheetsResponse({
            values: [
              ["id", "phone_number", "gate_code.?"],
              [uniqueId, "555-0199", "1234"],
            ],
          });
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => "boom",
        };
      });
      const partial = await runLeadsSync();
      expect(partial.error).not.toBeNull();

      const [afterPartial] = await db
        .select()
        .from(leadSyncStateTable)
        .where(eq(leadSyncStateTable.companyId, companyId));
      expect(afterPartial?.lastWarning).toContain(
        "which_rooms_need_cleaning.?",
      );
    } finally {
      await db.delete(leadsTable).where(eq(leadsTable.externalId, uniqueId));
    }
  });

  it("keeps readable tabs visible when another discovered tab fails", async () => {
    const companyId = await leadsCompanyId();
    proxy.mockImplementation(async (_connector: string, path: string) => {
      if (path.includes("fields=sheets.properties.title")) {
        return sheetsResponse({
          sheets: [
            { properties: { title: "Readable July Leads" } },
            { properties: { title: "Renamed August Leads" } },
          ],
        });
      }
      if (path.includes(encodeURIComponent("'Readable July Leads'"))) {
        return sheetsResponse({
          values: [
            ["id", "phone_number"],
            ["", ""],
          ],
        });
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "tab not found",
      };
    });

    const result = await runLeadsSync();
    expect(result.error).toContain("Renamed August Leads");
    expect(result.tabStatuses).toEqual([
      {
        name: "Readable July Leads",
        status: "read",
        rowsSeen: 0,
        eligibleRows: 0,
        importedRows: 0,
        duplicateRows: 0,
        skippedRows: 0,
      },
      {
        name: "Renamed August Leads",
        status: "failed",
        error: expect.stringContaining("Renamed August Leads"),
      },
    ]);

    const [state] = await db
      .select()
      .from(leadSyncStateTable)
      .where(eq(leadSyncStateTable.companyId, companyId));
    expect(state?.tabStatuses).toEqual(result.tabStatuses);
  });

  it("does not invent tab results when the connector cannot list tabs", async () => {
    proxy.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "authentication required",
    });

    const result = await runLeadsSync();
    expect(result.error).toContain("tab list");
    expect(result.tabStatuses).toEqual([]);
  });
});
