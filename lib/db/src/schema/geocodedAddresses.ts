import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  doublePrecision,
} from "drizzle-orm/pg-core";

/**
 * A durable cache of address → coordinates.
 *
 * Cleaning is repeat work: the same house is cleaned every week, so importing
 * a season of jobs produces hundreds of bookings sharing a few dozen distinct
 * addresses. Geocoding each booking would bill Google once per visit and take
 * hours at a safe request rate. Resolving each distinct address once and
 * fanning the result out to every booking at it turns that into a few dozen
 * calls, finished in a couple of minutes.
 *
 * Deliberately NOT scoped to a company. Coordinates are a property of the
 * address, not of who happens to clean there, and a shared cache means a
 * street that one company has already paid to resolve is free for the next.
 * Nothing company-owned lives here and it is never exposed through the API —
 * a lookup only ever answers a question the caller already knew the address
 * for.
 *
 * Failures are cached too. Google confidently resolves almost anything, so a
 * null result means the address is genuinely unusable; without remembering
 * that, every cycle would retry the same handful of bad addresses forever and
 * starve out work that would succeed.
 */
export const geocodedAddressesTable = pgTable("geocoded_addresses", {
  id: serial("id").primaryKey(),
  /** Whitespace-collapsed, lowercased address — see normalizeAddress(). */
  addressKey: text("address_key").notNull().unique(),
  /** Null together when the address could not be placed. */
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  /** How many times we've asked Google about this one. */
  attempts: integer("attempts").notNull().default(0),
  /** Last time Google answered at all, hit or miss. */
  checkedAt: timestamp("checked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GeocodedAddress = typeof geocodedAddressesTable.$inferSelect;
