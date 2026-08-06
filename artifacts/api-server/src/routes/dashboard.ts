import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, callsTable, bookingsTable, activityTable } from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetRecentActivityResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole, getCaller } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";
import { redactForCrew } from "../lib/crewRedaction";

const router: IRouter = Router();

router.use(requireAuth);

// Headline counts only — no customer names, phone numbers or money — so crew
// may read them. The activity feed below is a different matter.
router.get(
  "/dashboard/summary",
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.json(
        GetDashboardSummaryResponse.parse({
          callsToday: 0,
          callsThisWeek: 0,
          bookingsThisWeek: 0,
          answeredRate: 0,
          avgCallSeconds: 0,
          pendingBookings: 0,
          jobberSyncedCount: 0,
        }),
      );
      return;
    }

    const calls = await db
      .select()
      .from(callsTable)
      .where(eq(callsTable.companyId, company.id));
    const bookings = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.companyId, company.id));

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const callsToday = calls.filter((c) => c.startedAt >= startOfDay).length;
    const callsThisWeek = calls.filter((c) => c.startedAt >= weekAgo).length;
    const bookingsThisWeek = bookings.filter(
      (b) => b.createdAt >= weekAgo,
    ).length;
    const answered = calls.filter((c) => c.status !== "missed").length;
    const answeredRate =
      calls.length > 0 ? Math.round((answered / calls.length) * 100) / 100 : 0;
    const avgCallSeconds =
      calls.length > 0
        ? Math.round(
            calls.reduce((s, c) => s + c.durationSeconds, 0) / calls.length,
          )
        : 0;

    res.json(
      GetDashboardSummaryResponse.parse({
        callsToday,
        callsThisWeek,
        bookingsThisWeek,
        answeredRate,
        avgCallSeconds,
        pendingBookings: bookings.filter((b) => b.status === "pending").length,
        jobberSyncedCount: bookings.filter((b) => b.jobberSynced).length,
      }),
    );
  },
);

// Crew may follow along, but these messages quote customer phone numbers and
// deposit amounts verbatim — neither of which crew are shown anywhere else in
// the app — so those are masked out for cleaners before the feed leaves here.
router.get(
  "/dashboard/activity",
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.json(GetRecentActivityResponse.parse([]));
      return;
    }
    const items = await db
      .select()
      .from(activityTable)
      .where(eq(activityTable.companyId, company.id))
      .orderBy(desc(activityTable.occurredAt))
      .limit(20);

    const caller = await getCaller(req);
    const redact = caller.role === "cleaner";

    res.json(
      GetRecentActivityResponse.parse(
        items.map((i) => ({
          ...i,
          message: redact ? redactForCrew(i.message) : i.message,
          occurredAt: i.occurredAt.toISOString(),
        })),
      ),
    );
  },
);

export default router;
