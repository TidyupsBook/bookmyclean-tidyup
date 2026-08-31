import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { callersTable, callsTable, db } from "@workspace/db";
import {
  ListCallerCallsParams,
  ListCallerCallsResponse,
  ListCallersResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";

const router: IRouter = Router();
router.use(requireAuth);
const dispatchOnly = requireRole("owner", "dispatcher");

function serializeCall(call: typeof callsTable.$inferSelect) {
  return {
    id: call.id,
    callerName: call.callerName,
    callerPhone: call.callerPhone,
    status: call.status,
    serviceRequested: call.serviceRequested,
    preferredTime: call.preferredTime,
    startedAt: call.startedAt.toISOString(),
    durationSeconds: call.durationSeconds,
    isTest: call.isTest,
    bookingId: call.bookingId,
    direction: call.direction,
    summary: call.summary,
    quoCallId: call.quoCallId,
    tag: call.tag,
  };
}

router.get("/callers", dispatchOnly, async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.json(ListCallersResponse.parse([]));
    return;
  }
  const rows = await db
    .select()
    .from(callersTable)
    .where(eq(callersTable.companyId, company.id))
    .orderBy(desc(callersTable.latestCallAt));
  res.json(
    ListCallersResponse.parse(
      rows.map((row) => ({
        id: row.id,
        phone: row.phone,
        phoneE164: row.phoneE164,
        bestName: row.bestName,
        firstCallAt: row.firstCallAt.toISOString(),
        latestCallAt: row.latestCallAt.toISOString(),
        callCount: row.callCount,
        clientId: row.clientId,
        knownClient: row.clientId !== null,
        quoContactId: row.quoContactId,
      })),
    ),
  );
});

router.get(
  "/callers/:id/calls",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const params = ListCallerCallsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Caller not found" });
      return;
    }
    const [caller] = await db
      .select({ id: callersTable.id })
      .from(callersTable)
      .where(
        and(
          eq(callersTable.id, params.data.id),
          eq(callersTable.companyId, company.id),
        ),
      );
    if (!caller) {
      res.status(404).json({ error: "Caller not found" });
      return;
    }
    const calls = await db
      .select()
      .from(callsTable)
      .where(
        and(
          eq(callsTable.companyId, company.id),
          eq(callsTable.callerId, caller.id),
        ),
      )
      .orderBy(desc(callsTable.startedAt));
    res.json(ListCallerCallsResponse.parse(calls.map(serializeCall)));
  },
);

export default router;
