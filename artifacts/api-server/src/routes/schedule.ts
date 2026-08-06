import { Router, type IRouter } from "express";
import { and, eq, gte, lt, inArray, asc } from "drizzle-orm";
import {
  db,
  bookingsTable,
  bookingAssignmentsTable,
  teamMembersTable,
  servicesTable,
  type Booking,
} from "@workspace/db";
import {
  GetScheduleQueryParams,
  GetScheduleResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCaller } from "../middlewares/requireRole";
import { companyDayBounds } from "../lib/dayBounds";

const router: IRouter = Router();

/** When a booking carries no duration, fall back to the service, else two hours. */
const DEFAULT_DURATION_MINUTES = 120;

router.get(
  "/schedule",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const query = GetScheduleQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.json(
        GetScheduleResponse.parse({
          date: companyDayBounds(query.data.date, "UTC").date,
          cleaners: [],
          unassigned: [],
        }),
      );
      return;
    }
    const company = caller.company;
    const { start, end, date } = companyDayBounds(
      query.data.date,
      company.timezone,
    );

    const dayBookings = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, company.id),
          gte(bookingsTable.scheduledFor, start),
          lt(bookingsTable.scheduledFor, end),
        ),
      )
      .orderBy(asc(bookingsTable.scheduledFor));

    // Service durations to fall back on when a booking has none of its own.
    const services = await db
      .select({
        name: servicesTable.name,
        durationMinutes: servicesTable.durationMinutes,
      })
      .from(servicesTable)
      .where(eq(servicesTable.companyId, company.id));
    const serviceDuration = new Map<string, number | null>();
    for (const s of services) serviceDuration.set(s.name, s.durationMinutes);

    // Assignments across the day's bookings, keyed by booking id.
    const assignments = await db
      .select({
        bookingId: bookingAssignmentsTable.bookingId,
        teamMemberId: bookingAssignmentsTable.teamMemberId,
      })
      .from(bookingAssignmentsTable)
      .where(
        dayBookings.length > 0
          ? inArray(
              bookingAssignmentsTable.bookingId,
              dayBookings.map((b) => b.id),
            )
          : // No bookings — match nothing.
            eq(bookingAssignmentsTable.bookingId, -1),
      );
    const assigneesByBooking = new Map<number, number[]>();
    for (const a of assignments) {
      const list = assigneesByBooking.get(a.bookingId) ?? [];
      list.push(a.teamMemberId);
      assigneesByBooking.set(a.bookingId, list);
    }

    // The team members who could carry jobs. Cleaners only ever see their own
    // lane, so the roster is narrowed to them.
    const roster = await db
      .select({
        id: teamMembersTable.id,
        name: teamMembersTable.name,
        role: teamMembersTable.role,
      })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.companyId, company.id))
      .orderBy(teamMembersTable.name);

    const toJob = (b: Booking) => ({
      bookingId: b.id,
      customerName: b.customerName,
      customerAddress: b.customerAddress ?? null,
      scheduledFor: b.scheduledFor.toISOString(),
      durationMinutes:
        b.durationMinutes ??
        serviceDuration.get(b.service) ??
        DEFAULT_DURATION_MINUTES,
      status: b.status as "pending" | "confirmed" | "completed" | "canceled",
      // Best available headline price: the quoted flat amount, else the deposit.
      price: b.quotedAmount ?? null,
    });

    // A cleaner sees only the lane for their own seat, filled with only the
    // jobs they are actually assigned to — never another crew member's lane
    // and never the unassigned column.
    if (caller.role === "cleaner" && caller.teamMemberId !== null) {
      const mine = caller.teamMemberId;
      const seat = roster.find((r) => r.id === mine);
      const myJobs = dayBookings.filter((b) =>
        (assigneesByBooking.get(b.id) ?? []).includes(mine),
      );
      res.json(
        GetScheduleResponse.parse({
          date,
          cleaners: seat
            ? [
                {
                  teamMemberId: seat.id,
                  name: seat.name,
                  jobs: myJobs.map(toJob),
                },
              ]
            : [],
          unassigned: [],
        }),
      );
      return;
    }

    // Owner/dispatcher: a lane per cleaner, plus everything nobody is on yet.
    const cleanerSeats = roster.filter((r) => r.role === "cleaner");
    const cleaners = cleanerSeats.map((seat) => ({
      teamMemberId: seat.id,
      name: seat.name,
      jobs: dayBookings
        .filter((b) => (assigneesByBooking.get(b.id) ?? []).includes(seat.id))
        .map(toJob),
    }));
    const unassigned = dayBookings
      .filter((b) => (assigneesByBooking.get(b.id) ?? []).length === 0)
      .map(toJob);

    res.json(GetScheduleResponse.parse({ date, cleaners, unassigned }));
  },
);

export default router;
