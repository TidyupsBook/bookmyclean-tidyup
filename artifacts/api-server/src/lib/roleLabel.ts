/**
 * What a staff member's role is called on screen.
 *
 * "Lead cleaner" is a label the owner puts on a card, not a permission level —
 * it lives in its own column precisely so it can never widen anyone's access.
 * This is the one place that turns the pair back into words, so the staff list
 * and the map can't drift apart on what someone is called.
 */
export function roleLabel(member: {
  role: string;
  isLead?: boolean | null;
}): string {
  if (member.role === "owner") return "Owner";
  if (member.role === "dispatcher") return "Dispatcher";
  return member.isLead ? "Lead Cleaner" : "Cleaner";
}
