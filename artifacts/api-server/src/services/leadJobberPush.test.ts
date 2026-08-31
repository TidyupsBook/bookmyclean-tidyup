/**
 * Pushing website-form leads into Jobber the moment they are submitted.
 *
 * Jobber is stubbed at the HTTP boundary (same discipline as the booking
 * push tests), and what's proved is every way one enquiry could become two
 * Jobber records:
 *
 *   - one submit makes exactly one client and one request, and Jobber is
 *     never asked who owns the phone number (an ad enquiry must never be
 *     silently merged onto an existing customer);
 *   - a push that fails after the client is created remembers that client,
 *     releases its claim, and the retry reuses it — no orphaned duplicate;
 *   - a claim already in flight blocks a second push entirely;
 *   - sheet leads use the same push path as form leads, and converted leads
 *     are never pushed;
 *   - a booking converted from a pushed lead adopts the lead's client and
 *     request instead of minting its own — including when the lead's push
 *     had only got as far as the client.
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
  return { ...actual, getValidAccessToken: vi.fn(async () => "test-token") };
});

import {
  db,
  pool,
  companiesTable,
  bookingsTable,
  activityTable,
  leadsTable,
  clientsTable,
  type Lead,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { pushLeadToJobber, scheduleLeadJobberPush } from "./leadJobberPush";
import { pushBookingToJobber } from "./jobberPush";

type GraphqlCall = { query: string; variables: Record<string, unknown> };

const calls: GraphqlCall[] = [];
let respond: (call: GraphqlCall) => Promise<unknown> = async () => {
  throw new Error("no responder set");
};

vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
  const call = JSON.parse(init.body) as GraphqlCall;
  calls.push(call);
  const data = await respond(call);
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

const runId = `${Date.now()}_${process.pid}`;
let companyId: number;
let seq = 0;

async function company() {
  const [row] = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return row!;
}

async function makeLead(over: Record<string, unknown> = {}): Promise<Lead> {
  seq += 1;
  const [row] = await db
    .insert(leadsTable)
    .values({
      companyId,
      source: "form",
      externalId: `ljp_${runId}_${seq}`,
      sourceTab: "Website request form",
      firstName: "Nora",
      lastName: "Fields",
      phoneNumber: "(780) 555-0199",
      email: `nora_${runId}_${seq}@example.com`,
      streetAddress: "12 Maple Crescent",
      city: "Edmonton",
      province: "AB",
      postCode: "T5J 0N3",
      service: "Deep clean",
      bedrooms: "1 or 2",
      bathrooms: "2",
      dateOfServiceRequested: "sometime next weekend?",
      heardAbout: "A friend",
      ...over,
    })
    .returning();
  return row!;
}

async function reload(id: number): Promise<Lead> {
  const [row] = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
  return row!;
}

function varsFor(name: string): Record<string, unknown> | undefined {
  return calls.find((c) => c.query.includes(name))?.variables;
}

function countFor(name: string): number {
  return calls.filter((c) => c.query.includes(name)).length;
}

/** The property street matches the lead fixture, so it is reused, not recreated. */
const CLIENT_WITH_PROPERTY = {
  id: "cli_lead1",
  name: "Nora Fields",
  phones: [{ number: "+17805550199", friendly: "(780) 555-0199" }],
  clientProperties: {
    nodes: [
      {
        id: "prop_lead1",
        address: {
          street1: "12 Maple Crescent",
          city: "Edmonton",
          postalCode: "T5J 0N3",
        },
      },
    ],
  },
};

