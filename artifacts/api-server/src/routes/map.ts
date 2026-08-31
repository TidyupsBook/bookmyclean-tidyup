import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lt, isNotNull, inArray, sql } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  cleanerLocationsTable,
  staffDevicesTable,
  homeownerPinsTable,
} from "@workspace/db";
import {
  GeocodeMapAddressQueryParams,
  GeocodeMapAddressResponse,
  GetAddressSuggestionsQueryParams,
  GetAddressSuggestionsResponse,
  GetMapConfigResponse,
  GetMapDataQueryParams,
  GetMapDataResponse,
  GetMapDrivingRouteQueryParams,
  GetMapDrivingRouteResponse,
  GetMapRoutesResponse,
  CreateMapPinBody,
  CreateMapPinResponse,
  DeleteMapPinParams,
  UpdateMapPinBody,
  UpdateMapPinParams,
  UpdateMapPinResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole, getCaller } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";
import { companyDayBounds } from "../lib/dayBounds";
import { roleLabel } from "../lib/roleLabel";
import { computeRouteLegs } from "../lib/routeLegs";
import { livePositionAccess } from "../lib/livePositionAccess";
import { sharingEnabledSql } from "../lib/staffDevices";
import {
  geocodeAddress,
  normalizeAddress,
  GeocodeConfigError,
} from "../services/geocode";
import { suggestAddresses } from "../services/placeSuggestions";
import { getDrivingRoute } from "../services/directions";
import { allowRequest } from "../lib/rateLimit";
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

/** One-off address lookups allowed per signed-in person per minute. */
const GEOCODE_PER_MINUTE = 20;
/** Manual route checks allowed per signed-in person per minute. */
const DRIVING_ROUTES_PER_MINUTE = 30;

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

// Address suggestions while typing. Looked up here rather than in the browser
// so the failure is visible in the logs and so a key without the newest Places
// API still gets suggestions from the older one.
router.get(
  "/map/address-suggestions",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const query = GetAddressSuggestionsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }

    const lat = query.data.lat;
    const lng = query.data.lng;
    const bias =
      typeof lat === "number" && typeof lng === "number"
        ? { lat, lng }
        : undefined;

    try {
      const outcome = await suggestAddresses(query.data.q, bias);
      res.json(GetAddressSuggestionsResponse.parse(outcome));
    } catch (err) {
      // Suggestions are a convenience: a Google hiccup must never stop someone
      // finishing the form, so this answers "nothing found", not an error.
      logger.warn({ err }, "[map] address suggestions lookup failed");
      res.json(
        GetAddressSuggestionsResponse.parse({
          suggestions: [],
          available: true,
        }),
      );
    }
  },
);

