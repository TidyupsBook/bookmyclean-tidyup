/**
 * What a staff member's role is called on screen.
 *
 * Three separate facts collapse into one word here:
 *
 *  - `title` — the owner's own wording for the job ("Site Supervisor").
 *    It wins whenever it is set, because he knows what his crew are called
 *    better than we do.
 *  - `isLead` — a label the owner puts on a card, not a permission level. It
 *    lives in its own column precisely so it can never widen anyone's access.
 *  - `role` — the actual permission level, and the fallback wording.
 *
 * This is the one place that turns them back into words, so the staff list,
 * the map and the tracking page can't drift apart on what someone is called.
 * Nothing here may ever be read to decide what a person is ALLOWED to do.
 */
export function roleLabel(member: {
  role: string;
  isLead?: boolean | null;
  title?: string | null;
}): string {
  const custom = (member.title ?? "").trim();
  if (custom) return custom;
  if (member.role === "owner") return "Owner";
  if (member.role === "dispatcher") return "Dispatcher";
  return member.isLead ? "Lead Cleaner" : "Cleaner";
}

/**
 * The longest a job title may be. Long enough for "Assistant Site Supervisor",
 * short enough that a marker label and a roster badge stay readable.
 */
export const MAX_TITLE_LENGTH = 40;
