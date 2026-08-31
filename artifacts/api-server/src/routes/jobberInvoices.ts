import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, jobberInvoicesTable, type JobberInvoiceRow } from "@workspace/db";
import { ListJobberInvoicesResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";

const router: IRouter = Router();

router.use(requireAuth);

/**
 * Invoices carry customer names, addresses and money — owner/dispatcher
 * only, same audience as Quotes. Guards are per-route, never router-level:
 * routers all mount at `/`, and a `router.use(requireRole)` here would guard
 * other routers' routes too.
 */
const dispatchOnly = requireRole("owner", "dispatcher");

function serializeInvoice(inv: JobberInvoiceRow) {
  return {
    id: inv.id,
    jobberInvoiceId: inv.jobberInvoiceId,
    invoiceNumber: inv.invoiceNumber,
    subject: inv.subject,
    clientName: inv.clientName,
    clientPhone: inv.clientPhone,
    tag: inv.tag ?? null,
    propertyAddress: inv.propertyAddress,
    status: inv.status,
    totalCents: inv.totalCents,
    balanceCents: inv.balanceCents,
    jobberWebUri: inv.jobberWebUri,
    issuedAt: inv.issuedAt?.toISOString() ?? null,
    dueAt: inv.dueAt?.toISOString() ?? null,
    jobberCreatedAt: inv.jobberCreatedAt?.toISOString() ?? null,
    lastSyncedAt: inv.lastSyncedAt.toISOString(),
  };
}

router.get(
  "/jobber-invoices",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.json(ListJobberInvoicesResponse.parse([]));
      return;
    }
    // Newest invoice first, by when it was written in Jobber; the mirror's
    // own insert time is only a fallback for rows Jobber sent without a date.
    const rows = await db
      .select()
      .from(jobberInvoicesTable)
      .where(eq(jobberInvoicesTable.companyId, company.id))
      .orderBy(
        desc(
          sql`COALESCE(${jobberInvoicesTable.jobberCreatedAt}, ${jobberInvoicesTable.createdAt})`,
        ),
        desc(jobberInvoicesTable.id),
      );
    res.json(ListJobberInvoicesResponse.parse(rows.map(serializeInvoice)));
  },
);

export default router;
