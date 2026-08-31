import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import {
  db,
  teamMembersTable,
  activityTable,
  companiesTable,
  jobberConnectionsTable,
  type Company,
} from "@workspace/db";
import {
  ListTeamMembersResponse,
  ListJobberTeamMembersResponse,
  LinkJobberUserParams,
  LinkJobberUserBody,
  LinkJobberUserResponse,
  UnlinkJobberUserParams,
  UnlinkJobberUserResponse,
  ImportJobberUserBody,
  ImportJobberUserResponse,
  GetJoinCodeResponse,
  RequestToJoinCompanyBody,
  RequestToJoinCompanyResponse,
  CancelJoinRequestResponse,
  ApproveTeamMemberBody,
  ApproveTeamMemberParams,
  ApproveTeamMemberResponse,
  DeclineTeamMemberParams,
  DeclineTeamMemberResponse,
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
import {
  getValidAccessToken,
  getValidConnectionToken,
  listJobberUsers,
} from "../lib/jobber";
import {
  resolveAssigneesToRoster,
  type LinkedRosterMember,
} from "../services/jobberCalendarSync";
import { requireRole } from "../middlewares/requireRole";
import { forgetDeniedCaller } from "../lib/callerRole";
import { getCaller } from "../middlewares/requireRole";
import { findBlockedEmails } from "../lib/seatAffiliation";
import { roleLabel, MAX_TITLE_LENGTH } from "../lib/roleLabel";
import { geocodeAddress, GeocodeConfigError } from "../services/geocode";
import { queueText } from "../lib/pendingTexts";
import { appUrl, staffPageUrl } from "../lib/ownerNotify";
import { toE164 } from "../lib/quo";
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
    title: m.title,
    // Computed here, not in each client, so the roster, the map and the
    // tracking page can never disagree about what somebody is called.
    roleLabel: roleLabel(m),
    active: m.active,
    // The live-call dispatching grant on this seat. Meaningful only on a
    // dispatcher card — the entitlement check requires role AND flag — but
    // reported as stored so the Staff page shows exactly what is set.
    liveCallDispatching: m.liveCallDispatching,
    color: m.color,
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
    // The Jobber user this seat is linked to, or null. Identity only —
    // it's what assignment sync keys on, nothing else syncs through it.
    jobberUserId: m.jobberUserId,
    jobberConnectionId: m.jobberConnectionId ?? null,
    claimedAt: m.claimedAt ? m.claimedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Empty and whitespace-only both mean "not given", never an empty string. */
function cleanText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A staff colour is a plain `#rrggbb` and nothing else. Anything the picker
 * would never send — a name, a gradient, a stray `javascript:` — becomes null
 * rather than an error, because this value is written straight into inline
 * styles on the schedule and the map.
 */
function cleanColor(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : null;
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

/**
 * Is this the very card the caller's own access rests on?
 *
 * Only true for a seat-based caller. The account that owns the company
 * resolves as owner with no seat at all (`teamMemberId` null), so it never
 * matches — it can edit and remove any card, its own included, without
 * risking its way back in.
 */
function isSelfSeat(
  caller: { teamMemberId: number | null },
  target: { id: number },
): boolean {
  return caller.teamMemberId !== null && caller.teamMemberId === target.id;
}

router.get(
  "/team",
  // A cleaner may see the crew — the same names and numbers team chat and
  // the live map already show them — so their phone can render the roster
  // (and the rename pencil on their own card). What they must NOT see is the
  // applicant queue: who has asked to join is a hiring matter, filtered out
  // below.
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    // A pending applicant also resolves as a company-less "cleaner" — they
    // asked to join, nobody let them in yet, and the roster stays closed to
    // them exactly as before this route opened to actual crew.
    if (caller.role === "cleaner" && !caller.company) {
      res.status(403).json({ error: "You don't have access to do that here" });
      return;
    }
    if (!caller.company) {
      res.json(ListTeamMembersResponse.parse([]));
      return;
    }
    const rows = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.companyId, caller.company.id))
      .orderBy(teamMembersTable.id);
    // A cleaner's roster is names and contact details — where a teammate
    // LIVES is not theirs to browse, so home addresses (and their pins) are
    // stripped before serialization, not merely left unrendered by the app.
    const members =
      caller.role === "cleaner"
        ? rows
            .filter((m) => m.status !== "pending")
            .map((m) => ({
              ...m,
              homeAddress: null,
              homeLat: null,
              homeLng: null,
            }))
        : rows;

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
    const jobberConnectionId = parsed.data.jobberConnectionId ?? null;
    if (jobberConnectionId !== null) {
      const [ownedConn] = await db
        .select({ id: jobberConnectionsTable.id })
        .from(jobberConnectionsTable)
        .where(
          and(
            eq(jobberConnectionsTable.id, jobberConnectionId),
            eq(jobberConnectionsTable.companyId, caller.company.id),
          ),
        )
        .limit(1);
      if (!ownedConn) {
        res.status(400).json({
          error:
            "Unknown Jobber connection — make sure it belongs to your account.",
        });
        return;
      }
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
        color: cleanColor(parsed.data.color),
        companyId: caller.company.id,
        // No address means no invitation is outstanding, so there is nothing
        // to wait for — the seat is simply live.
        status: email ? "invited" : "active",
        clerkInvitationId: invite.invitationId,
        jobberConnectionId,
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

/**
 * The code the crew types when they sign up on their own.
 *
 * Deliberately not a secret: knowing it gets you a request in a queue, nothing
 * more. Ambiguous characters are left out so it survives being read down a
 * phone line.
 */
const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const JOIN_CODE_LENGTH = 6;

function newJoinCode(): string {
  const bytes = randomBytes(JOIN_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * This company's join code, minting one on first use so companies that predate
 * the feature don't need a backfill.
 */
async function ensureJoinCode(company: Company): Promise<string> {
  if (company.joinCode) return company.joinCode;

  // Codes are short, so a collision is unlikely but not impossible; the unique
  // constraint is what actually decides, and a few attempts settle it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = newJoinCode();
    try {
      const [updated] = await db
        .update(companiesTable)
        .set({ joinCode: candidate })
        // Pinning "still empty" means two racing requests hand back the same
        // code rather than one overwriting the other's.
        .where(
          and(
            eq(companiesTable.id, company.id),
            isNull(companiesTable.joinCode),
          ),
        )
        .returning({ joinCode: companiesTable.joinCode });
      if (updated?.joinCode) return updated.joinCode;

      const [current] = await db
        .select({ joinCode: companiesTable.joinCode })
        .from(companiesTable)
        .where(eq(companiesTable.id, company.id));
      if (current?.joinCode) return current.joinCode;
    } catch (err) {
      logger.warn({ err, attempt }, "[team] join code collided; retrying");
    }
  }
  throw new Error("Could not generate a join code");
}

router.get(
  "/team/join-code",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    res.json(
      GetJoinCodeResponse.parse({
        joinCode: await ensureJoinCode(caller.company),
      }),
    );
  },
);

/**
 * Retire the current code and mint a fresh one.
 *
 * The code is not a credential, but it does decide whose Staff page a
 * stranger's request lands on — so once it has been passed beyond the crew,
 * the owner needs a way to make old copies stop working. Nothing else moves:
 * staff, pending requests, and everything already in flight are keyed by
 * company id, never by the code.
 */
router.post(
  "/team/join-code/rotate",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    // A dispatcher can read the code out to a new hire, but retiring it is a
    // policy decision about who may apply — that stays with the owner.
    if (caller.role !== "owner") {
      res.status(403).json({ error: "Only the owner can change the code" });
      return;
    }
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    // Same collision handling as first-time minting: the unique constraint is
    // the arbiter, and a couple of retries settle the rare clash.
    let joinCode: string | null = null;
    for (let attempt = 0; attempt < 5 && !joinCode; attempt++) {
      const candidate = newJoinCode();
      try {
        const [updated] = await db
          .update(companiesTable)
          .set({ joinCode: candidate })
          .where(eq(companiesTable.id, caller.company.id))
          .returning({ joinCode: companiesTable.joinCode });
        joinCode = updated?.joinCode ?? null;
      } catch (err) {
        logger.warn({ err, attempt }, "[team] join code collided; retrying");
      }
    }
    if (!joinCode) {
      res.status(500).json({ error: "Could not generate a new code" });
      return;
    }

    await db.insert(activityTable).values({
      companyId: caller.company.id,
      type: "join_code_changed",
      message: "The staff join code was changed. The old code no longer works.",
    });

    res.json(GetJoinCodeResponse.parse({ joinCode }));
  },
);

/**
 * "I work here, let me in."
 *
 * The mirror image of an invite: instead of the owner adding an address and
 * waiting, the person signs up first and waits to be approved. No role guard,
 * because by definition the caller belongs to nothing yet — the join code is
 * what says which Staff page their request should appear on.
 */
router.post("/team/join-requests", async (req, res): Promise<void> => {
  const caller = await getCaller(req);
  if (caller.company) {
    res.status(409).json({ error: "You already belong to a company" });
    return;
  }
  if (caller.pendingCompanyName) {
    res.status(409).json({
      error: `You've already asked to join ${caller.pendingCompanyName}. They'll let you in from their Staff page.`,
    });
    return;
  }

  const parsed = RequestToJoinCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const name = cleanText(parsed.data.name);
  if (!name) {
    res.status(400).json({ error: "Please give your name" });
    return;
  }

  const code = (parsed.data.joinCode ?? "").trim().toUpperCase();
  const [company] = code
    ? await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.joinCode, code))
        .limit(1)
    : [];
  if (!company) {
    res.status(404).json({
      error:
        "That code doesn't match any company. Check it with whoever runs your office.",
    });
    return;
  }

  // Their verified address, so the Staff page shows the owner who is asking
  // rather than a name anyone could type.
  let email: string | null = null;
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    email =
      user.emailAddresses
        .filter((e) => e.verification?.status === "verified")
        .map((e) => e.emailAddress.trim().toLowerCase())[0] ?? null;
  } catch (err) {
    logger.warn({ err }, "[team] could not read the requester's email");
  }

  if (email && (await emailTaken(company.id, email))) {
    res.status(409).json({
      error:
        "Someone already added that email to this company. Sign out and back in — you should be let straight in.",
    });
    return;
  }

  const [member] = await db
    .insert(teamMembersTable)
    .values({
      companyId: company.id,
      name,
      email,
      phone: cleanText(parsed.data.phone),
      // A hint on the request card, not a decision: the approver picks the
      // role that actually gets granted.
      role: parsed.data.role ?? "cleaner",
      status: "pending",
      // Off the roster until approved, so nobody can be handed work — or
      // counted as crew — while they are still just an applicant.
      active: false,
      clerkUserId: req.userId!,
    })
    .returning();

  await db.insert(activityTable).values({
    companyId: company.id,
    type: "team_invited",
    message: `${name} signed up and is waiting to be approved. Approve them on the Staff page.`,
  });

  logger.info(
    { companyId: company.id, teamMemberId: member!.id },
    "[team] join request created",
  );

  // Nudge the owner the way other owner alerts go out — a dashboard entry
  // alone is exactly the silence this flow is meant to break. Queued first so
  // a send hiccup is retried by the hourly sweep rather than lost.
  await queueText(company, {
    to: null,
    kind: "join_request_owner",
    content:
      `${name} asked to join ${company.name} using your join code. ` +
      `Let them in (or decline) on your Staff page: ${staffPageUrl()}`,
  });

  res.status(201).json(
    RequestToJoinCompanyResponse.parse({
      ok: true,
      companyName: company.name,
    }),
  );
});

