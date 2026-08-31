/**
 * The sheet's tabs are asked for, never assumed.
 *
 * This is a regression pin rather than coverage for its own sake. The tab
 * names belong to whoever keeps the lead sheet, and they do change under us —
 * a month in, "Aug Leads V2" became "Aug Google Ads Leads" so the paid
 * sources could be told apart. While the names were a constant in the sync,
 * that rename had exactly one symptom: a Leads page that quietly stopped
 * filling. Nobody is watching a log line for a tab that no longer exists.
 *
 * So: whatever the sheet says its tabs are called is what gets read, and an
 * unreadable tab list is surfaced rather than swallowed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: leadsSync builds its connector at module load, which happens
// before any plain top-level const in this file is initialized.
const { proxy } = vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
  return { proxy: vi.fn() };
});

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {
    proxy = proxy;
  },
}));

import { pool } from "@workspace/db";
import { buildSheetRange, fetchTabNames } from "./leadsSync";

function sheetsResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  proxy.mockReset();
});

afterAll(async () => {
  await pool.end();
});

describe("discovering the sheet's tabs", () => {
  it("builds explicit A1 ranges for the reported tab and special names", () => {
    expect(
      buildSheetRange({
        title: "Lead Dataset Master Table",
        rowCount: 250,
        columnCount: 32,
      }),
    ).toBe("'Lead Dataset Master Table'!A1:AF250");
    expect(
      buildSheetRange({
        title: "Owner's Leads / August",
        rowCount: 40,
        columnCount: 28,
      }),
    ).toBe("'Owner''s Leads / August'!A1:AB40");
  });

  it("reads whatever the sheet currently calls them", async () => {
    proxy.mockResolvedValueOnce(
      sheetsResponse({
        sheets: [
          { properties: { title: "Aug FB Leads V1" } },
          { properties: { title: "FB Leads_V2" } },
          { properties: { title: "Sep FB Leads" } },
        ],
      }),
    );

    // Names this code has never heard of, including next month's.
    await expect(fetchTabNames()).resolves.toEqual([
      "Aug FB Leads V1",
      "FB Leads_V2",
      "Sep FB Leads",
    ]);

    // Asked the spreadsheet itself, rather than reaching for a fixed list.
    const [connector, path] = proxy.mock.calls[0] as [string, string];
    expect(connector).toBe("google-sheet");
    expect(path).toContain("/v4/spreadsheets/");
    expect(path).toContain("sheets.properties.title");
  });

  it("ignores a tab with no usable name", async () => {
    proxy.mockResolvedValueOnce(
      sheetsResponse({
        sheets: [
          { properties: { title: "Aug FB Leads V1" } },
          { properties: {} },
          { properties: { title: "   " } },
          {},
        ],
      }),
    );

    await expect(fetchTabNames()).resolves.toEqual(["Aug FB Leads V1"]);
  });

  it("ignores non-grid object tabs that the values API cannot read", async () => {
    proxy.mockResolvedValueOnce(
      sheetsResponse({
        sheets: [
          {
            properties: {
              title: "Lead Dataset Master Table",
              sheetType: "OBJECT",
            },
          },
          {
            properties: {
              title: "Renamed Leads",
              sheetType: "GRID",
              gridProperties: { rowCount: 20, columnCount: 12 },
            },
          },
        ],
      }),
    );

    await expect(fetchTabNames()).resolves.toEqual(["Renamed Leads"]);
  });

  it("says so when the tab list can't be read", async () => {
    proxy.mockResolvedValueOnce(
      sheetsResponse(
        { error: { message: "No google-sheet connection" } },
        false,
        404,
      ),
    );

    // The message carries the status and the body: a missing connection and a
    // deleted spreadsheet are different problems and read differently on the
    // Leads page.
    await expect(fetchTabNames()).rejects.toThrow(/404/);
    expect(proxy).toHaveBeenCalledTimes(1);
  });
});
