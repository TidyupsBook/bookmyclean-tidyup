import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { teamMembersTable } from "./teamMembers";
import { bookingsTable } from "./bookings";

export const savedRoutesTable = pgTable(
  "saved_routes",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    teamMemberId: integer("team_member_id")
      .notNull()
      .references(() => teamMembersTable.id),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("saved_routes_company_id_idx").on(table.companyId)],
);

export const savedRouteStopsTable = pgTable(
  "saved_route_stops",
  {
    id: serial("id").primaryKey(),
    routeId: integer("route_id")
      .notNull()
      .references(() => savedRoutesTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    linkedBookingId: integer("linked_booking_id").references(
      () => bookingsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("saved_route_stops_route_position_idx").on(
      table.routeId,
      table.position,
    ),
    uniqueIndex("saved_route_stops_route_position_unique").on(
      table.routeId,
      table.position,
    ),
  ],
);

export const insertSavedRouteSchema = createInsertSchema(savedRoutesTable).omit(
  { id: true, createdAt: true, updatedAt: true },
);
export const insertSavedRouteStopSchema = createInsertSchema(
  savedRouteStopsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSavedRoute = z.infer<typeof insertSavedRouteSchema>;
export type InsertSavedRouteStop = z.infer<typeof insertSavedRouteStopSchema>;
export type SavedRoute = typeof savedRoutesTable.$inferSelect;
export type SavedRouteStop = typeof savedRouteStopsTable.$inferSelect;
