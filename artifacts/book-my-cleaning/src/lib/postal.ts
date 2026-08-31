/** Normalize only Canadian postal codes for booking autofill. */
export function normalizeCanadianPostalCode(
  value: string | null | undefined,
): string | null {
  const compact = (value ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) return null;
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}
