/**
 * Save-time validation for owner phone number fields
 * (notificationNumber / ringThroughNumber).
 *
 * A typo like "555-12" stored silently only surfaces later, when an outage
 * text can't be delivered — so PATCH /api/company normalizes to E.164 up
 * front and rejects anything undialable with a clear message. Empty string
 * stays allowed: it clears the number.
 */
import { toE164 } from "./quo";

export type PhoneFieldResult =
  { ok: true; value: string | undefined } | { ok: false; error: string };

export function normalizePhoneField(
  raw: string | undefined,
  label: string,
): PhoneFieldResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw.trim() === "") return { ok: true, value: "" };
  const normalized = toE164(raw);
  if (!normalized) {
    return {
      ok: false,
      error: `"${raw}" isn't a ${label} we can text. Enter a full dialable number like 555-123-4567 (or +1 555-123-4567), or leave it blank.`,
    };
  }
  return { ok: true, value: normalized };
}
