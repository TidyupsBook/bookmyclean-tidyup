import {
  pgTable,
  text,
  serial,
  integer,
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
  // Which booking-form boxes must be filled before a booking can be saved,
  // by field key (name, phone, email, address, service, time). Empty — the
  // default — means everything is optional except the date: the owner asked
  // to save a booking with whatever they have, and a booking still has to
  // land somewhere on the calendar. The dashboard, the Bookings dialog and
  // the phone app all read this one list, so the three forms can't disagree.
  bookingRequiredFields: text("booking_required_fields")
    .array()
    .notNull()
    .default([]),
  // How many minutes after a call ends the mobile "Take booking" shortcut
  // stays on completed/missed rows. Busier receptions raise it, tidier ones
  // lower it; 30 matches the old hardcoded window.
  recentCallWindowMinutes: integer("recent_call_window_minutes")
    .notNull()
    .default(30),
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
  // Short code the crew types when signing up, so they land as a request to
  // join THIS company instead of creating an empty one of their own. It is not
  // a credential: it only decides which owner sees the request, and nothing
  // happens until that owner (or a dispatcher) approves it. Generated the
  // first time the Staff page asks for it, so existing companies get one
  // without a backfill.
  joinCode: text("join_code").unique(),
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
  // Quote-pull cursor: quotes updated up to this instant have all been
  // mirrored into jobber_quotes. Advances only when a pull read every page
  // Jobber offered — never derived from mirrored rows, because a capped pull
  // also writes rows and would silently advance a row-derived watermark past
  // updates on the pages it never saw.
  jobberQuotesSyncedThrough: timestamp("jobber_quotes_synced_through", {
    withTimezone: true,
  }),
  // Set on the first backfill run (whenever no watermark exists and this
  // marker is null) so that a completing backfill can set the watermark back
  // to this point in time — covering the entire multi-run backfill window,
  // not just the last hour. Cleared when the backfill completes.
  jobberQuotesBackfillStartedAt: timestamp(
    "jobber_quotes_backfill_started_at",
    { withTimezone: true },
  ),
  // Persists the Jobber pagination endCursor from the last capped backfill
  // run. The next run resumes from this cursor so a tie group of quotes
  // sharing one createdAt second can span multiple runs without looping
  // forever on the same filter floor. Cleared when the backfill completes.
  jobberQuotesBackfillEndCursor: text("jobber_quotes_backfill_end_cursor"),
  // The exact createdAt filter floor that was active when backfillEndCursor
  // was saved. Jobber pagination cursors are query-scoped: a cursor issued
  // against { createdAt > "2024-01-01" } is only valid for subsequent pages
  // of that exact query. Storing the floor alongside the cursor guarantees
  // the resuming run submits the identical filter. Cleared with the cursor.
  jobberQuotesBackfillFilterFloor: text("jobber_quotes_backfill_filter_floor"),
  // Request-pull cursor, same contract as the quote cursor above: advances
  // only on a complete pull, never derived from imported rows.
  jobberRequestsSyncedThrough: timestamp("jobber_requests_synced_through", {
    withTimezone: true,
  }),
  // Resumable request backfill, the same three-marker contract as the quote
  // backfill above. Requests need the saved-cursor form outright: the pull
  // sorts by REQUESTED_AT while filtering on updatedAt, and imported requests
  // become bookings rather than mirror rows, so no row-derived floor can ever
  // resume a capped run — only Jobber's own pagination cursor can.
  jobberRequestsBackfillStartedAt: timestamp(
    "jobber_requests_backfill_started_at",
    { withTimezone: true },
  ),
  jobberRequestsBackfillEndCursor: text("jobber_requests_backfill_end_cursor"),
  jobberRequestsBackfillFilterFloor: text(
    "jobber_requests_backfill_filter_floor",
  ),
  // Invoice-pull cursor, same contract again: advances only on a complete
  // pull, never derived from mirrored rows.
  jobberInvoicesSyncedThrough: timestamp("jobber_invoices_synced_through", {
    withTimezone: true,
  }),
  // One-time calendar history catch-up (see jobberHistoryCatchup.ts): visits
  // from the pinned history floor (Aug 2026) up to the rolling window's back
  // edge, for companies connecting after the window has moved past the floor.
  // `syncedTo` is the YYYY-MM-DD day imported through so far — a resume
  // cursor that advances only on a complete slice pull. `backfilledAt` marks
  // the catch-up finished; once set it never runs again.
  jobberHistorySyncedTo: text("jobber_history_synced_to"),
  jobberHistoryBackfilledAt: timestamp("jobber_history_backfilled_at", {
    withTimezone: true,
  }),
  // Set when we learn the stored tokens are dead (refresh rejected, or Jobber
  // told us the app was disconnected) so the UI can prompt a reconnect instead
  // of offering a sync that is guaranteed to fail.
  jobberNeedsReauth: boolean("jobber_needs_reauth").notNull().default(false),
  /**
   * How many roster slots — filled staff cards plus "Open seat" placeholders —
   * the Team page shows. Owners can raise it beyond the default of 20.
   * The default of 20 fits the "15 Jobber staff + 5 open slots" model most
   * single-crew companies start with.
   */
  rosterCapacity: integer("roster_capacity").notNull().default(20),
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
  // The shop's own spot on the map. Set when the owner marks a device as the
  // office: the office marker is ALWAYS drawn here, never at whatever the
  // browser's geolocation last claimed, so a bad reading can't move the shop.
  officeAddress: text("office_address"),
  officeLat: doublePrecision("office_lat"),
  officeLng: doublePrecision("office_lng"),
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
