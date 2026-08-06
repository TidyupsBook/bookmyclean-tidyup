import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/**
 * Map pins a dispatcher saves by hand — recurring homeowners, gate codes'
 * addresses, or anywhere worth marking that is not tied to a specific booking.
 *
 * Scoped to a company so pins never bleed across the shared map.
 */
export const homeownerPinsTable = pgTable(
  "homeowner_pins",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("homeowner_pins_company_id_idx").on(table.companyId)],
);

export type HomeownerPin = typeof homeownerPinsTable.$inferSelect;
