import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import {
  db,
  callsTable,
  bookingsTable,
  activityTable,
  pendingTextsTable,
  leadsTable,
} from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetRecentActivityResponse,
  ResendGivenUpTextBody,
  ResendGivenUpTextResponse,
} from "@workspace/api-zod";
import { deliverPendingText } from "../lib/pendingTexts";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole, getCaller } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";
import { redactForCrew } from "../lib/crewRedaction";
import { bookingHistoryFloor, companyDayBounds } from "../lib/dayBounds";
import { computeQuoteTotals } from "../lib/quotes";
import { roundMoney } from "@workspace/pricing";
import type { Booking, Company } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * What a completed job earned: the total the customer was actually promised
 * (frozen when the quote text went out), else the total derived from the
 * stored pricing inputs. A job that was never priced counts as zero rather
 * than being guessed at.
 */
function bookingRevenue(company: Company, booking: Booking): number {
  if (booking.quoteSentTotals) return booking.quoteSentTotals.total;
  return computeQuoteTotals(company, booking).total;
}

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
          upcomingBookings: 0,
          completedThisMonth: 0,
          totalBookings: 0,
          bookingsThisMonth: 0,
          canceledBookings: 0,
          revenueThisMonth: null,
          newLeads: 0,
        }),
      );
      return;
    }

    // Dashboard stats are computed over a recent rolling window, not all time.
    // Loading every call or booking ever is the main cause of dashboard
    // slowness as history accumulates — these windows are enough for every
    // metric the summary exposes.
    //
    // Calls: 90-day rolling window. callsToday/callsThisWeek sit well inside
    // it, and answeredRate/avgCallSeconds over the last quarter is more
    // actionable than an all-time average that includes the first noisy weeks.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const calls = await db
      .select()
      .from(callsTable)
      .where(
        and(
          eq(callsTable.companyId, company.id),
          gte(callsTable.startedAt, ninetyDaysAgo),
        ),
      );

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // "This month" is the calendar month where the company lives, not UTC —
    // an Edmonton owner's July 31st 9pm job is July revenue, not August.
    const today = companyDayBounds(undefined, company.timezone).date;
    const monthStart = companyDayBounds(
      `${today.slice(0, 7)}-01`,
      company.timezone,
    ).start;

    // Bookings: counted in SQL, never loaded as rows — these tallies span the
    // whole history floor onward (so they match the list the owner can
    // scroll), and pulling every row across the wire is exactly what makes
    // the dashboard crawl once years of jobs pile up. Aggregates stay cheap
    // no matter how much history accumulates.
    const [bookingAgg] = await db
      .select({
        totalBookings: sql<number>`count(*)::int`,
        bookingsThisWeek: sql<number>`count(*) filter (where ${bookingsTable.createdAt} >= ${weekAgo})::int`,
        bookingsThisMonth: sql<number>`count(*) filter (where ${bookingsTable.createdAt} >= ${monthStart})::int`,
        pendingBookings: sql<number>`count(*) filter (where ${bookingsTable.status} = 'pending')::int`,
        canceledBookings: sql<number>`count(*) filter (where ${bookingsTable.status} = 'canceled')::int`,
        jobberSyncedCount: sql<number>`count(*) filter (where ${bookingsTable.jobberSynced})::int`,
        upcomingBookings: sql<number>`count(*) filter (where ${bookingsTable.scheduledFor} >= ${now} and ${bookingsTable.status} in ('pending', 'confirmed'))::int`,
      })
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, company.id),
          gte(
            bookingsTable.scheduledFor,
            bookingHistoryFloor(company.timezone),
          ),
        ),
      );

    const callsToday = calls.filter((c) => c.startedAt >= startOfDay).length;
    const callsThisWeek = calls.filter((c) => c.startedAt >= weekAgo).length;
    const answered = calls.filter((c) => c.status !== "missed").length;
    const answeredRate =
      calls.length > 0 ? Math.round((answered / calls.length) * 100) / 100 : 0;
    const avgCallSeconds =
      calls.length > 0
        ? Math.round(
            calls.reduce((s, c) => s + c.durationSeconds, 0) / calls.length,
          )
        : 0;

    // Revenue needs per-booking pricing inputs, so this one loads rows — but
    // only completed jobs inside the current month, a bounded window.
    const completedThisMonth = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, company.id),
          eq(bookingsTable.status, "completed"),
          gte(bookingsTable.scheduledFor, monthStart),
        ),
      );

    // Crew see counts, never money — same rule as the activity feed below.
    const caller = await getCaller(req);
    const revenueThisMonth =
      caller.role === "cleaner"
        ? null
        : roundMoney(
            completedThisMonth.reduce(
              (sum, b) => sum + bookingRevenue(company, b),
              0,
            ),
          );

    // Sheet leads still waiting for review — the dashboard tile's number.
    // Crew never see the Leads inbox (the API refuses them), so they don't
    // get its count either: always 0 for cleaners, no tile to click.
    const newLeads =
      caller.role === "cleaner"
        ? []
        : await db
            .select({ id: leadsTable.id })
            .from(leadsTable)
            .where(
              and(
                eq(leadsTable.companyId, company.id),
                eq(leadsTable.status, "new"),
              ),
            );

    res.json(
      GetDashboardSummaryResponse.parse({
        callsToday,
        callsThisWeek,
        bookingsThisWeek: bookingAgg?.bookingsThisWeek ?? 0,
        answeredRate,
        avgCallSeconds,
        pendingBookings: bookingAgg?.pendingBookings ?? 0,
        jobberSyncedCount: bookingAgg?.jobberSyncedCount ?? 0,
        upcomingBookings: bookingAgg?.upcomingBookings ?? 0,
        completedThisMonth: completedThisMonth.length,
        totalBookings: bookingAgg?.totalBookings ?? 0,
        bookingsThisMonth: bookingAgg?.bookingsThisMonth ?? 0,
        canceledBookings: bookingAgg?.canceledBookings ?? 0,
        revenueThisMonth,
        newLeads: newLeads.length,
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
          id: i.id,
          type: i.type,
          message: redact ? redactForCrew(i.message) : i.message,
          occurredAt: i.occurredAt.toISOString(),
          canResendText:
            !redact && i.type === "text_given_up" && i.textPayload != null,
          ...(!redact &&
          i.type === "text_given_up" &&
          i.textPayload?.toPhone != null
            ? { resendPhone: i.textPayload.toPhone }
            : {}),
          ...(i.callId != null ? { callId: i.callId } : {}),
          ...(i.bookingId != null ? { bookingId: i.bookingId } : {}),
        })),
      ),
    );
  },
);

