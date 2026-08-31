/**
 * The count pill on a nav item.
 *
 * Each notification type keeps its own color so a glance says WHAT is
 * waiting, not just that something is:
 *
 *   red    — phone calls (the ring banner is red too; nothing else may be)
 *   pink   — customer texts
 *   purple — team chat
 *   orange — leads waiting for review
 *
 * Keep this the single source of those colors — a new badge elsewhere
 * should pick a tone here, never invent its own red.
 */
// Deeper shades than the brand accents on purpose: the label is 12px white
// text, and the bright brand fills fail WCAG AA contrast at that size.
const TONE_CLASSES = {
  calls: "bg-red-600",
  messages: "bg-pink-600",
  chat: "bg-purple-600",
  leads: "bg-orange-700",
} as const;

export type UnreadTone = keyof typeof TONE_CLASSES;

export function UnreadBadge({
  count,
  tone,
  testId,
}: {
  count: number;
  tone: UnreadTone;
  testId: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-label={`${count} unread`}
      className={`ml-auto min-w-5 h-5 px-1.5 rounded-full ${TONE_CLASSES[tone]} text-white text-xs font-bold flex items-center justify-center`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
