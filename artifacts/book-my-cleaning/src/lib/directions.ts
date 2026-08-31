/**
 * Turning a booking into "how do I drive there".
 *
 * Kept away from the components because getting a cleaner to the wrong house
 * is the most expensive mistake this app can make: the exact coordinates win
 * whenever we have them, and a half-typed address never becomes a link that
 * silently sends the van to another city.
 */

type Addressable = {
  customerAddress?: string | null;
  addressLine2?: string | null;
  addressCity?: string | null;
  addressProvince?: string | null;
  addressPostal?: string | null;
  lat?: number | null;
  lng?: number | null;
};

/**
 * The address as a person would read it out: street, city, province, postal
 * code, skipping whatever we never collected. Empty when there's nothing but
 * blanks — callers show "no address" rather than an empty line.
 */
export function fullAddress(booking: Addressable): string {
  return [
    booking.customerAddress,
    booking.addressLine2,
    booking.addressCity,
    booking.addressProvince,
    booking.addressPostal,
  ]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(", ");
}

/**
 * A Google Maps directions link, or null when we have nothing safe to point at.
 *
 * Coordinates are preferred over text: a pin that was geocoded once already is
 * exactly the house, while a street line like "660 Cedar Court" with no city
 * matches dozens of them. Text is only used when there is no pin, and only
 * when it carries more than a street number.
 */
export function directionsUrl(booking: Addressable): string | null {
  const { lat, lng } = booking;
  if (typeof lat === "number" && typeof lng === "number") {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }

  const address = fullAddress(booking);
  // A bare street with no city is ambiguous enough to send someone an hour the
  // wrong way, and Google will happily guess. Better to offer no link.
  if (!address.includes(",")) return null;

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    address,
  )}`;
}

/** Dial from a laptop or a phone; null when we never took a number. */
export function telHref(phone?: string | null): string | null {
  const trimmed = (phone ?? "").trim();
  if (!trimmed) return null;
  // Keep the leading + for international numbers, drop the spacing and
  // punctuation a dispatcher typed in.
  const dialable = trimmed.replace(/(?!^\+)[^\d]/g, "");
  return dialable.length >= 7 ? `tel:${dialable}` : null;
}
