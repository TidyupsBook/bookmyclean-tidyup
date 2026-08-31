import { createHash } from "node:crypto";
import { and, sql, asc, eq } from "drizzle-orm";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  db,
  companiesTable,
  leadsTable,
  leadSyncStateTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { toE164 } from "../lib/quo";
import { scheduleLeadJobberPush } from "./leadJobberPush";

/**
 * Polls the Facebook/Instagram leads Google Sheet and imports new rows as
 * leads for the dispatcher to review.
 *
 * The sheet is the source of truth and is read-only to us: nothing is ever
 * written back, and every value is stored verbatim — the answers are free
 * text ("1 or 2" bedrooms, a province of "Canada") and cleaning them up here
 * would silently rewrite what the customer typed. The one derived value is
 * the E.164 phone, computed for matching/dialing and stored alongside the
 * raw number.
 *
 * Idempotency lives in the database, not in this code: each row is keyed by
 * the sheet's unique lead id when it has one (Facebook's `id`, Google's
 * `lead_id`/`gclid`) or a content fingerprint when it doesn't (see leadKey),
 * and the insert is ON CONFLICT DO NOTHING
 * against the (company, sheet lead id) unique index. A re-sync, a restart or
 * two overlapping processes can only ever skip a row, never double it. On
 * top of that, a transaction-scoped advisory lock serializes whole runs so
 * two pollers don't race the same Sheets read.
 *
 * Safe to run in every environment: the connection is read-only, and each
 * environment imports into its own database — unlike the Jobber poller,
 * there is no shared rotating credential to fight over.
 */

/** Constant for now; overridable without a deploy via env. */
const SPREADSHEET_ID =
  process.env.LEADS_SPREADSHEET_ID ??
  "1-1palHco2hOEKDh8ivnLYX6-PuzeQtHhLQGkaD_Dp4I";

/**
 * The shared sheet belongs to one deployment/company. Keep that choice out of
 * the database's insertion order: test fixtures and retired companies can
 * otherwise become the "oldest" row and quietly steal the live inbox.
 */
function configuredLeadsCompanyId(): number | null | undefined {
  const raw = process.env.LEADS_COMPANY_ID?.trim();
  if (!raw) return undefined;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    logger.error(
      { value: raw },
      "[leads] LEADS_COMPANY_ID must be a positive integer",
    );
    return null;
  }
  return id;
}

/**
 * Every tab in the sheet is polled; the list is never hardcoded.
 *
 * The tab names belong to whoever keeps the sheet, not to us: they get
 * renamed mid-month as sources are split out ("Aug Leads V2" became "Aug
 * Google Ads Leads"), and a new one appears each month. A fixed list stops
 * importing the moment that happens, and the only symptom is a Leads page
 * that quietly stays empty. A tab that isn't a lead export costs one read
 * and imports little — blank padding rows are skipped, and anything else is
 * keyed idempotently (see leadKey) so re-reads never duplicate it.
 */
export async function fetchTabNames(): Promise<string[]> {
  return (await fetchTabMetadata()).map((tab) => tab.title);
}

type SheetTabMetadata = {
  title: string;
  sheetType?: string;
  rowCount?: number;
  columnCount?: number;
};

