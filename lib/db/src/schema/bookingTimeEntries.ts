import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bookingsTable } from "./bookings";
import { companiesTable } from "./companies";
import { teamMembersTable } from "./teamMembers";

/**
 * Time actually worked on a job, as clocked by the crew on site.
 *
 * A row per start/stop rather than two columns on the booking, because a job
 * is routinely interrupted — a supply run, a lunch break, a second crew member
 * arriving late — and the owner bills the sum of the stretches actually
 * worked, not the gap between the first start and the last stop.
 *
 * `endedAt` null means the clock is still running. At most one such row is
 * allowed per booking (enforced by a partial unique index in the migration),
 * so a double tap on a phone with a slow connection cannot open two clocks
 * that then both get stopped and double-bill the customer.
 */
export const bookingTimeEntriesTable = pgTable(
  "booking_time_entries",
  {
    id: serial("id").primaryKey(),
    // Denormalized from the booking so every query can be company-scoped
    // without a join, the same as everywhere else in this app.
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    // Who clocked in. Null when the office started the clock on the crew's
    // behalf, or if that person has since been removed from the team — the
    // time worked still counts toward the bill either way.
    teamMemberId: integer("team_member_id").references(
      () => teamMembersTable.id,
      { onDelete: "set null" },
    ),
    // Kept as plain text alongside the id so a deleted staff member does not
    // erase the history of who was on the job.
    startedByName: text("started_by_name"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Set when the office corrected the times by hand, so an owner reviewing
    // hours can tell clocked time from adjusted time.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // Set once this stretch of work has been written to the Jobber job, so a
    // retry cannot bill the customer for the same hour twice.
    jobberNoteId: text("jobber_note_id"),
    jobberSyncError: text("jobber_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One running clock per job. A crew member tapping Start twice on a
    // flaky phone signal must not open a second stretch that later gets
    // stopped as well and bills the customer for double the time.
    uniqueIndex("booking_time_entries_open_idx")
      .on(table.bookingId)
      .where(sql`${table.endedAt} is null`),
  ],
);

export type BookingTimeEntry = typeof bookingTimeEntriesTable.$inferSelect;
