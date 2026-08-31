/**
 * Phone numbers as a person reads them, and as a device dials them.
 *
 * Two different jobs, deliberately separated: what shows on screen has to be
 * readable at a glance from a van, while the link behind it has to be stripped
 * to digits or the phone app opens on nothing. Anything that isn't dialable
 * returns null so callers show plain text instead of a dead link.
 */

/** North-American style when it fits, otherwise the number as given. */
export function formatPhone(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";

  const digits = trimmed.replace(/\D/g, "");
  const local =
    digits.length === 10
      ? digits
      : digits.length === 11 && digits.startsWith("1")
        ? digits.slice(1)
        : null;
  if (local === null) return trimmed;

  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

/** Digits only, keeping a leading + so international numbers still dial. */
function dialable(raw?: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/(?!^\+)[^\d]/g, "");
  const digits = stripped.replace(/\D/g, "");
  return digits.length >= 7 ? stripped : null;
}

export function telHref(phone?: string | null): string | null {
  const number = dialable(phone);
  return number === null ? null : `tel:${number}`;
}

/**
 * A text to this number from whatever the device uses for SMS. This is the
 * phone's own messaging app — separate from the app's Messages page, which
 * texts from the company's business line.
 */
export function smsHref(phone?: string | null): string | null {
  const number = dialable(phone);
  return number === null ? null : `sms:${number}`;
}
