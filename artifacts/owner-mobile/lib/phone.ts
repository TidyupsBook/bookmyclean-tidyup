/**
 * Phone numbers as people read them out loud.
 *
 * Stored numbers are E.164 so Quo can dial them; nobody wants to read
 * "+17805550188" off a screen at 7am, so display is formatted and anything
 * unfamiliar (short codes, other countries) is shown untouched rather than
 * mangled into a shape it isn't.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

/** A `tel:` target, or null when there is nothing dialable. */
export function telHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  return cleaned.replace(/\D/g, "").length >= 7 ? `tel:${cleaned}` : null;
}
