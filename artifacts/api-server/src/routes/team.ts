import { Router, type IRouter } from "express";
import { and, eq, ne, sql } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, teamMembersTable, activityTable } from "@workspace/db";
import {
  ListTeamMembersResponse,
  InviteTeamMemberBody,
  InviteTeamMemberResponse,
  UpdateTeamMemberBody,
  UpdateTeamMemberParams,
  UpdateTeamMemberResponse,
  ImportTeamMembersBody,
  ImportTeamMembersResponse,
  RemoveTeamMemberParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { forgetDeniedCaller } from "../lib/callerRole";
import { getCaller } from "../middlewares/requireRole";
import { findBlockedEmails } from "../lib/seatAffiliation";
import { geocodeAddress, GeocodeConfigError } from "../services/geocode";
import { logger } from "../lib/logger";

/**
 * A cleaning company has a crew, not a payroll database. A file bigger than
 * this is a mistake — a wrong export, a duplicated sheet — and taking it would
 * mean a request that runs for minutes and a geocoding bill to match.
 */
const MAX_IMPORT_ROWS = 500;
/** Enough for the owner to see the pattern; the log has the rest. */
const MAX_IMPORT_ERRORS = 20;

const router: IRouter = Router();

function pushError(errors: string[], message: string): void {
  if (errors.length < MAX_IMPORT_ERRORS) errors.push(message);
  else if (errors.length === MAX_IMPORT_ERRORS) {
    errors.push("…and more rows had problems.");
  }
}

router.use(requireAuth);

function serializeMember(
  m: typeof teamMembersTable.$inferSelect,
  blockedByOtherCompany = false,
) {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    role: m.role,
    isLead: m.isLead,
    active: m.active,
    homeAddress: m.homeAddress,
    homeLat: m.homeLat,
    homeLng: m.homeLng,
    status: m.status,
    // The two facts the Staff page needs to stop lying about invites: whether
    // this person can actually sign in, and whether the email really went.
    hasLogin: m.clerkUserId !== null,
    inviteEmailSent: m.clerkInvitationId !== null,
    // True when this invite can never be accepted because the address is
    // already attached to another company (one login = one company).
    blockedByOtherCompany,
    claimedAt: m.claimedAt ? m.claimedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Empty and whitespace-only both mean "not given", never an empty string. */
function cleanText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanEmail(value: string | null | undefined): string | null {
  const email = cleanText(value);
  return email ? email.toLowerCase() : null;
}

/**
 * Look up a home address so it can be pinned.
 *
 * Never fatal: a staff member with an address we couldn't place is still a
 * staff member. A missing or denied Maps key in particular must not stop
 * someone being added to the roster, so it degrades to "saved, just not
 * pinned".
 */
async function locateHome(address: string | null): Promise<{
  homeAddress: string | null;
  homeLat: number | null;
  homeLng: number | null;
  homeGeocodedAt: Date | null;
}> {
  const empty = {
    homeAddress: address,
    homeLat: null,
    homeLng: null,
    homeGeocodedAt: null,
  };
  if (!address) return empty;
  try {
    const coords = await geocodeAddress(address);
    if (!coords) return empty;
    return {
      homeAddress: address,
      homeLat: coords.lat,
      homeLng: coords.lng,
      homeGeocodedAt: new Date(),
    };
  } catch (err) {
    if (!(err instanceof GeocodeConfigError)) {
      logger.warn({ err }, "[team] home address lookup failed");
    }
    return empty;
  }
}

/**
 * Where the invitation email's sign-up link should land. Clerk's development
 * and production instances have separate user stores, so the link has to
 * point back at the SAME environment that sent it — otherwise the invitee
 * creates an account the app cannot see.
 */
function inviteRedirectUrl(): string {
  const domain =
    process.env["REPLIT_DEPLOYMENT"] === "1"
      ? process.env["REPLIT_DOMAINS"]?.split(",")[0]?.trim()
      : process.env["REPLIT_DEV_DOMAIN"]?.trim();
  return domain ? `https://${domain}/` : "/";
}

/**
 * Send the Clerk sign-up invitation. A failure is reported to the caller so
 * the UI can say so, but never blocks the seat being created: claiming works
 * off the verified email at first sign-in, so the person can still get in by
 * signing up manually with the invited address.
 */
async function sendInviteEmail(
  email: string,
): Promise<{ sent: boolean; invitationId: string | null }> {
  try {
    const invitation = await clerkClient.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: inviteRedirectUrl(),
      notify: true,
      ignoreExisting: true,
    });
    return { sent: true, invitationId: invitation.id };
  } catch (err) {
    logger.error({ err, email }, "[team] failed to send Clerk invite email");
    return { sent: false, invitationId: null };
  }
}

