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
import { staffDevicesTable } from "./staffDevices";

/**
 * The latest known GPS position for each *device*, powering the live dispatch
 * map. One row per device — the client upserts this row as it moves rather
 * than appending a trail, so the table stays small and a read is always the
 * current location.
 *
 * It used to be one row per team member, which meant a person signed in on a
 * phone and a tablet had the two clients overwriting each other. The seat is
 * still carried here (denormalized from the device) because almost every read
 * groups by person — who is live, whose trail is this — and joining through
 * the device table for that is noise.
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
      .references(() => teamMembersTable.id, { onDelete: "cascade" }),
    /**
     * Which device reported this. Unique: a device has exactly one current
     * position. Nullable only for the instant between the migration adding
     * the column and its backfill — every write sets it.
     */
    deviceId: integer("device_id")
      .references(() => staffDevicesTable.id, { onDelete: "cascade" })
      .unique(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    // Reported horizontal accuracy in metres, when the device supplies it.
    accuracy: real("accuracy"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cleaner_locations_company_id_idx").on(table.companyId),
    index("cleaner_locations_team_member_idx").on(table.teamMemberId),
  ],
);

export type CleanerLocation = typeof cleanerLocationsTable.$inferSelect;
