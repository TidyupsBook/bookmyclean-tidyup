import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lt, isNotNull, inArray } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  cleanerLocationsTable,
  homeownerPinsTable,
} from "@workspace/db";
import {
  GetMapConfigResponse,
  GetMapDataQueryParams,
  GetMapDataResponse,
  CreateMapPinBody,
  CreateMapPinResponse,
  DeleteMapPinParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole, getCaller } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";
import { companyDayBounds } from "../lib/dayBounds";
import { roleLabel } from "../lib/roleLabel";
import {
  geocodeAddress,
  normalizeAddress,
  GeocodeConfigError,
} from "../services/geocode";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Ceiling on located jobs read for one map request.
 *
 * Only reachable in `all` mode. Generous enough to cover years of work for a
 * normal cleaning company, low enough that the response can't grow unbounded
 * as an account ages.
 */
const ALL_JOBS_LIMIT = 5000;

type PlacedJob = { row: typeof bookingsTable.$inferSelect; visits: number };

/**
 * Collapse repeat visits into one pin per place.
 *
 * Keyed on the address where there is one, and on rounded coordinates where
 * there isn't — five decimal places is about a metre, so the same house
 * geocoded twice lands in the same bucket while neighbours stay apart.
 *
 * The representative is the latest visit: the customer's current name, and the
 * most recent thing that happened at that address.
 */
function collapseToPlaces(
  rows: Array<typeof bookingsTable.$inferSelect>,
): PlacedJob[] {
  const byPlace = new Map<string, PlacedJob>();
  for (const row of rows) {
    const key = row.customerAddress
      ? normalizeAddress(row.customerAddress)
      : `${row.lat!.toFixed(5)},${row.lng!.toFixed(5)}`;
    const seen = byPlace.get(key);
    if (!seen) {
      byPlace.set(key, { row, visits: 1 });
      continue;
    }
    seen.visits += 1;
    if (row.scheduledFor > seen.row.scheduledFor) seen.row = row;
  }
  return [...byPlace.values()];
}

// The Google Maps browser key. Served only to authenticated dispatchers so it
// never has to be baked into the client bundle; missing key is a soft state
// (configured: false) rather than an error, so the UI can show its own hint.
router.get(
  "/map/config",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (_req, res): Promise<void> => {
    const apiKey = process.env["GOOGLE_MAPS_API_KEY"] ?? "";
    res.json(
      GetMapConfigResponse.parse({
        apiKey,
        configured: apiKey.length > 0,
      }),
    );
  },
);

// Crew may watch the day unfold — jobs, coworkers and saved pins. Editing the
// saved pins below stays with dispatch.
router.get(
  "/map/data",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const query = GetMapDataQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const caller = await getCaller(req);
    const company = caller.company;
    if (!company) {
      res.json(
        GetMapDataResponse.parse({
          cleaners: [],
          jobs: [],
          pins: [],
          staffHomes: [],
        }),
      );
      return;
    }

    // A single day unless the caller asked for a span: the week and month
    // views pin every job in view at once, so the map matches the calendar
    // above it instead of only the highlighted day.
    const from = companyDayBounds(query.data.date, company.timezone);
    const to = query.data.end
      ? companyDayBounds(query.data.end, company.timezone)
      : from;
    const start = from.start;
    const end = to.end > from.end ? to.end : from.end;

    // Latest position per cleaner in this company (one row each — the phone
    // upserts rather than appends). Joined to the seat for the display name.
    const locationRows = await db
      .select({
        teamMemberId: cleanerLocationsTable.teamMemberId,
        name: teamMembersTable.name,
        lat: cleanerLocationsTable.lat,
        lng: cleanerLocationsTable.lng,
        accuracy: cleanerLocationsTable.accuracy,
        updatedAt: cleanerLocationsTable.updatedAt,
      })
      .from(cleanerLocationsTable)
      .innerJoin(
        teamMembersTable,
        eq(cleanerLocationsTable.teamMemberId, teamMembersTable.id),
      )
      .where(eq(cleanerLocationsTable.companyId, company.id));

    const cleaners = locationRows.map((r) => ({
      teamMemberId: r.teamMemberId,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      accuracy: r.accuracy ?? null,
      updatedAt: r.updatedAt.toISOString(),
    }));

    // Where the crew live. Pinned all the time, not only when someone is off
    // duty: "who is nearest this job" is a question the owner asks while
    // planning tomorrow, when nobody is transmitting a position at all.
    //
    // A colleague's home address is personal, so dispatch sees the roster's
    // and a cleaner sees only their own.
    const staffScope =
      caller.role === "cleaner" && caller.teamMemberId !== null
        ? and(
            eq(teamMembersTable.companyId, company.id),
            eq(teamMembersTable.id, caller.teamMemberId),
          )
        : eq(teamMembersTable.companyId, company.id);

    const staffHomes = (
      await db
        .select()
        .from(teamMembersTable)
        .where(and(staffScope, isNotNull(teamMembersTable.homeLat)))
    ).map((m) => ({
      teamMemberId: m.id,
      name: m.name,
      roleLabel: roleLabel(m),
      address: m.homeAddress,
      lat: m.homeLat!,
      lng: m.homeLng!,
      active: m.active,
    }));

    // Jobs that already have coordinates — an un-geocoded booking simply has
    // no pin yet. Normally that's the requested day (company zone); in `all`
    // mode the dates drop away and every located job counts, because the
    // question being asked is "where are my clients", not "where is the crew
    // today".
    const showAll = query.data.all === true;
    const pinnedInRange = and(
      eq(bookingsTable.companyId, company.id),
      isNotNull(bookingsTable.lat),
      isNotNull(bookingsTable.lng),
      ...(showAll
        ? []
        : [
            gte(bookingsTable.scheduledFor, start),
            lt(bookingsTable.scheduledFor, end),
          ]),
    );

    // A pin carries the customer's home address. Crew see only the houses they
    // are actually sent to — the same rule as the bookings list, applied here
    // because a month-wide map would otherwise hand a cleaner every address
    // the company has.
    const jobScope =
      caller.role === "cleaner" && caller.teamMemberId !== null
        ? and(
            pinnedInRange,
            inArray(
              bookingsTable.id,
              db
                .select({ id: bookingAssignmentsTable.bookingId })
                .from(bookingAssignmentsTable)
                .where(
                  eq(bookingAssignmentsTable.teamMemberId, caller.teamMemberId),
                ),
            ),
          )
        : pinnedInRange;

    const jobRows = await db
      .select()
      .from(bookingsTable)
      .where(jobScope)
      // Newest first so that if the ceiling below does bite, what survives is
      // the recent work rather than an arbitrary slice the database happened
      // to return.
      .orderBy(desc(bookingsTable.scheduledFor))
      // Only bites in `all` mode; a dated span can't reach it. A ceiling has
      // to exist so one long-established account can't try to draw its entire
      // history at once.
      .limit(ALL_JOBS_LIMIT);

    // In `all` mode a pin is a place, not a visit. A house cleaned every week
    // for a year is one marker carrying its count, rather than fifty markers
    // stacked on the same roof that the dispatcher can neither read nor click
    // past. The most recent visit supplies the name and status, since that's
    // the freshest thing we know about the address.
    const visible = showAll
      ? collapseToPlaces(jobRows)
      : jobRows.map((row) => ({ row, visits: 1 }));

    const assigneesByBooking = await loadAssignees(
      visible.map((b) => b.row.id),
    );

    const jobs = visible.map(({ row: b, visits }) => ({
      bookingId: b.id,
      customerName: b.customerName,
      customerAddress: b.customerAddress ?? null,
      lat: b.lat!,
      lng: b.lng!,
      scheduledFor: b.scheduledFor.toISOString(),
      status: b.status as "pending" | "confirmed" | "completed" | "canceled",
      assignees: assigneesByBooking.get(b.id) ?? [],
      visits,
    }));

    const pinRows = await db
      .select()
      .from(homeownerPinsTable)
      .where(eq(homeownerPinsTable.companyId, company.id));

    const pins = pinRows.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address ?? null,
      lat: p.lat,
      lng: p.lng,
    }));

    res.json(GetMapDataResponse.parse({ cleaners, jobs, pins, staffHomes }));
  },
);

