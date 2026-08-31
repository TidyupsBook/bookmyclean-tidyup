/**
 * Production-only retry sweep for bookings whose outbound Jobber sync failed.
 *
 * The booking's existing sync claim remains the concurrency guard. This sweep
 * only decides whether a failed row is due; it hands the actual work to the
 * same per-company queue used by the manual retry button.
 */
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import {
  db,
  bookingsTable,
  companiesTable,
  jobberConnectionsTable,
  type Booking,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  queueBookingJobberSync,
  supportsAutomaticBookingRetry,
} from "./bookingJobberSync";

/** The calendar poller runs every two minutes, so retries are checked at that cadence. */
export const BOOKING_JOBBER_RETRY_INTERVAL_MS = 2 * 60 * 1000;
/** Let migrations and startup traffic settle before the first background pass. */
export const BOOKING_JOBBER_RETRY_INITIAL_DELAY_MS = 75 * 1000;
/** Automatic retries stop here; the owner's manual action remains available. */
export const BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS = 5;
/** The first retry waits one calendar cycle, then the delay doubles. */
export const BOOKING_JOBBER_RETRY_BASE_DELAY_MS =
  BOOKING_JOBBER_RETRY_INTERVAL_MS;
/** Never make a single booking wait more than an hour between automatic tries. */
export const BOOKING_JOBBER_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;

export type BookingJobberRetryStatus =
  "none" | "pending" | "exhausted" | "manual";

export type BookingJobberRetryState = {
  status: BookingJobberRetryStatus;
  attemptsRemaining: number | null;
  nextRetryAt: Date | null;
};

export function bookingJobberRetryDelayMs(attempts: number): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  return Math.min(
    BOOKING_JOBBER_RETRY_MAX_DELAY_MS,
    BOOKING_JOBBER_RETRY_BASE_DELAY_MS * 2 ** (safeAttempts - 1),
  );
}

/**
 * Translate the persisted failure into the status an owner needs to act on.
 *
 * This deliberately shares the same support check and backoff calculation as
 * the production sweep. A visit/scheduling failure is manual-only because the
 * generic booking sync queue cannot safely repeat that operation.
 */
export function bookingJobberRetryState(
  booking: Booking,
): BookingJobberRetryState {
  if (!booking.jobberSyncError) {
    return { status: "none", attemptsRemaining: null, nextRetryAt: null };
  }

  if (!booking.jobberSyncErrorAt || !supportsAutomaticBookingRetry(booking)) {
    return { status: "manual", attemptsRemaining: null, nextRetryAt: null };
  }

  const attemptsRemaining = Math.max(
    0,
    BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS - booking.jobberSyncAttempts,
  );
  if (attemptsRemaining === 0) {
    return { status: "exhausted", attemptsRemaining: 0, nextRetryAt: null };
  }

  return {
    status: "pending",
    attemptsRemaining,
    nextRetryAt: new Date(
      booking.jobberSyncErrorAt.getTime() +
        bookingJobberRetryDelayMs(booking.jobberSyncAttempts),
    ),
  };
}

export function bookingJobberRetryDue(
  booking: Pick<Booking, "jobberSyncErrorAt" | "jobberSyncAttempts">,
  nowMs: number = Date.now(),
): boolean {
  if (!booking.jobberSyncErrorAt) return false;
  if (booking.jobberSyncAttempts >= BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS) {
    return false;
  }
  return (
    booking.jobberSyncErrorAt.getTime() +
      bookingJobberRetryDelayMs(booking.jobberSyncAttempts) <=
    nowMs
  );
}

/**
 * Queue all due failures whose owning connection can authenticate. Legacy rows
 * use the company credential mirror; multi-account rows use their exact
 * connection. A disconnected row is left untouched until it is reconnected,
 * so an outage cannot consume its retry budget.
 */
