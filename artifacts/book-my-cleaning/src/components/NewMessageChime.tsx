/**
 * Makes a sound when something new arrives, from anywhere in the app.
 *
 * Mounted at the layout level rather than on the Messages or Team Chat page,
 * because the whole point is to be heard by someone who is looking at a
 * different screen. Renders nothing.
 *
 * It listens to exactly the same two queries the sidebar badges read — same
 * query keys, so React Query serves both from one request — which is what
 * keeps the sound and the red number from ever telling different stories.
 */
import { useEffect, useRef } from "react";
import {
  getGetUnreadMessageCountQueryKey,
  getListStaffConversationsQueryKey,
  useGetCurrentUser,
  useGetUnreadMessageCount,
  useListStaffConversations,
} from "@workspace/api-client-react";
import { playChime, unlockChime } from "@/lib/chime";
import { shouldChime, totalStaffUnread } from "@/lib/unread";

const POLL_MS = 15_000;

export function NewMessageChime() {
  const { data: me } = useGetCurrentUser();
  // Cleaners aren't on the customer inbox at all — asking would 403.
  const isCleaner = me?.role === "cleaner";

  const { data: customerUnread } = useGetUnreadMessageCount({
    query: {
      queryKey: getGetUnreadMessageCountQueryKey(),
      enabled: !!me && !isCleaner,
      refetchInterval: POLL_MS,
    },
  });

  // Crew chat is open to every role, cleaners included.
  const { data: conversations } = useListStaffConversations({
    query: {
      queryKey: getListStaffConversationsQueryKey(),
      enabled: !!me,
      refetchInterval: POLL_MS,
    },
  });

  useEffect(() => unlockChime(), []);

  const customerCount = isCleaner ? 0 : (customerUnread?.unread ?? 0);
  const total = customerCount + totalStaffUnread(conversations);

  /**
   * Who this tally belongs to. The query keys are plain endpoint keys with no
   * account in them, so switching person or company can hand this component a
   * completely different backlog — which is a different starting point, not a
   * pile of new messages. Changing identity restarts the baseline.
   */
  const identity = me
    ? `${me.role}:${me.teamMemberId ?? "none"}:${me.companyName}`
    : null;

  /**
   * Null until the first tally lands. Without that distinction, signing in to
   * a backlog of unread messages would play the sound immediately — and a
   * notification that fires when nothing happened is one people learn to
   * ignore.
   */
  const previous = useRef<{ identity: string; total: number } | null>(null);

  useEffect(() => {
    // Nothing has loaded yet; don't let "no data" count as zero and then have
    // the first real number read as an arrival.
    if (!identity) return;
    if (!isCleaner && customerUnread === undefined) return;
    if (conversations === undefined) return;

    const seen = previous.current;
    const samePerson = seen !== null && seen.identity === identity;
    if (shouldChime(samePerson ? seen.total : null, total)) playChime();
    previous.current = { identity, total };
  }, [identity, isCleaner, customerUnread, conversations, total]);

  return null;
}