// "Where is this?" for a one-off address — measuring who's nearest to a
// customer who isn't booked yet. Saves nothing, so anyone who can read the map
// can ask; the geocoding key stays on the server as it does everywhere else.
router.get(
  "/map/geocode",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const query = GeocodeMapAddressQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const address = query.data.address.trim();
    if (!address) {
      res.json(
        GeocodeMapAddressResponse.parse({
          found: false,
          lat: null,
          lng: null,
          message: "Type an address first.",
        }),
      );
      return;
    }

    // Every distinct address is a paid lookup at Google, so one signed-in
    // person — or one stuck retry loop — must not be able to run the bill up.
    // Generous for a human typing addresses, immediate for a script.
    if (
      !allowRequest(`map-geocode:${req.userId}`, {
        limit: GEOCODE_PER_MINUTE,
        windowMs: 60_000,
      })
    ) {
      res.status(429).json({
        error: "That's a lot of lookups at once — try again in a minute.",
      });
      return;
    }

    const lat = query.data.lat;
    const lng = query.data.lng;
    const bias =
      typeof lat === "number" && typeof lng === "number"
        ? { lat, lng }
        : undefined;

    try {
      const coords = await geocodeAddress(address, bias);
      res.json(
        GeocodeMapAddressResponse.parse(
          coords
            ? { found: true, lat: coords.lat, lng: coords.lng, message: null }
            : {
                found: false,
                lat: null,
                lng: null,
                message: "We couldn't find that address on the map.",
              },
        ),
      );
    } catch (err) {
      // A key that can't geocode is our problem, not a bad address — say so
      // rather than letting the dispatcher retype a perfectly good street.
      if (err instanceof GeocodeConfigError) {
        logger.warn({ err }, "[map] one-off geocode unavailable");
        res.json(
          GeocodeMapAddressResponse.parse({
            found: false,
            lat: null,
            lng: null,
            message: "Address lookup is unavailable right now.",
          }),
        );
        return;
      }
      throw err;
    }
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
          staffWithoutHome: [],
          office: null,
          livePositions: { allowed: true, reason: null },
        }),
      );
      return;
    }

    // Decided here, on the server, before the positions are even read: a
    // dispatcher outside working hours gets a response that genuinely does
    // not contain anybody's whereabouts. The jobs, saved pins and home
    // addresses are unaffected — the rule is about watching people move.
    const watch = livePositionAccess(caller.role, company);

    // A single day unless the caller asked for a span: the week and month
    // views pin every job in view at once, so the map matches the calendar
    // above it instead of only the highlighted day.
    const from = companyDayBounds(query.data.date, company.timezone);
    const to = query.data.end
      ? companyDayBounds(query.data.end, company.timezone)
      : from;
    const start = from.start;
    const end = to.end > from.end ? to.end : from.end;

    // Latest position per DEVICE in this company (one row each — a client
    // upserts its own row rather than appending). Joined to the device for
    // its name and to the seat for the person behind it: somebody signed in
    // on a PC and an iPad is two pins, both labelled, instead of one pin that
    // jumps between them.
    const locationRows = watch.allowed
      ? await db
          .select({
            teamMemberId: cleanerLocationsTable.teamMemberId,
            deviceId: cleanerLocationsTable.deviceId,
            deviceLabel: staffDevicesTable.label,
            platform: staffDevicesTable.platform,
            name: teamMembersTable.name,
            color: teamMembersTable.color,
            role: teamMembersTable.role,
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
          // LEFT, deliberately: a fix with no device row (one stored before
          // devices existed, or a backfill that didn't reach) still deserves
          // a pin. Losing a cleaner off the map is far worse than an unnamed
          // marker.
          .leftJoin(
            staffDevicesTable,
            eq(cleanerLocationsTable.deviceId, staffDevicesTable.id),
          )
          .where(
            and(
              eq(cleanerLocationsTable.companyId, company.id),
              // Somebody the owner has switched off has nothing stored, but
              // the filter stands so a row that outlived its switch can never
              // reappear on the map.
              sharingEnabledSql(),
              // The office is not a person on the move: it is drawn below as
              // a building parked on the stored company spot, so its browser
              // fixes never become a car. COALESCE because the join is LEFT —
              // a fix with no device row is a cleaner, never the office.
              sql`COALESCE(${staffDevicesTable.isOffice}, false) = false`,
            ),
          )
      : [];

    // The shop itself — a place like the saved pins, so it is NOT withheld
    // outside watching hours, and it sits on the stored company location
    // rather than anything the office browser ever reported.
    const [officeDevice] = await db
      .select({
        id: staffDevicesTable.id,
        label: staffDevicesTable.label,
      })
      .from(staffDevicesTable)
      .where(
        and(
          eq(staffDevicesTable.companyId, company.id),
          eq(staffDevicesTable.isOffice, true),
        ),
      )
      .limit(1);
    const office =
      officeDevice && company.officeLat !== null && company.officeLng !== null
        ? {
            deviceId: officeDevice.id,
            label: officeDevice.label,
            address: company.officeAddress,
            lat: company.officeLat,
            lng: company.officeLng,
          }
        : null;

    const cleaners = locationRows.map((r) => ({
      teamMemberId: r.teamMemberId,
      deviceId: r.deviceId ?? null,
      deviceLabel: r.deviceLabel,
      platform: r.platform,
      name: r.name,
      color: r.color,
      // The boss is painted bright yellow wherever he shows up, whatever
      // colour his roster card carries.
      isOwner: r.role === "owner",
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

    // One pass over the crew in scope, split into "has a pin" and "doesn't".
    // The second half matters as much as the first: a cleaner with no home
    // location simply never appears in a distance ranking, and without a name
    // attached to that gap the office has no way to notice.
    const staff = await db.select().from(teamMembersTable).where(staffScope);

    const staffHomes = staff
      .filter((m) => m.homeLat !== null && m.homeLng !== null)
      .map((m) => ({
        teamMemberId: m.id,
        name: m.name,
        color: m.color,
        roleLabel: roleLabel(m),
        address: m.homeAddress,
        lat: m.homeLat!,
        lng: m.homeLng!,
        active: m.active,
      }));

    const staffWithoutHome = staff
      .filter((m) => m.homeLat === null || m.homeLng === null)
      .map((m) => ({
        teamMemberId: m.id,
        name: m.name,
        roleLabel: roleLabel(m),
        active: m.active,
        // An address that's on the card but has no coordinates was tried and
        // couldn't be placed — usually a typo or a missing city — which is a
        // different fix from having typed nothing at all.
        reason: m.homeAddress ? ("unplaceable" as const) : ("missing" as const),
        address: m.homeAddress,
      }));

    // Jobs that already have coordinates — an un-geocoded booking simply has
    // no pin yet. Normally that's the requested day (company zone); in `all`
    // mode the dates drop away and every located job counts, because the
    // question being asked is "where are my clients", not "where is the crew
    // today".
    const showAll = query.data.all === true;
    const pinnedInRange = and(
      eq(bookingsTable.companyId, company.id),
      // A dated, geocoded request is not dispatch work until the customer has
      // confirmed it. Historical completed visits remain available as pins.
      inArray(bookingsTable.status, ["confirmed", "completed"]),
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
      // Map pins have no phone in their payload; a nameless booking's pin
      // reads "No name" rather than rendering an empty label.
      customerName: b.customerName.trim() || "No name",
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

    res.json(
      GetMapDataResponse.parse({
        cleaners,
        jobs,
        pins,
        staffHomes,
        staffWithoutHome,
        office,
        livePositions: watch,
      }),
    );
  },
);

// The trail from each cleaner on the move to wherever they are due next.
// Separate from /map/data because each leg can cost a billed Directions
// lookup: the service behind this caches per cleaner and only re-asks Google
// when someone actually moves, while /map/data stays a cheap read.
router.get(
  "/map/routes",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    const company = caller.company;
    if (!company) {
      res.json(
        GetMapRoutesResponse.parse({
          routes: [],
          livePositions: { allowed: true, reason: null },
        }),
      );
      return;
    }

    // A trail starts at where somebody is standing right now, so it leaks a
    // position just as plainly as the car does — same rule, checked before
    // anything is computed (which also spares the Directions budget).
    const watch = livePositionAccess(caller.role, company);
    if (!watch.allowed) {
      res.json(
        GetMapRoutesResponse.parse({ routes: [], livePositions: watch }),
      );
      return;
    }

    // Shared with the background lateness sweep, so the trails a dispatcher
    // sees and the feed's "running late" entries always come from the same
    // computation. A cleaner watches their own trail; dispatch the crew's.
    const routes = await computeRouteLegs(
      company,
      caller.role === "cleaner" && caller.teamMemberId !== null
        ? { teamMemberId: caller.teamMemberId }
        : {},
    );
    res.json(GetMapRoutesResponse.parse({ routes, livePositions: watch }));
  },
);

// One explicit, routed measurement between two points. Unlike the live trails
// above, this endpoint must never substitute a straight line: dispatch may
// repeat these numbers to a customer as driving distance and time.
router.get(
  "/map/driving-route",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const parsed = GetMapDrivingRouteQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (
      !allowRequest(`map-driving-route:${req.userId}`, {
        limit: DRIVING_ROUTES_PER_MINUTE,
        windowMs: 60_000,
      })
    ) {
      res
        .status(429)
        .json({ error: "Too many route checks. Try again shortly." });
      return;
    }

    const { startLat, startLng, endLat, endLng } = parsed.data;
    const origin = { lat: startLat, lng: startLng };
    const destination = { lat: endLat, lng: endLng };
    const cacheKey = [
      "measurement",
      startLat.toFixed(5),
      startLng.toFixed(5),
      endLat.toFixed(5),
      endLng.toFixed(5),
    ].join(":");
    const route = await getDrivingRoute(cacheKey, origin, destination);

    if (!route || route.source !== "google") {
      res.status(503).json({
        error:
          "Driving route unavailable. Google could not route between those points.",
      });
      return;
    }

    res.json(
      GetMapDrivingRouteResponse.parse({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.etaSeconds,
        path: route.path,
      }),
    );
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

router.patch(
  "/map/pins/:id",
  requireAuth,
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = UpdateMapPinParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateMapPinBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    const changes: Partial<{
      name: string;
      address: string | null;
      lat: number;
      lng: number;
    }> = {};
    if (parsed.data.name !== undefined) changes.name = parsed.data.name;
    if (parsed.data.address !== undefined) {
      changes.address = parsed.data.address ?? null;
    }

    let { lat, lng } = parsed.data;
    // Half a coordinate can't move a pin — silently ignoring it would return
    // 200 while discarding what the caller sent. Reject it outright.
    if ((lat == null) !== (lng == null)) {
      res
        .status(400)
        .json({ error: "Send both lat and lng together, or neither." });
      return;
    }
    // A new address without explicit coordinates is re-geocoded server-side,
    // exactly like pin creation — coordinates win when both are supplied.
    if ((lat == null || lng == null) && parsed.data.address) {
      try {
        const coords = await geocodeAddress(parsed.data.address);
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
    if (lat != null && lng != null) {
      changes.lat = lat;
      changes.lng = lng;
    }

    if (Object.keys(changes).length === 0) {
      res.status(400).json({ error: "Nothing to change." });
      return;
    }

    const [pin] = await db
      .update(homeownerPinsTable)
      .set(changes)
      .where(
        and(
          eq(homeownerPinsTable.id, params.data.id),
          eq(homeownerPinsTable.companyId, company.id),
        ),
      )
      .returning();
    if (!pin) {
      res.status(404).json({ error: "Pin not found" });
      return;
    }

    res.json(
      UpdateMapPinResponse.parse({
        id: pin.id,
        name: pin.name,
        address: pin.address ?? null,
        lat: pin.lat,
        lng: pin.lng,
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

type Assignee = { teamMemberId: number; name: string; color: string | null };

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
      color: teamMembersTable.color,
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
    list.push({
      teamMemberId: row.teamMemberId,
      name: row.name,
      color: row.color,
    });
    out.set(row.bookingId, list);
  }
  return out;
}

export default router;
