import {
  pgTable,
  text,
  serial,
  boolean,
  timestamp,
  jsonb,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type CustomQuestion = { question: string; answer: string };

export type JobberOauthState = {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: string;
};

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().unique(),
  // The address the owner signed up with, kept so ownership survives its login.
  // A Clerk account can be deleted, and a database moved between Clerk
  // instances carries ids that were never valid in the new one — in both cases
  // owner_user_id points at nothing and the company becomes unreachable, with
  // its owner sent to onboarding forever. Matching a VERIFIED email against
  // this column is what lets them back in. Null for companies created before
  // the column existed.
  ownerEmail: text("owner_email"),
  // How long owner_email may be used to re-attach this company, and nothing
  // more. A verified email is a weak proof of identity over time: addresses
  // get shared, handed to a successor, or released and re-registered by
  // someone else entirely. Left permanently open, this column would be a
  // standing route to take over a company by acquiring an old address.
  //
  // So it is not a standing feature. It is set only for the companies stranded
  // by the Clerk instance change, and only until the window closes. Companies
  // created normally never get one, and a genuinely deleted owner account is a
  // support job, not a self-service takeover.
  ownerRecoveryUntil: timestamp("owner_recovery_until", { withTimezone: true }),
  name: text("name").notNull(),
  greeting: text("greeting").notNull().default(""),
  collectFields: text("collect_fields").array().notNull().default([]),
  customQuestions: jsonb("custom_questions")
    .$type<CustomQuestion[]>()
    .notNull()
    .default([]),
  ringThroughNumber: text("ring_through_number"),
  // Fallback for owner-facing outage/recovery texts when no ring-through
  // number is set. Without either, those notifications can only surface in
  // the dashboard.
  notificationNumber: text("notification_number"),
  // Raw values that were stored before phone validation existed and could not
  // be normalized to E.164 by the one-time cleanup pass. The undialable value
  // is cleared from the live column and preserved here so settings can show
  // the owner what was removed. Nulled when the owner saves a replacement.
  ringThroughNumberRejected: text("ring_through_number_rejected"),
  notificationNumberRejected: text("notification_number_rejected"),
  phoneNumber: text("phone_number"),
  // IANA zone used when writing appointment times into customer-facing text.
  // Without this a quote would quote UTC and promise the wrong hour.
  timezone: text("timezone").notNull().default("America/Edmonton"),
  // Quote maths. Jobs are priced by the hour, at a rate that depends on how
  // many cleaners are sent. Defaults are Tidyups' real numbers.
  quoteRateSolo: doublePrecision("quote_rate_solo").notNull().default(52.5),
  quoteRateTeam: doublePrecision("quote_rate_team").notNull().default(105),
  quoteFuelSurcharge: doublePrecision("quote_fuel_surcharge")
    .notNull()
    .default(12.5),
  // Tax and fees go on top of the subtotal, and the rates are jurisdictional —
  // Alberta's 5% GST is not Ontario's 13% HST — so they belong to the company,
  // not the codebase.
  quoteTaxLabel: text("quote_tax_label").notNull().default("Alberta Tax"),
  quoteTaxRate: doublePrecision("quote_tax_rate").notNull().default(5),
  quoteFeesLabel: text("quote_fees_label").notNull().default("Fees & Supplies"),
  quoteFeesRate: doublePrecision("quote_fees_rate").notNull().default(7.5),
  // Default deposit asked for up front. Per-quote overrides live on the booking
  // — the real quotes show this varying by job.
  quoteDepositAmount: doublePrecision("quote_deposit_amount")
    .notNull()
    .default(0),
  // Where the customer sends the deposit. Named in the quote text itself.
  quoteDepositEmail: text("quote_deposit_email"),
  // Jobber OAuth tokens — real OAuth with PKCE
  jobberConnected: boolean("jobber_connected").notNull().default(false),
  // Jobber is optional. A company that explicitly skips it runs standalone:
  // quotes, scheduling and bookings all live in Book My Cleaning. This is a
  // deliberate choice, distinct from "hasn't got round to it yet", so the
  // setup wizard can stop blocking on it.
  jobberSkipped: boolean("jobber_skipped").notNull().default(false),
  jobberAccountName: text("jobber_account_name"),
  jobberAccountId: text("jobber_account_id"),
  jobberAccessToken: text("jobber_access_token"),
  jobberRefreshToken: text("jobber_refresh_token"),
  jobberTokenExpiresAt: timestamp("jobber_token_expires_at", {
    withTimezone: true,
  }),
  jobberOauth: jsonb("jobber_oauth").$type<JobberOauthState | null>(),
  // Set when we learn the stored tokens are dead (refresh rejected, or Jobber
  // told us the app was disconnected) so the UI can prompt a reconnect instead
  // of offering a sync that is guaranteed to fail.
  jobberNeedsReauth: boolean("jobber_needs_reauth").notNull().default(false),
  // Quo integration — company brings their own Quo workspace key
  quoConnected: boolean("quo_connected").notNull().default(false),
  quoWorkspaceName: text("quo_workspace_name"),
  // Quo lines this company's receptionist watches. A line may only be claimed
  // by one company — enforced in the selection route, since Postgres cannot
  // express uniqueness across array elements without an exclusion constraint.
  quoNumberIds: text("quo_number_ids").array().notNull().default([]),
  // The company's own Quo workspace API key, AES-256-GCM encrypted. Quo has no
  // OAuth flow, so each company pastes a key generated in their Quo settings.
  // Never returned to the browser — only `quoKeyLast4` is.
  quoApiKeyEncrypted: text("quo_api_key_encrypted"),
  quoKeyLast4: text("quo_key_last4"),
  // Set when Quo answers 401/403 for this company's key (revoked or rotated),
  // so the UI can warn the owner instead of failing silently. Cleared when a
  // key is (re)connected or a Quo call succeeds again.
  quoNeedsReauth: boolean("quo_needs_reauth").notNull().default(false),
  // Owner text still owed for the last Quo connection transition: "dead"
  // (outage text) or "restored" (back-online text), null when nothing is
  // owed. Decoupled from quoNeedsReauth so the dashboard warning flips
  // immediately even while a failed text is being retried by the hourly
  // health check.
  quoNotifyPending: text("quo_notify_pending"),
  receptionistConfigured: boolean("receptionist_configured")
    .notNull()
    .default(false),
  isLive: boolean("is_live").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