/** Changed your mind, or typed the wrong company's code. */
router.delete("/team/join-requests", async (req, res): Promise<void> => {
  const deleted = await db
    .delete(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.clerkUserId, req.userId!),
        eq(teamMembersTable.status, "pending"),
      ),
    )
    .returning({ id: teamMembersTable.id });

  res.json(
    CancelJoinRequestResponse.parse({
      ok: deleted.length > 0,
      companyName: "",
    }),
  );
});

router.post(
  "/team/:id/approve",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = ApproveTeamMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ApproveTeamMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    // A dispatcher can wave a cleaner through — that is the point of having
    // one — but handing out another dispatcher seat is the owner's call.
    if (caller.role !== "owner" && parsed.data.role !== "cleaner") {
      res
        .status(403)
        .json({ error: "Only the owner can approve someone as a dispatcher" });
      return;
    }

    // One conditional update does the whole job: it decides, in the database,
    // whether this request was still waiting. Reading first and updating after
    // would let two managers both approve — with different roles — or let an
    // approval land on a row a colleague declined a moment earlier.
    const [approved] = await db
      .update(teamMembersTable)
      .set({
        role: parsed.data.role,
        isLead: parsed.data.isLead ?? false,
        status: "active",
        active: true,
        claimedAt: new Date(),
      })
      .where(
        and(
          eq(teamMembersTable.id, params.data.id),
          // Company pinned so a stale id from another tab can't reach across
          // companies.
          eq(teamMembersTable.companyId, caller.company.id),
          eq(teamMembersTable.status, "pending"),
        ),
      )
      .returning();
    if (!approved) {
      res.status(404).json({ error: "That request is no longer waiting" });
      return;
    }

    // They may have been refused seconds ago; let them in on the next request
    // rather than at the end of the negative-cache window.
    forgetDeniedCaller();

    await db.insert(activityTable).values({
      companyId: caller.company.id,
      type: "team_invited",
      message: `${approved.name} was approved and can now sign in as a ${roleLabel(
        { role: parsed.data.role, isLead: parsed.data.isLead ?? false },
      ).toLowerCase()}.`,
    });

    // Tell them they're in, so they stop refreshing the waiting screen. Only
    // possible when they left a phone number; the waiting screen also polls,
    // so a member without one still gets moved along on their next visit.
    const to = approved.phone ? toE164(approved.phone) : null;
    if (to) {
      await queueText(caller.company, {
        to,
        kind: "join_request_approved",
        content:
          `Good news — ${caller.company.name} approved your request on Book My Cleaning. ` +
          `You're on the team: sign in at ${appUrl()}`,
      });
    }

    res.json(ApproveTeamMemberResponse.parse(serializeMember(approved!)));
  },
);

