import type { TeamMember, TeamMemberInput } from "@workspace/api-client-react";

/**
 * The staff list as a spreadsheet, both directions.
 *
 * The round trip is the point: download, fix a dozen phone numbers in Excel,
 * upload again. So the export has to be something Excel opens cleanly, and the
 * import has to accept what Excel gives back — which means tolerating renamed
 * capitalisation, reordered columns, missing columns, and stray blank rows.
 * Nothing here is required except a name.
 */

const COLUMNS = [
  "Name",
  "Email",
  "Phone",
  "Role",
  "Lead",
  "Active",
  "Home Address",
] as const;

function escapeCell(value: string | null | undefined): string {
  const text = value ?? "";
  // Quote anything a spreadsheet would otherwise misread as a new field or row.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function staffToCsv(members: TeamMember[]): string {
  const rows = members.map((m) =>
    [
      m.name,
      m.email ?? "",
      m.phone ?? "",
      m.role === "dispatcher"
        ? "Dispatcher"
        : m.isLead
          ? "Lead Cleaner"
          : "Cleaner",
      m.isLead ? "Yes" : "No",
      m.active ? "Yes" : "No",
      m.homeAddress ?? "",
    ]
      .map(escapeCell)
      .join(","),
  );
  // CRLF: Excel is the likely destination and it is the fussier of the two.
  return [COLUMNS.join(","), ...rows].join("\r\n");
}

/**
 * Split CSV text into rows of cells, honouring quoted fields.
 *
 * Tabs count as separators too: a block copied straight out of a spreadsheet
 * and pasted is tab-separated, not comma-separated, and it should read the
 * same either way. Real CSV files never contain bare tabs, so this costs
 * nothing on the file path.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "," || char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      // Swallow the second half of a CRLF pair.
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);

  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

/**
 * Split "Jane Doe 555-0100" into name and phone.
 *
 * A list copied out of a phone's contacts app has no commas or tabs at all —
 * just a name with the number tacked on the end. When a comma-free row is a
 * single cell that ends in something phone-shaped (7+ digits, allowing the
 * usual dashes, dots, spaces, and parentheses), peel the number off so it
 * lands in the phone field instead of inside the name. Anything that already
 * parsed into multiple cells is left strictly alone.
 */
function splitTrailingPhone(row: string[]): string[] {
  if (row.length !== 1) return row;
  const cell = row[0]!.trim();
  // Leftmost match, so "(555) 010-0101" is taken whole rather than losing its
  // area code to a greedy name.
  const match = cell.match(/[\s:]+(\+?\(?\d[\d\s().-]{5,}\d)$/);
  if (!match || match.index === undefined) return row;
  let name = cell.slice(0, match.index).trim();
  // Contact exports often label the number: "Jane Doe — mobile: 555-0100" or
  // "Jane Doe mobile 555-0100". Strip one trailing label word (plus any dash
  // or colon around it) — but only here, where a number actually follows, so
  // a name that merely ends in one of these words is never touched.
  name = name
    .replace(/[\s]*[—–-]?\s*\b(mobile|cell|work|home|phone)\b\s*:?$/i, "")
    .replace(/[\s]*[—–:-]+$/, "")
    .trim();
  const phone = match[1]!.trim();
  const digits = phone.replace(/\D/g, "");
  if (!name || !/[^\d\s]/.test(name)) return row;
  if (digits.length < 7 || digits.length > 15) return row;
  return [name, "", phone];
}

function isYes(value: string | undefined): boolean | undefined {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (["yes", "y", "true", "1", "active", "lead"].includes(text)) return true;
  if (["no", "n", "false", "0", "inactive"].includes(text)) return false;
  return undefined;
}

/**
 * Turn an uploaded spreadsheet into staff rows.
 *
 * Columns are matched by header name rather than position, so a file with the
 * columns shuffled or extra columns bolted on still works. A file with no
 * recognisable header is read positionally in export order, which is what a
 * hand-typed list tends to look like.
 */
export function csvToStaff(text: string): TeamMemberInput[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, "")).map(splitTrailingPhone);
  if (rows.length === 0) return [];

  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  const known = ["name", "email", "phone", "role", "lead", "active"];
  const hasHeader = known.some((k) => header.includes(k));
  const index = (...names: string[]) => {
    for (const name of names) {
      const at = header.indexOf(name);
      if (at !== -1) return at;
    }
    return -1;
  };

  const columns = hasHeader
    ? {
        name: index("name", "full name", "staff", "staff name"),
        email: index("email", "email address"),
        phone: index("phone", "phone number", "mobile"),
        role: index("role", "position"),
        lead: index("lead", "lead cleaner", "is lead"),
        active: index("active", "status"),
        address: index("home address", "address", "home"),
      }
    : { name: 0, email: 1, phone: 2, role: 3, lead: 4, active: 5, address: 6 };

  const at = (row: string[], column: number) =>
    column >= 0 ? (row[column] ?? "").trim() : "";

  return rows.slice(hasHeader ? 1 : 0).map((row) => {
    const roleText = at(row, columns.role).toLowerCase();
    // "Lead Cleaner" in the role column means the label, not a third role.
    const lead = isYes(at(row, columns.lead)) ?? roleText.includes("lead");
    return {
      name: at(row, columns.name),
      email: at(row, columns.email) || null,
      phone: at(row, columns.phone) || null,
      role: roleText.startsWith("dispatch")
        ? ("dispatcher" as const)
        : ("cleaner" as const),
      isLead: lead,
      active: isYes(at(row, columns.active)) ?? true,
      homeAddress: at(row, columns.address) || null,
    };
  });
}

/** Hand the browser a file to save, without leaving the page. */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM is what makes Excel read accented names correctly.
  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
