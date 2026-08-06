import { and, eq, gt, inArray } from "drizzle-orm";
import { db, bookingsTable } from "@workspace/db";
import { logger } from "./logger";

/** How far the zone is from UTC at a given instant, in ms (DST-aware). */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/**
 * After a company timezone change, flag upcoming bookings whose *displayed*
 * wall-clock time is different in the new zone than it was in the old one.
 *
 * Bookings are stored as UTC instants, so the instant is unchanged — but a
 * booking entered while the company sat on the wrong zone was entered as a
 * wall-clock agreement with the customer. Any booking whose rendered hour just
 * shifted may now disagree with that agreement, so the owner must confirm or
 * adjust each one.
 *
 * Only pending/confirmed bookings in the future are flagged: past and
 * completed/canceled jobs can't be missed anymore. A booking already awaiting
 * review keeps its original "previous" zone so the review UI still shows the
 * time the owner actually saw when it was entered.
 */
export async function flagShiftedBookings(
  companyId: number,
  oldTimezone: string,
  newTimezone: string,
): Promise<number> {
  const upcoming = await db
    .select({
      id: bookingsTable.id,
      scheduledFor: bookingsTable.scheduledFor,
      needsTimeReview: bookingsTable.needsTimeReview,
      status: bookingsTable.status,
    })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.companyId, companyId),
        gt(bookingsTable.scheduledFor, new Date()),
        inArray(bookingsTable.status, ["pending", "confirmed"]),
      ),
    );

  const shifted = upcoming.filter((b) => {
    if (b.needsTimeReview) return false; // already awaiting review
    try {
      return (
        zoneOffsetMs(b.scheduledFor, oldTimezone) !==
        zoneOffsetMs(b.scheduledFor, newTimezone)
      );
    } catch {
      // An unknown zone should never get this far (PATCH validates), but if it
      // does, flagging conservatively beats silently skipping the review.
      return true;
    }
  });
  if (shifted.length === 0) return 0;

  await db
    .update(bookingsTable)
    .set({
      needsTimeReview: true,
      timeReviewPreviousTimezone: oldTimezone,
    })
    .where(
      inArray(
        bookingsTable.id,
        shifted.map((b) => b.id),
      ),
    );
  logger.info(
    { companyId, oldTimezone, newTimezone, count: shifted.length },
    "Flagged shifted bookings for time review after timezone change",
  );
  return shifted.length;
}
