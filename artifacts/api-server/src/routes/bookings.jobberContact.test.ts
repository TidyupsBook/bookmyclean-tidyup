/**
 * Correcting contact details on a booking that already points at a Jobber
 * client.
 *
 * The local PATCH must finish even when Jobber fails. The failure then lives
 * on the booking and the existing Sync to Jobber action retries the current
 * local values rather than undoing them.
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
import type http from "node:http";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, unknown> }) => ({
    userId: (req.headers["x-test-user"] as string | undefined) ?? null,
    sessionClaims: {},
  }),
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  clerkClient: {
    users: {
      getUser: async () => ({
        emailAddresses: [],
        firstName: "Test",
        lastName: "Owner",
      }),
    },
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getClerkProxyHost: () => null,
}));

vi.mock("../lib/jobber", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/jobber")>("../lib/jobber");
  return {
    ...actual,
    getValidAccessToken: vi.fn(async () => "test-token"),
    getValidConnectionToken: vi.fn(async () => "connection-token"),
    editJobberVisitSchedule: vi.fn(async () => undefined),
  };
});

import app from "../app";
import {
  activityTable,
  bookingsTable,
  companiesTable,
  db,
  jobberConnectionsTable,
  pool,
  type Booking,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { JOBBER_CLIENT_SYNC_ERROR_PREFIX } from "../services/jobberClientSync";
import { recordJobberFailure } from "../services/jobberPush";
import { syncScheduledVisit } from "../services/jobberSchedule";

type GraphqlCall = {
  query: string;
  variables: Record<string, unknown>;
  authorization: string | null;
};

const nativeFetch = globalThis.fetch;
const graphqlCalls: GraphqlCall[] = [];
let failClientEdit = false;
let holdClientEdit = false;
let releaseClientEdit: (() => void) | null = null;

vi.stubGlobal(
  "fetch",
  async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!url.includes("api.getjobber.com/api/graphql")) {
      return nativeFetch(input, init);
    }

    const body = JSON.parse(String(init?.body)) as Omit<
      GraphqlCall,
      "authorization"
    >;
    const call: GraphqlCall = {
      ...body,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    graphqlCalls.push(call);
    if (call.query.includes("ClientForContactEdit")) {
      return Response.json({
        data: {
          client: {
            id: "jobber-client-1",
            phones: [
              {
                id: "jobber-phone-1",
                number: "+17805550100",
                friendly: "(780) 555-0100",
                primary: true,
              },
            ],
          },
        },
      });
    }
    if (call.query.includes("EditClientContact")) {
      if (holdClientEdit) {
        holdClientEdit = false;
        await new Promise<void>((resolve) => {
          releaseClientEdit = resolve;
        });
      }
      if (failClientEdit) {
        return Response.json({
          errors: [{ message: "Jobber is temporarily unavailable" }],
        });
      }
      return Response.json({
        data: {
          clientEdit: {
            client: { id: "jobber-client-1" },
            userErrors: [],
          },
        },
      });
    }
    throw new Error(`Unexpected Jobber operation: ${call.query}`);
  },
);

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `jobber_contact_owner_${runId}`;
let server: http.Server;
let baseUrl: string;
let companyId: number;

async function call(path: string, method: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "x-test-user": OWNER,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedBooking(linked: boolean, overrides: Partial<Booking> = {}) {
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: "Old Name",
      customerPhone: "+17805550100",
      service: "Deep clean",
      scheduledFor: new Date("2030-08-20T16:00:00Z"),
      jobberSynced: linked,
      jobberClientId: linked ? "jobber-client-1" : null,
      jobberJobId: linked ? "jobber-request-1" : null,
      jobberQuoteId: linked ? "jobber-quote-1" : null,
      ...overrides,
    })
    .returning();
  return booking!;
}

async function bookingById(id: number) {
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id));
  return booking!;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sync");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Jobber Contact Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "unused-test-access-token",
      jobberRefreshToken: "unused-test-refresh-token",
    })
    .returning();
  companyId = company!.id;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine test server port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  failClientEdit = false;
  holdClientEdit = false;
  releaseClientEdit = null;
  graphqlCalls.length = 0;
});

afterAll(async () => {
  server?.close();
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db
    .delete(jobberConnectionsTable)
    .where(eq(jobberConnectionsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

describe("booking Jobber contact corrections", () => {
  it("updates the linked Jobber client's name and primary phone after saving", async () => {
    const booking = await seedBooking(true);
    const response = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "New Customer Name",
      customerPhone: "+17805550199",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      customerName: "New Customer Name",
      customerPhone: "+17805550199",
    });
    await waitFor(async () =>
      graphqlCalls.some((entry) => entry.query.includes("EditClientContact")),
    );

    const mutation = graphqlCalls.find((entry) =>
      entry.query.includes("EditClientContact"),
    );
    expect(mutation?.variables).toEqual({
      clientId: "jobber-client-1",
      input: {
        firstName: "New Customer",
        lastName: "Name",
        phonesToEdit: [
          {
            id: "jobber-phone-1",
            description: "MAIN",
            primary: true,
            number: "+17805550199",
          },
        ],
      },
    });
  });

  it("keeps the local correction when Jobber fails and retries it manually", async () => {
    const booking = await seedBooking(true);
    failClientEdit = true;
    const response = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "Correct Local Name",
      customerPhone: "+17805550222",
    });

    expect(response.status).toBe(200);
    await waitFor(
      async () =>
        (await bookingById(booking.id)).jobberSyncError?.startsWith(
          JOBBER_CLIENT_SYNC_ERROR_PREFIX,
        ) ?? false,
    );
    expect(await bookingById(booking.id)).toMatchObject({
      customerName: "Correct Local Name",
      customerPhone: "+17805550222",
    });

    failClientEdit = false;
    graphqlCalls.length = 0;
    const retry = await call(`/bookings/${booking.id}/sync-jobber`, "POST");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      customerName: "Correct Local Name",
      customerPhone: "+17805550222",
      jobberSyncError: null,
    });
    expect(
      graphqlCalls.some((entry) => entry.query.includes("EditClientContact")),
    ).toBe(true);
    expect((await bookingById(booking.id)).jobberSyncError).toBeNull();
  });

  it("uses the specific Jobber connection that owns an imported booking", async () => {
    const [connection] = await db
      .insert(jobberConnectionsTable)
      .values({
        companyId,
        displayName: "Second office",
        accessToken: "unused",
        refreshToken: "unused",
        isPrimary: false,
      })
      .returning();
    const booking = await seedBooking(true, {
      jobberConnectionId: connection!.id,
      jobberVisitId: "jobber-visit-1",
    });

    const response = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "Second Office Customer",
    });
    expect(response.status).toBe(200);
    await waitFor(async () =>
      graphqlCalls.some((entry) => entry.query.includes("EditClientContact")),
    );

    expect(
      graphqlCalls.find((entry) => entry.query.includes("ClientForContactEdit"))
        ?.authorization,
    ).toBe("Bearer connection-token");
  });

  it("sends the latest saved correction after rapid back-to-back edits", async () => {
    const booking = await seedBooking(true);
    holdClientEdit = true;

    const first = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "First Correction",
      customerPhone: "+17805550444",
    });
    expect(first.status).toBe(200);
    await waitFor(async () => releaseClientEdit !== null);

    const second = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "Final Correction",
      customerPhone: "+17805550555",
    });
    expect(second.status).toBe(200);
    releaseClientEdit?.();

    await waitFor(
      async () =>
        graphqlCalls.filter((entry) =>
          entry.query.includes("EditClientContact"),
        ).length === 2,
    );
    const edits = graphqlCalls.filter((entry) =>
      entry.query.includes("EditClientContact"),
    );
    expect(edits.at(-1)?.variables).toMatchObject({
      input: {
        firstName: "Final",
        lastName: "Correction",
        phonesToEdit: [{ number: "+17805550555" }],
      },
    });
  });

  it("does not erase a separate Jobber problem while retrying contact details", async () => {
    const booking = await seedBooking(true, {
      jobberSyncError: "Visit is locked in Jobber",
      jobberSyncErrorAt: new Date("2026-08-20T12:00:00Z"),
    });
    failClientEdit = true;
    const response = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "Correct Despite Two Problems",
    });
    expect(response.status).toBe(200);
    await waitFor(
      async () =>
        (await bookingById(booking.id)).jobberSyncError?.includes(
          "Visit is locked in Jobber",
        ) ?? false,
    );

    failClientEdit = false;
    const retry = await call(`/bookings/${booking.id}/sync-jobber`, "POST");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      customerName: "Correct Despite Two Problems",
      jobberSyncError: "Visit is locked in Jobber",
    });
    expect((await bookingById(booking.id)).jobberSyncError).toBe(
      "Visit is locked in Jobber",
    );
  });

  it("keeps contact retryable when another Jobber operation fails afterward", async () => {
    const booking = await seedBooking(true);
    failClientEdit = true;
    const response = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "Correction Still Owed",
    });
    expect(response.status).toBe(200);
    await waitFor(
      async () =>
        (await bookingById(booking.id)).jobberSyncError?.startsWith(
          JOBBER_CLIENT_SYNC_ERROR_PREFIX,
        ) ?? false,
    );

    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    const afterContactFailure = await bookingById(booking.id);
    await recordJobberFailure(
      company!,
      afterContactFailure,
      "Visit later failed in Jobber",
    );
    expect((await bookingById(booking.id)).jobberSyncError).toContain(
      "Visit later failed in Jobber",
    );
    expect(
      (await bookingById(booking.id)).jobberSyncError?.startsWith(
        JOBBER_CLIENT_SYNC_ERROR_PREFIX,
      ),
    ).toBe(true);

    failClientEdit = false;
    const retry = await call(`/bookings/${booking.id}/sync-jobber`, "POST");
    expect(retry.status).toBe(200);
    expect((await bookingById(booking.id)).jobberSyncError).toBe(
      "Visit later failed in Jobber",
    );
  });

  it("keeps contact retryable after a later visit update succeeds", async () => {
    const booking = await seedBooking(true, {
      jobberCreatedJobId: "jobber-job-1",
      jobberCreatedVisitId: "jobber-visit-1",
    });
    failClientEdit = true;
    const response = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "Contact Retry Survives",
    });
    expect(response.status).toBe(200);
    await waitFor(
      async () =>
        (await bookingById(booking.id)).jobberSyncError?.startsWith(
          JOBBER_CLIENT_SYNC_ERROR_PREFIX,
        ) ?? false,
    );

    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    const visitUpdate = await syncScheduledVisit(
      company!,
      await bookingById(booking.id),
      { time: true },
    );
    expect(visitUpdate.status).toBe("updated");
    expect(
      (await bookingById(booking.id)).jobberSyncError?.startsWith(
        JOBBER_CLIENT_SYNC_ERROR_PREFIX,
      ),
    ).toBe(true);

    failClientEdit = false;
    const retry = await call(`/bookings/${booking.id}/sync-jobber`, "POST");
    expect(retry.status).toBe(200);
    expect((await bookingById(booking.id)).jobberSyncError).toBeNull();
  });

  it("leaves an unlinked booking local-only", async () => {
    const booking = await seedBooking(false);
    const response = await call(`/bookings/${booking.id}`, "PATCH", {
      customerName: "Local Only",
      customerPhone: "+17805550333",
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graphqlCalls).toHaveLength(0);
  });
});
