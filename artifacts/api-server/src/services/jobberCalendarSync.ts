/**
 * Pulls scheduled *visits* out of Jobber and onto our calendar and map.
 *
 * The outbound sync in routes/bookings.ts pushes a booking we took into Jobber
 * as a work request. This is the other direction: an owner who books most of
 * their work in Jobber still expects it to show up on the schedule and the
 * live map, and typing it in twice is not a plan.
 *
 * Why visits and not jobs: a recurring client is ONE Jobber job with a visit
 * per clean. An earlier version of this sync imported jobs, which put a weekly
 * customer on the board once — at the job's first-ever date — and never again.
 * Visits are what Jobber's own calendar draws, and they also say who is
 * assigned, which is what lets the schedule colour a chip by cleaner the way
 * Jobber does.
 *
 * Rules that keep the directions from fighting:
 *   - An imported booking is tagged with `jobberVisitId` (and carries its
 *     parent `jobberSyncedJobId` for the time-sheet pull). Nothing else is
 *     ever touched by this sync, so a booking taken by the AI receptionist can
 *     never be overwritten or cancelled by a Jobber pull.
 *   - Rows created by the old job-keyed sync are *adopted* — the earliest
 *     visit of the same job claims the row instead of inserting a duplicate —
 *     so clocked hours and history attached to them survive the switch.
 *   - Coordinates are left to the existing geocode backfill. Import writes the
 *     address; the backfill turns it into a pin a few minutes later, exactly
 *     as it does for bookings we take ourselves.
 */
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
} from "drizzle-orm";
import {
  db,
  companiesTable,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  jobberConnectionsTable,
  type Company,
  type JobberConnection,
} from "@workspace/db";
import {
  getValidAccessToken,
  getValidConnectionToken,
  jobberGraphql,
} from "../lib/jobber";
import { companyDayBounds } from "../lib/dayBounds";
import { logger } from "../lib/logger";
import { syncCompanyTimeSheets } from "./jobberTimeSheetSync";
// Runtime-only circular reference (catch-up calls back into
// syncCompanyCalendar); both sides touch the other only inside async
// functions invoked long after module init, so ESM resolves it safely.
import { runJobberHistoryCatchup } from "./jobberHistoryCatchup";
import { syncCompanyJobberQuotes } from "./jobberQuoteSync";
import { syncCompanyJobberInvoices } from "./jobberInvoiceSync";
import { syncCompanyJobberRequests } from "./jobberRequestSync";
import { sweepJobberRequestLeads } from "./jobberRequestLeads";
import { recordClientContact } from "./clientDirectory";

/**
 * How often the background pull runs.
 *
 * Two minutes, not one: every run re-reads the whole nine-month window for
 * every connected company (up to 60 pages each), so the floor is set by
 * Jobber's rate limits and by not hammering our own database, while still
 * being fast enough that a job booked in Jobber shows up here before the
 * owner thinks to look for it. The in-flight guard below keeps a slow run
 * from overlapping the next tick.
 */
export const JOBBER_SYNC_INTERVAL_MS = 2 * 60 * 1000;
/**
 * Rolling window the poller keeps fresh: three months back, six months ahead.
 *
 * It reaches backwards because the map answers "where are my clients", not
 * just "where is the crew today" — a house cleaned monthly is invisible on a
 * 60-day forward window if its last visit was in the spring. Both spans are
 * where the owner drew the line: far enough to catch occasional clients and
 * recurring cleans booked well ahead, short enough that the calendar isn't
 * buried in work nobody is thinking about yet.
 */
export const WINDOW_BACK_DAYS = 90;
const WINDOW_FORWARD_DAYS = 180;
/**
 * Small pages on purpose. Jobber prices a query by what it *could* return
 * (page size × nested assignee page size), and this account's rate budget
 * is shared with the production poller and the time-sheet sync — a big
 * page gets Throttled whenever the budget is half-drained, while a cheap
 * one slips through. MAX_PAGES is the hard stop so one runaway account
 * can't page forever; the window spans nine months of individual visits,
 * so the ceiling (40 × 150 = 6,000 visits) has to clear a busy account's
 * real volume — hitting it silently disables the cancellation sweep.
 */
const PAGE_SIZE = 40;
const MAX_PAGES = 150;
/** More people than any residential crew; Jobber pages assignees too. */
const ASSIGNEES_PER_VISIT = 10;

export type JobberVisitAssignedUser = {
  id: string;
  name: { full: string | null } | null;
};

export type JobberCalendarVisit = {
  id: string;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  /** Set when the visit was marked complete in Jobber. */
  completedAt: string | null;
  assignedUsers: { nodes: JobberVisitAssignedUser[] } | null;
  job: {
    id: string;
    client: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
    } | null;
    property: {
      address: {
        street: string | null;
        city: string | null;
        province: string | null;
        postalCode: string | null;
      } | null;
    } | null;
  } | null;
};