/** Is this address already on the roster (ignoring one member being edited)? */
async function emailTaken(
  companyId: number,
  email: string,
  exceptId?: number,
): Promise<boolean> {
  const conditions = [
    eq(teamMembersTable.companyId, companyId),
    sql`lower(trim(${teamMembersTable.email})) = ${email}`,
  ];
  if (exceptId !== undefined) {
    conditions.push(ne(teamMembersTable.id, exceptId));
  }
  const [row] = await db
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(and(...conditions))
    .limit(1);
  return Boolean(row);
}

router.get(
  "/team",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.json(ListTeamMembersResponse.parse([]));
      return;
    }
    const members = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.companyId, caller.company.id))
      .orderBy(teamMembersTable.id);

    // Label invites that can never be accepted because the address already
    // belongs to someone attached to another company, so the owner can act
    // (remove the seat and invite a different address) instead of waiting.
    // Staff with no email were never invited, so they are not in this set.
    const pendingEmails = members
      .filter((m) => m.clerkUserId === null && m.role !== "owner" && m.email)
      .map((m) => m.email!);
    const blocked = await findBlockedEmails(pendingEmails);

    res.json(
      ListTeamMembersResponse.parse(
        members.map((m) =>
          serializeMember(
            m,
            m.clerkUserId === null &&
              m.email !== null &&
              blocked.has(m.email.trim().toLowerCase()),
          ),
        ),
      ),
    );
  },
);

router.post(
  "/team",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    // Adding someone hands out access to customer data and money movement,
    // so it stays with the owner rather than anyone holding a dispatcher seat.
    // Checked before anything else so a non-owner always gets 403, not a
    // validation error that suggests retrying might work.
    const caller = await getCaller(req);
    if (caller.role !== "owner") {
      res.status(403).json({ error: "Only the owner can add team members" });
      return;
    }
    const parsed = InviteTeamMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const name = cleanText(parsed.data.name);
    if (!name) {
      res.status(400).json({ error: "A name is required" });
      return;
    }
    const email = cleanEmail(parsed.data.email);

    if (email) {
      if (await emailTaken(caller.company.id, email)) {
        res.status(409).json({ error: "That email is already on your team" });
        return;
      }

      // Block up front rather than letting the invite hang forever: a login can
      // only belong to one company, so an address already attached elsewhere
      // can never accept this invite.
      const blocked = await findBlockedEmails([email]);
      if (blocked.has(email)) {
        res.status(409).json({
          error:
            "That address already has a login with another company. A login can only belong to one company — ask them for a different email address to use here.",
        });
        return;
      }
    }

    // Only someone with an address gets an invitation; staff without one are
    // simply on the roster and never sign in.
    const invite = email
      ? await sendInviteEmail(email)
      : { sent: false, invitationId: null };

    const home = await locateHome(cleanText(parsed.data.homeAddress));

    const [member] = await db
      .insert(teamMembersTable)
      .values({
        name,
        email,
        phone: cleanText(parsed.data.phone),
        role: parsed.data.role,
        isLead: parsed.data.isLead ?? false,
        active: parsed.data.active ?? true,
        companyId: caller.company.id,
        // No address means no invitation is outstanding, so there is nothing
        // to wait for — the seat is simply live.
        status: email ? "invited" : "active",
        clerkInvitationId: invite.invitationId,
        ...home,
      })
      .returning();

    // A previously denied account may be this invitee refreshing the page; drop
    // the negative cache so they are let in on their next request.
    forgetDeniedCaller();

    await db.insert(activityTable).values({
      companyId: caller.company.id,
      type: "team_invited",
      message: email
        ? invite.sent
          ? `${name} was invited as a ${parsed.data.role}.`
          : `${name} was added as a ${parsed.data.role}, but the invite email could not be sent.`
        : `${name} was added to the team as a ${parsed.data.role}.`,
    });

    res
      .status(201)
      .json(InviteTeamMemberResponse.parse(serializeMember(member!)));
  },
);

