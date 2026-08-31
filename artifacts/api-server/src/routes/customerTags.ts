import { Router, type IRouter } from "express";
import {
  db,
  bookingsTable,
  callsTable,
  clientsTable,
  jobberInvoicesTable,
  leadsTable,
} from "@workspace/db";
import {
  UpdateCustomerTagBody,
  UpdateCustomerTagResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";
import { setCustomerTag, type CustomerTagKind } from "../lib/customerTag";
import { and, eq } from "drizzle-orm";

const router: IRouter = Router();
router.use(requireAuth);
const dispatchOnly = requireRole("owner", "dispatcher");
const kinds = new Set<CustomerTagKind>([
  "lead",
  "call",
  "booking",
  "invoice",
  "client",
]);

router.patch(
  "/customer-tags/:kind/:id",
  dispatchOnly,
  async (req, res): Promise<void> => {
    const kind = req.params.kind as CustomerTagKind;
    const id = Number(req.params.id);
    const body = UpdateCustomerTagBody.safeParse(req.body);
    if (!kinds.has(kind) || !Number.isInteger(id) || id <= 0 || !body.success) {
      res.status(400).json({ error: "Invalid customer tag request" });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    const table =
      kind === "lead"
        ? leadsTable
        : kind === "call"
          ? callsTable
          : kind === "booking"
            ? bookingsTable
            : kind === "invoice"
              ? jobberInvoicesTable
              : clientsTable;
    const [exists] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.companyId, company.id)))
      .limit(1);
    if (!exists) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    await setCustomerTag(company.id, { kind, id }, body.data.tag);
    res.json(UpdateCustomerTagResponse.parse({ kind, id, tag: body.data.tag }));
  },
);

export default router;
