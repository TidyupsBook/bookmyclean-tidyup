/**
 * How a booking's address and frequency read to a human — in the dashboard,
 * in a text, and in anything sent to Jobber. Kept out of the routes file so
 * background pushes can use the same wording the office sees.
 */

/**
 * The address as a human would write it, from the separate boxes the booking
 * desk types into. Bookings taken before those boxes existed keep the whole
 * address in `customerAddress`, so this returns that unchanged for them.
 */
export function joinAddress(b: {
  customerAddress: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressProvince: string | null;
  addressPostal: string | null;
}): string | null {
  const cityLine = [b.addressCity, b.addressProvince]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");
  const joined = [
    b.customerAddress?.trim(),
    b.addressLine2?.trim(),
    cityLine,
    b.addressPostal?.trim(),
  ]
    .filter(Boolean)
    .join(", ");
  return joined || null;
}

const FREQUENCY_LABELS: Record<string, string> = {
  one_time: "One time",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
};

/** Falls back to the stored value so an unknown code still reads as something. */
export function frequencyLabel(frequency: string): string {
  return FREQUENCY_LABELS[frequency] ?? frequency;
}

/**
 * What to call the customer when the booking might not carry a name.
 *
 * Since names became optional, every sentence built around
 * `booking.customerName` — activity lines, owner texts, Jobber pushes —
 * goes through here instead: the name when there is one, else the phone
 * number, else a plain "No name". Never an empty string, because
 * "Booking added by hand for ." reads like a bug.
 */
export function customerLabel(b: {
  customerName: string | null;
  customerPhone?: string | null;
}): string {
  const name = (b.customerName ?? "").trim();
  if (name) return name;
  const phone = (b.customerPhone ?? "").trim();
  return phone || "No name";
}

/**
 * The feed line for a cleared deposit, composed here (not inline in the
 * Stripe path) so the nameless-booking fallback is pinned by a unit test —
 * that route only fires on a real Checkout round-trip.
 */
export function depositPaidMessage(
  b: { customerName: string | null; customerPhone?: string | null },
  service: string,
  amountTotalCents: number | null,
): string {
  const amount =
    amountTotalCents != null
      ? `$${(amountTotalCents / 100).toFixed(2)}`
      : "their deposit";
  return `${customerLabel(b)} paid ${amount} toward ${service}.`;
}