router.patch(
  "/team/:id",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = UpdateTeamMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateTeamMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    const [target] = await db
      .select()
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.id, params.data.id),
          eq(teamMembersTable.companyId, caller.company.id),
        ),
      )
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }

    const body = parsed.data;
    const changesRole = body.role !== undefined && body.role !== target.role;
    const changesEmail =
      body.email !== undefined && cleanEmail(body.email) !== target.email;

    // A dispatcher can keep the roster tidy — phone numbers, addresses, who is
    // on this week. What they cannot do is change who can sign in or what
    // anyone is allowed to see; that is the owner's alone.
    if ((changesRole || changesEmail) && caller.role !== "owner") {
      res.status(403).json({
        error: "Only the owner can change someone's role or email address",
      });
      return;
    }
    if (changesRole && target.role === "owner") {
      res.status(400).json({ error: "The owner's role cannot be changed" });
      return;
    }

    const updates: Partial<typeof teamMembersTable.$inferInsert> = {};

    if (body.name !== undefined) {
      const name = cleanText(body.name);
      if (!name) {
        res.status(400).json({ error: "A name is required" });
        return;
      }
      updates.name = name;
    }
    if (body.phone !== undefined) updates.phone = cleanText(body.phone);
    if (body.isLead !== undefined) updates.isLead = body.isLead;
    if (body.active !== undefined) updates.active = body.active;
    if (changesRole) updates.role = body.role;

    let invite: { sent: boolean; invitationId: string | null } | null = null;
    if (changesEmail) {
      const email = cleanEmail(body.email);
      // Their login is bound to the address that claimed the seat. Changing it
      // underneath them would either lock them out or hand their access to
      // whoever owns the new address, so it isn't allowed.
      if (target.clerkUserId) {
        res.status(400).json({
          error:
            "This person has already signed in, so their email can't be changed. Remove them and add them again with the new address.",
        });
        return;
      }
      if (email) {
        if (await emailTaken(caller.company.id, email, target.id)) {
          res.status(409).json({ error: "That email is already on your team" });
          return;
        }
        const blocked = await findBlockedEmails([email]);
        if (blocked.has(email)) {
          res.status(409).json({
            error:
              "That address already has a login with another company. A login can only belong to one company — ask them for a different email address to use here.",
          });
          return;
        }
        invite = await sendInviteEmail(email);
        updates.clerkInvitationId = invite.invitationId;
        updates.status = "invited";
      } else {
        // Address removed: nothing is outstanding any more.
        updates.clerkInvitationId = null;
        updates.status = "active";
      }
      updates.email = email;
      forgetDeniedCaller();
    }

    if (body.homeAddress !== undefined) {
      const address = cleanText(body.homeAddress);
      // Only pay for a lookup when the address actually changed; re-saving the
      // same card shouldn't cost anything.
      Object.assign(
        updates,
        address === target.homeAddress
          ? { homeAddress: address }
          : await locateHome(address),
      );
    }

    const [updated] = await db
      .update(teamMembersTable)
      .set(updates)
      .where(eq(teamMembersTable.id, target.id))
      .returning();

    res.json(UpdateTeamMemberResponse.parse(serializeMember(updated!)));
  },
);

