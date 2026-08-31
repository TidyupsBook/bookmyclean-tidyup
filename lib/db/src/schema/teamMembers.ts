import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  uniqueIndex,
  boolean,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const teamMembersTable = pgTable(
  "team_members",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    name: text("name").notNull(),
    /**
     * Nullable on purpose: not everyone on a cleaning crew uses the app. An
     * address is what connects a person to a login, so a member without one is
     * simply staff who exist on the schedule and the map and never sign in.
     * Anything matching a caller to a seat must therefore treat a missing
     * email as "never matches" rather than as an empty string.
     */
    email: text("email"),
    phone: text("phone"),
    role: text("role").notNull(), // owner | dispatcher | cleaner
    /**
     * A display label, NOT a permission level. A lead cleaner sees exactly what
     * a cleaner sees; the distinction is who the crew answers to on site, which
     * is the owner's business and not the app's. Kept out of `role` so it can
     * never widen anyone's access by accident.
     */
    isLead: boolean("is_lead").notNull().default(false),
    /**
     * What this person is *called* on screen, in the owner's own words:
     * "Site Supervisor", "Window Tech", "Office". Free text, and again NOT a
     * permission level — it only replaces the wording that `role`/`isLead`
     * would otherwise produce ("Cleaner", "Lead Cleaner"). Null means "use
     * the standard wording", so an untouched roster reads exactly as before.
     *
     * Anything deciding what somebody may DO must read `role`; this column is
     * for humans, and letting it near a permission check would hand the
     * owner's authority to whoever can type a job title.
     */
    title: text("title"),
    /**
     * Whether this person is currently on the roster. Distinct from `status`,
     * which tracks the invite: someone can be fully signed up and still be
     * off the roster for the winter. Inactive staff keep their history and
     * their seat, they just stop appearing where work gets assigned.
     */
    active: boolean("active").notNull().default(true),
    /**
     * The colour this person's work is drawn in on the schedule and the map,
     * as `#rrggbb`. Null means "whatever the app picks", which is a stable
     * hue derived from the row id — so every member always has a colour and
     * this column only ever records a deliberate choice made in the office
     * (owner or dispatcher, the same people who keep the rest of the card).
     */
    color: text("color"),
    /**
     * Where this person starts and ends their day. Pinned on the live map so
     * dispatch can see who is nearest a job, and geocoded once on save.
     */
    homeAddress: text("home_address"),
    homeLat: doublePrecision("home_lat"),
    homeLng: doublePrecision("home_lng"),
    homeGeocodedAt: timestamp("home_geocoded_at", { withTimezone: true }),
    /**
     * Whether this person's devices may store and show a live position.
     *
     * Off by default, and only the owner can turn it on (the Tracking page).
     * Off means genuinely nothing: reported fixes are refused rather than
     * stored, and switching it back off deletes whatever was there — so a
     * cleaner who was never switched on has no position anywhere to leak.
     *
     * The owner's own seat is exempt: their authority over the company is
     * what the whole page is built on, so their devices are always tracked
     * and this column is not consulted for them.
     */
    locationSharing: boolean("location_sharing").notNull().default(false),
    /**
     * Whether this seat may take a booking off a live call — the incoming
     * call alert, the microphone panel and the form-filling routes.
     *
     * Off by default, and only the owner can switch it (a toggle on the
     * staff card). It is a grant on top of the dispatcher role, not a role
     * of its own: the entitlement check requires role `dispatcher` AND this
     * flag, so a stray true on a cleaner's row grants nothing. The owner
     * never needs it — his authority comes from owning the company.
     */
    liveCallDispatching: boolean("live_call_dispatching")
      .notNull()
      .default(false),
    /**
     * active    — a working seat.
     * invited   — created by the owner, waiting for that person to sign up.
     * pending   — the reverse direction: THEY signed up first, typed the
     *             company's join code, and are waiting to be let in. A pending
     *             seat carries a Clerk account but grants nothing at all until
     *             somebody with authority approves it.
     */
    status: text("status").notNull().default("invited"),
    /**
     * The Clerk account that claimed this seat. Null until the invitee signs up
     * and their VERIFIED email is matched to this row. Unique across the table,
     * so one Clerk account can never occupy two seats — if the same address is
     * invited by two companies, the first claim wins and the other stays
     * pending.
     */
    clerkUserId: text("clerk_user_id").unique(),
    /**
     * Clerk backend invitation id (`inv_...`) for the sign-up email we sent, so
     * removing the member can also revoke the emailed link. Null when the email
     * failed to send — the seat still works, the invitee just has to sign up
     * manually with the invited address.
     */
    clerkInvitationId: text("clerk_invitation_id"),
    /**
     * The Jobber user this staff member IS, once the owner has said so (or a
     * name match was unambiguous enough for the sync to adopt). This is what
     * assignment sync keys on in both directions, so renaming someone on
     * either side no longer breaks who a job is coloured for. Null means
     * "unlinked" — the sync falls back to name matching for these, exactly
     * as it always did.
     *
     * Identity only, on purpose: nothing else about the person (name, phone,
     * role) syncs through this link.
     */
    jobberUserId: text("jobber_user_id"),
    /**
     * Which Jobber connection (account) this staff member is assigned to.
     * Null means "use the company's only / primary connection" — the behaviour
     * before multi-account support existed. When multiple connections are active
     * the owner assigns each staff member to the right one here, and outbound
     * scheduling / calendar sync route them through that connection.
     *
     * FK is enforced at the DB level (see migration 0073). Not declared in
     * Drizzle to avoid a cross-schema import cycle; drizzle-orm doesn't need
     * the FK for querying, only for schema diffing.
     */
    jobberConnectionId: integer("jobber_connection_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /**
     * How long this seat may be re-claimed by a verified matching email after
     * the account holding it turns out to be deleted — and nothing more.
     *
     * A verified email proves who you are today, not that you are the person
     * who held this seat. Addresses get shared, inherited, or released and
     * re-registered. Left permanently open, this would be a standing way to
     * walk into somebody's company by acquiring an old address, so it is not a
     * standing feature: only the seats stranded by the Clerk instance change
     * carry a window, and only until it closes.
     */
    recoveryUntil: timestamp("recovery_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One seat per address per company, so two racing invites cannot leave a
    // ghost row that nobody can ever claim.
    uniqueIndex("team_members_company_email_idx").on(
      table.companyId,
      sql`lower(${table.email})`,
    ),
    // One seat per Jobber user per company — two staff members claiming the
    // same Jobber identity would make assignment sync nondeterministic.
    // NULLs are distinct in Postgres, so unlinked staff are unconstrained.
    uniqueIndex("team_members_company_jobber_user_idx").on(
      table.companyId,
      table.jobberUserId,
    ),
  ],
);

export const insertTeamMemberSchema = createInsertSchema(teamMembersTable).omit(
  { id: true, createdAt: true },
);
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type TeamMember = typeof teamMembersTable.$inferSelect;
