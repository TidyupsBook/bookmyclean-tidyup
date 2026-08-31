/**
 * Stable visual identities for user-added map pins.
 *
 * Saved pins are numbered by id order, so hiding one or receiving the same
 * rows in a different API order never changes the labels on the remaining
 * pins. Colours cycle only after the deliberately broad palette is exhausted.
 */
export const DROPPED_PIN_COLORS = [
  "hsl(276,72%,52%)",
  "hsl(24,90%,50%)",
  "hsl(199,89%,44%)",
  "hsl(145,64%,38%)",
  "hsl(48,92%,43%)",
  "hsl(258,72%,60%)",
  "hsl(0,72%,51%)",
  "hsl(186,75%,36%)",
] as const;

export function droppedPinOrdinal(
  pins: ReadonlyArray<{ id: number }>,
  pinId: number,
): number {
  const ids = [...new Set(pins.map((pin) => pin.id))].sort((a, b) => a - b);
  const index = ids.indexOf(pinId);
  return index < 0 ? 1 : index + 1;
}

export function droppedPinColor(ordinal: number): string {
  const safeOrdinal = Number.isInteger(ordinal) && ordinal > 0 ? ordinal : 1;
  return DROPPED_PIN_COLORS[(safeOrdinal - 1) % DROPPED_PIN_COLORS.length]!;
}
