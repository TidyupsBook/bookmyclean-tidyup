import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  callsTable,
  bookingsTable,
  servicesTable,
  activityTable,
  type Call,
} from "@workspace/db";
import {
  ListCallsQueryParams,
  ListCallsResponse,
  GetCallParams,
  GetCallResponse,
  GetCallBookingDraftParams,
  GetCallBookingDraftResponse,
  DraftBookingFromTextBody,
  DraftBookingFromTextResponse,
  SimulateTestCallResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import {
  getCompanyForUser,
  companyQuoKey,
  isQuoAuthError,
  setQuoNeedsReauth,
} from "../lib/company";
import { buildSimulatedCall } from "../lib/simulateCall";
import { buildBookingDraft, buildDraftFromText } from "../lib/bookingDraft";
import { backfillCalls } from "../lib/quoIngest";
import { listPhoneNumbers } from "../lib/quo";
import { SyncCallsFromQuoResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.use(requireAuth);

function serializeCall(c: Call) {
  return {
    id: c.id,
    callerName: c.callerName,
    callerPhone: c.callerPhone,
    status: c.status,
    serviceRequested: c.serviceRequested,
    preferredTime: c.preferredTime,
    startedAt: c.startedAt.toISOString(),
    durationSeconds: c.durationSeconds,
    isTest: c.isTest,
    bookingId: c.bookingId,
    direction: c.direction,
    summary: c.summary,
    quoCallId: c.quoCallId,
  };
}

function serializeCallDetail(c: Call) {
  return {
    ...serializeCall(c),
    recordingUrl: c.recordingUrl,
    transcript: c.transcript,
    extractedAnswers: c.extractedAnswers,
  };
}

router.get(
  "/calls",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.json(ListCallsResponse.parse([]));
      return;
    }
    const query = ListCallsQueryParams.safeParse(req.query);
    const status = query.success ? query.data.status : undefined;

    const where = status
      ? and(eq(callsTable.companyId, company.id), eq(callsTable.status, status))
      : eq(callsTable.companyId, company.id);

    const calls = await db
      .select()
      .from(callsTable)
      .where(where)
      .orderBy(desc(callsTable.startedAt));

    res.json(ListCallsResponse.parse(calls.map(serializeCall)));
  },
);

router.post(
  "/calls/sync",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    if (!company.quoConnected || company.quoNumberIds.length === 0) {
      res.status(400).json({ error: "Connect Quo and choose lines first" });
      return;
    }
    const quoKey = companyQuoKey(company);
    if (!quoKey) {
      res
        .status(400)
        .json({ error: "Reconnect your Quo account to sync calls" });
      return;
    }

    try {
      const numbers = await listPhoneNumbers(quoKey);
      const ourNumbers = new Set(numbers.map((n) => n.number));
      const result = await backfillCalls(quoKey, company, ourNumbers);
      res.json(
        SyncCallsFromQuoResponse.parse({
          ...result,
          message:
            result.callsImported === 0
              ? "No new calls found on the watched lines."
              : `Imported ${result.callsImported} call${result.callsImported === 1 ? "" : "s"} and ${result.transcriptsImported} transcript${result.transcriptsImported === 1 ? "" : "s"}.`,
        }),
      );
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "Quo sync failed");
      if (isQuoAuthError(err)) {
        await setQuoNeedsReauth(company, true).catch(() => {});
        res.status(502).json({
          error:
            "Quo rejected your API key. Reconnect Quo from the setup page to resume syncing.",
        });
        return;
      }
      res.status(502).json({ error: "Could not sync calls from Quo" });
    }
  },
);

router.get(
  "/calls/:id",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = GetCallParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    const [call] = await db
      .select()
      .from(callsTable)
      .where(
        and(
          eq(callsTable.id, params.data.id),
          eq(callsTable.companyId, company.id),
        ),
      );
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json(GetCallResponse.parse(serializeCallDetail(call)));
  },
);

/**
 * What the New Booking form pre-fills from a call. Declared after
 * `/calls/:id` — Express matches in order and the paths don't collide, but
 * keeping them together makes the pair obvious.
 */
router.get(
  "/calls/:id/booking-draft",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = GetCallBookingDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    const [call] = await db
      .select()
      .from(callsTable)
      .where(
        and(
          eq(callsTable.id, params.data.id),
          eq(callsTable.companyId, company.id),
        ),
      );
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json(GetCallBookingDraftResponse.parse(buildBookingDraft(call)));
  },
);

/**
 * The same thing for a call Quo hasn't transcribed yet — the dispatcher's own
 * microphone, while the customer is still talking. Nothing is saved: this only
 * reads text and hands back suggestions.
 */
router.post(
  "/booking-drafts",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const parsed = DraftBookingFromTextBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    res.json(
      DraftBookingFromTextResponse.parse(buildDraftFromText(parsed.data.text)),
    );
  },
);

router.post(
  "/calls/simulate",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    const services = await db
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.companyId, company.id));

    const sim = buildSimulatedCall(company, services);
    const callerPhone = `(555) ${100 + Math.floor(Math.random() * 900)}-${1000 + Math.floor(Math.random() * 9000)}`;

    // Create the booking that the AI extracted from the call
    const scheduledFor = new Date();
    scheduledFor.setDate(
      scheduledFor.getDate() + 3 + Math.floor(Math.random() * 5),
    );
    scheduledFor.setHours(10, 0, 0, 0);

    const [booking] = await db
      .insert(bookingsTable)
      .values({
        companyId: company.id,
        customerName: sim.ctx.callerName,
        customerPhone: callerPhone,
        customerAddress: sim.ctx.address,
        service: sim.service ? sim.service.name : "Deep Clean",
        scheduledFor,
        status: "pending",
      })
      .returning();

    const [call] = await db
      .insert(callsTable)
      .values({
        companyId: company.id,
        callerName: sim.ctx.callerName,
        callerPhone,
        status: "booked",
        serviceRequested: sim.service ? sim.service.name : "Deep Clean",
        preferredTime: sim.ctx.preferredTime,
        startedAt: new Date(),
        durationSeconds: sim.durationSeconds,
        isTest: true,
        transcript: sim.transcript,
        extractedAnswers: sim.extractedAnswers,
        bookingId: booking!.id,
      })
      .returning();

    await db
      .update(bookingsTable)
      .set({ callId: call!.id })
      .where(eq(bookingsTable.id, booking!.id));

    await db.insert(activityTable).values([
      {
        companyId: company.id,
        type: "test_call",
        message: `Test call answered — ${sim.ctx.callerName} asked about ${call!.serviceRequested}.`,
      },
      {
        companyId: company.id,
        type: "booking_created",
        message: `Booking created for ${sim.ctx.callerName} (${call!.serviceRequested}).`,
      },
    ]);

    res
      .status(201)
      .json(SimulateTestCallResponse.parse(serializeCallDetail(call!)));
  },
);

export default router;
