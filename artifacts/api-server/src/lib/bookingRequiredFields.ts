/**
 * The owner's "required booking fields" setting, enforced where bookings are
 * created.
 *
 * Every booking field is optional by default — the desk saves whatever it
 * has, and a booking with gaps beats a sticky note. Each key the owner
 * toggles on in Settings → Booking form turns one field back into a hard
 * requirement, checked here so the dashboard form, the Bookings dialog and
 * the phone app can't drift apart on what "required" means.
 *
 * `time` is on the settings list but is a form-side concern only: every
 * client folds a time (or its 9:00 AM default) into `scheduledFor` before
 * the request is made, so by the time a payload reaches the server there is
 * no separate "time" box left to check. The date itself is not a setting —
 * a booking always has to land somewhere on the calendar.
 */

export const SERVER_CHECKED_BOOKING_FIELDS = [
  { key: "name", label: "name" },
  { key: "phone", label: "phone number" },
  { key: "email", label: "email" },
  { key: "address", label: "address" },
  { key: "service", label: "service" },
] as const;

type ServerCheckedField = (typeof SERVER_CHECKED_BOOKING_FIELDS)[number]["key"];

/**
 * Which required fields this create payload leaves blank, as lowercase
 * labels ready for an error message. Unknown keys in the stored setting are
 * ignored rather than made unsatisfiable.
 */
export function missingRequiredBookingFields(
  required: readonly string[],
  values: {
    customerName?: string | null;
    customerPhone?: string | null;
    customerEmail?: string | null;
    customerAddress?: string | null;
    service?: string | null;
  },
): string[] {
  const blank = (v: string | null | undefined) => !(v ?? "").trim();
  const byField: Record<ServerCheckedField, boolean> = {
    name: blank(values.customerName),
    phone: blank(values.customerPhone),
    email: blank(values.customerEmail),
    address: blank(values.customerAddress),
    service: blank(values.service),
  };
  return SERVER_CHECKED_BOOKING_FIELDS.filter(
    (f) => required.includes(f.key) && byField[f.key],
  ).map((f) => f.label);
}

/** The 400 the desk sees, naming every gap at once so fixing it is one pass. */
export function missingFieldsMessage(missing: readonly string[]): string {
  const list = missing.join(", ");
  return missing.length === 1
    ? `The ${list} field is required. You can change which fields are required in Settings → Booking form.`
    : `These fields are required: ${list}. You can change which fields are required in Settings → Booking form.`;
}