async function fetchTabMetadata(): Promise<SheetTabMetadata[]> {
  const fields = [
    "sheets.properties.title",
    "sheets.properties.sheetType",
    "sheets.properties.gridProperties",
  ].join(",");
  const res = await connectors.proxy(
    "google-sheet",
    `/v4/spreadsheets/${SPREADSHEET_ID}?fields=${fields}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Sheets tab list failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    sheets?: Array<{
      properties?: {
        title?: string;
        sheetType?: string;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }>;
  };
  return (
    (data.sheets ?? [])
      .map(
        (
          s,
        ): {
          title?: string;
          sheetType?: string;
          rowCount?: number;
          columnCount?: number;
        } => ({
          title: s.properties?.title,
          sheetType: s.properties?.sheetType,
          rowCount: s.properties?.gridProperties?.rowCount,
          columnCount: s.properties?.gridProperties?.columnCount,
        }),
      )
      .filter(
        (tab): tab is SheetTabMetadata =>
          typeof tab.title === "string" && tab.title.trim() !== "",
      )
      // Google Sheets OBJECT tabs (for example a table object) have a title but
      // no grid and cannot be addressed by the values API. They are still
      // returned by spreadsheet metadata, so exclude them before constructing an
      // A1 range. GRID and DATA_SOURCE tabs remain dynamically discovered.
      .filter((tab) => tab.sheetType !== "OBJECT")
  );
}

/** "Within a few minutes" — new rows land on the Leads page inside one cycle. */
export const LEADS_SYNC_INTERVAL_MS = 3 * 60 * 1000;

/** Short first delay so a fresh boot shows leads quickly without blocking listen(). */
const INITIAL_DELAY_MS = 15 * 1000;

/**
 * Three missed poll windows means the automatic worker is no longer current.
 * Keep this server-owned so every client reports the same health state.
 */
export const LEADS_SYNC_STALE_AFTER_MS = LEADS_SYNC_INTERVAL_MS * 3;

export function isLeadsSyncStale(
  lastSyncAt: Date | null | undefined,
  nowMs = Date.now(),
): boolean {
  return (
    !lastSyncAt ||
    !Number.isFinite(lastSyncAt.getTime()) ||
    nowMs - lastSyncAt.getTime() > LEADS_SYNC_STALE_AFTER_MS
  );
}

const connectors = new ReplitConnectors();

/** One raw sheet row keyed by its (lowercased) header names. */
export type SheetRow = Record<string, string>;

/**
 * The one sheet column that becomes a clickable link. Sheet data is untrusted
 * external input — a `javascript:` (or any non-https) value here would run in
 * the signed-in dashboard the moment dispatch clicks "Open in Meta inbox" —
 * so only absolute https URLs on Meta's own inbox domains survive the import.
 * Anything else is stored as null; the lead itself is still kept.
 */
const META_INBOX_HOSTS = new Set([
  "facebook.com",
  "business.facebook.com",
  "m.me",
  "messenger.com",
  "instagram.com",
]);
export function safeInboxUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return META_INBOX_HOSTS.has(host) ? url.toString() : null;
}

/**
 * A values-range response folded into header-keyed rows. Headers are matched
 * case-insensitively because the sheet is hand-managed and "Phone_Number"
 * vs "phone_number" must not silently drop a column.
 */
export function rowsFromValues(values: string[][] | undefined): SheetRow[] {
  if (!values || values.length < 2) return [];
  const headers = (values[0] ?? []).map((h) => String(h).trim().toLowerCase());
  const rows: SheetRow[] = [];
  for (const raw of values.slice(1)) {
    const row: SheetRow = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const cell = raw[i];
      row[h] = cell == null ? "" : String(cell);
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Every (lowercased) header the import knows what to do with — either it
 * maps to a stored field, keys the row, or is deliberately ignored. Kept
 * next to the mapping in importLeadRows: adding a new `val(row, "x")`
 * there means adding "x" here.
 *
 * The point of the list is the *complement*: the sheet's headers are
 * hand-managed and have renamed once already ("how_many_bedrooms?" became
 * "how_many_bedrooms_do_you_have.?"). When that happens the lead still
 * imports via fingerprint, but the renamed field silently goes blank — the
 * only symptom is emptier lead cards. A non-empty header that isn't in
 * this set is the next rename announcing itself, and it gets surfaced in
 * lead sync state within one sync cycle (see unmappedHeaders).
 */
const KNOWN_HEADERS = new Set([
  // Row identity (see leadKey).
  "id",
  "lead_id",
  "google_lead_id",
  "gclid",
  // Stored fields, verbatim.
  "created_time",
  "campaign_name",
  "ad_name",
  "form_name",
  "platform",
  "service",
  "service_interest",
  "what_service_are_you_interested_in?",
  "please_select_the_service_your_interested_in?",
  "bedrooms",
  "how_many_bedrooms?",
  "how_many_bedrooms_do_you_have.?",
  "bathrooms",
  "how_many_bathrooms?",
  "how_many_bathrooms_do_you_have.?",
  "date_of_service_requested",
  "date_of_service_requested.?",
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
]);
const val = (row: SheetRow, key: string): string | null => {
  const v = row[key];
  return v && v.trim() !== "" ? v : null;
};

type LeadQuestionField =
  "service" | "bedrooms" | "bathrooms" | "dateOfServiceRequested";

/**
 * Form providers rename question headers when a form is copied or edited.
 * Keep this intentionally conservative: only headers whose wording clearly
 * identifies one of the four booking details are promoted to stored fields.
 * The cell value is returned unchanged by importLeadRows.
 */
export function leadQuestionField(header: string): LeadQuestionField | null {
  const normalized = header.trim().toLowerCase();
  if (
    normalized === "preferred_date" ||
    normalized === "preferred_cleaning_date" ||
    (normalized.includes("date") &&
      (normalized.includes("service") ||
        normalized.includes("clean") ||
        normalized.includes("preferred") ||
        normalized.includes("when") ||
        normalized.includes("requested")))
  ) {
    return "dateOfServiceRequested";
  }
  if (
    KNOWN_HEADERS.has(normalized) &&
    [
      "service",
      "service_interest",
      "what_service_are_you_interested_in?",
      "please_select_the_service_your_interested_in?",
    ].includes(normalized)
  ) {
    return "service";
  }
  if (normalized === "how_many_bedrooms?") return "bedrooms";
  if (normalized === "how_many_bathrooms?") return "bathrooms";
  if (
    /(?:^|_)(?:requested_)?service(?:_|$)/.test(normalized) ||
    (normalized.includes("service") &&
      /(what|which|select|interested|type|need|want)/.test(normalized))
  ) {
    return "service";
  }
  if (
    normalized.includes("bedroom") &&
    (normalized === "bedrooms" ||
      normalized.includes("number_of_bedrooms") ||
      normalized.includes("bedroom_count") ||
      normalized.includes("how_many_bedrooms_do_you_have"))
  ) {
    return "bedrooms";
  }
  if (
    normalized.includes("bathroom") &&
    (normalized === "bathrooms" ||
      normalized.includes("number_of_bathrooms") ||
      normalized.includes("bathroom_count") ||
      normalized.includes("how_many_bathrooms_do_you_have"))
  ) {
    return "bathrooms";
  }
  return null;
}

function valueForLeadQuestion(
  row: SheetRow,
  field: LeadQuestionField,
): string | null {
  for (const [header, value] of Object.entries(row)) {
    if (leadQuestionField(header) === field) {
      const nonEmpty = value && value.trim() !== "" ? value : null;
      if (nonEmpty !== null) return nonEmpty;
    }
  }
  return null;
}

/**
 * The idempotency key for one sheet row.
 *
 * Facebook rows carry a unique lead id in `id`. The live Google Ads tab
 * (inspected 2026-08-13) shares the exact same header set, putting a
 * gclid-style value in `id` — so it keys the same way — but a future
 * Google export may drop the column, and a row without it must not be
 * silently dropped. Preference order:
 *  1. The sheet's own `id` (Facebook lead id).
 *  2. Whatever unique-id column a Google Ads export carries (`lead_id`,
 *     `google_lead_id`, `gclid`) — a real id from the source always beats a
 *     derived one, because it survives edits to the row's other cells.
 *  3. A fingerprint of the row's full content, so a re-read of the sheet
 *     maps back to the same lead and never re-imports one that was
 *     dismissed — but only for rows that look like a lead (they carry a
 *     phone, an email, or a name alongside another lead detail — hand-typed
 *     rows often have only a name and address).
 *
 * Blank padding rows (the sheet has ~27 of them), title/footer rows, and
 * rows from tabs that aren't lead exports have no key and are skipped.
 */
export function leadKey(row: SheetRow): string | null {
  // A duplicated header row — exports sometimes echo the header into the
  // data, and every non-empty cell then literally equals its own column
  // name. That's the sheet's furniture, never a person; checked before the
  // explicit-id branch because an echo row carries `id` = "id".
  const filled = Object.entries(row).filter(([, v]) => v && v.trim() !== "");
  if (
    filled.length > 0 &&
    filled.every(([k, v]) => v.trim().toLowerCase() === k)
  ) {
    return null;
  }
  const explicit =
    val(row, "id") ??
    val(row, "lead_id") ??
    val(row, "google_lead_id") ??
    val(row, "gclid");
  if (explicit) return explicit.trim();
  // No id column: only fall back to a fingerprint for a row that is
  // recognizably a lead. Every tab in the sheet gets polled — including ones
  // that aren't lead exports at all — and any of them can hold title, footer
  // or "Total: 27" rows. A phone or an email always qualifies. Rows the
  // owner types in by hand (walk-ins, phone inquiries, referrals) often have
  // neither yet — those qualify on a name PLUS some other lead detail (an
  // address, a service, room counts, a requested date), so a lone note
  // sitting under a name column on some other tab still stays out.
  const hasName = val(row, "first_name") ?? val(row, "last_name");
  const hasLeadDetail =
    val(row, "street_address") ??
    val(row, "city") ??
    val(row, "service") ??
    val(row, "service_interest") ??
    val(row, "what_service_are_you_interested_in?") ??
    val(row, "please_select_the_service_your_interested_in?") ??
    val(row, "bedrooms") ??
    val(row, "how_many_bedrooms?") ??
    val(row, "how_many_bedrooms_do_you_have.?") ??
    val(row, "bathrooms") ??
    val(row, "how_many_bathrooms?") ??
    val(row, "how_many_bathrooms_do_you_have.?") ??
    val(row, "date_of_service_requested") ??
    val(row, "date_of_service_requested.?");
  const looksLikeALead =
    val(row, "phone_number") ??
    val(row, "email") ??
    (hasName && hasLeadDetail ? hasName : null);
  if (!looksLikeALead) return null;
  // Fingerprint the whole row, not a handpicked subset: two distinct id-less
  // leads that happen to share a phone (say, a couple booking separately)
  // still differ somewhere — campaign, address, service — and must not
  // collapse into one. The one excluded column is the sheet's own mutable
  // status, which the owner flips after the fact; including it would
  // re-import an already-handled lead as new the moment it changes.
  const identity = Object.keys(row)
    .filter((k) => k !== "lead_status")
    .sort()
    .map((k) => `${k}=${(row[k] ?? "").trim()}`)
    .filter((pair) => !pair.endsWith("="))
    .join("\n");
  const hash = createHash("sha256").update(identity).digest("hex");
  return `fp_${hash}`;
}

/**
 * Google's boilerplate test lead, present in every Google Ads lead export.
 *
 * Google marks its sample row the same way everywhere: a gclid-style id
 * whose last six characters are literally `SaMple` (that exact casing —
 * real gclids are base64-ish and case matters, so a genuine id ending in
 * that six-character sequence with that casing does not occur in practice).
 * The rest of the row is tester filler ("FirstName LastName",
 * 1 (650) 555-0123, test@example.com, Mountain View) — but the id suffix is
 * the contract Google documents, so it alone decides. Matching on the
 * placeholder values instead would break the day Google reworded them, and
 * worse, could swallow a real lead who happens to live in Mountain View.
 *
 * Facebook's sample row has a different shape and is handled separately.
 */
export function isGoogleSampleLead(sheetLeadId: string): boolean {
  return sheetLeadId.endsWith("SaMple");
}

/**
 * Import one tab's rows for a company. Returns how many were newly inserted.
 * Every non-empty row gets a key (see leadKey); only genuinely blank padding
 * rows are skipped — a Google Ads row without Facebook's `id` column still
 * imports, keyed by its own content.
 */
type LeadImportSummary = {
  rowsSeen: number;
  eligibleRows: number;
  importedRows: number;
  duplicateRows: number;
  skippedRows: number;
};

async function importLeadRowsWithSummary(
  companyId: number,
  sourceTab: string,
  rows: SheetRow[],
): Promise<LeadImportSummary> {
  let rowsSeen = 0;
  let eligibleRows = 0;
  let importedRows = 0;
  let skippedRows = 0;
  for (const row of rows) {
    const hasAnyValue = Object.values(row).some(
      (value) => value && value.trim() !== "",
    );
    if (!hasAnyValue) continue;
    rowsSeen += 1;
    const sheetLeadId = leadKey(row);
    if (!sheetLeadId) {
      skippedRows += 1;
      continue;
    }
    // Google's fake sample row imports fully populated and reads like a real
    // lead on the Leads page; keep it out at the door.
    if (isGoogleSampleLead(sheetLeadId)) {
      skippedRows += 1;
      continue;
    }
    eligibleRows += 1;
    const phoneNumber = val(row, "phone_number");
    const result = await db
      .insert(leadsTable)
      .values({
        companyId,
        source: "sheet",
        externalId: sheetLeadId,
        sourceTab,
        createdTime: val(row, "created_time"),
        campaignName: val(row, "campaign_name"),
        adName: val(row, "ad_name"),
        formName: val(row, "form_name"),
        platform: val(row, "platform"),
        // The sheet names this column differently across exports; take
        // whichever service-interest column is present. The live Aug tabs
        // (both FB and Google Ads, inspected 2026-08-13) use the long
        // form-question headers with a trailing "?" — and the bedroom/
        // bathroom/date ones carry a stray ".?" suffix, kept verbatim here
        // because headers are matched exactly (lowercased) and a "cleaned"
        // variant would silently miss the real column.
        service: valueForLeadQuestion(row, "service"),
        bedrooms: valueForLeadQuestion(row, "bedrooms"),
        bathrooms: valueForLeadQuestion(row, "bathrooms"),
        dateOfServiceRequested: valueForLeadQuestion(
          row,
          "dateOfServiceRequested",
        ),
        firstName: val(row, "first_name"),
        lastName: val(row, "last_name"),
        phoneNumber,
        email: val(row, "email"),
        streetAddress: val(row, "street_address"),
        city: val(row, "city"),
        province: val(row, "province"),
        postCode: val(row, "post_code"),
        inboxUrl: safeInboxUrl(val(row, "inbox_url")),
        sheetLeadStatus: val(row, "lead_status"),
        phoneE164: phoneNumber ? toE164(phoneNumber) : null,
        // This is deliberately set only on a newly inserted sheet row. A
        // durable marker lets a later sync pick up a push missed by a restart,
        // while existing historical sheet leads remain out of Jobber.
        jobberPushPending: true,
      })
      .onConflictDoNothing({
        target: [leadsTable.companyId, leadsTable.externalId],
      })
      .returning({ id: leadsTable.id });
    importedRows += result.length;
  }
  return {
    rowsSeen,
    eligibleRows,
    importedRows,
    duplicateRows: eligibleRows - importedRows,
    skippedRows,
  };
}

export async function importLeadRows(
  companyId: number,
  sourceTab: string,
  rows: SheetRow[],
): Promise<number> {
  return (await importLeadRowsWithSummary(companyId, sourceTab, rows))
    .importedRows;
}

/**
 * Start every durable sheet-to-Jobber handoff after the sheet read is done.
 * A row keeps its marker until the queued push succeeds, fails visibly, or is
 * converted, so a process death after import is recovered by the next poll.
 * The marker is set only on new rows, never on historical sheet leads.
 */
async function schedulePendingSheetLeadPushes(
  companyId: number,
): Promise<void> {
  const [company] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  if (!company) return;

  const leads = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.companyId, companyId),
        eq(leadsTable.source, "sheet"),
        eq(leadsTable.jobberPushPending, true),
      ),
    );
  await Promise.all(leads.map((lead) => scheduleLeadJobberPush(company, lead)));
}

function columnName(columnNumber: number): string {
  let result = "";
  for (let n = columnNumber; n > 0; n = Math.floor((n - 1) / 26)) {
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  }
  return result;
}

/** Build a connector-safe A1 range for a discovered sheet tab. */
export function buildSheetRange(tab: SheetTabMetadata): string {
  const rowCount =
    Number.isInteger(tab.rowCount) && tab.rowCount! > 0 ? tab.rowCount! : 1000;
  const columnCount =
    Number.isInteger(tab.columnCount) && tab.columnCount! > 0
      ? tab.columnCount!
      : 18278;
  return `'${tab.title.replace(/'/g, "''")}'!A1:${columnName(columnCount)}${rowCount}`;
}

