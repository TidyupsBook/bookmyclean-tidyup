import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  doublePrecision,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { bookingsTable } from "./bookings";
import { callsTable } from "./calls";

/**
 * The Leads inbox rows: Facebook/Instagram lead-ad rows pulled from the leads
 * Google Sheet, requests submitted on our own public request form, and work
 * requests submitted on the company's Jobber form (webhook + sweep import).
 *
 * Everything is stored raw and verbatim — the answers are free text ("1 or
 * 2" bedrooms, a province of "Canada", padded phone numbers) and guessing at
 * cleanup here would silently rewrite what the customer actually typed. The
 * one derived column is `phoneE164`, kept alongside the raw number so
 * matching and dialing have something normalized to work with.
 */
export const leadsTable = pgTable(
  "leads",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    // Where the row came from: "sheet" (the ad-sheet sync), "form" (our own
    // public request form) or "jobber" (a request submitted on the company's
    // Jobber form, imported by the webhook or the sweep).
    source: text("source").notNull().default("sheet"),
    // The id that makes imports idempotent, per source: the sheet's own
    // unique lead id (or content fingerprint) for sheet rows, a random token
    // for form submissions, the Jobber request id for Jobber imports. The
    // unique index below on (company, externalId) is what makes re-syncs,
    // webhook replays and restarts idempotent: a row already imported is
    // skipped, never doubled.
    //
    // The physical column keeps its historical name — Publish diffs the dev
    // schema into production before boot, and a rename risks drop+add.
    externalId: text("sheet_lead_id").notNull(),
    // Which sheet tab the row came from, or a fixed label for form leads.
    sourceTab: text("source_tab").notNull(),
    // Raw values, verbatim.
    createdTime: text("created_time"),
    campaignName: text("campaign_name"),
    adName: text("ad_name"),
    formName: text("form_name"),
    platform: text("platform"),
    service: text("service"),
    bedrooms: text("bedrooms"),
    bathrooms: text("bathrooms"),
    dateOfServiceRequested: text("date_of_service_requested"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    phoneNumber: text("phone_number"),
    email: text("email"),
    streetAddress: text("street_address"),
    city: text("city"),
    province: text("province"),
    postCode: text("post_code"),
    inboxUrl: text("inbox_url"),
    // The sheet's own lead_status column, raw. Our review state lives in
    // `status` below — the sheet is read-only and never written back.
    sheetLeadStatus: text("sheet_lead_status"),
    // "How did you hear about us?" — form leads only, verbatim.
    heardAbout: text("heard_about"),
    // The customer's own words from the Jobber request (their first note on
    // the request), verbatim — never parsed into a schedule or anything else.
    message: text("message"),
    // ---- The Jobber records tied to this lead. ----
    // Which direction they travelled is told by `source`, never by these
    // columns: a "jobber" lead carries the ids it was IMPORTED from (so
    // converting attaches to what Jobber already has, and the outbound push
    // knows never to send it back), while a "form" or "sheet" lead carries
    // what OUR push into Jobber created for it.
    //
    // For form leads, `jobberRequestId` doubles as the push's claim slot:
    // while a push is in flight it holds a "pending:<ts>" marker, exactly
    // like the booking push's jobber_job_id, so two rapid submits or a
    // retry racing the original cannot mint two requests. `jobberSynced`
    // flips true only once a real request exists; jobber-source leads never
    // set it (they were never pushed).
    jobberSynced: boolean("jobber_synced").notNull().default(false),
    jobberRequestId: text("jobber_request_id"),
    jobberClientId: text("jobber_client_id"),
    jobberPropertyId: text("jobber_property_id"),
    // Jobber's own page for the request, captured when the id was (imported
    // or created), so the card links straight to it without guessing how
    // Jobber builds links.
    jobberWebUri: text("jobber_web_uri"),
    // Why the last push failed, verbatim; null after a clean push. Form
    // leads only. The lead stays in the inbox either way — Jobber being
    // down never loses a lead.
    jobberPushError: text("jobber_push_error"),
    jobberPushErrorAt: timestamp("jobber_push_error_at", {
      withTimezone: true,
    }),
    // Automatic retries back off and stop after a bounded number of attempts.
    // Manual retries still use the normal push path and are not limited by
    // this counter.
    jobberPushAttempts: integer("jobber_push_attempts").notNull().default(0),
    // A sheet row that was newly imported and still needs its automatic
    // Jobber push. This makes the handoff durable across a restart between
    // importing the row and starting the queued push; historical sheet rows
    // are false, so enabling the feature never backfills them unexpectedly.
    jobberPushPending: boolean("jobber_push_pending").notNull().default(false),
    // Normalized from phoneNumber at import time (both-sides normalization
    // happens at lookup too, since roster-style values are typed as-is).
    phoneE164: text("phone_e164"),
    // Where this lead's address sits on the map. Filled by the shared
    // geocode backfill (address-keyed cache, one Google lookup per distinct
    // address); null until resolved or when the address is unusable.
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    geocodedAt: timestamp("geocoded_at", { withTimezone: true }),
    // new | converted | dismissed — the dispatcher's review state.
    status: text("status").notNull().default("new"),
    // The owner's quick verdict. Null until tagged; independent of `status`
    // — a dismissed lead can still be marked spam so the pattern is visible
    // later. A DB CHECK constraint pins the same four values.
    tag: text("tag", { enum: ["client", "good_lead", "bad_lead", "spam"] }),
    // Set when the lead is converted, so the card can link to the booking.
    convertedBookingId: integer("converted_booking_id").references(
      () => bookingsTable.id,
    ),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    // The call that was saved as this lead (save-as-lead flow). Only set for
    // source="call" leads; null for every other source. Lets the card navigate
    // straight to the original transcript/recording without relying on the
    // phone-number match that powers lastCallId.
    callId: integer("call_id").references(() => callsTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Index name is historical; it now covers every source's external id.
    uniqueIndex("leads_company_sheet_lead_idx").on(
      table.companyId,
      table.externalId,
    ),
  ],
);

/**
 * One row per company: when the sheet was last polled and whether that poll
 * worked. A clean `lastError` still needs the timestamp freshness check: an
 * autoscaled process can sleep before its next interval callback.
 */
export const leadSyncStateTable = pgTable("lead_sync_state", {
  companyId: integer("company_id")
    .primaryKey()
    .references(() => companiesTable.id),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  // The result of the latest discovered-tab pass. An empty array means the
  // connector failed before the spreadsheet's tabs could be listed.
  tabStatuses: jsonb("tab_statuses")
    .$type<
      Array<{
        name: string;
        status: "read" | "failed";
        error?: string;
        rowsSeen?: number;
        eligibleRows?: number;
        importedRows?: number;
        duplicateRows?: number;
        skippedRows?: number;
        eligibilityWarning?: string;
      }>
    >()
    .notNull()
    .default([]),
  // Non-fatal: the sync worked, but the sheet grew a header this code
  // doesn't map to any stored field (the headers are hand-managed and have
  // renamed before). Null after a pass that recognized every header.
  lastWarning: text("last_warning"),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
export type LeadSyncState = typeof leadSyncStateTable.$inferSelect;