function happyJobber(
  over: {
    failRequest?: boolean;
    clientRequests?: { id: string; jobberWebUri: string | null }[];
    orphanClients?: unknown[];
  } = {},
) {
  return async ({ query }: GraphqlCall): Promise<unknown> => {
    if (query.includes("LeadClientRequests")) {
      return {
        client: { requests: { nodes: over.clientRequests ?? [] } },
      };
    }
    if (query.includes("LeadOrphanClient")) {
      return { clients: { nodes: over.orphanClients ?? [] } };
    }
    if (query.includes("ArchiveOrphanClient")) {
      return { clientArchive: { client: { id: "x" }, userErrors: [] } };
    }
    if (query.includes("ArchiveOrphanRequest")) {
      return { requestArchive: { request: { id: "x" }, userErrors: [] } };
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
        propertyEdit: { property: { id: "prop_lead1" }, userErrors: [] },
      };
    }
    if (query.includes("CreateRequest")) {
      if (over.failRequest) throw new Error("Jobber is down");
      return {
        requestCreate: {
          request: {
            id: "req_lead1",
            jobberWebUri: "https://jobber/req_lead1",
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

async function lastActivity(type: string) {
  const [row] = await db
    .select()
    .from(activityTable)
    .where(
      and(eq(activityTable.companyId, companyId), eq(activityTable.type, type)),
    )
    .orderBy(desc(activityTable.id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  const [row] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `ljp_owner_${runId}`,
      name: `Lead Push Co ${runId}`,
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
  await db.delete(clientsTable).where(eq(clientsTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await pool.end();
});

beforeEach(() => {
  calls.length = 0;
  respond = happyJobber();
});

describe("pushing a form lead to Jobber", () => {
  it("makes one new client and one request, never asking who owns the phone", async () => {
    const lead = await makeLead();
    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("synced");
    // Never matched by phone: an ad enquiry always becomes a NEW client.
    expect(countFor("FindClient")).toBe(0);
    // And a first attempt never goes looking for a crashed attempt's orphan
    // — the recovery search runs only on evidence of a prior attempt.
    expect(countFor("LeadOrphanClient")).toBe(0);
    expect(countFor("clientCreate")).toBe(1);
    expect(countFor("CreateRequest")).toBe(1);
    // The client came back with a property at the same street — reused.
    expect(countFor("propertyCreate")).toBe(0);

    const row = await reload(lead.id);
    expect(row.jobberSynced).toBe(true);
    expect(row.jobberClientId).toBe("cli_lead1");
    expect(row.jobberPropertyId).toBe("prop_lead1");
    expect(row.jobberRequestId).toBe("req_lead1");
    expect(row.jobberWebUri).toBe("https://jobber/req_lead1");
    expect(row.jobberPushError).toBeNull();

    const activity = await lastActivity("jobber_synced");
    expect(activity?.message).toContain("Nora Fields");
  });

  it("sends the customer's own words in the request note, verbatim", async () => {
    const lead = await makeLead();
    await pushLeadToJobber(await company(), lead);

    const note = String(varsFor("requestCreateNote")?.["body"] ?? "");
    expect(note).toContain("(780) 555-0199");
    expect(note).toContain("Bedrooms: 1 or 2");
    // Free text, never parsed into a date.
    expect(note).toContain("sometime next weekend?");
    expect(note).toContain("Heard about us: A friend");

    const input = varsFor("CreateRequest")?.["input"] as Record<
      string,
      unknown
    >;
    expect(String(input["title"])).toContain("Deep clean");
    expect(String(input["title"])).toContain("Nora Fields");
  });

  it("remembers the client when the request fails, and the retry reuses it", async () => {
    respond = happyJobber({ failRequest: true });
    const lead = await makeLead({
      source: "sheet",
      sourceTab: "Aug FB V1",
      jobberPushPending: true,
    });
    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("failed");
    const afterFailure = await reload(lead.id);
    // The client exists in Jobber and is remembered…
    expect(afterFailure.jobberClientId).toBe("cli_lead1");
    expect(afterFailure.jobberSynced).toBe(false);
    // …the claim is released so the office isn't locked out…
    expect(afterFailure.jobberRequestId).toBeNull();
    // …and the failure is written down where the inbox can show it.
    expect(afterFailure.jobberPushError).toContain("Jobber is down");
    expect(afterFailure.jobberPushErrorAt).not.toBeNull();
    expect(afterFailure.jobberPushPending).toBe(false);
    const failureLine = await lastActivity("jobber_sync_failed");
    expect(failureLine?.message).toContain("Nora Fields");

    // Retry: same client, no second clientCreate anywhere.
    calls.length = 0;
    respond = happyJobber();
    const retry = await pushLeadToJobber(await company(), afterFailure);

    expect(retry.status).toBe("synced");
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("CreateRequest")).toBe(1);
    const done = await reload(lead.id);
    expect(done.jobberSynced).toBe(true);
    expect(done.jobberRequestId).toBe("req_lead1");
    expect(done.jobberPushError).toBeNull();
  });

  it("skips a lead whose claim is still fresh — no second request mid-flight", async () => {
    const lead = await makeLead({
      jobberRequestId: `pending:${Date.now()}`,
    });
    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  it("pushes an ad-sheet lead through the same path as a form lead", async () => {
    const lead = await makeLead({
      source: "sheet",
      sourceTab: "Aug FB V1",
      jobberPushPending: true,
    });
    await scheduleLeadJobberPush(await company(), lead);

    expect(countFor("FindClient")).toBe(0);
    expect(countFor("clientCreate")).toBe(1);
    expect(countFor("CreateRequest")).toBe(1);
    const saved = await reload(lead.id);
    expect(saved.jobberSynced).toBe(true);
    expect(saved.jobberPushPending).toBe(false);
  });

  it("leaves a converted lead to its booking", async () => {
    const lead = await makeLead({ status: "converted" });
    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  it("finishes an interrupted push by adopting the request Jobber already accepted", async () => {
    // The nastiest crash window: Jobber accepted the request, then the
    // process died before the id was written down. The lead looks unsynced
    // but the request exists — so before creating anything, the push asks
    // Jobber what the lead's own client already carries, and adopts it.
    respond = happyJobber({
      clientRequests: [
        { id: "req_recovered", jobberWebUri: "https://jobber/req_recovered" },
      ],
    });
    const lead = await makeLead({
      jobberClientId: "cli_lead1",
      jobberRequestId: `pending:${Date.now() - 6 * 60_000}`,
    });

    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("synced");
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("CreateRequest")).toBe(0);
    const row = await reload(lead.id);
    expect(row.jobberSynced).toBe(true);
    expect(row.jobberRequestId).toBe("req_recovered");
    expect(row.jobberWebUri).toBe("https://jobber/req_recovered");
    expect(row.jobberPushError).toBeNull();
  });

  it("reclaims a stale attempt that never made its request, reusing its client", async () => {
    const lead = await makeLead({
      jobberClientId: "cli_lead1",
      jobberRequestId: `pending:${Date.now() - 6 * 60_000}`,
    });

    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("synced");
    // It checked with Jobber first, found nothing, and only then created —
    // reusing the client the dead attempt left behind.
    expect(countFor("LeadClientRequests")).toBe(1);
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("CreateRequest")).toBe(1);
    expect((await reload(lead.id)).jobberRequestId).toBe("req_lead1");
  });

  it("a push that outlives its lease adds nothing once a retry has taken over", async () => {
    // The reviewer's race: worker one stalls inside Jobber's API long
    // enough for its lease to expire and a retry to run to completion.
    // When worker one wakes up it must add nothing — its next write is
    // conditioned on a claim it no longer holds, and the client Jobber
    // gave it after the fact gets archived, not recorded.
    const lead = await makeLead();
    let clientCalls = 0;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    respond = async (call) => {
      if (call.query.includes("clientCreate")) {
        clientCalls += 1;
        const mine = clientCalls;
        if (mine === 1) await slowGate;
        return {
          clientCreate: {
            client: {
              ...CLIENT_WITH_PROPERTY,
              id: mine === 1 ? "cli_slow" : "cli_retry",
            },
            userErrors: [],
          },
        };
      }
      return happyJobber()(call);
    };

    const co = await company();
    const first = pushLeadToJobber(co, lead);
    await vi.waitFor(() => {
      if (clientCalls === 0) throw new Error("first push not at Jobber yet");
    });

    // The lease expires while worker one is still inside Jobber's API.
    await db
      .update(leadsTable)
      .set({ jobberRequestId: `pending:${Date.now() - 6 * 60_000}` })
      .where(eq(leadsTable.id, lead.id));

    const retry = await pushLeadToJobber(co, await reload(lead.id));
    expect(retry.status).toBe("synced");

    releaseSlow();
    const slow = await first;
    expect(slow.status).toBe("skipped");

    // Exactly one request reached the CRM, and the slow worker archived
    // its own late client rather than leaving a second active one.
    expect(countFor("CreateRequest")).toBe(1);
    expect(varsFor("ArchiveOrphanClient")?.["clientId"]).toBe("cli_slow");
    const after = await reload(lead.id);
    expect(after.jobberSynced).toBe(true);
    expect(after.jobberClientId).toBe("cli_retry");
    expect(after.jobberRequestId).toBe("req_lead1");
  });

  it("archives its own request when the claim is stolen at the last instant", async () => {
    // The claim is taken during the CreateRequest round-trip itself — past
    // every checkpoint. The write-back refuses, and the request Jobber just
    // made is archived so the owner never sees a second enquiry.
    const lead = await makeLead();
    respond = async (call) => {
      if (call.query.includes("CreateRequest")) {
        await db
          .update(leadsTable)
          .set({ jobberRequestId: `pending:${Date.now()}` })
          .where(eq(leadsTable.id, lead.id));
      }
      return happyJobber()(call);
    };

    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("skipped");
    expect(varsFor("ArchiveOrphanRequest")?.["requestId"]).toBe("req_lead1");
    const row = await reload(lead.id);
    expect(row.jobberSynced).toBe(false);
  });

  it("judges the lead as it is NOW, not as the caller captured it", async () => {
    // The push runs queued: by our turn the office may have dismissed the
    // lead or another retry may have finished it. The caller's snapshot
    // says "new and unsynced" — the row says otherwise, and the row wins.
    const lead = await makeLead();
    await db
      .update(leadsTable)
      .set({ jobberSynced: true, jobberRequestId: "req_done_elsewhere" })
      .where(eq(leadsTable.id, lead.id));

    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("skipped");
    expect(calls.length).toBe(0);
    expect((await reload(lead.id)).jobberRequestId).toBe("req_done_elsewhere");
  });

  it("writes the refusal onto the lead when the owner has to reconnect Jobber", async () => {
    // The owner believes enquiries are flowing into Jobber; an expired grant
    // must surface like any other failure, not silently swallow leads.
    const [stale] = await db
      .insert(companiesTable)
      .values({
        ownerUserId: `ljp_reauth_${runId}`,
        name: `Reauth Co ${runId}`,
        timezone: "America/Edmonton",
        jobberConnected: true,
        jobberAccessToken: "enc",
        jobberRefreshToken: "enc",
        jobberNeedsReauth: true,
      })
      .returning();
    try {
      const [lead] = await db
        .insert(leadsTable)
        .values({
          companyId: stale!.id,
          source: "form",
          externalId: `ljp_reauth_lead_${runId}`,
          sourceTab: "Website request form",
          firstName: "Rea",
          lastName: "Uth",
          phoneNumber: "(780) 555-0777",
        })
        .returning();

      await scheduleLeadJobberPush(stale!, lead!);

      expect(calls.length).toBe(0);
      const [row] = await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.id, lead!.id));
      expect(row!.jobberPushError).toContain("reconnect");
      expect(row!.jobberSynced).toBe(false);
    } finally {
      await db
        .delete(activityTable)
        .where(eq(activityTable.companyId, stale!.id));
      await db.delete(leadsTable).where(eq(leadsTable.companyId, stale!.id));
      await db.delete(companiesTable).where(eq(companiesTable.id, stale!.id));
    }
  });

  it("takes back the echo lead when Jobber's webhook outruns the id write", async () => {
    // Our own requestCreate fires REQUEST_CREATE like a Jobber-form submit;
    // if that webhook is imported before the push writes its request id
    // down, the same enquiry sits in the inbox twice. Simulated here at the
    // exact interleaving: the echo lead appears while requestCreate is in
    // flight, before the push's write-back.
    const lead = await makeLead();
    const base = happyJobber();
    respond = async (call) => {
      if (call.query.includes("CreateRequest")) {
        await db.insert(leadsTable).values({
          companyId,
          source: "jobber",
          externalId: `ljp_echo_${runId}`,
          sourceTab: "Jobber request",
          firstName: "Nora",
          lastName: "Fields",
          jobberRequestId: "req_lead1",
        });
      }
      return base(call);
    };

    const result = await pushLeadToJobber(await company(), lead);
    expect(result.status).toBe("synced");

    const echoes = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.companyId, companyId),
          eq(leadsTable.source, "jobber"),
          eq(leadsTable.jobberRequestId, "req_lead1"),
        ),
      );
    expect(echoes).toHaveLength(0);
    // The form lead itself — carrying the same request id — is untouched.
    const row = await reload(lead.id);
    expect(row.jobberSynced).toBe(true);
    expect(row.jobberRequestId).toBe("req_lead1");
  });

  it("adopts the client a crashed attempt created, instead of a second one", async () => {
    // The irreversible window: Jobber accepted clientCreate, then the
    // process died before the id write. The retry has evidence (the
    // recorded failure) and finds an exact double with zero requests —
    // that client is finished, not duplicated.
    const lead = await makeLead({
      jobberPushError: "Jobber timed out",
      jobberPushErrorAt: new Date(),
    });
    respond = happyJobber({
      orphanClients: [
        {
          id: "cli_orphan",
          name: "Nora Fields",
          emails: [{ address: lead.email }],
          phones: [{ number: "+17805550199", friendly: "(780) 555-0199" }],
          requests: { nodes: [] },
          clientProperties: CLIENT_WITH_PROPERTY.clientProperties,
        },
      ],
    });

    const result = await pushLeadToJobber(await company(), lead);
    expect(result.status).toBe("synced");
    expect(countFor("LeadOrphanClient")).toBe(1);
    // Recovered, not re-created — and the orphan's property is reused too.
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("propertyCreate")).toBe(0);
    expect(countFor("CreateRequest")).toBe(1);

    const row = await reload(lead.id);
    expect(row.jobberClientId).toBe("cli_orphan");
    expect(row.jobberSynced).toBe(true);
    expect(row.jobberPushError).toBeNull();
  });

  it("never mistakes an established customer for a crashed attempt's orphan", async () => {
    // Same name, same phone, same email — but this client has a request on
    // it, so it is somebody's real customer record. The retry must make a
    // NEW client rather than quietly merge the enquiry onto it.
    const lead = await makeLead({
      jobberPushError: "Jobber timed out",
      jobberPushErrorAt: new Date(),
    });
    respond = happyJobber({
      orphanClients: [
        {
          id: "cli_established",
          name: "Nora Fields",
          emails: [{ address: lead.email }],
          phones: [{ number: "+17805550199", friendly: "(780) 555-0199" }],
          requests: { nodes: [{ id: "req_history" }] },
          clientProperties: CLIENT_WITH_PROPERTY.clientProperties,
        },
      ],
    });

    const result = await pushLeadToJobber(await company(), lead);
    expect(result.status).toBe("synced");
    expect(countFor("clientCreate")).toBe(1);
    const row = await reload(lead.id);
    expect(row.jobberClientId).toBe("cli_lead1");
    expect(row.jobberClientId).not.toBe("cli_established");
  });
});

describe("a booking converted from a pushed lead", () => {
  async function makeBooking(over: Record<string, unknown> = {}) {
    const [row] = await db
      .insert(bookingsTable)
      .values({
        companyId,
        customerName: "Nora Fields",
        customerPhone: "(780) 555-0199",
        customerAddress: "12 Maple Crescent",
        addressCity: "Edmonton",
        addressProvince: "AB",
        addressPostal: "T5J 0N3",
        service: "Deep clean",
        scheduledFor: new Date("2026-08-22T16:00:00Z"),
        status: "pending",
        ...over,
      })
      .returning();
    return row!;
  }

  it("adopts the lead's client and request instead of minting a second pair", async () => {
    const lead = await makeLead();
    await pushLeadToJobber(await company(), lead);
    calls.length = 0;

    // An older phone build creates the booking bare — only leadId. The push
    // must still find the lead's Jobber state before touching Jobber.
    const booking = await makeBooking({ leadId: lead.id });
    await pushBookingToJobber(await company(), booking);

    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("CreateRequest")).toBe(0);
    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, booking.id));
    expect(row!.jobberSynced).toBe(true);
    expect(row!.jobberJobId).toBe("req_lead1");
    expect(row!.jobberClientId).toBe("cli_lead1");
    expect(row!.jobberWebUri).toBe("https://jobber/req_lead1");
    // Outbound columns only: adopted, not imported — it can still quote and
    // schedule, and the request pull is what stamps jobberSyncedRequestId.
    expect(row!.jobberSyncedRequestId).toBeNull();
  });

  it("defers to a booking the moment one exists, even before convert flips the status", async () => {
    // The desk creates the booking BEFORE calling convert, so there is a
    // window where the lead still reads "new" but a booking already owns
    // the Jobber sync. A lead push landing in that window must stand down.
    const lead = await makeLead();
    await makeBooking({ leadId: lead.id });

    const result = await pushLeadToJobber(await company(), lead);

    expect(result.status).toBe("skipped");
    expect(calls.length).toBe(0);
    expect((await reload(lead.id)).jobberSynced).toBe(false);
  });

  it("a delayed lead push after the booking's own push adds nothing — one client, one request", async () => {
    // The reviewer's race: the automatic lead push is scheduled at submit
    // but only reaches the queue after the desk has already created the
    // booking and its push has run. The stale Lead snapshot the scheduler
    // captured must not produce a second client or request.
    const staleLead = await makeLead();
    const booking = await makeBooking({ leadId: staleLead.id });
    const pushed = await pushBookingToJobber(await company(), booking);
    expect(pushed.status).toBe("synced");
    expect(countFor("clientCreate")).toBe(1);
    expect(countFor("CreateRequest")).toBe(1);

    // Now the delayed automatic push arrives, holding the pre-booking
    // snapshot of the lead.
    await scheduleLeadJobberPush(await company(), staleLead);

    // Still exactly one of each — the lead push stood down.
    expect(countFor("clientCreate")).toBe(1);
    expect(countFor("CreateRequest")).toBe(1);
    const after = await reload(staleLead.id);
    expect(after.jobberSynced).toBe(false);
    expect(after.jobberRequestId).toBeNull();
    expect(after.jobberPushError).toBeNull();
  });

  it("reuses the lead's client when its push had failed after creating it", async () => {
    respond = happyJobber({ failRequest: true });
    const lead = await makeLead();
    await pushLeadToJobber(await company(), lead);

    calls.length = 0;
    respond = happyJobber();
    const booking = await makeBooking({ leadId: lead.id });
    const result = await pushBookingToJobber(await company(), booking);

    expect(result.status).toBe("synced");
    // The half-finished lead push left a client behind; the booking raises
    // its request on that same customer.
    expect(countFor("clientCreate")).toBe(0);
    expect(countFor("CreateRequest")).toBe(1);
    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, booking.id));
    expect(row!.jobberClientId).toBe("cli_lead1");
    expect(row!.jobberSynced).toBe(true);
  });
});
