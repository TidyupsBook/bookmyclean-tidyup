import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, jobberQuotesTable, type JobberQuoteRow } from "@workspace/db";
import { ListJobberQuotesResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";

const router: IRouter = Router();

router.use(requireAuth);

/**
 * Quotes carry customer names, numbers and prices — owner/dispatcher only,
 * same audience as Bookings. Guards are per-route, never router-level:
 * routers all mount at `/`, and a `router.use(requireRole)` here would guard
 * other routers' routes too.
 */
const dispatchOnly = requireRole("owner", "dispatcher");

function serializeQuote(q: JobberQuoteRow) {
  return {
    id: q.id,
    jobberQuoteId: q.jobberQuoteId,
    quoteNumber: q.quoteNumber,
    title: q.title,
    clientName: q.clientName,
    clientPhone: q.clientPhone,
    propertyAddress: q.propertyAddress,
    status: q.status,
    totalCents: q.totalCents,
    jobberWebUri: q.jobberWebUri,
    jobberCreatedAt: q.jobberCreatedAt?.toISOString() ?? null,
    sentAt: q.sentAt?.toISOString() ?? null,
    transitionedAt: q.transitionedAt?.toISOString() ?? null,
    lastSyncedAt: q.lastSyncedAt.toISOString(),
  };
}

router.get("/jobber-quotes", dispatchOnly, async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.json(ListJobberQuotesResponse.parse([]));
    return;
  }
  // Newest quote first, by when it was written in Jobber; the mirror's own
  // insert time is only a fallback for rows Jobber sent without a date.
  const rows = await db
    .select()
    .from(jobberQuotesTable)
    .where(eq(jobberQuotesTable.companyId, company.id))
    .orderBy(
      desc(
        sql`COALESCE(${jobberQuotesTable.jobberCreatedAt}, ${jobberQuotesTable.createdAt})`,
      ),
      desc(jobberQuotesTable.id),
    );
  res.json(ListJobberQuotesResponse.parse(rows.map(serializeQuote)));
});

export default router;
