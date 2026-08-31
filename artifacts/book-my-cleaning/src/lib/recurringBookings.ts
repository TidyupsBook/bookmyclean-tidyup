import type { Booking } from "@workspace/api-client-react";

const RECURRING_FREQUENCIES = new Set([
  "weekly",
  "biweekly",
  "monthly",
  "recurring",
]);

export function isRecurringBooking(
  booking: Pick<Booking, "frequency" | "service">,
): boolean {
  const frequency = booking.frequency?.trim().toLowerCase();
  return (
    (frequency != null && RECURRING_FREQUENCIES.has(frequency)) ||
    /\brecurr(?:ing|ence)\b/i.test(booking.service)
  );
}

function customerKey(booking: Booking): string {
  if (booking.jobberClientId != null) return `jobber:${booking.jobberClientId}`;
  const phone = booking.customerPhone.replace(/\D/g, "");
  if (phone) return `phone:${phone}`;
  return `customer:${booking.customerName.trim().toLowerCase()}|${(
    booking.customerAddress ?? ""
  )
    .trim()
    .toLowerCase()}`;
}

function nextRecurringBooking(bookings: Booking[], now: number): Booking {
  const upcoming = bookings
    .filter(
      (booking) =>
        booking.status !== "canceled" &&
        new Date(booking.scheduledFor).getTime() >= now,
    )
    .sort(
      (a, b) =>
        new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
    );
  return upcoming[0] ?? bookings[0]!;
}

export function collapseRecurringBookings(
  bookings: Booking[],
  expanded: boolean,
  now = Date.now(),
): { bookings: Booking[]; groupCount: number; hiddenCount: number } {
  const recurring = bookings.filter(isRecurringBooking);
  const groups = new Map<string, Booking[]>();
  for (const booking of recurring) {
    const key = customerKey(booking);
    const group = groups.get(key) ?? [];
    group.push(booking);
    groups.set(key, group);
  }

  if (expanded || groups.size === 0) {
    return { bookings, groupCount: groups.size, hiddenCount: 0 };
  }

  const nextBookings = new Set(
    [...groups.values()].map((group) => nextRecurringBooking(group, now).id),
  );
  const visible = bookings.filter(
    (booking) => !isRecurringBooking(booking) || nextBookings.has(booking.id),
  );
  return {
    bookings: visible,
    groupCount: groups.size,
    hiddenCount: recurring.length - nextBookings.size,
  };
}
