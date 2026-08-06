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
     * Whether this person is currently on the roster. Distinct from `status`,
     * which tracks the invite: someone can be fully signed up and still be
     * off the roster for the winter. Inactive staff keep their history and
     * their seat, they just stop appearing where work gets assigned.
     */
    active: boolean("active").notNull().default(true),
    /**
     * Where this person starts and ends their day. Pinned on the live map so
     * dispatch can see who is nearest a job, and geocoded once on save.
     */
    homeAddress: text("home_address"),
    homeLat: doublePrecision("home_lat"),
    homeLng: doublePrecision("home_lng"),
    homeGeocodedAt: timestamp("home_geocoded_at", { withTimezone: true }),
    status: text("status").notNull().default("invited"), // active | invited
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
  ],
);

export const insertTeamMemberSchema = createInsertSchema(teamMembersTable).omit(
  { id: true, createdAt: true },
);
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type TeamMember = typeof teamMembersTable.$inferSelect;
