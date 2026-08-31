/**
 * Pushing our own bookings and quotes into Jobber.
 *
 * Jobber is stubbed at the HTTP boundary rather than at our own helpers, so
 * these tests see the exact GraphQL that would go over the wire. That matters:
 * every push used to fail because the mutation named fields Jobber's input
 * doesn't have, and a test that stubs our helpers cannot catch that.
 *
 * What's proved here is everything that decides whether the owner's Jobber
 * account ends up correct or a mess:
 *
 *   - the request is built only from fields Jobber accepts;
 *   - a customer Jobber already knows is reused, not cloned once per clean;
 *   - a client created just before a failure is remembered, so the retry
 *     doesn't leave a second one behind;
 *   - a booking imported *from* Jobber is never pushed back at it;
 *   - two pushes racing (the automatic one and the office's button) produce
 *     one request, not two.
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

// Only the token is faked; the real query builders run, and their HTTP calls
// are answered by the stub below.
vi.mock("../lib/jobber", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/jobber")>("../lib/jobber");
  return {
    ...actual,
    getValidAccessToken: vi.fn(async () => "test-token"),
    getValidConnectionToken: vi.fn(
      async (connection: { accountId: string | null }) =>
        `test-token-${connection.accountId ?? "unknown"}`,
    ),
  };
});

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  activityTable,
  leadsTable,
  jobberConnectionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  pushBookingToJobber,
  pushQuoteToJobber,
  scheduleJobberPush,
} from "./jobberPush";

type GraphqlCall = {
  query: string;
  variables: Record<string, unknown>;
  authorization?: string | null;
};

const calls: GraphqlCall[] = [];
let respond: (call: GraphqlCall) => Promise<unknown> = async () => {
  throw new Error("no responder set");
};

vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
  const call = JSON.parse(String(init.body)) as GraphqlCall;
  call.authorization = new Headers(init.headers).get("Authorization");
  calls.push(call);
  const data = await respond(call);
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function makeBooking(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(bookingsTable)
    .values({
      companyId,
      customerName: "Dee Dee Lawson",
      customerPhone: "(780) 555-0134",
      customerAddress: "12 Maple Crescent",
      addressCity: "Edmonton",
      addressProvince: "AB",
      addressPostal: "T5J 0N3",
      service: "Deep clean",
      scheduledFor: new Date("2026-08-20T16:00:00Z"),
      status: "pending",
      ...over,
    })
    .returning();
  return row!;
}

async function reload(id: number) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id));
  return row!;
}

/** Variables sent with the first call whose query mentions `name`. */
function varsFor(name: string): Record<string, unknown> | undefined {
  return calls.find((c) => c.query.includes(name))?.variables;
}

function countFor(name: string): number {
  return calls.filter((c) => c.query.includes(name)).length;
}

const CLIENT_WITH_PROPERTY = {
  id: "cli_1",
  name: "Dee Dee Lawson",
  phones: [{ number: "+17805550134", friendly: "(780) 555-0134" }],
  clientProperties: {
    nodes: [
      {
        id: "prop_1",
        address: {
          street1: "12 Maple Crescent",
          street2: null,
          city: "Edmonton",
          postalCode: "T5J 0N3",
        },
      },
    ],
  },
};

