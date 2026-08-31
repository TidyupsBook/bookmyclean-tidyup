import { describe, expect, it } from "vitest";
import { csvToStaff } from "./staffCsv";

/**
 * The paste path feeds the same reader as the file path, so the reader must
 * accept what pasting actually produces: a block copied out of a spreadsheet
 * arrives tab-separated, and a hand-typed list is commas with no header.
 */
describe("csvToStaff", () => {
  it("reads a tab-separated block copied from a spreadsheet", () => {
    const pasted = [
      "Name\tEmail\tPhone\tRole",
      "Jane Doe\tjane@example.com\t555-0100\tCleaner",
      "Sam Lee\t\t555-0101\tDispatcher",
    ].join("\n");

    const rows = csvToStaff(pasted);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "555-0100",
      role: "cleaner",
    });
    expect(rows[1]).toMatchObject({
      name: "Sam Lee",
      email: null,
      role: "dispatcher",
    });
  });

  it("reads a hand-typed comma list with no header", () => {
    const rows = csvToStaff("Jane Doe, jane@example.com, 555-0100\nSam Lee");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("Jane Doe");
    expect(rows[0]!.email).toBe("jane@example.com");
    expect(rows[1]!.name).toBe("Sam Lee");
    expect(rows[1]!.email).toBeNull();
  });

  it("splits a trailing phone number off a comma-free contacts line", () => {
    const rows = csvToStaff(
      [
        "Jane Doe 555-0100",
        "Sam Lee (555) 010-0101",
        "Ana María +1 555 010 0102",
      ].join("\n"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ name: "Jane Doe", phone: "555-0100" });
    expect(rows[1]).toMatchObject({ name: "Sam Lee", phone: "(555) 010-0101" });
    expect(rows[2]).toMatchObject({
      name: "Ana María",
      phone: "+1 555 010 0102",
    });
  });

  it("strips a phone label between name and number", () => {
    const rows = csvToStaff(
      [
        "Jane Doe mobile: 555-0100",
        "Sam Lee — mobile: 555-0101",
        "Ana María work 555-0102",
        "Bob Ray Cell 555-0103",
        "Kim Woo home: 555-0104",
        "Lou Ann phone 555-0105",
      ].join("\n"),
    );
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ name: "Jane Doe", phone: "555-0100" });
    expect(rows[1]).toMatchObject({ name: "Sam Lee", phone: "555-0101" });
    expect(rows[2]).toMatchObject({ name: "Ana María", phone: "555-0102" });
    expect(rows[3]).toMatchObject({ name: "Bob Ray", phone: "555-0103" });
    expect(rows[4]).toMatchObject({ name: "Kim Woo", phone: "555-0104" });
    expect(rows[5]).toMatchObject({ name: "Lou Ann", phone: "555-0105" });
  });

  it("does not mangle names ending in a label word when no number follows", () => {
    const rows = csvToStaff("Rob Cell\nDawn Homer");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Rob Cell", phone: null });
    expect(rows[1]).toMatchObject({ name: "Dawn Homer", phone: null });
  });

  it("leaves comma-free lines without a phone-shaped ending untouched", () => {
    const rows = csvToStaff("Jane Doe\nJohn Smith Jr 42");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Jane Doe", phone: null });
    // Too few digits to be a phone number — stays part of the name.
    expect(rows[1]).toMatchObject({ name: "John Smith Jr 42", phone: null });
  });

  it("does not touch lines that already parse into columns", () => {
    const rows = csvToStaff("Jane Doe, jane@example.com, 555-0100 x2");
    expect(rows[0]).toMatchObject({
      name: "Jane Doe",
      email: "jane@example.com",
    });
  });

  it("still reads ordinary comma CSV with quoted fields", () => {
    const rows = csvToStaff(
      'Name,Email,Role,Lead,Home Address\n"Doe, Jane",jane@example.com,Lead Cleaner,Yes,"12 Main St, Springfield"',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Doe, Jane",
      role: "cleaner",
      isLead: true,
      homeAddress: "12 Main St, Springfield",
    });
  });
});
