import {
  pgTable,
  serial,
  integer,
  timestamp,
  doublePrecision,
  real,
  index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { teamMembersTable } from "./teamMembers";

/**
 * The latest known GPS position for each cleaner, powering the live dispatch
 * map. One row per team member — the phone upserts this row as it moves rather
 * than appending a trail, so the table stays small and a read is always the
 * current location.
 *
 * Scoped to a company so one company's map can never surface another's crew.
 */
export const cleanerLocationsTable = pgTable(
  "cleaner_locations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    teamMemberId: integer("team_member_id")
      .notNull()
      .references(() => teamMembersTable.id, { onDelete: "cascade" })
      .unique(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    // Reported horizontal accuracy in metres, when the device supplies it.
    accuracy: real("accuracy"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("cleaner_locations_company_id_idx").on(table.companyId)],
);

export type CleanerLocation = typeof cleanerLocationsTable.$inferSelect;