async function fetchTab(tab: SheetTabMetadata): Promise<SheetRow[]> {
  // The connector rejects a quoted sheet name without a cell range for some
  // tabs (notably "Lead Dataset Master Table"), even though that is accepted
  // by Google's A1 parser. Use the sheet's actual grid dimensions instead.
  // This is also deliberately not A:Z: hand-managed lead exports can grow
  // past column Z, and the unmapped-header warning must still see those cells.
  return rowsFromValues(await fetchTabValues(tab));
}

async function fetchTabValues(
  tab: SheetTabMetadata,
): Promise<string[][] | undefined> {
  const range = encodeURIComponent(buildSheetRange(tab));
  const res = await connectors.proxy(
    "google-sheet",
    `/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Sheets read failed for "${tab.title}": ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { values?: string[][] };
  return data.values;
}

export type LeadHeaderMapping = {
  header: string;
  destination: LeadQuestionField;
  /** A short, display-only example from the first data row, when present. */
  exampleAnswer?: string;
};

export type LeadsSyncPreviewTab = {
  name: string;
  status: "read" | "failed";
  questionMappings: LeadHeaderMapping[];
  metadataHeaders: string[];
  unmappedHeaders: string[];
  error?: string;
};

function previewTabHeaders(values: string[][] | undefined): {
  questionMappings: LeadHeaderMapping[];
  metadataHeaders: string[];
  unmappedHeaders: string[];
} {
  const headers = (values?.[0] ?? [])
    .map((header) => String(header).trim())
    .filter(Boolean);
  const rows = rowsFromValues(values);
  const activeUnknown = new Set(unmappedHeaders(rows));
  const questionMappings: LeadHeaderMapping[] = [];
  const metadataHeaders: string[] = [];
  for (const header of headers) {
    const normalized = header.toLowerCase();
    const destination = leadQuestionField(normalized);
    if (destination) {
      const answer = rows[0]?.[normalized];
      const exampleAnswer = answer?.trim()
        ? summarizePreviewAnswer(answer)
        : undefined;
      questionMappings.push({
        header,
        destination,
        ...(exampleAnswer ? { exampleAnswer } : {}),
      });
    } else if (KNOWN_HEADERS.has(normalized)) {
      metadataHeaders.push(header);
    }
  }
  return {
    questionMappings,
    metadataHeaders,
    unmappedHeaders: [...activeUnknown].sort(),
  };
}

const PREVIEW_ANSWER_MAX_LENGTH = 80;

/**
 * Keep the preview useful without exposing a whole answer or preserving
 * spreadsheet formatting that could make a sample unexpectedly tall.
 */
export function summarizePreviewAnswer(value: string): string | undefined {
  const compact = value.trim().replace(/\s+/g, " ");
  if (!compact) return undefined;
  return compact.length > PREVIEW_ANSWER_MAX_LENGTH
    ? `${compact.slice(0, PREVIEW_ANSWER_MAX_LENGTH - 1).trimEnd()}…`
    : compact;
}

/**
 * Read the current sheet shape without inserting any leads. This is separate
 * from the sync state so an owner can check a copied form before its first
 * import changes any lead cards.
 */
export async function previewLeadsSync(): Promise<LeadsSyncPreviewTab[]> {
  const tabs = await fetchTabMetadata();
  const previews: LeadsSyncPreviewTab[] = [];
  for (const tab of tabs) {
    try {
      previews.push({
        name: tab.title,
        status: "read",
        ...previewTabHeaders(await fetchTabValues(tab)),
      });
    } catch (err) {
      previews.push({
        name: tab.title,
        status: "failed",
        questionMappings: [],
        metadataHeaders: [],
        unmappedHeaders: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return previews;
}

async function recordSyncState(
  companyId: number,
  error: string | null,
  warning: string | null = null,
  tabStatuses: LeadsSyncTabStatus[] = [],
): Promise<void> {
  const now = new Date();
  await db
    .insert(leadSyncStateTable)
    .values({
      companyId,
      lastSyncAt: now,
      lastSuccessAt: error ? null : now,
      lastError: error,
      lastWarning: warning,
      tabStatuses,
    })
    .onConflictDoUpdate({
      target: leadSyncStateTable.companyId,
      set: {
        lastSyncAt: now,
        lastError: error,
        tabStatuses,
        // The warning reflects the latest *complete* pass, and only that: a
        // clean run that saw no unmapped headers clears it (so a fixed sheet
        // stops warning within one cycle), and a clean run that saw some
        // replaces it. A failed run inspected only part of the sheet — an
        // unreadable tab may still hold the column a standing warning is
        // about — so it never touches the warning at all.
        ...(error ? {} : { lastWarning: warning }),
        ...(error ? {} : { lastSuccessAt: now }),
      },
    });
}

/**
 * The company whose Leads page the sheet feeds.
 *
 * The spreadsheet id is a single constant — this is bookmycleaning's own
 * lead sheet, not per-tenant configuration — so its rows belong to the
 * founding (oldest) company. Other companies' Leads pages simply stay empty
 * until per-company sheet configuration exists.
 *
 * Exported because the public request form resolves its company the same
 * way — one deployment, one inbox — rather than guessing from the request
 * host.
 */
export async function leadsCompanyId(): Promise<number | null> {
  const configuredId = configuredLeadsCompanyId();
  if (configuredId !== undefined) {
    if (configuredId === null) return null;
    const [configuredCompany] = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.id, configuredId))
      .limit(1);
    if (!configuredCompany) {
      logger.error(
        { companyId: configuredId },
        "[leads] configured lead company does not exist",
      );
      return null;
    }
    return configuredCompany.id;
  }

  const [company] = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .orderBy(asc(companiesTable.id))
    .limit(1);
  return company?.id ?? null;
}

export type LeadsSyncResult = {
  imported: number;
  error: string | null;
  tabStatuses: LeadsSyncTabStatus[];
};

export type LeadsSyncTabStatus = {
  name: string;
  status: "read" | "failed";
  error?: string;
  rowsSeen?: number;
  eligibleRows?: number;
  importedRows?: number;
  duplicateRows?: number;
  skippedRows?: number;
  eligibilityWarning?: string;
};

let syncInFlight: Promise<LeadsSyncResult> | null = null;

/**
 * One full sync pass: read every tab, insert what's new, record the outcome.
 * Never throws — the error lands in lead_sync_state (and the return value)
 * where the Leads page shows it, instead of killing the interval.
 */
async function executeLeadsSync(): Promise<LeadsSyncResult> {
  const companyId = await leadsCompanyId();
  if (companyId === null) return { imported: 0, error: null, tabStatuses: [] };

  try {
    const result = await db.transaction(async (tx) => {
      // Serialize whole runs across processes (dev restarts, rolling
      // deploys): the second runner waits, then finds the rows already
      // inserted and skips them via the unique index.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`leads-sync:${companyId}`}))`,
      );
      let imported = 0;
      let error: string | null = null;
      const warnings: string[] = [];
      const tabStatuses: LeadsSyncTabStatus[] = [];
      // Ask the sheet what its tabs are called before reading any of them;
      // if even that fails there is nothing to import this pass.
      let tabs: SheetTabMetadata[] = [];
      try {
        tabs = await fetchTabMetadata();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logger.error({ err }, "[leads] sheet tab list failed");
      }
      for (const tab of tabs) {
        try {
          const rows = await fetchTab(tab);
          // The next header rename announces itself here instead of as
          // quietly blank lead cards. Once per tab, not per row.
          const unknown = unmappedHeaders(rows);
          if (unknown.length > 0) {
            warnings.push(`"${tab.title}": ${unknown.join(", ")}`);
            logger.warn(
              { tab: tab.title, headers: unknown },
              "[leads] sheet has unrecognized non-empty headers",
            );
          }
          const summary = await importLeadRowsWithSummary(
            companyId,
            tab.title,
            rows,
          );
          imported += summary.importedRows;
          tabStatuses.push({
            name: tab.title,
            status: "read",
            ...summary,
            ...(summary.rowsSeen > 0 && summary.eligibleRows === 0
              ? {
                  eligibilityWarning: `${summary.skippedRows} non-empty ${
                    summary.skippedRows === 1 ? "row was" : "rows were"
                  } intentionally skipped because ${
                    summary.skippedRows === 1 ? "it did" : "they did"
                  } not qualify as a lead.`,
                }
              : {}),
          });
        } catch (err) {
          // One unreadable tab must not hide the other's new leads.
          error = err instanceof Error ? err.message : String(err);
          tabStatuses.push({
            name: tab.title,
            status: "failed",
            error,
          });
          logger.error(
            { err, tab: tab.title },
            "[leads] sheet tab read failed",
          );
        }
      }
      const warning =
        warnings.length > 0
          ? `The leads sheet has columns this import doesn't recognize — ${warnings.join(
              "; ",
            )}. Values in them aren't being saved to lead cards.`
          : null;
      await recordSyncState(companyId, error, warning, tabStatuses);
      if (imported > 0) {
        logger.info({ imported }, "[leads] imported new leads");
        // Nudge the geocoder so fresh leads land on the Leads map within a
        // sync cycle, not whenever the ten-minute backfill next wakes up.
        // Fire-and-forget: pin placement must never fail the sync itself.
        // NEVER in tests: the suite shares the dev DB and injects a
        // null-returning stub geocoder — letting this run there would cache
        // "unplaceable" for every real lead address for a month.
        if (process.env["NODE_ENV"] !== "test") {
          void import("./geocodeBackfill").then(({ runGeocodeBackfill }) =>
            runGeocodeBackfill().catch((err) =>
              logger.warn({ err }, "[leads] post-sync geocode pass failed"),
            ),
          );
        }
      }
      return { imported, error, tabStatuses };
    });
    void schedulePendingSheetLeadPushes(companyId).catch((err) =>
      logger.warn({ err }, "[leads] automatic Jobber push scheduling failed"),
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[leads] sync failed");
    await recordSyncState(companyId, message, null, []).catch(() => {});
    return { imported: 0, error: message, tabStatuses: [] };
  }
}

