import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/**
 * One row per Jobber OAuth connection per company.
 *
 * A company that connected Jobber before multi-account support existed gets
 * a single row seeded from the companies.jobber_* columns during the
 * 0073 migration. Additional connections are created through the OAuth flow
 * when the owner wants to link a second Jobber account (a separate crew,
 * franchise location, etc.).
 *
 * The companies.jobber_* columns are kept for backward compatibility but are
 * no longer the authoritative source — use this table's rows instead.
 */
export const jobberConnectionsTable = pgTable("jobber_connections", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  /**
   * Owner-chosen label shown in the Jobber Connections section on the Team
   * page, e.g. "Main crew" or "Night crew". Null until the owner assigns one.
   */
  displayName: text("display_name"),
  /** Jobber account id, used to detect when a re-connect hits the same account. */
  accountId: text("account_id"),
  /** Jobber account name as returned by the account query. */
  accountName: text("account_name"),
  /** AES-256-GCM encrypted access token — never sent to the browser. */
  accessToken: text("access_token"),
  /** AES-256-GCM encrypted refresh token — never sent to the browser. */
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  /**
   * Set when a token refresh is rejected (grant revoked / expired).
   * The UI switches from "Sync" to "Reconnect Jobber" for this connection.
   */
  needsReauth: boolean("needs_reauth").notNull().default(false),
  /**
   * True for the one connection whose tokens are kept in sync with
   * companies.jobber_* so every existing sync path continues to work without
   * being rewritten.  Exactly one connection per company is primary at any
   * time.  When the primary is deleted, the next-oldest connection is promoted.
   * When the last connection is deleted, the company is fully disconnected.
   */
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type JobberConnection = typeof jobberConnectionsTable.$inferSelect;