router.post(
  "/map/pins",
  requireAuth,
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const parsed = CreateMapPinBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    let { lat, lng } = parsed.data;
    const address = parsed.data.address ?? null;

    // Coordinates win when supplied; otherwise resolve the address server-side
    // so the browser never sees the geocoding key.
    if ((lat == null || lng == null) && address) {
      try {
        const coords = await geocodeAddress(address);
        if (!coords) {
          res
            .status(400)
            .json({ error: "Couldn't find that address on the map." });
          return;
        }
        lat = coords.lat;
        lng = coords.lng;
      } catch (err) {
        if (err instanceof GeocodeConfigError) {
          logger.warn({ err }, "Pin geocoding unavailable");
          res.status(400).json({
            error:
              "Address lookup is unavailable — enter the location by hand.",
          });
          return;
        }
        throw err;
      }
    }

    if (lat == null || lng == null) {
      res
        .status(400)
        .json({ error: "A pin needs either coordinates or an address." });
      return;
    }

    const [pin] = await db
      .insert(homeownerPinsTable)
      .values({
        companyId: company.id,
        name: parsed.data.name,
        address,
        lat,
        lng,
      })
      .returning();

    res.status(201).json(
      CreateMapPinResponse.parse({
        id: pin!.id,
        name: pin!.name,
        address: pin!.address ?? null,
        lat: pin!.lat,
        lng: pin!.lng,
      }),
    );
  },
);

router.delete(
  "/map/pins/:id",
  requireAuth,
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = DeleteMapPinParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const deleted = await db
      .delete(homeownerPinsTable)
      .where(
        and(
          eq(homeownerPinsTable.id, params.data.id),
          eq(homeownerPinsTable.companyId, company.id),
        ),
      )
      .returning({ id: homeownerPinsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Pin not found" });
      return;
    }
    res.status(204).end();
  },
);

type Assignee = { teamMemberId: number; name: string };

/** Assignees for a set of bookings, keyed by booking id, in one query. */
async function loadAssignees(
  bookingIds: number[],
): Promise<Map<number, Assignee[]>> {
  const out = new Map<number, Assignee[]>();
  if (bookingIds.length === 0) return out;
  const rows = await db
    .select({
      bookingId: bookingAssignmentsTable.bookingId,
      teamMemberId: teamMembersTable.id,
      name: teamMembersTable.name,
    })
    .from(bookingAssignmentsTable)
    .innerJoin(
      teamMembersTable,
      eq(bookingAssignmentsTable.teamMemberId, teamMembersTable.id),
    )
    .where(inArray(bookingAssignmentsTable.bookingId, bookingIds))
    .orderBy(teamMembersTable.name);
  for (const row of rows) {
    const list = out.get(row.bookingId) ?? [];
    list.push({ teamMemberId: row.teamMemberId, name: row.name });
    out.set(row.bookingId, list);
  }
  return out;
}

export default router;
