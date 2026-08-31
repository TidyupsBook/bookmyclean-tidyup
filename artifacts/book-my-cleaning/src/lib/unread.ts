/**
 * Unread arithmetic, kept in one place.
 *
 * The nav badge and the chime must never disagree about how many messages are
 * waiting — two separate tallies drift the moment one of them forgets a rule —
 * so both read the same conversation list through this function.
 */

/** Total unread across every staff-chat conversation this person is in. */
export function totalStaffUnread(
  conversations: ReadonlyArray<{ unreadCount: number }> | undefined,
): number {
  if (!conversations) return 0;
  return conversations.reduce(
    (sum, conversation) => sum + Math.max(0, conversation.unreadCount),
    0,
  );
}

/**
 * Whether the arrival of `next` should make a sound.
 *
 * The first tally is a baseline, never a chime: someone opening the dashboard
 * to eleven waiting messages is not eleven new events, and dinging on page
 * load would train them to ignore the sound. Only a rise counts — reading
 * messages lowers the number, and a re-render at the same number is nothing.
 */
export function shouldChime(previous: number | null, next: number): boolean {
  if (previous === null) return false;
  return next > previous;
}
