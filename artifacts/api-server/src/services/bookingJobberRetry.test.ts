/**
 * Automatic booking retries must be selective: only due failures for a usable
 * Jobber connection may re-enter the same sync path as the owner's retry.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("./bookingJobberSync", async () => {
  const actual = await vi.importActual<typeof import("./bookingJobberSync")>(
    "./bookingJobberSync",
  );
  return {
    ...actual,
    queueBookingJobberSync: vi.fn(async (_company, booking) => ({
      status: "skipped" as const,
      reason: "test",
      booking,
    })),
  };
});

import {
  db,
  pool,
  bookingsTable,
  companiesTable,
  jobberConnectionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { queueBookingJobberSync } from "./bookingJobberSync";
import {
  BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
  BOOKING_JOBBER_RETRY_BASE_DELAY_MS,
  bookingJobberRetryDue,
  bookingJobberRetryState,
  runBookingJobberRetryCycle,
  startBookingJobberRetry,
} from "./bookingJobberRetry";

const mockedQueueBookingJobberSync = vi.mocked(queueBookingJobberSync);
const runId = `${Date.now()}_${process.pid}`;
const fixedNow = Date.UTC(2020, 0, 2, 12);
let connectedCompanyId: number;
let disconnectedCompanyId: number;
let reauthCompanyId: number;
let reauthSecondaryConnectionId: number;
let missingTokenSecondaryConnectionId: number;

async function makeBooking(
  over: Record<string, unknown> = {},
  companyId: number = connectedCompanyId,
) {
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: "Retry Customer",
      customerPhone: "(780) 555-0188",
      service: "Standard clean",
      scheduledFor: new Date("2020-01-03T16:00:00Z"),
      jobberSyncError: "Jobber is unavailable",
      jobberSyncErrorAt: new Date(
        fixedNow - BOOKING_JOBBER_RETRY_BASE_DELAY_MS - 1,
      ),
      jobberSyncAttempts: 1,
      ...over,
    })
    .returning();
  return booking!;
}

beforeAll(async () => {
  const rows = await db
    .insert(companiesTable)
    .values([
      {
        ownerUserId: `booking_retry_owner_${runId}`,
        name: `Booking retry ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
      },
      {
        ownerUserId: `booking_retry_disconnected_${runId}`,
        name: `Booking retry disconnected ${runId}`,
        timezone: "America/Edmonton",
      },
      {
        ownerUserId: `booking_retry_reauth_${runId}`,
        name: `Booking retry reauth ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
        jobberNeedsReauth: true,
      },
    ])
    .returning();
  connectedCompanyId = rows[0]!.id;
  disconnectedCompanyId = rows[1]!.id;
  reauthCompanyId = rows[2]!.id;

  const connections = await db
    .insert(jobberConnectionsTable)
    .values([
      {
        companyId: connectedCompanyId,
        accountId: `primary_${runId}`,
        accessToken: "enc",
        refreshToken: "enc",
        isPrimary: true,
      },
      {
        companyId: connectedCompanyId,
        accountId: `reauth_secondary_${runId}`,
        accessToken: "enc",
        refreshToken: "enc",
        needsReauth: true,
      },
      {
        companyId: connectedCompanyId,
        accountId: `missing_token_secondary_${runId}`,
        accessToken: null,
        refreshToken: null,
      },
    ])
    .returning();
  reauthSecondaryConnectionId = connections[1]!.id;
  missingTokenSecondaryConnectionId = connections[2]!.id;
});

afterAll(async () => {
  const companyIds = [
    connectedCompanyId,
    disconnectedCompanyId,
    reauthCompanyId,
  ];
  await db
    .delete(bookingsTable)
    .where(inArray(bookingsTable.companyId, companyIds));
  await db
    .delete(jobberConnectionsTable)
    .where(inArray(jobberConnectionsTable.companyId, companyIds));
  await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  await pool.end();
});

beforeEach(async () => {
  mockedQueueBookingJobberSync.mockClear();
  await db
    .update(companiesTable)
    .set({ jobberNeedsReauth: false })
    .where(eq(companiesTable.id, connectedCompanyId));
  await db
    .update(jobberConnectionsTable)
    .set({ needsReauth: true })
    .where(eq(jobberConnectionsTable.id, reauthSecondaryConnectionId));
  await db
    .delete(bookingsTable)
    .where(eq(bookingsTable.companyId, connectedCompanyId));
  await db
    .delete(bookingsTable)
    .where(eq(bookingsTable.companyId, disconnectedCompanyId));
  await db
    .delete(bookingsTable)
    .where(eq(bookingsTable.companyId, reauthCompanyId));
});

describe("bookingJobberRetry", () => {
  it("re-queues only due failures for an active Jobber connection", async () => {
    const due = await makeBooking();
    const tooSoon = await makeBooking({
      jobberSyncErrorAt: new Date(fixedNow),
    });
    const exhausted = await makeBooking({
      jobberSyncAttempts: BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
    });
    const noError = await makeBooking({
      jobberSyncError: null,
      jobberSyncErrorAt: null,
    });
    const visitFailure = await makeBooking({
      jobberSyncError:
        "Could not update this job's Jobber visit: Visit is locked",
    });
    const scheduleFailure = await makeBooking({
      jobberQuoteId: "quote_legacy",
      clientApprovedAt: new Date("2020-01-01T00:00:00Z"),
    });
    const disconnected = await makeBooking({}, disconnectedCompanyId);
    const reauth = await makeBooking({}, reauthCompanyId);

    const queued = await runBookingJobberRetryCycle(fixedNow);

    expect(queued).toBe(1);
    expect(mockedQueueBookingJobberSync).toHaveBeenCalledTimes(1);
    expect(mockedQueueBookingJobberSync).toHaveBeenCalledWith(
      expect.objectContaining({ id: connectedCompanyId }),
      expect.objectContaining({ id: due.id }),
    );
    const attemptedIds = mockedQueueBookingJobberSync.mock.calls.map(
      ([, booking]) => booking.id,
    );
    expect(attemptedIds).not.toContain(tooSoon.id);
    expect(attemptedIds).not.toContain(exhausted.id);
    expect(attemptedIds).not.toContain(noError.id);
    expect(attemptedIds).not.toContain(visitFailure.id);
    expect(attemptedIds).not.toContain(scheduleFailure.id);
    expect(attemptedIds).not.toContain(disconnected.id);
    expect(attemptedIds).not.toContain(reauth.id);
    const [afterSkip] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, due.id));
    expect(afterSkip!.jobberSyncAttempts).toBe(2);
    expect(afterSkip!.jobberSyncErrorAt?.getTime()).toBe(fixedNow);
    for (const unsupported of [visitFailure, scheduleFailure]) {
      const [unchanged] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, unsupported.id));
      expect(unchanged!.jobberSyncAttempts).toBe(1);
    }
  });

  it("waits for the booking's own secondary connection without spending its retry budget", async () => {
    const needsReauth = await makeBooking({
      jobberConnectionId: reauthSecondaryConnectionId,
    });
    const missingTokens = await makeBooking({
      jobberConnectionId: missingTokenSecondaryConnectionId,
    });

    expect(await runBookingJobberRetryCycle(fixedNow)).toBe(0);
    expect(mockedQueueBookingJobberSync).not.toHaveBeenCalled();

    for (const booking of [needsReauth, missingTokens]) {
      const [unchanged] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, booking.id));
      expect(unchanged!.jobberSyncAttempts).toBe(1);
      expect(unchanged!.jobberSyncErrorAt?.getTime()).toBe(
        booking.jobberSyncErrorAt?.getTime(),
      );
    }

    await db
      .update(jobberConnectionsTable)
      .set({ needsReauth: false })
      .where(eq(jobberConnectionsTable.id, reauthSecondaryConnectionId));
    await db
      .update(companiesTable)
      .set({ jobberNeedsReauth: true })
      .where(eq(companiesTable.id, connectedCompanyId));

    const visitFailure = await makeBooking({
      jobberConnectionId: reauthSecondaryConnectionId,
      jobberSyncError:
        "Could not update this job's Jobber visit: Visit is locked",
    });
    const scheduleFailure = await makeBooking({
      jobberConnectionId: reauthSecondaryConnectionId,
      jobberQuoteId: "quote_secondary",
      clientApprovedAt: new Date("2020-01-01T00:00:00Z"),
    });

    expect(await runBookingJobberRetryCycle(fixedNow)).toBe(1);
    expect(mockedQueueBookingJobberSync).toHaveBeenCalledWith(
      expect.objectContaining({ id: connectedCompanyId }),
      expect.objectContaining({
        id: needsReauth.id,
        jobberConnectionId: reauthSecondaryConnectionId,
      }),
    );
    const [retried] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, needsReauth.id));
    expect(retried!.jobberSyncAttempts).toBe(2);

    const [stillWaiting] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, missingTokens.id));
    expect(stillWaiting!.jobberSyncAttempts).toBe(1);
    for (const unsupported of [visitFailure, scheduleFailure]) {
      const [unchanged] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, unsupported.id));
      expect(unchanged!.jobberSyncAttempts).toBe(1);
      expect(unchanged!.jobberSyncErrorAt?.getTime()).toBe(
        unsupported.jobberSyncErrorAt?.getTime(),
      );
    }
  });

  it("uses the failure timestamp and attempt count for bounded exponential backoff", () => {
    // Rows that failed before the counter existed were migrated with zero.
    // They still get a first automatic recovery attempt.
    expect(
      bookingJobberRetryDue(
        {
          jobberSyncErrorAt: new Date(
            fixedNow - BOOKING_JOBBER_RETRY_BASE_DELAY_MS,
          ),
          jobberSyncAttempts: 0,
        },
        fixedNow,
      ),
    ).toBe(true);
    expect(
      bookingJobberRetryDue(
        {
          jobberSyncErrorAt: new Date(
            fixedNow - BOOKING_JOBBER_RETRY_BASE_DELAY_MS,
          ),
          jobberSyncAttempts: 1,
        },
        fixedNow,
      ),
    ).toBe(true);
    expect(
      bookingJobberRetryDue(
        {
          jobberSyncErrorAt: new Date(
            fixedNow - BOOKING_JOBBER_RETRY_BASE_DELAY_MS,
          ),
          jobberSyncAttempts: 2,
        },
        fixedNow,
      ),
    ).toBe(false);
    expect(
      bookingJobberRetryDue(
        {
          jobberSyncErrorAt: new Date(fixedNow - 7 * 24 * 60 * 60 * 1000),
          jobberSyncAttempts: BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
        },
        fixedNow,
      ),
    ).toBe(false);
  });

  it("describes pending, exhausted, and manual-only failures for booking details", async () => {
    const pending = await makeBooking({
      jobberSyncAttempts: 2,
      jobberSyncErrorAt: new Date(fixedNow),
    });
    const exhausted = await makeBooking({
      jobberSyncAttempts: BOOKING_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
    });
    const manual = await makeBooking({
      jobberSyncError:
        "Could not update this job's Jobber visit: Visit is locked",
    });
    const clean = await makeBooking({
      jobberSyncError: null,
      jobberSyncErrorAt: null,
      jobberSyncAttempts: 0,
    });

    expect(bookingJobberRetryState(pending)).toEqual({
      status: "pending",
      attemptsRemaining: 3,
      nextRetryAt: new Date(fixedNow + BOOKING_JOBBER_RETRY_BASE_DELAY_MS * 2),
    });
    expect(bookingJobberRetryState(exhausted)).toEqual({
      status: "exhausted",
      attemptsRemaining: 0,
      nextRetryAt: null,
    });
    expect(bookingJobberRetryState(manual)).toEqual({
      status: "manual",
      attemptsRemaining: null,
      nextRetryAt: null,
    });
    expect(bookingJobberRetryState(clean)).toEqual({
      status: "none",
      attemptsRemaining: null,
      nextRetryAt: null,
    });
  });

  it("does not start the poller in a dev workspace without a public URL pin", () => {
    const savedPin = process.env.PUBLIC_APP_URL;
    delete process.env.PUBLIC_APP_URL;
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      startBookingJobberRetry();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (savedPin === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = savedPin;
    }
  });
});
