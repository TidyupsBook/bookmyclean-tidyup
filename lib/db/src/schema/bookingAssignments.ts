import {
  pgTable,
  serial,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bookingsTable } from "./bookings";
import { teamMembersTable } from "./teamMembers";

/**
 * Which cleaners are working a booking. A join table rather than a column on
 * `bookings` because a job routinely needs a crew of two or more.
 *
 * Rows are deleted with their booking or their team member, so removing
 * someone from the team also drops them off every job they were on rather
 * than leaving a dangling reference on the schedule.
 */
export const bookingAssignmentsTable = pgTable(
  "booking_assignments",
  {
    id: serial("id").primaryKey(),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    teamMemberId: integer("team_member_id")
      .notNull()
      .references(() => teamMembersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The same person can only be on a job once, so re-saving a crew is
    // idempotent instead of stacking duplicates.
    uniqueIndex("booking_assignments_booking_member_idx").on(
      table.bookingId,
      table.teamMemberId,
    ),
  ],
);

export type BookingAssignment = typeof bookingAssignmentsTable.$inferSelect;