export async function runBookingJobberRetryCycle(
  nowMs: number = Date.now(),
): Promise<number> {
  const rows = await db
    .select({ booking: bookingsTable, company: companiesTable })
    .from(bookingsTable)
    .innerJoin(companiesTable, eq(bookingsTable.companyId, companiesTable.id))
    .leftJoin(
      jobberConnectionsTable,
      and(
        eq(jobberConnectionsTable.id, bookingsTable.jobberConnectionId),
        eq(jobberConnectionsTable.companyId, bookingsTable.companyId),
      ),
    )
    .where(
      and(
        or(
          and(
            isNull(bookingsTable.jobberConnectionId),
            eq(companiesTable.jobberConnected, true),
            eq(companiesTable.jobberNeedsReauth, false),
            isNotNull(companiesTable.jobberAccessToken),
            isNotNull(companiesTable.jobberRefreshToken),
          ),
          and(
            isNotNull(bookingsTable.jobberConnectionId),
            isNotNull(jobberConnectionsTable.id),
            eq(jobberConnectionsTable.needsReauth, false),
            isNotNull(jobberConnectionsTable.accessToken),
            isNotNull(jobberConnectionsTable.refreshToken),
          ),
        ),
        isNotNull(bookingsTable.jobberSyncError),
        isNotNull(bookingsTable.jobberSyncErrorAt),
        lt(
          bookingsTable.jobberSyncAttempts,
          BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
        ),
      ),
    )
    .orderBy(bookingsTable.id);

  let queued = 0;
  for (const { booking, company } of rows) {
    if (!supportsAutomaticBookingRetry(booking)) continue;
    if (!bookingJobberRetryDue(booking, nowMs)) continue;
    queued += 1;
    try {
      const result = await queueBookingJobberSync(company, booking);
      if (result.status === "skipped") {
        // A stale claim or an error from a Jobber operation this shared action
        // cannot repeat must not be reconsidered every two minutes forever.
        // Pin the error and count we selected so a concurrent successful retry
        // cannot have its clean state overwritten by this bookkeeping.
        await db
          .update(bookingsTable)
          .set({
            jobberSyncAttempts: booking.jobberSyncAttempts + 1,
            jobberSyncErrorAt: new Date(nowMs),
          })
          .where(
            and(
              eq(bookingsTable.id, booking.id),
              eq(bookingsTable.jobberSyncError, booking.jobberSyncError!),
              eq(bookingsTable.jobberSyncAttempts, booking.jobberSyncAttempts),
            ),
          );
      }
    } catch (err) {
      // The queue normally returns a result, but one unexpected failure must
      // not prevent later bookings from getting their retry opportunity.
      logger.warn(
        { err, companyId: company.id, bookingId: booking.id },
        "[bookingJobberRetry] retry failed unexpectedly; continuing",
      );
      await db
        .update(bookingsTable)
        .set({
          jobberSyncAttempts: booking.jobberSyncAttempts + 1,
          jobberSyncErrorAt: new Date(nowMs),
        })
        .where(
          and(
            eq(bookingsTable.id, booking.id),
            eq(bookingsTable.jobberSyncError, booking.jobberSyncError!),
            eq(bookingsTable.jobberSyncAttempts, booking.jobberSyncAttempts),
          ),
        );
    }
  }
  if (queued > 0) {
    logger.info(
      { queued },
      "[bookingJobberRetry] automatic booking retries queued",
    );
  }
  return queued;
}

let timer: NodeJS.Timeout | null = null;
let cycleInFlight = false;

export function startBookingJobberRetry(): void {
  if (!process.env["PUBLIC_APP_URL"]?.trim()) {
    logger.info(
      "[bookingJobberRetry] background retry disabled: no PUBLIC_APP_URL pin (dev workspace)",
    );
    return;
  }

  if (timer) return;
  const run = () => {
    if (cycleInFlight) return;
    cycleInFlight = true;
    runBookingJobberRetryCycle()
      .catch((err) =>
        logger.error({ err }, "[bookingJobberRetry] retry cycle failed"),
      )
      .finally(() => {
        cycleInFlight = false;
      });
  };
  setTimeout(run, BOOKING_JOBBER_RETRY_INITIAL_DELAY_MS).unref();
  timer = setInterval(run, BOOKING_JOBBER_RETRY_INTERVAL_MS);
  timer.unref();
  logger.info(
    { intervalMs: BOOKING_JOBBER_RETRY_INTERVAL_MS },
    "[bookingJobberRetry] background retry started",
  );
}
