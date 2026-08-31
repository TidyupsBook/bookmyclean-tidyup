/**
 * Saving a booking that isn't finished yet.
 *
 * The booking desk is used with a customer mid-sentence. They give a phone
 * number and a day, then say "hold on" — and until now the Save button
 * refused anything without a name, a phone number and a service type, so
 * that booking existed only in the dispatcher's head. A partial booking on
 * the schedule is worth more than a complete one on a sticky note, so a time
 * on the calendar is the whole floor and the gaps get filled in later —
 * unless the owner flips a field's "required" toggle in Settings, which is
 * the second half of what these tests pin.
 *
 * The gaps must also stay *gaps* — an absent service must not become a
 * guess, and the feed line must not read like a typo.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
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
        lastName: "User",
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

import app from "../app";
import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  bookingAssignmentsTable,
  activityTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const runId = `${Date.now()}_${process.pid}`;
const OWNER = `min_owner_${runId}`;
// A second company whose owner toggled fields back to required — proving the
// rule is per-company setting, not a global constant.
const STRICT_OWNER = `min_strict_owner_${runId}`;

let server: http.Server;
let baseUrl: string;
let companyId: number;
let strictCompanyId: number;

async function create(body: unknown, owner: string = OWNER): Promise<Response> {
  return fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": owner },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: OWNER,
      name: `Minimal Co ${runId}`,
      timezone: "America/Edmonton",
    })
    .returning();
  companyId = company!.id;

  const [strict] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: STRICT_OWNER,
      name: `Strict Co ${runId}`,
      timezone: "America/Edmonton",
      bookingRequiredFields: ["phone", "service"],
    })
    .returning();
  strictCompanyId = strict!.id;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine test server port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.close();
  for (const id of [companyId, strictCompanyId]) {
    if (id == null) continue;
    const rows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, id));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db
        .delete(bookingAssignmentsTable)
        .where(inArray(bookingAssignmentsTable.bookingId, ids));
    }
    await db.delete(activityTable).where(eq(activityTable.companyId, id));
    await db.delete(bookingsTable).where(eq(bookingsTable.companyId, id));
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
  await pool.end();
});

/** Only the fields these tests read back off the create response. */
type BookingRow = {
  id: number;
  customerName: string;
  customerPhone: string;
  service: string;
};

describe("taking a booking with the details still missing", () => {
  it("saves a booking that has only a name and a time", async () => {
    const res = await create({
      customerName: "Jay",
      scheduledFor: "2030-07-01T16:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const booking = (await res.json()) as BookingRow;
    expect(booking.customerName).toBe("Jay");
    // Absent, not invented: nothing downstream should read a guessed service
    // as something the customer asked for.
    expect(booking.customerPhone).toBe("");
    expect(booking.service).toBe("");
  });

  it("saves with a phone number but no service picked yet", async () => {
    const res = await create({
      customerName: "Dana Okoro",
      customerPhone: "780-920-6391",
      service: "",
      scheduledFor: "2030-07-02T16:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const booking = (await res.json()) as BookingRow;
    expect(booking.customerPhone).toBe("780-920-6391");
    expect(booking.service).toBe("");
  });

  it("leaves the dash out of the feed line when there is no service", async () => {
    const res = await create({
      customerName: "Priya",
      scheduledFor: "2030-07-03T16:00:00.000Z",
    });
    const booking = (await res.json()) as BookingRow;

    const [line] = await db
      .select({ message: activityTable.message })
      .from(activityTable)
      .where(eq(activityTable.bookingId, booking.id));
    expect(line!.message).toBe("Booking added by hand for Priya.");
  });

  it("saves a booking that is nothing but a phone number and a time", async () => {
    const res = await create({
      customerName: "",
      customerPhone: "780-920-6391",
      scheduledFor: "2030-07-04T16:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const booking = (await res.json()) as BookingRow;
    expect(booking.customerName).toBe("");

    // Nameless must never read as blank in the feed: the phone number stands
    // in for the name, so the line still says who the visit is for.
    const [line] = await db
      .select({ message: activityTable.message })
      .from(activityTable)
      .where(eq(activityTable.bookingId, booking.id));
    expect(line!.message).toBe("Booking added by hand for 780-920-6391.");
  });

  it("labels a booking with no name and no phone 'No name', never blank", async () => {
    const res = await create({ scheduledFor: "2030-07-06T16:00:00.000Z" });
    expect(res.status).toBe(201);
    const booking = (await res.json()) as BookingRow;

    const [line] = await db
      .select({ message: activityTable.message })
      .from(activityTable)
      .where(eq(activityTable.bookingId, booking.id));
    expect(line!.message).toBe("Booking added by hand for No name.");
  });

  it("still refuses a booking with no time", async () => {
    const res = await create({ customerName: "Jay" });
    expect(res.status).toBe(400);
  });
});

describe("a company that toggled fields back to required", () => {
  it("refuses the booking and names every missing field", async () => {
    const res = await create(
      { customerName: "Jay", scheduledFor: "2030-07-01T16:00:00.000Z" },
      STRICT_OWNER,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The message must name what's missing — "invalid request" sends the
    // owner hunting — and point at where the rule lives.
    expect(body.error).toContain("phone number");
    expect(body.error).toContain("service");
    expect(body.error).toContain("Booking form");
  });

  it("accepts once the required fields are filled", async () => {
    const res = await create(
      {
        customerName: "Jay",
        customerPhone: "780-555-0142",
        service: "Deep clean",
        scheduledFor: "2030-07-02T16:00:00.000Z",
      },
      STRICT_OWNER,
    );
    expect(res.status).toBe(201);
  });
});
