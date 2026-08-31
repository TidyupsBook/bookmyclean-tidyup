import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  doublePrecision,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { QuoteTotals } from "@workspace/pricing";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const bookingsTable = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    // Unique so concurrent transcript/summary webhooks for the same call cannot
    // create duplicate bookings.
    callId: integer("call_id").unique(),
    // Set when this booking was worked from the Leads inbox. Read by the
    // Jobber push, which must never match a lead onto an existing Jobber
    // client by phone — an ad enquiry becomes a new client and the owner
    // merges it in Jobber if it turns out to be someone they already have.
    //
    // No .references() here, and no foreign key in the database either: the
    // origin has to outlive the lead row. If deleting a lead nulled this out,
    // a later re-send would go back to matching by phone. See the migration.
    leadId: integer("lead_id"),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    tag: text("tag"),
    // The street line only. City/province/postal are separate below because the
    // booking desk types them into separate boxes and Jobber wants them apart —
    // but everything that displays or geocodes an address joins them back up, so
    // a booking taken over the phone before those boxes existed still works.
    customerAddress: text("customer_address"),
    // Optional apartment, suite, or unit line. Kept separate from the street
    // address so geocoding and Jobber receive the address in the right order.
    addressLine2: text("address_line_2"),
    customerEmail: text("customer_email"),
    addressCity: text("address_city"),
    addressProvince: text("address_province"),
    addressPostal: text("address_postal"),
    service: text("service").notNull(),
    // What the dispatcher is walking through on the phone. All optional: a
    // caller who won't say how many bathrooms they have still gets a booking.
    bedrooms: integer("bedrooms"),
    bathrooms: integer("bathrooms"),
    // Extra rooms/appliances chosen as chips, e.g. ["Oven", "Fridge"]. Free
    // strings rather than an enum so a company can be asked for its own list
    // later without a migration.
    extras: jsonb("extras").$type<string[]>(),
    // one_time | weekly | biweekly | monthly. Recurrence is recorded here but
    // NOT expanded into future bookings — this is what the customer asked for,
    // not a schedule. Jobber owns recurring visits.
    frequency: text("frequency"),
    // Gate codes, dogs, where the key is. Crew-visible, never sent to the
    // customer and never part of a quote.
    internalNotes: text("internal_notes"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"), // pending | confirmed | completed | canceled
    // Quoting lives here rather than in Jobber, so companies that skip Jobber
    // can still price a job and text the customer.
    //
    // A job is priced as hours x crew rate, plus a fuel surcharge, less any
    // promo discount. Those inputs are stored rather than just their result, so
    // reopening a quote shows the dispatcher the same choices they made — and the
    // estimate's line items can be rebuilt from them exactly.
    quoteHours: doublePrecision("quote_hours"),
    // Which crew option was picked, e.g. "2 cleaners". Free text because it is
    // shown to the customer and companies word it differently.
    quoteCrewLabel: text("quote_crew_label"),
    quoteHourlyRate: doublePrecision("quote_hourly_rate"),
    // Null means "use the company default"; 0 means "waived for this job".
    quoteFuelSurcharge: doublePrecision("quote_fuel_surcharge"),
    quoteDiscountAmount: doublePrecision("quote_discount_amount"),
    // Where the customer heard about the company — names the discount line on
    // the estimate, e.g. "Discount $10 Google Ad Promo".
    quoteReferralSource: text("quote_referral_source"),
    // Fallback for a job priced without the calculator: a flat subtotal, before
    // the company's tax and fees. The customer-facing total is always derived,
    // never stored, so changing a tax rate cannot leave an old quote disagreeing
    // with itself.
    quotedAmount: doublePrecision("quoted_amount"),
    // Overrides the company default when a particular job needs more up front.
    quoteDeposit: doublePrecision("quote_deposit"),
    quoteNotes: text("quote_notes"),
    // What the customer was actually promised, frozen at the moment the text
    // went out. Everything else about a quote is derived from current settings,
    // but a sent price is a commitment: changing the company's tax rate next
    // month must not rewrite history and leave the dashboard disagreeing with
    // the message in the customer's phone.
    quoteSentTotals: jsonb("quote_sent_totals").$type<QuoteTotals>(),
    // The exact text last sent to the customer, and when. Kept so the dispatcher
    // can see what was promised rather than guessing from the amount alone.
    quoteMessage: text("quote_message"),
    quoteSentAt: timestamp("quote_sent_at", { withTimezone: true }),
    // The customer's key to their own quote page. Unguessable rather than
    // sequential: the page is necessarily public — someone reading a text on
    // their phone is not going to sign in — so the token IS the authorisation.
    // Unique so a collision fails loudly instead of handing one customer another
    // customer's quote.
    quoteToken: text("quote_token").unique(),
    // Set when the customer taps Approve on that page.
    quoteApprovedAt: timestamp("quote_approved_at", { withTimezone: true }),
    // The client said yes and somebody in the office recorded it — most
    // approvals happen on the phone, not through the link. Deliberately
    // separate from `quoteApprovedAt`: one is the customer's own tap, this one
    // is second-hand, and "who told us" is the difference that matters when an
    // owner is looking at a job nobody remembers agreeing to.
    clientApprovedAt: timestamp("client_approved_at", { withTimezone: true }),
    // The name of the person who recorded it, kept as text so it survives
    // them leaving the team.
    clientApprovedBy: text("client_approved_by"),
    // The Stripe Checkout session opened for this booking's deposit. Kept so a
    // customer who wanders off mid-payment can be reconciled later without
    // guessing which session was theirs.
    depositCheckoutSessionId: text("deposit_checkout_session_id"),
    // Set once Stripe confirms the deposit actually cleared — never on redirect
    // alone, which the customer can fake by editing the URL.
    depositPaidAt: timestamp("deposit_paid_at", { withTimezone: true }),
    // What they actually paid, in case the company edits the deposit afterwards.
    depositPaidAmount: doublePrecision("deposit_paid_amount"),
    // Set when the company's timezone change shifted this booking's displayed
    // wall-clock time. The owner is asked to confirm or adjust — the stored UTC
    // instant may have been entered under the wrong zone.
    needsTimeReview: boolean("needs_time_review").notNull().default(false),
    // The zone the booking was displayed in before the switch, so the review UI
    // can show "was 10:00 AM MDT". Kept from the *first* flagging so repeated
    // zone changes still reference what the owner originally saw.
    timeReviewPreviousTimezone: text("time_review_previous_timezone"),
    jobberSynced: boolean("jobber_synced").notNull().default(false),
    jobberJobId: text("jobber_job_id"),
    // The Jobber *job* this booking was imported from, when the calendar pull
    // created it. Deliberately separate from `jobberJobId`, which holds the
    // Jobber *request* id our outbound sync creates — one is "Jobber told us
    // about this", the other is "we told Jobber about this", and conflating them
    // would make the calendar sync overwrite work it never imported.
    jobberSyncedJobId: text("jobber_synced_job_id"),
    // The Jobber *visit* this booking mirrors. A recurring client is one Jobber
    // job with a visit per clean, so the calendar pull keys on visits — keying
    // on jobs put a weekly customer on the board once, at the job's first-ever
    // date. The parent job id above still rides along for time-sheet matching.
    jobberVisitId: text("jobber_visit_id"),
    // The connected Jobber account this imported visit belongs to. A company
    // can have several Jobber accounts, and their visit ids/cancellation pulls
    // are independent — this source keeps one account's reconciliation from
    // canceling another account's work.
    jobberConnectionId: integer("jobber_connection_id"),
    jobberClientId: text("jobber_client_id"),
    jobberWebUri: text("jobber_web_uri"),
    // The Jobber invoice created from this booking's quote, when the owner
    // clicked Create Invoice. Presence means "already invoiced" — the button
    // must not mint a second invoice for the same job.
    jobberInvoiceId: text("jobber_invoice_id"),
    jobberInvoiceNumber: text("jobber_invoice_number"),
    // Jobber's own web URL for that invoice, captured at creation time so
    // "open the invoice" never has to guess how Jobber builds its links.
    // Null for invoices created before this column existed.
    jobberInvoiceWebUri: text("jobber_invoice_web_uri"),
    // The Jobber property (service address) this booking's work happens at.
    // Jobber needs one to schedule a job or raise a quote, and it is reused
    // across visits so a regular customer's address isn't duplicated.
    jobberPropertyId: text("jobber_property_id"),
    // The quote raised in Jobber from this booking's own quote. Presence means
    // "already sent over" — re-texting a quote must not mint a second one.
    jobberQuoteId: text("jobber_quote_id"),
    jobberQuoteNumber: text("jobber_quote_number"),
    jobberQuoteWebUri: text("jobber_quote_web_uri"),
    // The Jobber job and visit *we* scheduled from this booking's approved
    // quote. Kept apart from `jobberSyncedJobId`/`jobberVisitId`, which mean
    // "Jobber told us about this": the outbound push refuses to send a booking
    // carrying those, and a job we created ourselves must not start looking
    // imported until the calendar pull actually adopts it.
    jobberCreatedJobId: text("jobber_created_job_id"),
    jobberCreatedVisitId: text("jobber_created_visit_id"),
    // The Jobber *request* this booking was imported from, when the pending
    // pull created it. Deliberately separate from `jobberJobId`, which holds
    // the request id our OUTBOUND push minted — one means "Jobber told us
    // about this", the other "we told Jobber about this". Conflating them
    // would let a pull adopt (or a sweep cancel) work it never imported.
    jobberSyncedRequestId: text("jobber_synced_request_id"),
    // Same story for quotes: the Jobber *quote* this booking was imported
    // from, kept apart from `jobberQuoteId` (the quote our push raised —
    // though an import also stamps `jobberQuoteId` so the accept-and-assign
    // flow can schedule from the real Jobber quote). The sync keys on THIS
    // column only.
    jobberSyncedQuoteId: text("jobber_synced_quote_id"),
    // Jobber's own page for that job, captured at creation time so the office
    // can open it without the app guessing how Jobber builds its links.
    jobberJobWebUri: text("jobber_job_web_uri"),
    jobberSyncError: text("jobber_sync_error"),
    jobberSyncErrorAt: timestamp("jobber_sync_error_at", {
      withTimezone: true,
    }),
    // Automatic retries back off and stop after a bounded number of attempts.
    // Manual retries still use the normal sync path and remain available after
    // the automatic retry budget is exhausted.
    jobberSyncAttempts: integer("jobber_sync_attempts").notNull().default(0),
    // Geocoded position of the job's address, for the live dispatch map. Null
    // until the address is resolved; geocodedAt records when that happened so a
    // stale pin can be refreshed after an address edit.
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    geocodedAt: timestamp("geocoded_at", { withTimezone: true }),
    // How long the job is expected to take, for laying it out on the schedule.
    durationMinutes: integer("duration_minutes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A legacy row has no source connection, but still needs duplicate
    // protection until it can be safely claimed by a proven matching primary.
    uniqueIndex("bookings_company_legacy_jobber_visit_idx")
      .on(table.companyId, table.jobberVisitId)
      .where(
        sql`${table.jobberVisitId} is not null and ${table.jobberConnectionId} is null`,
      ),
    // One row per named Jobber connection + visit, enforced by the database
    // rather than by the sync's row-exists check — two sync processes overlap
    // during a rolling deploy. Visit ids and cancellation pulls are only
    // meaningful inside their Jobber account.
    uniqueIndex("bookings_company_connection_jobber_visit_idx")
      .on(table.companyId, table.jobberConnectionId, table.jobberVisitId)
      .where(
        sql`${table.jobberVisitId} is not null and ${table.jobberConnectionId} is not null`,
      ),
    // One row per imported Jobber request/quote, enforced by the database:
    // two sync processes overlap during a rolling deploy, and the loser's
    // insert must become a no-op instead of a duplicate pending booking.
    uniqueIndex("bookings_company_jobber_synced_request_idx")
      .on(table.companyId, table.jobberSyncedRequestId)
      .where(sql`${table.jobberSyncedRequestId} is not null`),
    uniqueIndex("bookings_company_jobber_synced_quote_idx")
      .on(table.companyId, table.jobberSyncedQuoteId)
      .where(sql`${table.jobberSyncedQuoteId} is not null`),
    // Every schedule, map, and dashboard query filters by company and a
    // scheduled_for window; without this index those queries scan the whole
    // history, which grows forever now that Jobber-era jobs are kept.
    index("bookings_company_scheduled_for_idx").on(
      table.companyId,
      table.scheduledFor,
    ),
  ],
);

export const insertBookingSchema = createInsertSchema(bookingsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookingsTable.$inferSelect;