/**
 * Collapse concurrent timer, web and mobile wake-ups into one connector read.
 * The advisory lock still protects against a second deployment process.
 */
export function runLeadsSync(): Promise<LeadsSyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = executeLeadsSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/**
 * Autoscaled deployments may sleep through interval callbacks. A normal Leads
 * refresh wakes the service, and if three poll windows were missed this runs
 * one catch-up pass before returning the inbox/status.
 */
export async function refreshLeadsSyncIfStale(
  companyId: number,
): Promise<void> {
  if (process.env["NODE_ENV"] === "test") return;
  const destinationCompanyId = await leadsCompanyId();
  if (destinationCompanyId !== companyId) return;
  const [state] = await db
    .select({ lastSyncAt: leadSyncStateTable.lastSyncAt })
    .from(leadSyncStateTable)
    .where(eq(leadSyncStateTable.companyId, companyId))
    .limit(1);
  if (isLeadsSyncStale(state?.lastSyncAt)) {
    await runLeadsSync();
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the background poller. Singleton per process; timers never hold the process open. */
export function startLeadsSync(): void {
  if (timer) return;
  const run = () => void runLeadsSync();
  setTimeout(run, INITIAL_DELAY_MS).unref();
  timer = setInterval(run, LEADS_SYNC_INTERVAL_MS);
  timer.unref();
  logger.info(
    { intervalMs: LEADS_SYNC_INTERVAL_MS },
    "[leads] sheet sync poller started",
  );
}

/**
 * The headers in a tab that carry data but map to no stored field.
 *
 * Only headers with at least one non-empty cell count: the sheet keeps
 * legacy columns around empty (both bedroom spellings exist side by side),
 * and warning about a column nobody fills would train the owner to ignore
 * the banner. Computed once per tab, not per row.
 */
export function unmappedHeaders(rows: SheetRow[]): string[] {
  const found = new Set<string>();
  for (const row of rows) {
    for (const [header, cell] of Object.entries(row)) {
      if (KNOWN_HEADERS.has(header) || leadQuestionField(header)) continue;
      if (cell && cell.trim() !== "") found.add(header);
    }
  }
  return [...found].sort();
}
