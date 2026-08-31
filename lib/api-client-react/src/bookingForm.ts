/**
 * The booking form's field list and the two rules built on it — hand-written
 * and shared by every client, so the dashboard new-booking page, the
 * Bookings-page dialog and the phone app cannot drift apart on what
 * "required" means or on what a nameless booking is called.
 *
 * Every field is optional unless the owner toggles it on in Settings →
 * Booking form (`company.bookingRequiredFields`). The date is deliberately
 * not on this list: a booking always has to land somewhere on the calendar,
 * so the forms keep their own date check.
 *
 * This file lives outside `src/generated`, which orval wipes on codegen.
 */

export const BOOKING_FORM_FIELDS = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "service", label: "Service" },
  { key: "time", label: "Time" },
] as const;

export type BookingFormFieldKey = (typeof BOOKING_FORM_FIELDS)[number]["key"];

export const ALL_BOOKING_FORM_FIELD_KEYS: BookingFormFieldKey[] =
  BOOKING_FORM_FIELDS.map((f) => f.key);

/** Whether one field is on the owner's required list. */
export function isBookingFieldRequired(
  required: readonly string[] | null | undefined,
  key: BookingFormFieldKey,
): boolean {
  return (required ?? []).includes(key);
}

/**
 * Which required fields this form still has blank, as lowercase labels ready
 * for a "still needs: …" message. Only the keys the form actually passes are
 * checked — a form that doesn't collect a field can't hold the Save button
 * hostage to it (the server still enforces the full list on create).
 */
export function missingBookingFields(
  required: readonly string[] | null | undefined,
  values: Partial<Record<BookingFormFieldKey, string | null | undefined>>,
): string[] {
  const req = required ?? [];
  return BOOKING_FORM_FIELDS.filter(
    (f) =>
      req.includes(f.key) && f.key in values && !(values[f.key] ?? "").trim(),
  ).map((f) => f.label.toLowerCase());
}

/**
 * Preset choices for the "Take booking" window — how many minutes after a
 * finished call the calendar shortcut stays visible in the Calls list.
 *
 * Shared by the web Settings page and the mobile Booking Form Settings screen
 * so the two UIs cannot silently drift apart on supported values.
 */
export const CALL_WINDOW_CHOICES = [10, 15, 30, 60, 120, 240, 480] as const;
export type CallWindowMinutes = (typeof CALL_WINDOW_CHOICES)[number];

/** Default window when the company record has no stored value. */
export const DEFAULT_CALL_WINDOW_MINUTES: CallWindowMinutes = 30;

/**
 * What to call the customer on any surface now that names are optional: the
 * name when there is one, else the phone number, else "No name" — never a
 * blank. The server applies the same rule to texts, activity lines and the
 * Jobber push.
 */
export function bookingDisplayName(b: {
  customerName?: string | null;
  customerPhone?: string | null;
}): string {
  const name = (b.customerName ?? "").trim();
  if (name) return name;
  const phone = (b.customerPhone ?? "").trim();
  return phone || "No name";
}