/** An account with no matching customer, where everything else succeeds. */
function happyJobber(
  over: { findClient?: unknown; quoteDeleted?: boolean } = {},
) {
  return async ({ query }: GraphqlCall): Promise<unknown> => {
    if (query.includes("FindClient")) {
      return over.findClient ?? { clients: { nodes: [] } };
    }
    if (query.includes("FetchQuote")) {
      if (over.quoteDeleted) return { quote: null };
      // Jobber holds whatever the draft push put there, so a second push at
      // the same price genuinely has nothing to change.
      const attrs = (varsFor("CreateQuote")?.["attributes"] ?? {}) as {
        title?: string;
        message?: string;
        lineItems?: Array<{
          name: string;
          quantity: number;
          unitPrice: number;
        }>;
      };
      return {
        quote: {
          id: "quo_1",
          quoteNumber: "17",
          jobberWebUri: "https://jobber/quo_1",
          title: attrs.title ?? null,
          message: attrs.message ?? null,
          lineItems: {
            nodes: (attrs.lineItems ?? []).map((line, i) => ({
              id: `line_${i}`,
              name: line.name,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
            })),
          },
        },
      };
    }
    if (query.includes("EditQuote")) {
      return { quoteEdit: { quote: { id: "quo_1" }, userErrors: [] } };
    }
    if (query.includes("AddQuoteLines")) {
      return {
        quoteCreateLineItems: { quote: { id: "quo_1" }, userErrors: [] },
      };
    }
    if (query.includes("RemoveQuoteLines")) {
      return {
        quoteDeleteLineItems: { quote: { id: "quo_1" }, userErrors: [] },
      };
    }
    if (query.includes("clientCreate")) {
      return { clientCreate: { client: CLIENT_WITH_PROPERTY, userErrors: [] } };
    }
    if (query.includes("propertyCreate")) {
      return {
        propertyCreate: { properties: [{ id: "prop_new" }], userErrors: [] },
      };
    }
    if (query.includes("propertyEdit")) {
      return {
        propertyEdit: { property: { id: "prop_1" }, userErrors: [] },
      };
    }
    if (query.includes("CreateRequest")) {
      return {
        requestCreate: {
          request: { id: "req_1", jobberWebUri: "https://jobber/req_1" },
          userErrors: [],
        },
      };
    }
    if (query.includes("quoteCreate")) {
      return {
        quoteCreate: {
          quote: {
            id: "quo_1",
            quoteNumber: "17",
            jobberWebUri: "https://jobber/quo_1",
          },
          userErrors: [],
        },
      };
    }
    if (query.includes("requestCreateNote")) {
      return {
        requestCreateNote: { requestNote: { id: "note_1" }, userErrors: [] },
      };
    }
    throw new Error(`unstubbed query: ${query}`);
  };
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `jpush_owner_${runId}`,
      name: `Jobber Push Co ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = row!.id;
});

afterAll(async () => {
  await db.delete(activityTable).where(eq(activityTable.companyId, companyId));
  await db.delete(bookingsTable).where(eq(bookingsTable.companyId, companyId));
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db
    .delete(jobberConnectionsTable)
    .where(eq(jobberConnectionsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

beforeEach(() => {
  calls.length = 0;
  respond = happyJobber();
});

describe("pushing a booking to Jobber", () => {
  it("keeps a retry on its persisted secondary account when the primary changes", async () => {
    const [primary, secondary] = await db
      .insert(jobberConnectionsTable)
      .values([
        {
          companyId,
          accountId: `primary_${runId}`,
          accessToken: "enc-primary",
          refreshToken: "enc-primary",
          needsReauth: true,
          isPrimary: true,
        },
        {
          companyId,
          accountId: `secondary_${runId}`,
          accessToken: "enc-secondary",
          refreshToken: "enc-secondary",
          isPrimary: false,
        },
      ])
      .returning();
    const booking = await makeBooking({
      jobberConnectionId: secondary!.id,
      jobberClientId: "cli_1",
      jobberPropertyId: "prop_1",
      jobberSyncError: "Jobber was temporarily unavailable",
      jobberSyncErrorAt: new Date(),
      jobberSyncAttempts: 1,
    });
    await db
      .update(companiesTable)
      .set({ jobberNeedsReauth: true })
      .where(eq(companiesTable.id, companyId));

    try {
      const result = await pushBookingToJobber(await company(), booking);

      expect(result.status).toBe("synced");
      expect(calls.length).toBeGreaterThan(0);
      expect(
        calls.every(
          (call) =>
            call.authorization === `Bearer test-token-${secondary!.accountId}`,
        ),
      ).toBe(true);
      expect((await reload(booking.id)).jobberConnectionId).toBe(secondary!.id);
    } finally {
      await db
        .update(companiesTable)
        .set({ jobberNeedsReauth: false })
        .where(eq(companiesTable.id, companyId));
      await db
        .delete(activityTable)
        .where(eq(activityTable.bookingId, booking.id));
      await db.delete(bookingsTable).where(eq(bookingsTable.id, booking.id));
      await db
        .delete(jobberConnectionsTable)
        .where(eq(jobberConnectionsTable.id, primary!.id));
      await db
        .delete(jobberConnectionsTable)
        .where(eq(jobberConnectionsTable.id, secondary!.id));
    }
  });

  it("sends only fields Jobber's input actually has", async () => {
    const booking = await makeBooking();
    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    const input = varsFor("CreateRequest")?.["input"] as Record<
      string,
      unknown
    >;
    // The two that used to be wrong: `source` was free text on a field that
    // only takes a fixed list, and the address was passed inline as
    // `property`. Either one makes Jobber reject the whole mutation.
    expect(input).not.toHaveProperty("source");
    expect(input).not.toHaveProperty("property");
    expect(input["clientId"]).toBe("cli_1");
    expect(input["propertyId"]).toBe("prop_1");
    expect(String(input["title"])).toContain("Deep clean");
  });

  it("sends the address as separate parts so Jobber can place it", async () => {
    const booking = await makeBooking();
    await pushBookingToJobber(await company(), booking);

    const input = varsFor("clientCreate")?.["input"] as Record<string, unknown>;
    const properties = input["properties"] as Array<{
      address: Record<string, string>;
    }>;
    expect(properties[0]!.address).toEqual({
      street1: "12 Maple Crescent",
      city: "Edmonton",
      province: "AB",
      postalCode: "T5J 0N3",
    });
  });

  it("sends a unit or suite as Jobber street 2", async () => {
    const booking = await makeBooking({ addressLine2: "Suite 4" });
    await pushBookingToJobber(await company(), booking);

    const input = varsFor("clientCreate")?.["input"] as Record<string, unknown>;
    const properties = input["properties"] as Array<{
      address: Record<string, string | null>;
    }>;
    expect(properties[0]!.address).toEqual({
      street1: "12 Maple Crescent",
      street2: "Suite 4",
      city: "Edmonton",
      province: "AB",
      postalCode: "T5J 0N3",
    });
  });

  it("creates a new property rather than confusing another suite at the same street", async () => {
    respond = happyJobber({
      findClient: {
        clients: {
          nodes: [
            {
              id: "cli_existing",
              name: "Dee Dee Lawson",
              phones: [{ number: "+1 780-555-0134", friendly: null }],
              clientProperties: {
                nodes: [
                  {
                    id: "prop_suite_4",
                    address: {
                      street1: "12 Maple Crescent",
                      street2: "Suite 4",
                      city: "Edmonton",
                      postalCode: "T5J 0N3",
                    },
                  },
                  {
                    id: "prop_suite_8",
                    address: {
                      street1: "12 Maple Crescent",
                      street2: "Suite 8",
                      city: "Edmonton",
                      postalCode: "T5J 0N3",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const booking = await makeBooking({ addressLine2: "Suite 5" });

    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    expect(varsFor("CreateProperty")).toEqual({
      clientId: "cli_existing",
      input: {
        properties: [
          {
            address: {
              street1: "12 Maple Crescent",
              street2: "Suite 5",
              city: "Edmonton",
              province: "AB",
              postalCode: "T5J 0N3",
            },
          },
        ],
      },
    });
    expect(varsFor("CreateRequest")?.["input"]).toMatchObject({
      clientId: "cli_existing",
      propertyId: "prop_new",
    });
    expect(countFor("EditProperty")).toBe(0);
  });

  it("clears the remote unit instead of retaining a stale suite", async () => {
    const booking = await makeBooking({
      addressLine2: null,
      jobberClientId: "cli_1",
      jobberPropertyId: "prop_1",
    });
    await pushBookingToJobber(await company(), booking);

    expect(varsFor("EditProperty")).toEqual({
      propertyId: "prop_1",
      input: {
        address: {
          street1: "12 Maple Crescent",
          street2: null,
          city: "Edmonton",
          province: "AB",
          postalCode: "T5J 0N3",
        },
      },
    });
  });

  it("stores what Jobber gave back", async () => {
    const booking = await makeBooking();
    await pushBookingToJobber(await company(), booking);

    const row = await reload(booking.id);
    expect(row.jobberSynced).toBe(true);
    expect(row.jobberJobId).toBe("req_1");
    expect(row.jobberClientId).toBe("cli_1");
    expect(row.jobberPropertyId).toBe("prop_1");
    expect(row.jobberWebUri).toBe("https://jobber/req_1");
    expect(row.jobberSyncError).toBeNull();
  });

  it("reuses a customer Jobber already has, matched on phone", async () => {
    respond = happyJobber({
      findClient: {
        clients: {
          nodes: [
            {
              id: "cli_existing",
              name: "Dee Dee Lawson",
              // Punctuated differently from what we store — the digits are
              // what must match.
              phones: [{ number: "+1 780-555-0134", friendly: null }],
              clientProperties: {
                nodes: [
                  {
                    id: "prop_existing",
                    address: {
                      street1: "12 Maple Crescent",
                      street2: null,
                      city: "Edmonton",
                      postalCode: "T5J 0N3",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const booking = await makeBooking();
    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("propertyCreate")).toBe(0);
    const row = await reload(booking.id);
    expect(row.jobberClientId).toBe("cli_existing");
    expect(row.jobberPropertyId).toBe("prop_existing");
  });

  it("gives a lead its own client rather than merging it into an existing one", async () => {
    // Same customer, same phone, already in Jobber — the one case where the
    // reuse above must NOT happen. An ad enquiry landing silently on top of
    // an existing client is a merge the owner never agreed to; they would
    // rather see two clients and merge them in Jobber, where it can be undone.
    respond = happyJobber({
      findClient: {
        clients: {
          nodes: [
            {
              id: "cli_existing",
              name: "Dee Dee Lawson",
              phones: [{ number: "+1 780-555-0134", friendly: null }],
              clientProperties: { nodes: [] },
            },
          ],
        },
      },
    });

    const [lead] = await db
      .insert(leadsTable)
      .values({
        companyId,
        externalId: `push_lead_${runId}`,
        sourceTab: "Aug FB Leads V1",
        firstName: "Dee Dee",
        lastName: "Lawson",
        phoneNumber: "(780) 555-0134",
      })
      .returning();

    const booking = await makeBooking({ leadId: lead!.id });
    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    // Jobber is never even asked who owns that number.
    expect(countFor("FindClient")).toBe(0);
    expect(countFor("clientCreate")).toBe(1);
    const row = await reload(booking.id);
    expect(row.jobberClientId).not.toBe("cli_existing");
  });

  it("still refuses to merge once the lead row itself is gone", async () => {
    // How the customer arrived is a fact about this booking, so it has to
    // survive the inbox being tidied up. This is why lead_id carries no
    // foreign key: a cascade that nulled it would silently put the booking
    // back on phone matching, months later, on a retry nobody is watching.
    respond = happyJobber({
      findClient: {
        clients: {
          nodes: [
            {
              id: "cli_existing",
              name: "Dee Dee Lawson",
              phones: [{ number: "+1 780-555-0134", friendly: null }],
              clientProperties: { nodes: [] },
            },
          ],
        },
      },
    });

    const [lead] = await db
      .insert(leadsTable)
      .values({
        companyId,
        externalId: `push_lead_gone_${runId}`,
        sourceTab: "Aug FB Leads V1",
        firstName: "Dee Dee",
        lastName: "Lawson",
        phoneNumber: "(780) 555-0134",
      })
      .returning();
    const booking = await makeBooking({ leadId: lead!.id });
    await db.delete(leadsTable).where(eq(leadsTable.id, lead!.id));

    const result = await pushBookingToJobber(
      await company(),
      await reload(booking.id),
    );

    expect(result.status).toBe("synced");
    expect(countFor("FindClient")).toBe(0);
    expect(countFor("clientCreate")).toBe(1);
  });

  it("ignores a search hit whose number is somebody else's", async () => {
    respond = happyJobber({
      findClient: {
        clients: {
          nodes: [
            {
              id: "cli_other",
              name: "Someone Else",
              phones: [{ number: "+17805559999", friendly: null }],
              clientProperties: { nodes: [] },
            },
          ],
        },
      },
    });

    const booking = await makeBooking();
    await pushBookingToJobber(await company(), booking);

    expect(countFor("clientCreate")).toBe(1);
    expect((await reload(booking.id)).jobberClientId).toBe("cli_1");
  });

  it("remembers a client created just before a failure, and reuses it on retry", async () => {
    let requestAttempts = 0;
    const happy = happyJobber();
    respond = async (call) => {
      if (call.query.includes("CreateRequest")) {
        requestAttempts += 1;
        if (requestAttempts === 1) throw new Error("Jobber said no");
        return {
          requestCreate: {
            request: { id: "req_retry", jobberWebUri: null },
            userErrors: [],
          },
        };
      }
      return happy(call);
    };

    const booking = await makeBooking();
    const failed = await pushBookingToJobber(await company(), booking);
    expect(failed.status).toBe("failed");

    const afterFailure = await reload(booking.id);
    expect(afterFailure.jobberClientId).toBe("cli_1");
    expect(afterFailure.jobberSynced).toBe(false);
    expect(afterFailure.jobberSyncError).toBeTruthy();
    expect(afterFailure.jobberSyncAttempts).toBe(1);
    // The claim must be released, or the retry below would be locked out for
    // five minutes.
    expect(afterFailure.jobberJobId).toBeNull();

    const retried = await pushBookingToJobber(await company(), afterFailure);
    expect(retried.status).toBe("synced");
    // One client for two attempts — no stray duplicate left in Jobber.
    expect(countFor("clientCreate")).toBe(1);
    const recovered = await reload(booking.id);
    expect(recovered.jobberJobId).toBe("req_retry");
    expect(recovered.jobberSynced).toBe(true);
    expect(recovered.jobberSyncError).toBeNull();
    expect(recovered.jobberSyncErrorAt).toBeNull();
    expect(recovered.jobberSyncAttempts).toBe(0);
    const feed = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.bookingId, booking.id));
    expect(feed.map((entry) => entry.type)).toContain("jobber_synced");
  });

  it("stays quiet when its claim was taken while Jobber was answering", async () => {
    const booking = await makeBooking();
    const happy = happyJobber();
    respond = async (call) => {
      if (call.query.includes("CreateRequest")) {
        // Somebody else finished this booking while our call was in flight —
        // a slow call whose claim went stale is the real-world version.
        await db
          .update(bookingsTable)
          .set({ jobberSynced: true, jobberJobId: "req_someone_else" })
          .where(eq(bookingsTable.id, booking.id));
      }
      return happy(call);
    };

    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("skipped");
    const row = await reload(booking.id);
    // The other push's result stands; ours is not written over the top of it.
    expect(row.jobberJobId).toBe("req_someone_else");
    const feed = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.bookingId, booking.id));
    expect(feed).toHaveLength(0);
  });

  it("never pushes back a booking that came from Jobber", async () => {
    const imported = await makeBooking({
      jobberVisitId: `visit_${runId}`,
      jobberSyncedJobId: `job_${runId}`,
    });
    const result = await pushBookingToJobber(await company(), imported);

    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("creates one request when two pushes race", async () => {
    const booking = await makeBooking();
    const current = await company();
    const [first, second] = await Promise.all([
      pushBookingToJobber(current, booking),
      pushBookingToJobber(current, booking),
    ]);

    expect([first!.status, second!.status].sort()).toEqual([
      "skipped",
      "synced",
    ]);
    expect(countFor("CreateRequest")).toBe(1);
  });

  it("does nothing when Jobber isn't connected", async () => {
    const [other] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jpush_off_${runId}`,
        name: `No Jobber Co ${runId}`,
        timezone: "America/Edmonton",
      })
      .returning();
    const [booking] = await db
      .insert(bookingsTable)
      .values({
        companyId: other!.id,
        customerName: "Pat",
        customerPhone: "(780) 555-0199",
        service: "Standard clean",
        scheduledFor: new Date("2026-08-21T16:00:00Z"),
        status: "pending",
      })
      .returning();

    const result = await pushBookingToJobber(other!, booking!);
    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);

    await db.delete(bookingsTable).where(eq(bookingsTable.id, booking!.id));
    await db.delete(companiesTable).where(eq(companiesTable.id, other!.id));
  });
});