// Confirm-and-resend for a dropped text. The conditional update that nulls the
// payload is the claim: only the request that actually cleared it queues a
// text, so a double submit (or two dispatchers at once) can't double-text.
// Crew are excluded — the payload quotes phone numbers verbatim.
router.post(
  "/dashboard/activity/:id/resend-text",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    const id = Number(req.params.id);
    if (!company || !Number.isInteger(id)) {
      res.status(404).json({ error: "No text to resend" });
      return;
    }
    const input = ResendGivenUpTextBody.safeParse(req.body);
    if (!input.success) {
      res
        .status(400)
        .json({ error: "Enter a valid phone number in E.164 format." });
      return;
    }
    const [entry] = await db
      .select()
      .from(activityTable)
      .where(
        and(eq(activityTable.id, id), eq(activityTable.companyId, company.id)),
      );
    const payload = entry?.type === "text_given_up" ? entry.textPayload : null;
    if (!payload) {
      res.status(404).json({ error: "No text to resend" });
      return;
    }
    // Claim the payload and create the durable queue row atomically: if the
    // insert fails the claim rolls back too, so the entry stays resendable
    // and the owner never gets a "queued" answer for a text that was lost.
    // The queue row gets a fresh createdAt — the 3-day expiry clock restarts
    // now. Delivery is only attempted after the row is committed; a send
    // failure re-inserts it for the hourly sweep, as with any owed text.
    let queued;
    try {
      queued = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(activityTable)
          .set({ textPayload: null })
          .where(
            and(eq(activityTable.id, id), isNotNull(activityTable.textPayload)),
          )
          .returning({ id: activityTable.id });
        if (claimed.length === 0) return null;
        const [row] = await tx
          .insert(pendingTextsTable)
          .values({
            companyId: company.id,
            toPhone: input.data.toPhone,
            kind: payload.kind,
            content: payload.content,
          })
          .returning();
        return row!;
      });
    } catch (err) {
      logger.error(
        { companyId: company.id, activityId: id, err },
        "[dashboard] could not re-queue given-up text; entry left resendable",
      );
      res.status(500).json({ error: "Could not re-queue the text" });
      return;
    }
    if (!queued) {
      res.status(404).json({ error: "No text to resend" });
      return;
    }
    // Best effort immediate send; on failure the row stays for the sweep.
    await deliverPendingText(company, queued);
    res.json(ResendGivenUpTextResponse.parse({ queued: true }));
  },
);

export default router;
