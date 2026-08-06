import {
  pgTable,
  text,
  serial,
  integer,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const servicesTable = pgTable("services", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  name: text("name").notNull(),
  description: text("description"),
  // Optional — not every service has a published price range.
  priceMin: doublePrecision("price_min"),
  priceMax: doublePrecision("price_max"),
  durationMinutes: integer("duration_minutes"),
});

export const insertServiceSchema = createInsertSchema(servicesTable).omit({
  id: true,
});
export type InsertService = z.infer<typeof insertServiceSchema>;
export type Service = typeof servicesTable.$inferSelect;
