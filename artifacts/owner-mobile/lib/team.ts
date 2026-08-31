/**
 * Role-choice mapping for approving a pending join request, mirrored from the
 * web Staff page. The picker flattens two facts (`role`, `isLead`) into the
 * three words an owner actually uses; "lead cleaner" is a label, never a role.
 */

export type RoleChoice = "dispatcher" | "lead" | "cleaner";

export function roleFields(choice: RoleChoice): {
  role: "dispatcher" | "cleaner";
  isLead: boolean;
} {
  if (choice === "dispatcher") return { role: "dispatcher", isLead: false };
  return { role: "cleaner", isLead: choice === "lead" };
}

export function roleChoiceOf(member: {
  role: string;
  isLead: boolean;
}): RoleChoice {
  if (member.role === "dispatcher") return "dispatcher";
  return member.isLead ? "lead" : "cleaner";
}

/**
 * What to call somebody on screen.
 *
 * A saved roster card already carries `roleLabel` worked out by the server
 * (the owner's own job title first, then the standard wording) — use that
 * where it exists. This is for describing a role that isn't saved yet, such
 * as the seat a join request is about to be approved into, and as the answer
 * for an older payload that predates the field.
 */
export function roleLabel(member: {
  role: string;
  isLead: boolean;
  title?: string | null;
  roleLabel?: string | null;
}): string {
  const given = (member.roleLabel ?? member.title ?? "").trim();
  if (given) return given;
  if (member.role === "owner") return "Owner";
  if (member.role === "dispatcher") return "Dispatcher";
  return member.isLead ? "Lead Cleaner" : "Cleaner";
}

/**
 * Which roster card belongs to the caller — the one that gets the rename
 * pencil. Everyone may fix their own name (the server narrows a cleaner's
 * PATCH to self-only, name-only). The server reports `teamMemberId: null`
 * for the company owner — their seat is implicit — so the owner's card is
 * found by role instead: every company has exactly one owner card, and it's
 * the caller's when they're the owner.
 */
export function selfRosterMemberId(
  me: { role?: string; teamMemberId?: number | null } | undefined,
  roster: { id: number; role: string }[],
): number | null {
  if (me?.role === "owner") {
    return roster.find((m) => m.role === "owner")?.id ?? null;
  }
  return me?.teamMemberId ?? null;
}

/**
 * The choices a given approver may hand out. Granting a dispatcher seat is
 * the owner's call — a dispatcher approving someone is never offered it.
 */
export function roleChoicesFor(approverRole: string | undefined): RoleChoice[] {
  const base: RoleChoice[] = ["cleaner", "lead"];
  return approverRole === "owner" ? [...base, "dispatcher"] : base;
}

/**
 * What a request starts out selected as: whatever the applicant asked for,
 * clamped to what the approver may grant.
 */
export function defaultChoiceFor(
  member: { role: string; isLead: boolean },
  approverRole: string | undefined,
): RoleChoice {
  const asked = roleChoiceOf(member);
  return roleChoicesFor(approverRole).includes(asked) ? asked : "cleaner";
}

export const choiceLabels: Record<RoleChoice, string> = {
  cleaner: "Cleaner",
  lead: "Lead Cleaner",
  dispatcher: "Dispatcher",
};