router.post(
  "/team/:id/decline",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = DeclineTeamMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    // Only ever a pending request: this must not become a second, unguarded
    // way to delete a working seat.
    const [removed] = await db
      .delete(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.id, params.data.id),
          eq(teamMembersTable.companyId, caller.company.id),
          eq(teamMembersTable.status, "pending"),
        ),
      )
      .returning({
        name: teamMembersTable.name,
        phone: teamMembersTable.phone,
      });

    if (removed) {
      await db.insert(activityTable).values({
        companyId: caller.company.id,
        type: "team_invited",
        message: `${removed.name}'s request to join was declined.`,
      });

      // No ghosting: say so plainly. Queued from the deleted row's own
      // details, so the retry needs nothing from a seat that no longer
      // exists. Without a phone there is nothing to send — their waiting
      // screen clears on its next poll.
      const to = removed.phone ? toE164(removed.phone) : null;
      if (to) {
        await queueText(caller.company, {
          to,
          kind: "join_request_declined",
          content:
            `${caller.company.name} looked at your request to join on Book My Cleaning ` +
            `and didn't approve it this time. If that seems wrong, check with whoever runs the office.`,
        });
      }
    }

    res.json(
      DeclineTeamMemberResponse.parse({
        ok: Boolean(removed),
        companyName: "",
      }),
    );
  },
);