describe("the draft quote that comes with the booking", () => {
  it("raises the client, the request and then a draft quote for the service", async () => {
    const booking = await makeBooking({
      quoteHours: 3,
      quoteCrewLabel: "2 cleaners",
      quoteHourlyRate: 60,
      quoteNotes: "Front door code 1234",
    });

    const result = await pushBookingToJobber(await company(), booking);
    expect(result.status).toBe("synced");

    // Order matters: Jobber won't take a quote without a client and a
    // property, and the quote is only worth having if it hangs off the
    // request the office is looking at.
    const at = (name: string) => calls.findIndex((c) => c.query.includes(name));
    expect(at("clientCreate")).toBeLessThan(at("CreateRequest"));
    expect(at("CreateRequest")).toBeLessThan(at("CreateQuote"));

    const attrs = varsFor("CreateQuote")?.["attributes"] as Record<
      string,
      unknown
    >;
    expect(attrs["requestId"]).toBe("req_1");
    expect(attrs["clientId"]).toBe("cli_1");
    expect(attrs["title"]).toContain("Deep clean");
    // The service's scheduled time, in the company's own timezone.
    expect(attrs["title"]).toContain("August 20, 2026");
    const lines = attrs["lineItems"] as Array<Record<string, unknown>>;
    // The same money the quote calculator shows: 3h × $60.
    expect(lines[0]?.["quantity"]).toBe(3);
    expect(lines[0]?.["unitPrice"]).toBe(60);
    // Tax comes from Jobber's account configuration, not a second taxable
    // line item. The customer-facing quote still displays the 12.5% total.
    expect(lines.some((line) => String(line["name"]).includes("Tax"))).toBe(
      false,
    );

    const row = await reload(booking.id);
    expect(row.jobberSynced).toBe(true);
    expect(row.jobberQuoteId).toBe("quo_1");
    expect(row.jobberQuoteNumber).toBe("17");
    expect(row.jobberQuoteWebUri).toBe("https://jobber/quo_1");
  });

  it("sends a service-table flat price to Jobber as one unit", async () => {
    const booking = await makeBooking({
      quoteHours: 1,
      quoteCrewLabel: "flat rate",
      quoteHourlyRate: 400,
    });

    const result = await pushBookingToJobber(await company(), booking);
    expect(result.status).toBe("synced");

    const attrs = varsFor("CreateQuote")?.["attributes"] as Record<
      string,
      unknown
    >;
    const lines = attrs["lineItems"] as Array<Record<string, unknown>>;
    expect(lines[0]).toMatchObject({
      quantity: 1,
      unitPrice: 400,
    });
    expect(lines[0]?.["name"]).toContain("flat rate");
  });

  it("skips the quote, but keeps the request, when nothing is priced yet", async () => {
    const booking = await makeBooking();
    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    expect(countFor("CreateQuote")).toBe(0);
    expect((await reload(booking.id)).jobberSynced).toBe(true);
  });

  it("fills in only the missing quote when the request is already there", async () => {
    const booking = await makeBooking({
      quoteHours: 2,
      quoteHourlyRate: 60,
      jobberSynced: true,
      jobberJobId: "req_old",
      jobberClientId: "cli_1",
      jobberPropertyId: "prop_1",
      jobberWebUri: "https://jobber/req_old",
    });

    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    expect(countFor("CreateRequest")).toBe(0);
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("CreateQuote")).toBe(1);
    expect(
      (varsFor("CreateQuote")?.["attributes"] as Record<string, unknown>)[
        "requestId"
      ],
    ).toBe("req_old");
  });

  it("leaves a booking that already has both halves alone", async () => {
    const booking = await makeBooking({
      quoteHours: 2,
      quoteHourlyRate: 60,
      jobberSynced: true,
      jobberJobId: "req_done",
      jobberQuoteId: "quo_done",
    });

    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

describe("a push that is refused before it starts", () => {
  async function companyWith(
    over: Record<string, unknown>,
    tag: string,
  ): Promise<{ companyRow: typeof companiesTable.$inferSelect; id: number }> {
    const [row] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `jpush_${tag}_${runId}`,
        name: `${tag} Co ${runId}`,
        timezone: "America/Edmonton",
        ...over,
      })
      .returning();
    return { companyRow: row!, id: row!.id };
  }

  async function bookingFor(id: number) {
    const [row] = await db
      .insert(bookingsTable)
      .values({
        companyId: id,
        customerName: "Pat Ng",
        customerPhone: "(780) 555-0177",
        service: "Standard clean",
        scheduledFor: new Date("2026-08-21T16:00:00Z"),
        status: "pending",
      })
      .returning();
    return row!;
  }

  it("writes the reason on the booking and into the feed when Jobber needs reconnecting", async () => {
    const { companyRow, id } = await companyWith(
      {
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
        jobberNeedsReauth: true,
      },
      "stale",
    );
    const booking = await bookingFor(id);

    await scheduleJobberPush(companyRow, booking);

    const row = await reload(booking.id);
    expect(row.jobberSyncError).toContain("reconnect Jobber");
    expect(row.jobberSyncErrorAt).toBeTruthy();
    const feed = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, id));
    expect(feed.map((f) => f.type)).toContain("jobber_sync_failed");
    expect(calls).toHaveLength(0);

    await db.delete(activityTable).where(eq(activityTable.companyId, id));
    await db.delete(bookingsTable).where(eq(bookingsTable.companyId, id));
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  });

  it("says nothing at all for a company that doesn't use Jobber", async () => {
    const { companyRow, id } = await companyWith({}, "offjobber");
    const booking = await bookingFor(id);

    await scheduleJobberPush(companyRow, booking);

    const row = await reload(booking.id);
    expect(row.jobberSyncError).toBeNull();
    const feed = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, id));
    expect(feed).toHaveLength(0);

    await db.delete(bookingsTable).where(eq(bookingsTable.companyId, id));
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  });
});

