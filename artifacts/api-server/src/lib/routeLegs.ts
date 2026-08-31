/**
 * The cleaner-to-next-job trail computation behind GET /map/routes, pulled out
 * of the route handler so the background lateness sweep reads the *same*
 * legs — same live-window rule, same next-job pick, same cached Directions
 * lookups — instead of growing a second opinion about where anyone is headed.
 */
import { and, eq, gt, gte, lt, inArray } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  cleanerLocationsTable,
} from "@workspace/db";
import { companyDayBounds } from "./dayBounds";
import { LIVE_WITHIN_MS } from "./presence";
import { sharingEnabledSql } from "./staffDevices";
import { pickNextJob } from "./nextJob";
import { getDrivingRoute, estimateRoute } from "../services/directions";

export type RouteLeg = {
  teamMemberId: number;
  name: string;
  color: string | null;
  bookingId: number;
  customerName: string;
  customerAddress: string | null;
  destLat: number;
  destLng: number;
  /** ISO timestamp of the booked time. */
  scheduledFor: string;
  etaSeconds: number;
  distanceMeters: number;
  source: "google" | "estimate";
  path: Array<{ lat: number; lng: number }>;
};

/**
 * One leg per cleaner who is both transmitting a live position and has a
 * next job today (company zone). `teamMemberId` narrows to a single seat —
 * the "a cleaner watches their own trail" rule from /map/routes.
 */
export async function computeRouteLegs(
  company: { id: number; timezone: string },
  opts: { teamMemberId?: number } = {},
): Promise<RouteLeg[]> {
  // Only phones heard from inside the live window get a trail — the same
  // rule as the green dots and the bright cars, so we never draw a confident
  // route from a position that is actually an hour old.
  const cutoff = new Date(Date.now() - LIVE_WITHIN_MS);
  const fixes = await db
    .select({
      teamMemberId: cleanerLocationsTable.teamMemberId,
      name: teamMembersTable.name,
      color: teamMembersTable.color,
      lat: cleanerLocationsTable.lat,
      lng: cleanerLocationsTable.lng,
      updatedAt: cleanerLocationsTable.updatedAt,
    })
    .from(cleanerLocationsTable)
    .innerJoin(
      teamMembersTable,
      eq(cleanerLocationsTable.teamMemberId, teamMembersTable.id),
    )
    .where(
      and(
        eq(cleanerLocationsTable.companyId, company.id),
        gt(cleanerLocationsTable.updatedAt, cutoff),
        sharingEnabledSql(),
        ...(opts.teamMemberId !== undefined
          ? [eq(cleanerLocationsTable.teamMemberId, opts.teamMemberId)]
          : []),
      ),
    );

  // A person is one trail however many devices they carry: the phone in the
  // van and the tablet left at the last house would otherwise draw two lines
  // to the same job and bill two Directions lookups. Whichever device spoke
  // most recently is where we believe they are.
  const freshestByMember = new Map<number, (typeof fixes)[number]>();
  for (const fix of fixes) {
    const seen = freshestByMember.get(fix.teamMemberId);
    if (!seen || fix.updatedAt > seen.updatedAt) {
      freshestByMember.set(fix.teamMemberId, fix);
    }
  }
  const moving = [...freshestByMember.values()];
  if (moving.length === 0) return [];

  // Today's candidate work for those people, bounded by the company's day —
  // never the server's. Tomorrow's first job is not tonight's destination.
  const { start, end } = companyDayBounds(undefined, company.timezone);
  const candidates = await db
    .select({
      id: bookingsTable.id,
      customerName: bookingsTable.customerName,
      customerAddress: bookingsTable.customerAddress,
      lat: bookingsTable.lat,
      lng: bookingsTable.lng,
      scheduledFor: bookingsTable.scheduledFor,
      durationMinutes: bookingsTable.durationMinutes,
      status: bookingsTable.status,
      teamMemberId: bookingAssignmentsTable.teamMemberId,
    })
    .from(bookingsTable)
    .innerJoin(
      bookingAssignmentsTable,
      eq(bookingAssignmentsTable.bookingId, bookingsTable.id),
    )
    .where(
      and(
        eq(bookingsTable.companyId, company.id),
        inArray(
          bookingAssignmentsTable.teamMemberId,
          moving.map((m) => m.teamMemberId),
        ),
        // A pending request must never look like a cleaner's next stop. The
        // same confirmed-only rule drives the schedule and map pins.
        eq(bookingsTable.status, "confirmed"),
        gte(bookingsTable.scheduledFor, start),
        lt(bookingsTable.scheduledFor, end),
      ),
    );

  const byMember = new Map<number, typeof candidates>();
  for (const c of candidates) {
    const list = byMember.get(c.teamMemberId);
    if (list) list.push(c);
    else byMember.set(c.teamMemberId, [c]);
  }

  const now = new Date();
  const legs = await Promise.all(
    moving.map(async (m): Promise<RouteLeg | null> => {
      const next = pickNextJob(byMember.get(m.teamMemberId) ?? [], now);
      if (!next) return null;
      const origin = { lat: m.lat, lng: m.lng };
      const dest = { lat: next.lat!, lng: next.lng! };
      // One cached route per seat — a cleaner has one "next job" at a time.
      const drive =
        (await getDrivingRoute(
          `${company.id}:${m.teamMemberId}`,
          origin,
          dest,
        )) ?? estimateRoute(origin, dest);
      return {
        teamMemberId: m.teamMemberId,
        name: m.name,
        color: m.color,
        bookingId: next.id,
        // Trails, lateness texts and "heading to" lines all read this label;
        // there's no phone in the leg payload, so blank becomes "No name".
        customerName: next.customerName.trim() || "No name",
        customerAddress: next.customerAddress ?? null,
        destLat: dest.lat,
        destLng: dest.lng,
        scheduledFor: next.scheduledFor.toISOString(),
        etaSeconds: drive.etaSeconds,
        distanceMeters: drive.distanceMeters,
        source: drive.source,
        path: drive.path,
      };
    }),
  );
  return legs.filter((leg): leg is RouteLeg => leg !== null);
}
