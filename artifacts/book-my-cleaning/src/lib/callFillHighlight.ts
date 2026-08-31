/**
 * How a box on the booking form looks once a live call has filled it in.
 *
 * Two states, deliberately: everything the call captured stays lit green for
 * the rest of the form's life — that is the owner's running answer to "did it
 * get all of it?" — while the box that just landed also pulses for a few
 * seconds, because mid-call it is the movement that catches the eye.
 *
 * Kept out of the page so the rule can be pinned by tests: a filled box that
 * silently stopped lighting up would be invisible in a screenshot review.
 */
export function fieldHighlightClass(
  filled: ReadonlySet<string>,
  justFilled: ReadonlySet<string>,
  key: string,
): string | undefined {
  if (!filled.has(key)) return undefined;
  // Keep the input's own background intact so the caller's letters and numbers
  // stay easy to read. The brighter border/ring is enough to show what the
  // call filled without painting over the value.
  const lit =
    "border-emerald-400 ring-2 ring-emerald-400/70 text-foreground transition-colors";
  return justFilled.has(key) ? `${lit} animate-pulse` : lit;
}