describe("pushing a quote to Jobber", () => {
  it("does not block a quote on the removed unsupported account tax query", async () => {
    const booking = await makeBooking({
      quoteHours: 2,
      quoteHourlyRate: 60,
      jobberClientId: "cli_1",
      jobberPropertyId: "prop_1",
    });

    const result = await pushQuoteToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    expect(countFor("JobberTaxConfiguration")).toBe(0);
    expect(countFor("CreateQuote")).toBe(1);
  });

  it("sends the priced lines, hung off the work request", async () => {
    const booking = await makeBooking({
      quoteHours: 3,
      quoteCrewLabel: "2 cleaners",
      quoteHourlyRate: 60,
      quoteNotes: "Front door code 1234",
    });
    const result = await pushQuoteToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    const attrs = varsFor("quoteCreate")?.["attributes"] as Record<
      string,
      unknown
    >;
    expect(attrs["clientId"]).toBe("cli_1");
    expect(attrs["propertyId"]).toBe("prop_1");
    expect(attrs["requestId"]).toBe("req_1");
    expect(attrs["message"]).toBe("Front door code 1234");
    const lines = attrs["lineItems"] as Array<Record<string, unknown>>;
    expect(lines.length).toBeGreaterThan(0);
    // A quote must never quietly edit the company's saved price list.
    expect(lines.every((l) => l["saveToProductsAndServices"] === false)).toBe(
      true,
    );

    const row = await reload(booking.id);
    expect(row.jobberQuoteId).toBe("quo_1");
    expect(row.jobberQuoteNumber).toBe("17");
    expect(row.jobberQuoteWebUri).toBe("https://jobber/quo_1");
  });

  it("leaves the draft alone when the texted price is the drafted price", async () => {
    const booking = await makeBooking({ quoteHours: 2, quoteHourlyRate: 60 });
    await pushQuoteToJobber(await company(), booking);
    const again = await pushQuoteToJobber(
      await company(),
      await reload(booking.id),
    );

    expect(again.status).toBe("synced");
    expect(countFor("CreateQuote")).toBe(1);
    // Nothing changed, so nothing was sent — a quote history full of edits
    // nobody made is its own kind of wrong.
    expect(countFor("EditQuote")).toBe(0);
    expect(countFor("AddQuoteLines")).toBe(0);
  });

  it("updates the draft, rather than raising a second quote, when the price moved", async () => {
    const booking = await makeBooking({ quoteHours: 2, quoteHourlyRate: 60 });
    await pushQuoteToJobber(await company(), booking);

    // The office re-priced the job before texting it.
    await db
      .update(bookingsTable)
      .set({ quoteHours: 4 })
      .where(eq(bookingsTable.id, booking.id));

    const again = await pushQuoteToJobber(
      await company(),
      await reload(booking.id),
    );

    expect(again.status).toBe("synced");
    expect(countFor("CreateQuote")).toBe(1);
    const added = varsFor("AddQuoteLines")?.["lineItems"] as Array<
      Record<string, unknown>
    >;
    expect(added[0]?.["quantity"]).toBe(4);
    // The new lines go on before the old ones come off, so the quote is never
    // momentarily empty.
    expect(
      calls.findIndex((c) => c.query.includes("AddQuoteLines")),
    ).toBeLessThan(
      calls.findIndex((c) => c.query.includes("RemoveQuoteLines")),
    );
    // Every line that was on the draft comes off, so the two prices can't end
    // up stacked on one quote.
    const drafted = (
      varsFor("CreateQuote")?.["attributes"] as { lineItems: unknown[] }
    ).lineItems;
    expect(varsFor("RemoveQuoteLines")?.["lineItemIds"]).toEqual(
      drafted.map((_, i) => `line_${i}`),
    );
  });

  it("raises a fresh quote when the draft was deleted in Jobber", async () => {
    const booking = await makeBooking({
      quoteHours: 2,
      quoteHourlyRate: 60,
      jobberClientId: "cli_1",
      jobberPropertyId: "prop_1",
      jobberSynced: true,
      jobberJobId: "req_1",
      jobberQuoteId: "quo_gone",
      jobberQuoteNumber: "9",
    });
    respond = happyJobber({ quoteDeleted: true });

    const result = await pushQuoteToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    expect(countFor("CreateQuote")).toBe(1);
    expect((await reload(booking.id)).jobberQuoteId).toBe("quo_1");
  });

  it("skips a booking with no price on it", async () => {
    const booking = await makeBooking();
    const result = await pushQuoteToJobber(await company(), booking);

    expect(result.status).toBe("skipped");
    expect(countFor("quoteCreate")).toBe(0);
  });

  it("reuses a lead's Jobber client and request instead of minting new ones", async () => {
    // A booking created from a Jobber-origin lead is born wearing the ids the
    // lead was imported with: Jobber's own client, property and request.
    const [lead] = await db
      .insert(leadsTable)
      .values({
        companyId,
        source: "jobber",
        externalId: `lead_quote_${runId}`,
        sourceTab: "Jobber requests",
        firstName: "Lena",
        lastName: "FromJobber",
        phoneNumber: "+17805550190",
        jobberRequestId: "req_lead",
        jobberClientId: "cli_lead",
        status: "converted",
      })
      .returning();
    const booking = await makeBooking({
      leadId: lead!.id,
      quoteHours: 2,
      quoteHourlyRate: 60,
      jobberSynced: true,
      jobberSyncedRequestId: "req_lead",
      jobberClientId: "cli_lead",
      jobberPropertyId: "prop_lead",
    });

    const result = await pushQuoteToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    // Nothing was created except the quote itself...
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("CreateRequest")).toBe(0);
    expect(countFor("propertyCreate")).toBe(0);
    // ...and the quote hangs off the lead's own client, property and
    // request, so Jobber shows one enquiry with one price on it.
    const attrs = varsFor("quoteCreate")?.["attributes"] as Record<
      string,
      unknown
    >;
    expect(attrs["clientId"]).toBe("cli_lead");
    expect(attrs["propertyId"]).toBe("prop_lead");
    expect(attrs["requestId"]).toBe("req_lead");
    expect((await reload(booking.id)).jobberQuoteId).toBe("quo_1");
  });
});