export type CalendarSyncResult = {
  imported: number;
  updated: number;
  skipped: number;
  canceled: number;
  jobberCount: number;
  hitPageLimit: boolean;
  /**
   * Every page arrived and parsed, and the page ceiling was never reached —
   * the pull covered the whole requested window. The history catch-up only
   * advances its resume cursor on a complete pull.
   */
  pullComplete: boolean;
  /**
   * Visits Jobber returned that we failed to WRITE (upsert threw). Distinct
   * from `skipped` (benign: unparseable dates, other-company rows). The
   * rolling window retries these every cycle for free, but the one-time
   * history catch-up must not advance its durable cursor past a slice that
   * didn't fully persist — those dates never come back into the window.
   */
  persistFailures: number;
};

const EMPTY_RESULT: CalendarSyncResult = {
  imported: 0,
  updated: 0,
  skipped: 0,
  canceled: 0,
  jobberCount: 0,
  hitPageLimit: false,
  // A skipped run (not connected, already in flight) proved nothing about
  // the window, so it must never advance a completeness-gated cursor.
  pullComplete: false,
  persistFailures: 0,
};

const VISITS_QUERY = `
  query SyncCalendarVisits($filter: VisitFilterAttributes, $first: Int!, $after: String, $assignees: Int!) {
    visits(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        title
        startAt
        endAt
        completedAt
        assignedUsers(first: $assignees) { nodes { id name { full } } }
        job {
          id
          client { id firstName lastName phone }
          property { address { street city province postalCode } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** "12 Main St, Calgary, AB T2P 1J9" from Jobber's address parts. */
export function formatJobberAddress(visit: JobberCalendarVisit): string | null {
  const a = visit.job?.property?.address;
  if (!a) return null;
  const line = [a.street, a.city, a.province].filter(Boolean).join(", ");
  const full = [line, a.postalCode].filter(Boolean).join(" ").trim();
  return full.length > 0 ? full : null;
}

/** The name a dispatcher will recognise on the map. */
export function jobberCustomerName(visit: JobberCalendarVisit): string {
  const person = [visit.job?.client?.firstName, visit.job?.client?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (person) return person;
  // No client on the job — the title is the only human-readable handle left.
  return visit.title?.trim() || "Jobber visit";
}

/** Minutes between start and end, when Jobber gave us both. */
export function jobberDurationMinutes(
  visit: JobberCalendarVisit,
): number | null {
  if (!visit.startAt || !visit.endAt) return null;
  const start = new Date(visit.startAt).getTime();
  const end = new Date(visit.endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.round((end - start) / 60_000);
}

/* ────────────────── matching Jobber staff to the roster ────────────────── */

export type RosterMember = { id: number; name: string };

/**
 * Fold a human name down to something two systems can agree on: lowercase,
 * accents stripped, punctuation gone, and bare numbers dropped — Jobber
 * rosters carry sort-hack prefixes like "1 Joseph Juma", and this roster
 * carries decorations like `Richard "BOSS"`.
 */
export function normalizeStaffName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !/^\d+$/.test(token))
    .join(" ");
}

/**
 * Who on the roster is this Jobber user? Tried strictest first:
 *
 *   1. exact   — "1 Joseph Juma" ↔ "Joseph Juma"
 *   2. prefix  — "Sergine Ngongang wetie" ↔ "Sergine",
 *                "Jen & Bryan Cabugon" ↔ "Jen & Bryan"
 *   3. first name — "Joel MBATCHOU" ↔ "Joel Djankam" (spelled differently
 *                past the first name, but the only Joel on the team)
 *
 * A tier that yields two candidates is ambiguous, and ambiguity means no
 * match: colouring a job with the wrong cleaner is worse than leaving it
 * uncoloured for the owner to fix.
 */
export function matchAssigneesToRoster(
  assigneeNames: string[],
  roster: RosterMember[],
): { matchedIds: number[]; unmatched: string[] } {
  const members = roster
    .map((m) => ({ id: m.id, norm: normalizeStaffName(m.name) }))
    .filter((m) => m.norm.length > 0);

  const matchedIds: number[] = [];
  const unmatched: string[] = [];

  for (const raw of assigneeNames) {
    const norm = normalizeStaffName(raw);
    if (!norm) continue;

    const exact = members.filter((m) => m.norm === norm);
    const prefix =
      exact.length > 0
        ? []
        : members.filter((m) => norm.startsWith(`${m.norm} `));
    const firstToken = norm.split(" ")[0]!;
    const byFirstName =
      exact.length > 0 || prefix.length > 0
        ? []
        : members.filter((m) => m.norm.split(" ")[0] === firstToken);

    const tier =
      exact.length > 0 ? exact : prefix.length > 0 ? prefix : byFirstName;
    if (tier.length === 1) matchedIds.push(tier[0]!.id);
    else unmatched.push(raw.trim());
  }

  return {
    matchedIds: [...new Set(matchedIds)],
    unmatched: [...new Set(unmatched)],
  };
}

/** A roster member together with their stored Jobber link, if any. */
export type LinkedRosterMember = RosterMember & { jobberUserId: string | null };

export type AssigneeResolution = {
  jobberUserId: string;
  name: string;
  teamMemberId: number | null;
  /** How the match was made — a stored link, a name match, or not at all. */
  via: "link" | "name" | null;
};

/**
 * Resolve Jobber's assigned users onto the roster. A stored link always wins
 * — that's the whole point of links: renaming someone on either side changes
 * nothing. Name matching (the exact tiers above) remains the fallback, but
 * only for staff with no link of their own; a linked member's visits arrive
 * by id, so their name must never grab a different Jobber user's work.
 *
 * Name matches are only honoured when they're one-to-one across the whole
 * batch: if two DIFFERENT Jobber users both land on the same seat (two
 * "Alex"es in Jobber, one Alex here), the name proved nothing about who is
 * who — matching either would attach the wrong person's work to that seat.
 * Both walk away unmatched and the owner links them by hand on the Team page.
 *
 * The Team page's suggested-match preview calls this same function, so what
 * the owner is shown is exactly what a sync would do.
 */
export function resolveAssigneesToRoster(
  assignees: Array<{ id: string; name: string }>,
  roster: LinkedRosterMember[],
): AssigneeResolution[] {
  const byJobberId = new Map<string, number>();
  for (const m of roster) {
    if (m.jobberUserId) byJobberId.set(m.jobberUserId, m.id);
  }
  const unlinked = roster.filter((m) => !m.jobberUserId);

  const provisional = assignees.map((a) => {
    const linked = byJobberId.get(a.id);
    if (linked !== undefined) {
      return {
        jobberUserId: a.id,
        name: a.name,
        teamMemberId: linked,
        via: "link" as const,
      };
    }
    const { matchedIds } = matchAssigneesToRoster([a.name], unlinked);
    if (matchedIds.length === 1) {
      return {
        jobberUserId: a.id,
        name: a.name,
        teamMemberId: matchedIds[0]!,
        via: "name" as const,
      };
    }
    return { jobberUserId: a.id, name: a.name, teamMemberId: null, via: null };
  });

  // The one-to-one rule: count how many distinct Jobber users name-matched
  // each seat. The same user appearing twice in a batch is the same person,
  // not a collision.
  const claimants = new Map<number, Set<string>>();
  for (const r of provisional) {
    if (r.via !== "name") continue;
    const set = claimants.get(r.teamMemberId) ?? new Set<string>();
    set.add(r.jobberUserId);
    claimants.set(r.teamMemberId, set);
  }
  return provisional.map((r) =>
    r.via === "name" && claimants.get(r.teamMemberId)!.size > 1
      ? {
          jobberUserId: r.jobberUserId,
          name: r.name,
          teamMemberId: null,
          via: null,
        }
      : r,
  );
}

/**
 * The last set of unmatchable Jobber names we logged, per company. The sync
 * runs every two minutes; the owner needs to hear "rename these in Team"
 * once, not thirty times an hour.
 */
const lastUnmatchedByCompany = new Map<number, string>();

function reportUnmatchedAssignees(
  companyId: number,
  unmatched: Set<string>,
): void {
  const key = [...unmatched].sort().join("|");
  if (lastUnmatchedByCompany.get(companyId) === key) return;
  lastUnmatchedByCompany.set(companyId, key);
  if (unmatched.size === 0) return;
  logger.info(
    { companyId, names: [...unmatched].sort() },
    "Jobber calendar sync: assignees with no roster match — matching their Team name will colour their jobs",
  );
}

/* ───────────────────────────── the sync ───────────────────────────── */

/**
 * One company at a time, and never twice at once. The poller and an owner
 * hitting "Sync now" would otherwise race each other into duplicate inserts.
 */
const inFlight = new Set<number>();

export async function syncCompanyCalendar(
  company: Company,
  connection: JobberConnection | null = null,
  options: { startDate?: string; endDate?: string; sweep?: boolean } = {},
): Promise<CalendarSyncResult> {
  // A named connection owns its own authorization state. The legacy company
  // flag only applies when no connection row is available; otherwise one
  // expired primary would incorrectly suppress every healthy secondary.
  if (
    !company.jobberConnected ||
    (connection === null && company.jobberNeedsReauth)
  ) {
    return { ...EMPTY_RESULT };
  }
  if (inFlight.has(company.id)) return { ...EMPTY_RESULT };
  inFlight.add(company.id);
  try {
    return await runSync(company, connection, options);
  } finally {
    inFlight.delete(company.id);
  }
}

async function runSync(
  company: Company,
  connection: JobberConnection | null,
  options: { startDate?: string; endDate?: string; sweep?: boolean },
): Promise<CalendarSyncResult> {
  const today = companyDayBounds(undefined, company.timezone).date;
  const startDate = options.startDate ?? shiftDate(today, -WINDOW_BACK_DAYS);
  const endDate = options.endDate ?? shiftDate(today, WINDOW_FORWARD_DAYS);

  // Window boundaries in the company's zone, so a visit at 8am local is
  // inside the day the owner thinks it is.
  const windowStart = companyDayBounds(startDate, company.timezone).start;
  const windowEnd = companyDayBounds(endDate, company.timezone).end;

  // Use the specific connection's credentials when syncing a named Jobber
  // account; fall back to the legacy company-level token for companies that
  // have not yet been migrated to the connections table.
  const accessToken = connection
    ? await getValidConnectionToken(connection)
    : await getValidAccessToken(company);

  const visits: JobberCalendarVisit[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let hitPageLimit = false;
  /**
   * Did Jobber hand us its complete inventory for this window?
   *
   * Only a complete pull may drive cancellations. Everything else — a page
   * that came back without a payload, a response missing its pagination
   * block — means "we don't know what Jobber has", and the difference between
   * "not in the pull" and "canceled in Jobber" collapses. Getting that wrong
   * now wipes nine months of a company's calendar, so absence of evidence
   * must never be read as evidence of cancellation.
   */
  let pullComplete = true;

  type VisitsPage = {
    nodes: JobberCalendarVisit[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };

  do {
    const data: { visits: VisitsPage } = await jobberGraphql<{
      visits: VisitsPage;
    }>(accessToken, VISITS_QUERY, {
      filter: {
        startAt: {
          after: windowStart.toISOString(),
          before: windowEnd.toISOString(),
        },
      },
      first: PAGE_SIZE,
      after: cursor,
      assignees: ASSIGNEES_PER_VISIT,
    });

    const page = data?.visits;
    if (!page?.nodes || !page.pageInfo) {
      // A shape we don't recognise. Import nothing further and, crucially,
      // don't let the sweep treat this truncated pull as the whole truth.
      pullComplete = false;
      logger.warn(
        { companyId: company.id, pages },
        "Jobber calendar sync: incomplete page, skipping cancellation sweep",
      );
      break;
    }
    visits.push(...page.nodes);
    pages += 1;
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor && pages >= MAX_PAGES) {
      hitPageLimit = true;
      cursor = null;
    }
  } while (cursor);

  // Every active seat once per run, not per visit. Inactive staff don't get
  // new work pinned on them by a background pull.
  const roster: LinkedRosterMember[] = await db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      jobberUserId: teamMembersTable.jobberUserId,
    })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.companyId, company.id),
        eq(teamMembersTable.active, true),
      ),
    );

  // Resolve every assignee this pull mentioned in ONE batch, so the
  // one-to-one rule sees the whole picture: two same-named Jobber users on
  // different visits still collide, instead of the first visit's user
  // quietly claiming the seat for itself. Name matches remain provisional
  // until the owner confirms a link on the Team page.
  const assigneesById = new Map<string, { id: string; name: string }>();
  for (const v of visits) {
    for (const u of v.assignedUsers?.nodes ?? []) {
      if (u?.id && !assigneesById.has(u.id)) {
        assigneesById.set(u.id, { id: u.id, name: u.name?.full?.trim() ?? "" });
      }
    }
  }
  const resolutions = resolveAssigneesToRoster(
    [...assigneesById.values()],
    roster,
  );
  const seatByJobberUser = new Map(
    resolutions.map((r) => [r.jobberUserId, r.teamMemberId]),
  );
  const unmatched = new Set(
    resolutions.flatMap((r) =>
      r.teamMemberId === null && r.name ? [r.name] : [],
    ),
  );

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let persistFailures = 0;

  // Earliest first, so when several visits share a job the first one adopts
  // the old job-keyed row (and its clocked hours) deterministically.
  const ordered = [...visits].sort((a, b) =>
    (a.startAt ?? "").localeCompare(b.startAt ?? ""),
  );

  for (const visit of ordered) {
    try {
      const outcome = await upsertVisit(
        company,
        connection,
        visit,
        seatByJobberUser,
      );
      if (outcome === "imported") imported += 1;
      else if (outcome === "updated") updated += 1;
      else skipped += 1;
    } catch (err) {
      // A write that THREW is not a benign skip: the visit exists in Jobber
      // but not here. Counted apart so completeness-gated callers (the
      // history catch-up) can refuse to move on past it.
      persistFailures += 1;
      logger.warn(
        { err, companyId: company.id, jobberVisitId: visit.id },
        "Jobber calendar sync: could not import a visit",
      );
    }
  }

  reportUnmatchedAssignees(company.id, unmatched);

  // Every customer this pull saw belongs in the client directory — one call
  // per distinct client, not per visit. recordClientContact never throws, so
  // a directory hiccup cannot cost the import that already happened.
  const directoryClients = new Map<string, JobberCalendarVisit>();
  for (const v of visits) {
    const client = v.job?.client;
    const key = client?.id ?? client?.phone ?? null;
    if (client && key && !directoryClients.has(key)) {
      directoryClients.set(key, v);
    }
  }
  for (const v of directoryClients.values()) {
    const client = v.job!.client!;
    const person = [client.firstName, client.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!person) continue;
    const a = v.job?.property?.address;
    await recordClientContact(company.id, {
      name: person,
      phone: client.phone,
      streetAddress: a?.street,
      city: a?.city,
      province: a?.province,
      postalCode: a?.postalCode,
      jobberClientId: client.id,
      source: "jobber",
    });
  }

  // Cancel only off a pull we know is the whole window: every page received
  // and understood, and the page ceiling never reached. Callers importing
  // history slices (options.sweep === false) never sweep at all — a visit
  // absent from an old slice was never imported, not canceled.
  const canceled =
    options.sweep === false || hitPageLimit || !pullComplete
      ? 0
      : await sweepCanceled(
          company,
          connection,
          windowStart,
          windowEnd,
          visits.map((v) => v.id),
        );

  return {
    imported,
    updated,
    skipped,
    canceled,
    jobberCount: visits.length,
    hitPageLimit,
    pullComplete: pullComplete && !hitPageLimit,
    persistFailures,
  };
}

/** Shift a YYYY-MM-DD by whole days, anchored at noon so DST can't bite. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

type ExistingRow = {
  id: number;
  customerAddress: string | null;
  customerPhone: string;
  status: string;
};

const existingRowColumns = {
  id: bookingsTable.id,
  customerAddress: bookingsTable.customerAddress,
  customerPhone: bookingsTable.customerPhone,
  status: bookingsTable.status,
};

async function upsertVisit(
  company: Company,
  connection: JobberConnection | null,
  visit: JobberCalendarVisit,
  /** The run's settled verdict per Jobber user id — see runSync. */
  seatByJobberUser: Map<string, number | null>,
): Promise<"imported" | "updated" | "skipped"> {
  // An unscheduled visit has nowhere to sit on a calendar.
  if (!visit.startAt) return "skipped";
  const scheduledFor = new Date(visit.startAt);
  if (Number.isNaN(scheduledFor.getTime())) return "skipped";
  // No parent job means no way to tie clocked hours back to this row later —
  // and a payload that half-formed isn't something to key a calendar row
  // off. Skipping is sweep-safe: every id Jobber returned counts as seen, so
  // an existing row for this visit is left exactly as it was.
  if (!visit.job?.id) return "skipped";
  const jobId = visit.job.id;
  // A legacy row has no source connection. Only the primary that mirrors the
  // same recorded Jobber account may claim it: a newly added secondary must
  // never adopt or cancel an old row that might belong to another workspace.
  const canClaimLegacy =
    connection?.isPrimary === true &&
    company.jobberAccountId === connection.accountId;
  const sourceScope = connection
    ? canClaimLegacy
      ? or(
          eq(bookingsTable.jobberConnectionId, connection.id),
          isNull(bookingsTable.jobberConnectionId),
        )
      : eq(bookingsTable.jobberConnectionId, connection.id)
    : isNull(bookingsTable.jobberConnectionId);

  const address = formatJobberAddress(visit);
  const fields = {
    customerName: jobberCustomerName(visit),
    customerPhone: visit.job?.client?.phone ?? "",
    customerAddress: address,
    service: visit.title?.trim() || "Jobber visit",
    scheduledFor,
    durationMinutes: jobberDurationMinutes(visit),
  };

  let [existing]: Array<ExistingRow | undefined> = await db
    .select(existingRowColumns)
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberVisitId, visit.id),
        sourceScope,
      ),
    );

  // A job this app put on the Jobber calendar comes back around on the very
  // next pull. It is the same clean, not a new one: adopt the booking we
  // already have rather than importing a second copy of it.
  if (!existing)
    existing = await adoptAppScheduledRow(
      company,
      connection,
      canClaimLegacy,
      visit,
    );

  if (!existing)
    existing = await adoptLegacyJobRow(
      company,
      connection,
      canClaimLegacy,
      visit,
    );

  if (!existing) {
    const inserted = await db
      .insert(bookingsTable)
      .values({
        companyId: company.id,
        callId: null,
        ...fields,
        // It's on the calendar in Jobber, so it's a real commitment — not a
        // lead waiting to be confirmed. Already ticked off in Jobber means
        // it lands here as done, so the schedule shows it checked off.
        status: visit.completedAt ? "completed" : "confirmed",
        jobberVisitId: visit.id,
        jobberConnectionId: connection?.id ?? null,
        jobberSyncedJobId: jobId,
        jobberSynced: true,
      })
      // Two sync processes can race past the row-exists check above (a
      // rolling deploy runs two instances at once). The partial unique index
      // on (company_id, jobber_visit_id) turns the loser's insert into a
      // no-op instead of a duplicate chip on the calendar.
      .onConflictDoNothing()
      .returning({ id: bookingsTable.id });
    if (inserted.length === 0) {
      // Lost that race; the winner's row gets updated on the next cycle.
      return "skipped";
    }
    await applyJobberAssignments(inserted[0]!.id, visit, seatByJobberUser);
    return "imported";
  }

  // Jobber knowing less than we do must not erase what we know: a visit that
  // comes back without a phone or an address (Jobber only fills those in from
  // the client record) leaves the booking's own details standing.
  const effectiveAddress = address ?? existing.customerAddress;
  // A moved address must lose its old pin, or the map keeps showing the crew
  // the house the customer used to live at until someone notices.
  const addressChanged =
    (existing.customerAddress ?? null) !== effectiveAddress;
  await db
    .update(bookingsTable)
    .set({
      ...fields,
      customerPhone: fields.customerPhone || existing.customerPhone,
      customerAddress: effectiveAddress,
      // Reappearing in Jobber un-cancels a visit the previous sweep cancelled.
      // Completion flows one way, from either side: ticked off in Jobber marks
      // the booking done here, and a booking already completed locally (say,
      // by a cleaner's timer) never gets knocked back to "confirmed" just
      // because Jobber hasn't caught up yet.
      status:
        visit.completedAt || existing.status === "completed"
          ? "completed"
          : "confirmed",
      // The parent job id rides along on every write — time sheets key off
      // it, and the guard above means it is always present here.
      jobberSyncedJobId: jobId,
      jobberConnectionId: connection?.id ?? null,
      ...(addressChanged ? { lat: null, lng: null, geocodedAt: null } : {}),
    })
    .where(eq(bookingsTable.id, existing.id));
  await applyJobberAssignments(existing.id, visit, seatByJobberUser);
  return "updated";
}

/**
 * The booking this app scheduled into Jobber, coming back on the pull.
 *
 * Matched on the ids we recorded when we created the job — the visit id when
 * Jobber handed one over, otherwise the parent job id for a booking whose
 * visit was still being generated. Claiming it stamps the inbound ids on the
 * row, which is also what stops the outbound push from ever touching it
 * again: from here on the visit belongs to Jobber's calendar.
 *
 * Without this the very next pull would import the clean a second time and
 * the owner would be looking at two of everything.
 */
async function adoptAppScheduledRow(
  company: Company,
  connection: JobberConnection | null,
  canClaimLegacy: boolean,
  visit: JobberCalendarVisit,
): Promise<ExistingRow | undefined> {
  const jobId = visit.job?.id;
  if (!jobId) return undefined;

  const [candidate] = await db
    .select(existingRowColumns)
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        isNull(bookingsTable.jobberVisitId),
        connection
          ? canClaimLegacy
            ? or(
                isNull(bookingsTable.jobberConnectionId),
                eq(bookingsTable.jobberConnectionId, connection.id),
              )
            : eq(bookingsTable.jobberConnectionId, connection.id)
          : isNull(bookingsTable.jobberConnectionId),
        or(
          eq(bookingsTable.jobberCreatedVisitId, visit.id),
          and(
            eq(bookingsTable.jobberCreatedJobId, jobId),
            isNull(bookingsTable.jobberCreatedVisitId),
          ),
        ),
      ),
    )
    .limit(1);
  if (!candidate) return undefined;

  const claimed = await db
    .update(bookingsTable)
    .set({
      jobberVisitId: visit.id,
      jobberConnectionId: connection?.id ?? null,
      jobberSyncedJobId: jobId,
      jobberCreatedVisitId: visit.id,
      jobberSynced: true,
    })
    .where(
      and(
        eq(bookingsTable.id, candidate.id),
        isNull(bookingsTable.jobberVisitId),
      ),
    )
    .returning({ id: bookingsTable.id });
  return claimed.length > 0 ? candidate : undefined;
}

/**
 * The job-keyed era left one row per Jobber job. The earliest visit of that
 * job claims the row — conditionally, so a re-entrant run can't hand the same
 * row to two visits — and everything hanging off it (clocked hours, history)
 * survives the switch to visit-keyed rows.
 */
async function adoptLegacyJobRow(
  company: Company,
  connection: JobberConnection | null,
  canClaimLegacy: boolean,
  visit: JobberCalendarVisit,
): Promise<ExistingRow | undefined> {
  const jobId = visit.job?.id;
  if (!jobId) return undefined;

  const [candidate] = await db
    .select(existingRowColumns)
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        eq(bookingsTable.jobberSyncedJobId, jobId),
        isNull(bookingsTable.jobberVisitId),
        connection
          ? canClaimLegacy
            ? or(
                isNull(bookingsTable.jobberConnectionId),
                eq(bookingsTable.jobberConnectionId, connection.id),
              )
            : eq(bookingsTable.jobberConnectionId, connection.id)
          : isNull(bookingsTable.jobberConnectionId),
      ),
    )
    .orderBy(bookingsTable.scheduledFor)
    .limit(1);
  if (!candidate) return undefined;

  const claimed = await db
    .update(bookingsTable)
    .set({
      jobberVisitId: visit.id,
      jobberConnectionId: connection?.id ?? null,
    })
    .where(
      and(
        eq(bookingsTable.id, candidate.id),
        isNull(bookingsTable.jobberVisitId),
      ),
    )
    .returning({ id: bookingsTable.id });
  return claimed.length > 0 ? candidate : undefined;
}

/**
 * Mirror Jobber's crew onto the booking — that's what colours the chip.
 *
 * Two deliberate softenings:
 *   - Jobber names nobody (or nobody we can match): leave the booking's crew
 *     alone. An owner who hand-assigned someone here must not lose that to a
 *     background pull that knows less than they do.
 *   - At least one match: Jobber is the source of truth for its own visits,
 *     so the crew becomes exactly the matched set.
 */
async function applyJobberAssignments(
  bookingId: number,
  visit: JobberCalendarVisit,
  /** The run's settled verdict per Jobber user id — resolved and adopted
      once per run in runSync, so every visit agrees on who everyone is. */
  seatByJobberUser: Map<string, number | null>,
): Promise<void> {
  const assigneeIds = (visit.assignedUsers?.nodes ?? []).flatMap((u) =>
    u?.id ? [u.id] : [],
  );
  if (assigneeIds.length === 0) return;

  const matchedIds = [
    ...new Set(
      assigneeIds.flatMap((id) => {
        const seat = seatByJobberUser.get(id);
        return seat === null || seat === undefined ? [] : [seat];
      }),
    ),
  ];
  if (matchedIds.length === 0) return;

  const current = await db
    .select({ teamMemberId: bookingAssignmentsTable.teamMemberId })
    .from(bookingAssignmentsTable)
    .where(eq(bookingAssignmentsTable.bookingId, bookingId));
  const have = new Set(current.map((c) => c.teamMemberId));
  const want = new Set(matchedIds);

  const toAdd = matchedIds.filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !want.has(id));
  if (toAdd.length === 0 && toRemove.length === 0) return;

  if (toRemove.length > 0) {
    await db
      .delete(bookingAssignmentsTable)
      .where(
        and(
          eq(bookingAssignmentsTable.bookingId, bookingId),
          inArray(bookingAssignmentsTable.teamMemberId, toRemove),
        ),
      );
  }
  if (toAdd.length > 0) {
    await db
      .insert(bookingAssignmentsTable)
      .values(toAdd.map((teamMemberId) => ({ bookingId, teamMemberId })))
      .onConflictDoNothing();
  }
}

/**
 * Visits we imported that have since vanished from Jobber were cancelled or
 * deleted there. Mark them cancelled rather than deleting: the owner's history
 * (and any deposit taken against them) has to survive.
 *
 * Rows still keyed only by job id are the same story — after adoption has had
 * its chance, a job-era row with no live visit left to claim it corresponds
 * to nothing on Jobber's calendar.
 *
 * Only ever touches rows this sync created — an untagged booking is ours.
 */
async function sweepCanceled(
  company: Company,
  connection: JobberConnection | null,
  windowStart: Date,
  windowEnd: Date,
  seenVisitIds: string[],
): Promise<number> {
  try {
    const seen = new Set(seenVisitIds);
    const canClaimLegacy =
      connection?.isPrimary === true &&
      company.jobberAccountId === connection.accountId;
    const sourceScope = connection
      ? canClaimLegacy
        ? or(
            eq(bookingsTable.jobberConnectionId, connection.id),
            isNull(bookingsTable.jobberConnectionId),
          )
        : eq(bookingsTable.jobberConnectionId, connection.id)
      : isNull(bookingsTable.jobberConnectionId);
    const rows = await db
      .select({
        id: bookingsTable.id,
        jobberVisitId: bookingsTable.jobberVisitId,
      })
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, company.id),
          sourceScope,
          gte(bookingsTable.scheduledFor, windowStart),
          lt(bookingsTable.scheduledFor, windowEnd),
          ne(bookingsTable.status, "canceled"),
          // Completed is one-way: a job Jobber already finished stays in the
          // books (and in revenue totals) even if Jobber later omits it.
          ne(bookingsTable.status, "completed"),
          or(
            isNotNull(bookingsTable.jobberVisitId),
            isNotNull(bookingsTable.jobberSyncedJobId),
          ),
        ),
      );

    const gone = rows
      .filter((r) => r.jobberVisitId === null || !seen.has(r.jobberVisitId))
      .map((r) => r.id);
    if (gone.length === 0) return 0;

    await db
      .update(bookingsTable)
      .set({ status: "canceled" })
      .where(inArray(bookingsTable.id, gone));
    logger.info(
      {
        companyId: company.id,
        connectionId: connection?.id ?? null,
        count: gone.length,
      },
      "Jobber calendar sync: cancelled bookings that left Jobber",
    );
    return gone.length;
  } catch (err) {
    // A failed sweep must not throw away a successful import.
    logger.warn(
      { err, companyId: company.id, connectionId: connection?.id ?? null },
      "Jobber calendar sync: cancellation sweep failed",
    );
    return 0;
  }
}

/* ───────────────────────── background poller ───────────────────────── */

export async function runJobberCalendarSyncCycle(): Promise<void> {
  const companies = await db
    .select()
    .from(companiesTable)
    .where(and(eq(companiesTable.jobberConnected, true)));

  for (const company of companies) {
    try {
      // Run calendar sync once per Jobber connection so each workspace's
      // visits are imported independently.  Companies that pre-date the
      // connections table fall back to the legacy company-level token.
      const connections = await db
        .select()
        .from(jobberConnectionsTable)
        .where(eq(jobberConnectionsTable.companyId, company.id));

      const syncsToRun: Array<JobberConnection | null> =
        connections.length > 0 ? connections : [null];

      let result = { ...EMPTY_RESULT };
      for (const conn of syncsToRun) {
        try {
          const r = await syncCompanyCalendar(company, conn);
          result = {
            imported: result.imported + r.imported,
            updated: result.updated + r.updated,
            canceled: result.canceled + r.canceled,
            skipped: result.skipped + r.skipped,
            jobberCount: result.jobberCount + r.jobberCount,
            hitPageLimit: result.hitPageLimit || r.hitPageLimit,
            pullComplete: result.pullComplete && r.pullComplete,
            persistFailures: result.persistFailures + r.persistFailures,
          };
        } catch (err) {
          // A revoked or undecryptable account marks itself for reconnection in
          // the token resolver. It must not prevent another connected Jobber
          // account from keeping the shared calendar up to date.
          logger.warn(
            { err, companyId: company.id, connectionId: conn?.id ?? null },
            "Jobber calendar sync failed for one connection",
          );
        }
      }

      if (result.imported || result.updated || result.canceled) {
        logger.info(
          { companyId: company.id, ...result },
          "Jobber calendar sync complete",
        );
      }
      // Hours clocked in Jobber's own timer, pulled in so the office bills
      // one set of numbers. Separate try: a timer read must not cost the
      // owner their calendar import.
      try {
        const hours = await syncCompanyTimeSheets(company);
        if (hours.imported || hours.updated) {
          logger.info(
            { companyId: company.id, ...hours },
            "Jobber time sheet sync complete",
          );
        }
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber time sheet sync failed for company",
        );
      }
      // The Leads safety net rides ahead of the request pull on purpose:
      // a brand-new Jobber-form enquiry whose webhook never arrived must
      // become a lead BEFORE the request sync can claim it as a pending
      // booking. Best effort, same as time sheets.
      try {
        await sweepJobberRequestLeads(company);
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber lead sweep failed for company",
        );
      }
      // Open requests ride the same cycle, ahead of quotes so a quote raised
      // from a just-imported request lands on that request's booking instead
      // of minting its own. Best effort, same as time sheets.
      try {
        await syncCompanyJobberRequests(company);
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber request sync failed for company",
        );
      }
      // Quotes ride the same cycle. Best effort for the same reason as time
      // sheets: a quote pull failing must not lose the calendar import.
      try {
        await syncCompanyJobberQuotes(company);
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber quote sync failed for company",
        );
      }
      // Invoices too — the paid/pending mirror. Best effort, same reason.
      try {
        await syncCompanyJobberInvoices(company);
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber invoice sync failed for company",
        );
      }
      // One-time history catch-up for companies whose rolling window no
      // longer reaches the pinned Aug 2026 floor — at most one slice per
      // cycle, import-only, no-op once done. Best effort, same reason.
      // The done marker certifies the rolling window's contents too, so it
      // may only be stamped off a cycle whose rolling pull was complete and
      // fully persisted.
      try {
        await runJobberHistoryCatchup(company, {
          rollingPullComplete:
            result.pullComplete && result.persistFailures === 0,
        });
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "Jobber history catch-up failed for company",
        );
      }
    } catch (err) {
      // One company's dead token must not stop the others syncing.
      logger.warn(
        { err, companyId: company.id },
        "Jobber calendar sync failed for company",
      );
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * First pass a couple of minutes after boot, then every two minutes — but
 * ONLY in the environment with PUBLIC_APP_URL pinned (the published site).
 *
 * Dev and production share one Jobber account, and Jobber rotates the
 * refresh token on every renewal. Two environments both polling every two
 * minutes take turns invalidating each other's refresh token — whichever
 * refreshes second gets rejected and flags the company for reconnect, so
 * merely running the dev server knocked the live site off Jobber. The two
 * pollers also drained one shared Jobber rate budget. Background polling is
 * therefore production-only; the dev workspace still syncs on demand via the
 * "Sync now" endpoint, same as the Quo webhook reconcile precedent.
 */
export function startJobberCalendarSync(): void {
  if (!process.env["PUBLIC_APP_URL"]?.trim()) {
    logger.info(
      "Jobber calendar background sync disabled: no PUBLIC_APP_URL pin (dev workspace) — production owns the shared Jobber grant; use Sync now for on-demand pulls",
    );
    return;
  }
  if (timer) return;
  const run = () => {
    runJobberCalendarSyncCycle().catch((err) =>
      logger.error({ err }, "Jobber calendar sync cycle failed"),
    );
  };
  setTimeout(run, 120 * 1000).unref();
  timer = setInterval(run, JOBBER_SYNC_INTERVAL_MS);
  timer.unref();
}