router.post(
  "/team/import",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (caller.role !== "owner") {
      res.status(403).json({ error: "Only the owner can import team members" });
      return;
    }
    const parsed = ImportTeamMembersBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const companyId = caller.company.id;

    if (parsed.data.members.length > MAX_IMPORT_ROWS) {
      res.status(400).json({
        error: `That file has ${parsed.data.members.length} rows. Import up to ${MAX_IMPORT_ROWS} people at a time.`,
      });
      return;
    }

    const existing = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.companyId, companyId));
    const byEmail = new Map(
      existing.filter((m) => m.email).map((m) => [m.email!.toLowerCase(), m]),
    );
    // Name is only ever a fallback for people with no address, and only when
    // exactly one person answers to it — two Alex Smiths on the crew must not
    // silently overwrite each other.
    const nameCounts = new Map<string, number>();
    for (const m of existing.filter((m) => !m.email)) {
      const key = m.name.trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const byName = new Map(
      existing
        .filter(
          (m) => !m.email && nameCounts.get(m.name.trim().toLowerCase()) === 1,
        )
        .map((m) => [m.name.trim().toLowerCase(), m]),
    );

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    // Which identities this upload has already dealt with, so a file listing
    // the same person twice reports the clash instead of applying whichever
    // row happened to come last.
    const seen = new Set<string>();

    for (const [index, row] of parsed.data.members.entries()) {
      const line = index + 2; // header occupies line 1 of the spreadsheet
      const name = cleanText(row.name);
      if (!name) {
        skipped += 1;
        pushError(errors, `Row ${line}: no name, so there was nothing to add.`);
        continue;
      }
      const email = cleanEmail(row.email);

      const key = email ? `email:${email}` : `name:${name.toLowerCase()}`;
      if (seen.has(key)) {
        skipped += 1;
        pushError(
          errors,
          `Row ${line}: ${email ?? name} appears more than once in this file.`,
        );
        continue;
      }
      seen.add(key);

      // A row that carries an address is matched on that address and nothing
      // else. Falling back to the name would let a new address for "Alex
      // Smith" quietly overwrite a different Alex Smith who never signs in.
      const match = email ? byEmail.get(email) : byName.get(name.toLowerCase());

      try {
        const home = await locateHome(cleanText(row.homeAddress));
        if (match) {
          await db
            .update(teamMembersTable)
            .set({
              name,
              phone: cleanText(row.phone),
              isLead: row.isLead ?? match.isLead,
              active: row.active ?? match.active,
              ...home,
            })
            .where(eq(teamMembersTable.id, match.id));
          updated += 1;
          continue;
        }

        if (email && (await emailTaken(companyId, email))) {
          skipped += 1;
          pushError(errors, `Row ${line}: ${email} is already on your team.`);
          continue;
        }

        // Deliberately no invitation email here. An import can be dozens of
        // rows and a mistaken upload should never blast the owner's whole
        // address book. The seat still works — anyone signing up with the
        // address claims it — and the owner can invite individually.
        const [created] = await db
          .insert(teamMembersTable)
          .values({
            companyId,
            name,
            email,
            phone: cleanText(row.phone),
            role: row.role,
            isLead: row.isLead ?? false,
            active: row.active ?? true,
            status: "active",
            ...home,
          })
          .returning();
        if (email) byEmail.set(email, created!);
        else byName.set(name.toLowerCase(), created!);
        added += 1;
      } catch (err) {
        skipped += 1;
        logger.warn({ err, companyId, line }, "[team] import row failed");
        pushError(errors, `Row ${line}: couldn't be saved.`);
      }
    }

    if (added > 0 || updated > 0) {
      await db.insert(activityTable).values({
        companyId,
        type: "team_invited",
        message: `Staff list imported — ${added} added, ${updated} updated.`,
      });
      forgetDeniedCaller();
    }

    res.json(
      ImportTeamMembersResponse.parse({ added, updated, skipped, errors }),
    );
  },
);

router.delete(
  "/team/:id",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = RemoveTeamMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    if (caller.role !== "owner") {
      res.status(403).json({ error: "Only the owner can remove team members" });
      return;
    }

    const [target] = await db
      .select()
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.id, params.data.id),
          eq(teamMembersTable.companyId, caller.company.id),
        ),
      )
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (target.role === "owner") {
      res.status(400).json({ error: "The owner cannot be removed" });
      return;
    }

    await db.delete(teamMembersTable).where(eq(teamMembersTable.id, target.id));

    // Kill the emailed sign-up link too, so removing someone actually revokes
    // their way in rather than just deleting the row.
    if (target.clerkInvitationId) {
      try {
        await clerkClient.invitations.revokeInvitation(
          target.clerkInvitationId,
        );
      } catch (err) {
        logger.error(
          { err, invitationId: target.clerkInvitationId },
          "[team] failed to revoke Clerk invitation",
        );
      }
    }

    res.sendStatus(204);
  },
);

export default router;
