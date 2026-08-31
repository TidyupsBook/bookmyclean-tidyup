/**
 * Push customer contact corrections onto a booking's already-linked Jobber
 * client without making the local edit depend on Jobber being online.
 *
 * The booking route answers as soon as its own database update is durable.
 * This work then runs in the same per-company lane as every other outbound
 * Jobber call. A failure is stored on the booking for the existing retry
 * action; a successful retry clears only a contact-sync error, not an
 * unrelated quote, schedule, or time-sheet failure.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  activityTable,
  bookingsTable,
  db,
  jobberConnectionsTable,
  type Booking,
  type Company,
} from "@workspace/db";
import {
  getValidAccessToken,
  getValidConnectionToken,
  updateJobberClient,
} from "../lib/jobber";
import { customerLabel } from "../lib/bookingFormat";
import { logger } from "../lib/logger";
import {
  JOBBER_CLIENT_SYNC_ERROR_PREFIX,
  isJobberClientSyncError,
  otherJobberError,
  recordJobberFailure,
  runQueuedForCompany,
} from "./jobberPush";

export {
  JOBBER_CLIENT_SYNC_ERROR_PREFIX,
  isJobberClientSyncError,
} from "./jobberPush";

export type JobberClientSyncResult =
  | { status: "synced"; booking: Booking }
  | { status: "skipped"; booking: Booking }
  | { status: "failed"; error: string; booking: Booking };

async function pushBookingClientUpdate(
  company: Company,
  booking: Booking,
): Promise<JobberClientSyncResult> {
  if (!booking.jobberClientId) {
    return { status: "skipped", booking };
  }

  try {
    let accessToken: string;
    if (booking.jobberConnectionId) {
      const [connection] = await db
        .select()
        .from(jobberConnectionsTable)
        .where(
          and(
            eq(jobberConnectionsTable.id, booking.jobberConnectionId),
            eq(jobberConnectionsTable.companyId, company.id),
          ),
        )
        .limit(1);
      if (!connection) {
        throw new Error("The booking's Jobber connection was not found");
      }
      accessToken = await getValidConnectionToken(connection);
    } else {
      accessToken = await getValidAccessToken(company);
    }
    await updateJobberClient(accessToken, {
      clientId: booking.jobberClientId,
      name: booking.customerName,
      phone: booking.customerPhone,
    });

    let updated = booking;
    if (isJobberClientSyncError(booking.jobberSyncError)) {
      const remainingError = otherJobberError(booking.jobberSyncError);
      const [cleared] = await db
        .update(bookingsTable)
        .set({
          jobberSyncError: remainingError,
          jobberSyncErrorAt: remainingError ? booking.jobberSyncErrorAt : null,
          jobberSyncAttempts: 0,
        })
        .where(
          and(
            eq(bookingsTable.id, booking.id),
            eq(bookingsTable.jobberSyncError, booking.jobberSyncError!),
          ),
        )
        .returning();
      updated = cleared ?? booking;
    }

    await db.insert(activityTable).values({
      companyId: company.id,
      type: "jobber_synced",
      message: `Customer details updated in Jobber for ${customerLabel(booking)}.`,
      bookingId: booking.id,
    });

    return { status: "synced", booking: updated ?? booking };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(
      { err, companyId: company.id, bookingId: booking.id },
      "Jobber client contact update failed",
    );
    const failure = `${JOBBER_CLIENT_SYNC_ERROR_PREFIX}${message}`;
    const updated = await recordJobberFailure(company, booking, failure);
    return {
      status: "failed",
      error: updated.jobberSyncError ?? failure,
      booking: updated,
    };
  }
}

export function queueBookingClientUpdate(
  company: Company,
  booking: Booking,
): Promise<JobberClientSyncResult> {
  return runQueuedForCompany(company.id, () =>
    db.transaction(async (tx) => {
      // The in-memory company queue prevents ordinary overlap in one server.
      // The advisory lock extends that ordering across processes, and the
      // reload after acquiring it means a delayed earlier PATCH can only send
      // the newest committed contact details.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`jobber-client-sync:${booking.id}`}))`,
      );
      const [current] = await tx
        .select()
        .from(bookingsTable)
        .where(
          and(
            eq(bookingsTable.id, booking.id),
            eq(bookingsTable.companyId, company.id),
          ),
        )
        .limit(1);
      if (!current) return { status: "skipped", booking };
      return pushBookingClientUpdate(company, current);
    }),
  );
}

export function scheduleBookingClientUpdate(
  company: Company,
  booking: Booking,
): Promise<void> {
  return queueBookingClientUpdate(company, booking)
    .then((result) => {
      if (result.status === "failed") {
        logger.warn(
          { bookingId: booking.id, error: result.error },
          "Automatic Jobber client contact update failed",
        );
      }
    })
    .catch((err) => {
      logger.error(
        { err, bookingId: booking.id },
        "Automatic Jobber client contact update threw",
      );
    });
}