router.patch(
  "/team/:id",
  // Cleaners are let past the guard for exactly one thing: fixing the name
  // on their own card. Everything else on this route stays owner/dispatcher;
  // the self-only, name-only narrowing is enforced right below.
  requireRole("owner", "dispatcher", "cleaner"),
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

    if (caller.role === "cleaner") {
      // Their card is theirs to label — nothing more. Any other card is 403
      // (not 404: the roster is visible to them, so there is nothing to hide),
      // and any field beyond the name — phone, role, active, colour — is
      // refused outright rather than silently dropped.
      if (params.data.id !== caller.teamMemberId) {
        res.status(403).json({ error: "You can only edit your own card" });
        return;
      }
      const extraFields = Object.entries(parsed.data).filter(
        ([key, value]) => key !== "name" && value !== undefined,
      );
      if (extraFields.length > 0 || parsed.data.name === undefined) {
        res.status(403).json({ error: "You can only change your own name" });
        return;
      }
    }

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

    const changesLiveCall =
      body.liveCallDispatching !== undefined &&
      body.liveCallDispatching !== target.liveCallDispatching;

    // A dispatcher can keep the roster tidy — phone numbers, addresses, who is
    // on this week. What they cannot do is change who can sign in or what
    // anyone is allowed to see; that is the owner's alone. Live-call
    // dispatching is in the same bucket: it widens what a seat may do, so a
    // dispatcher cannot hand it out — least of all to themselves.
    if (
      (changesRole || changesEmail || changesLiveCall) &&
      caller.role !== "owner"
    ) {
      res.status(403).json({
        error: "Only the owner can change someone's role or email address",
      });
      return;
    }

    // The switch only exists on dispatcher cards. Granting it to a cleaner
    // would do nothing (the entitlement check requires the role too), and a
    // silent no-op reads as "it worked" — refuse instead. Owners never need
    // it. Judged against the role the card will have AFTER this save, so
    // promoting to dispatcher and granting in one save works.
    if (changesLiveCall && body.liveCallDispatching === true) {
      const roleAfter = body.role ?? target.role;
      if (roleAfter !== "dispatcher") {
        res.status(400).json({
          error: "Live-call dispatching can only be given to a dispatcher",
        });
        return;
      }
    }
    // A company can have more than one owner: the boss signs in from a phone,
    // a tablet and a desk PC, and each of those accounts is him.
    //
    // The one move that can't be undone from inside the app is signing away
    // your own owner access, so it is refused. Only a caller whose access
    // comes FROM this seat is at risk — the account that owns the company
    // resolves as owner without a seat at all (`teamMemberId` null), and may
    // demote any card including its own.
    if (changesRole && target.role === "owner" && isSelfSeat(caller, target)) {
      res.status(400).json({
        error:
          "You can't take away your own owner access. Sign in as the account that owns the company to change this card.",
      });
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
    // A job title is wording, not authority: the owner can call a seat
    // "Site Supervisor" without that seat gaining anything, and null puts the
    // standard wording back. Trimmed to a length a badge can actually show.
    if (body.title !== undefined) {
      const title = cleanText(body.title);
      updates.title = title ? title.slice(0, MAX_TITLE_LENGTH) : null;
    }
    if (body.active !== undefined) updates.active = body.active;
    // Null clears a deliberate choice and hands the card back to the
    // automatic hue, so "no colour" is a real value here rather than a skip.
    if (body.color !== undefined) updates.color = cleanColor(body.color);
    if (changesLiveCall) {
      updates.liveCallDispatching = body.liveCallDispatching;
    }
    if (changesRole) {
      updates.role = body.role;
      // "Lead" is cleaner wording. Carrying it onto an owner would leave the
      // card reading "Lead Cleaner" for somebody who runs the company.
      if (body.role === "owner") updates.isLead = false;
      // The grant rides on the dispatcher role; a card moving off it loses
      // the switch too, so a later promotion starts from "off" rather than
      // silently resurrecting an old grant.
      if (body.role !== "dispatcher" && target.liveCallDispatching) {
        updates.liveCallDispatching = false;
      }
    }

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
        // The owner already has a login of their own, so the address on their
        // card is a contact detail, not an invitation waiting to be accepted.
        // Mailing them a sign-up link and parking their own card on "invited"
        // would read as though they had lost their access.
        if (target.role !== "owner") {
          invite = await sendInviteEmail(email);
          updates.clerkInvitationId = invite.invitationId;
          updates.status = "invited";
        }
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

    // Assign (or clear) which Jobber connection this staff member routes through.
    // Null means "use the primary / only connection" — backward compatible.
    if (body.jobberConnectionId !== undefined) {
      if (caller.role !== "owner") {
        res.status(403).json({
          error: "Only the owner can assign a Jobber connection",
        });
        return;
      }
      // Non-null ids must belong to the caller's own company — reject a
      // cross-tenant connection id that would let one owner route another
      // company's staff through a connection they don't control.
      if (body.jobberConnectionId !== null) {
        const [ownedConn] = await db
          .select({ id: jobberConnectionsTable.id })
          .from(jobberConnectionsTable)
          .where(
            and(
              eq(jobberConnectionsTable.id, body.jobberConnectionId),
              eq(jobberConnectionsTable.companyId, caller.company.id),
            ),
          )
          .limit(1);
        if (!ownedConn) {
          res.status(400).json({
            error:
              "Unknown Jobber connection — make sure it belongs to your account.",
          });
          return;
        }
      }
      updates.jobberConnectionId = body.jobberConnectionId ?? null;
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

/**
 * Revoke a staff member's Clerk credentials without removing the seat.
 *
 * The roster card stays — name, phone, Jobber link, and all booking history
 * are preserved — so the owner can invite someone new to the same slot.
 * Use DELETE /team/:id to remove the row entirely.
 */
router.delete(
  "/team/:id/account",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid team member id" });
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
          eq(teamMembersTable.id, id),
          eq(teamMembersTable.companyId, caller.company.id),
        ),
      )
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    // Prevent the caller from revoking their own login — they would be locked
    // out the moment the response is sent.
    if (isSelfSeat(caller, target)) {
      res.status(400).json({
        error: "You can't revoke your own login from here.",
      });
      return;
    }

    // Best-effort: revoke the outstanding Clerk invitation (makes the emailed
    // sign-up link stop working). If it's already accepted or already gone,
    // the error is irrelevant — we're clearing it either way.
    if (target.clerkInvitationId) {
      try {
        await clerkClient.invitations.revokeInvitation(
          target.clerkInvitationId,
        );
      } catch (err) {
        logger.warn(
          { err, invitationId: target.clerkInvitationId, teamMemberId: id },
          "[team] revoke invitation best-effort failed",
        );
      }
    }

    // If the person has actually signed up, remove their Clerk user entirely
    // so they cannot sign back in. Fail-closed: a non-404 error means Clerk
    // still has the account active, so we must NOT clear our reference (the
    // owner would think the login was removed, but the person can still sign
    // in). A 404 means the user is already gone — safe to clear.
    if (target.clerkUserId) {
      try {
        await clerkClient.users.deleteUser(target.clerkUserId);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status !== 404) {
          logger.error(
            { err, clerkUserId: target.clerkUserId, teamMemberId: id },
            "[team] Clerk user deletion failed — login NOT removed",
          );
          res.status(502).json({
            error:
              "Couldn't remove this person's login. Their access may still be active — please try again.",
          });
          return;
        }
        // 404 = already gone from Clerk (deleted from dashboard, etc.) — safe.
        logger.warn(
          { clerkUserId: target.clerkUserId, teamMemberId: id },
          "[team] Clerk user already gone; clearing reference",
        );
      }
    }

    const [updated] = await db
      .update(teamMembersTable)
      .set({
        clerkUserId: null,
        clerkInvitationId: null,
        // Back to "active" (seat exists, no login). The owner can re-invite by
        // editing the email on this card — the PATCH handler treats a newly
        // added email as an invitation trigger.
        status: "active",
      })
      .where(eq(teamMembersTable.id, target.id))
      .returning();

    logger.info(
      { companyId: caller.company.id, teamMemberId: id },
      "[team] account revoked; seat preserved",
    );

    res.json(serializeMember(updated!));
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
    // Same rule as demoting: an owner card can be removed — the boss retires
    // an old tablet — but never the one the remover's own access rests on.
    if (target.role === "owner" && isSelfSeat(caller, target)) {
      res.status(400).json({
        error:
          "You can't remove your own owner card. Sign in as the account that owns the company to remove it.",
      });
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

/* ─────────────── linking the roster to Jobber's team ─────────────── */

/** Postgres unique_violation — someone else claimed that Jobber user. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

type JobberUser = { id: string; name: string };
type FailedJobberConnection = { id: number; name: string };

function jobberConnectionName(connection: {
  id: number;
  displayName: string | null;
  accountName: string | null;
}): string {
  return (
    connection.displayName?.trim() ||
    connection.accountName?.trim() ||
    `Connection ${connection.id}`
  );
}

/**
 * Load every connected Jobber workspace.
 *
 * A partial user list is not safe to interpret: callers use absence to decide
 * whether a stored link is gone. Keep the successful users for a useful
 * preview, but return every connection that could not be loaded so reads can
 * warn and writes can refuse to guess.
 */
async function listJobberUsersAcrossConnections(
  company: Company,
  connections: (typeof jobberConnectionsTable.$inferSelect)[],
): Promise<{
  users: JobberUser[];
  failedConnections: FailedJobberConnection[];
  connectionIdByUserId: Map<string, number>;
}> {
  if (connections.length === 0) {
    const accessToken = await getValidAccessToken(company);
    return {
      users: await listJobberUsers(accessToken),
      failedConnections: [],
      connectionIdByUserId: new Map(),
    };
  }

  const seen = new Set<string>();
  const users: JobberUser[] = [];
  const failedConnections: FailedJobberConnection[] = [];
  const connectionIdByUserId = new Map<string, number>();

  for (const connection of connections) {
    try {
      const accessToken = await getValidConnectionToken(connection);
      for (const user of await listJobberUsers(accessToken)) {
        connectionIdByUserId.set(user.id, connection.id);
        if (!seen.has(user.id)) {
          seen.add(user.id);
          users.push(user);
        }
      }
    } catch (err) {
      failedConnections.push({
        id: connection.id,
        name: jobberConnectionName(connection),
      });
      logger.warn(
        { err, connId: connection.id, companyId: company.id },
        "[team] could not list Jobber members for one connection",
      );
    }
  }

  return { users, failedConnections, connectionIdByUserId };
}

function incompleteJobberRosterError(
  failedConnections: FailedJobberConnection[],
): string {
  const names = failedConnections
    .map((connection) => connection.name)
    .join(", ");
  return `Couldn't load all connected Jobber accounts (${names}). Refresh after they are available before changing staff links.`;
}

/**
 * Jobber's active team members, each with their link status here.
 *
 * The suggestion for an unlinked Jobber user is computed by the calendar
 * sync's own resolver against the same active-only roster the sync loads, so
 * what this preview shows is exactly what the next sync would do — never a
 * second opinion.
 */
router.get(
  "/team/jobber-members",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    if (!caller.company.jobberConnected) {
      res.status(400).json({ error: "Jobber isn't connected yet." });
      return;
    }
    if (caller.company.jobberNeedsReauth) {
      res.status(409).json({
        error:
          "Jobber authorization has expired — reconnect Jobber to keep syncing.",
      });
      return;
    }

    // Aggregate users from every Jobber account so the owner can link and
    // import staff across all connected workspaces.  For companies with a
    // single account the list is identical to the previous behaviour.
    const connections = await db
      .select()
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, caller.company.id));

    let users: JobberUser[];
    let failedConnections: FailedJobberConnection[];
    try {
      ({ users, failedConnections } = await listJobberUsersAcrossConnections(
        caller.company,
        connections,
      ));
    } catch (err) {
      logger.warn(
        { err, companyId: caller.company.id },
        "[team] could not list Jobber team members",
      );
      res.status(502).json({
        error: "Couldn't reach Jobber. Try again in a moment.",
      });
      return;
    }

    const roster = await db
      .select({
        id: teamMembersTable.id,
        name: teamMembersTable.name,
        jobberUserId: teamMembersTable.jobberUserId,
        active: teamMembersTable.active,
      })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.companyId, caller.company.id));

    // A link is a link even when the seat is inactive — it still owns that
    // Jobber identity. Suggestions, though, come only from the active roster,
    // because that is the only roster the sync ever matches against.
    const linkedByJobberId = new Map<string, number>();
    for (const m of roster) {
      if (m.jobberUserId) linkedByJobberId.set(m.jobberUserId, m.id);
    }
    const activeRoster: LinkedRosterMember[] = roster
      .filter((m) => m.active)
      .map((m) => ({ id: m.id, name: m.name, jobberUserId: m.jobberUserId }));
    const resolutions = resolveAssigneesToRoster(
      users.map((u) => ({ id: u.id, name: u.name })),
      activeRoster,
    );

    const items = users
      .map((u, index) => {
        const linked = linkedByJobberId.get(u.id) ?? null;
        const resolution = resolutions[index]!;
        return {
          jobberUserId: u.id,
          name: u.name,
          linkedTeamMemberId: linked,
          suggestedTeamMemberId:
            linked === null && resolution.via === "name"
              ? resolution.teamMemberId
              : null,
          gone: false,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    // A stored link whose Jobber user is missing from the active list means
    // the account was deactivated (or deleted) in Jobber. The sync rightly
    // refuses to re-guess by name, so without these rows the stale link would
    // be invisible — the owner would just see that seat's assignments stop
    // syncing. Named for the roster member, since Jobber no longer says who
    // the user was.
    const activeJobberIds = new Set(users.map((u) => u.id));
    const goneLinks =
      failedConnections.length > 0
        ? []
        : roster
            .filter(
              (m) => m.jobberUserId && !activeJobberIds.has(m.jobberUserId),
            )
            .map((m) => ({
              jobberUserId: m.jobberUserId!,
              name: m.name,
              linkedTeamMemberId: m.id,
              suggestedTeamMemberId: null,
              gone: true,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

    res.json(
      ListJobberTeamMembersResponse.parse({
        members: [...items, ...goneLinks],
        failedConnections,
      }),
    );
  },
);

/**
 * Say who a staff member IS in Jobber. From then on assignment sync in both
 * directions keys on this, and renaming the person on either side changes
 * nothing. Relinking replaces the old link — the unique index guarantees a
 * Jobber user never ends up on two seats.
 *
 * The id is verified against Jobber's active team members before anything is
 * stored: a typo'd, fabricated, or deactivated id would otherwise sit there
 * as a durable link that blocks name fallback and quietly breaks assignment
 * sync for that seat.
 */
router.post(
  "/team/:id/jobber-link",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    // Who somebody is in Jobber decides whose calendar their work lands on —
    // that identity call stays with the owner.
    if (caller.role !== "owner") {
      res.status(403).json({ error: "Only the owner can link Jobber staff" });
      return;
    }
    const params = LinkJobberUserParams.safeParse(req.params);
    const body = LinkJobberUserBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "That link request wasn't understood" });
      return;
    }
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    if (!caller.company.jobberConnected) {
      res.status(400).json({ error: "Jobber isn't connected yet." });
      return;
    }
    if (caller.company.jobberNeedsReauth) {
      res.status(409).json({
        error:
          "Jobber authorization has expired — reconnect Jobber to keep syncing.",
      });
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
      );
    if (!target) {
      res.status(404).json({ error: "Staff member not found" });
      return;
    }

    // Only an id Jobber itself vouches for right now may be stored.
    // Check all connections so the owner can link staff from any account.
    const jobberUserId = body.data.jobberUserId;
    const linkConnections = await db
      .select()
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, caller.company.id));
    let jobberUsers: JobberUser[];
    let failedConnections: FailedJobberConnection[];
    try {
      ({ users: jobberUsers, failedConnections } =
        await listJobberUsersAcrossConnections(
          caller.company,
          linkConnections,
        ));
    } catch (err) {
      logger.warn(
        { err, companyId: caller.company.id },
        "[team] could not verify a Jobber user before linking",
      );
      res.status(502).json({
        error: "Couldn't reach Jobber. Try again in a moment.",
      });
      return;
    }
    if (failedConnections.length > 0) {
      res.status(409).json({
        error: incompleteJobberRosterError(failedConnections),
      });
      return;
    }
    if (!jobberUsers.some((u) => u.id === jobberUserId)) {
      res.status(404).json({
        error: "That Jobber team member doesn't exist (or is deactivated).",
      });
      return;
    }

    const [holder] = await db
      .select({ id: teamMembersTable.id, name: teamMembersTable.name })
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.companyId, caller.company.id),
          eq(teamMembersTable.jobberUserId, jobberUserId),
        ),
      );
    if (holder && holder.id !== target.id) {
      res.status(409).json({
        error: `That Jobber user is already linked to ${holder.name}. Unlink them first.`,
      });
      return;
    }

    try {
      const [updated] = await db
        .update(teamMembersTable)
        .set({ jobberUserId })
        .where(eq(teamMembersTable.id, target.id))
        .returning();
      res.json(LinkJobberUserResponse.parse(serializeMember(updated!)));
    } catch (err) {
      // The pre-check raced another link of the same Jobber user.
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "That Jobber user was just linked to someone else.",
        });
        return;
      }
      throw err;
    }
  },
);

