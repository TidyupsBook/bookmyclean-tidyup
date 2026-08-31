/**
 * The one address string the booking desk hands to the geocoder.
 *
 * The form keeps the address in four boxes; a lookup wants one line. Two rules
 * matter enough to live here rather than inline:
 *
 * 1. A street line alone is not enough to place. "17115 61 Ave" is a real
 *    address in several provinces, and Google picks one with full confidence
 *    rather than admitting the ambiguity — so the region always goes on the
 *    end even when the dispatcher hasn't typed a city yet.
 * 2. Nothing is looked up until there is a plausible street, because every
 *    distinct string is a paid lookup and a half-typed one is never the
 *    address anyway.
 */

/** Below this a street line is still being typed. */
const MIN_STREET_CHARS = 6;

export type AddressParts = {
  street: string;
  addressLine2?: string;
  city: string;
  /** Province or state — always set on the form, so always appended. */
  province: string;
  postal: string;
};

/**
 * One line for the geocoder, or null when there isn't enough to look up yet.
 */
export function composeBookingAddress(parts: AddressParts): string | null {
  const street = parts.street.trim().replace(/\s+/g, " ");
  const line2 = (parts.addressLine2 ?? "").trim().replace(/\s+/g, " ");
  if (street.length < MIN_STREET_CHARS) return null;
  // A street of digits only ("5810") is the start of an address, not one.
  if (!/[a-z]/i.test(street)) return null;

  const tail = [
    parts.city.trim(),
    [parts.province.trim(), parts.postal.trim().toUpperCase()]
      .filter(Boolean)
      .join(" "),
  ].filter(Boolean);

  return [street, line2, ...tail].filter(Boolean).join(", ");
}