/**
 * Forget who a staff member is in Jobber. The seat stays; the sync simply
 * goes back to name matching for them (and may re-adopt a link later if
 * their name matches unambiguously). Works even after Jobber is
 * disconnected, so a wrong link is never stuck behind a dead connection.
 */
router.delete(
  "/team/:id/jobber-link",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (caller.role !== "owner") {
      res.status(403).json({ error: "Only the owner can unlink Jobber staff" });
      return;
    }
    const params = UnlinkJobberUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "That unlink request wasn't understood" });
      return;
    }
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    const [updated] = await db
      .update(teamMembersTable)
      .set({ jobberUserId: null })
      .where(
        and(
          eq(teamMembersTable.id, params.data.id),
          eq(teamMembersTable.companyId, caller.company.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Staff member not found" });
      return;
    }
    res.json(UnlinkJobberUserResponse.parse(serializeMember(updated)));
  },
);

/**
 * Take a Jobber team member the roster doesn't have and give them a seat.
 *
 * Roster-only on purpose: no email, no invitation, no login — exactly like a
 * hand-added cleaner — just already linked, so their visits colour correctly
 * from the next sync on. Nothing is ever created without this explicit call.
 */
router.post(
  "/team/jobber-members/import",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (caller.role !== "owner") {
      res.status(403).json({ error: "Only the owner can add team members" });
      return;
    }
    const body = ImportJobberUserBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "That import request wasn't understood" });
      return;
    }
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    if (!caller.company.jobberConnected) {
      res.status(400).json({ error: "Jobber isn't connected yet." });
      return;
    }
    const companyId = caller.company.id;

    // The name comes from Jobber itself, never from the request — the id is
    // only trusted to the extent Jobber confirms it names an active user.
    // Search all connections and remember which one this Jobber user belongs
    // to so jobberConnectionId can be set on the imported roster member.
    const importConnections = await db
      .select()
      .from(jobberConnectionsTable)
      .where(eq(jobberConnectionsTable.companyId, companyId));
    let users: JobberUser[];
    let failedConnections: FailedJobberConnection[];
    let connectionIdByUserId: Map<string, number>;
    try {
      ({ users, failedConnections, connectionIdByUserId } =
        await listJobberUsersAcrossConnections(
          caller.company,
          importConnections,
        ));
    } catch (err) {
      logger.warn(
        { err, companyId },
        "[team] could not list Jobber team members for import",
      );
      res.status(502).json({
        error: "Couldn't reach Jobber. Try again in a moment.",
      });
      return;
    }
    if (failedConnections.length > 0) {
      res.status(409).json({
        error: incompleteJobberRosterError(failedConnections),
      });
      return;
    }
    const user = users.find((u) => u.id === body.data.jobberUserId);
    if (!user) {
      res.status(404).json({ error: "No active Jobber user with that id" });
      return;
    }
    const importedConnectionId =
      connectionIdByUserId.get(body.data.jobberUserId) ?? null;
    const name = user.name.trim();
    if (!name) {
      res.status(400).json({
        error: "That Jobber user has no name to put on the roster.",
      });
      return;
    }

    const [holder] = await db
      .select({ name: teamMembersTable.name })
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.companyId, companyId),
          eq(teamMembersTable.jobberUserId, user.id),
        ),
      );
    if (holder) {
      res.status(409).json({
        error: `That Jobber user is already linked to ${holder.name}.`,
      });
      return;
    }

    try {
      const [created] = await db
        .insert(teamMembersTable)
        .values({
          companyId,
          name,
          role: "cleaner",
          active: true,
          status: "active",
          jobberUserId: user.id,
          // Pin the roster member to whichever Jobber account supplied this
          // user so their push/pull operations use the right workspace.
          jobberConnectionId: importedConnectionId,
        })
        .returning();

      await db.insert(activityTable).values({
        companyId,
        type: "team_invited",
        message: `${name} was added to the team from Jobber.`,
      });

      res
        .status(201)
        .json(ImportJobberUserResponse.parse(serializeMember(created!)));
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "That Jobber user was just linked to someone else.",
        });
        return;
      }
      throw err;
    }
  },
);

export default router;
