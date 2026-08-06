import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, servicesTable } from "@workspace/db";
import {
  ListServicesResponse,
  CreateServiceBody,
  CreateServiceResponse,
  UpdateServiceParams,
  UpdateServiceBody,
  UpdateServiceResponse,
  DeleteServiceParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";

const router: IRouter = Router();

router.use(requireAuth);

router.get(
  "/services",
  requireRole("owner", "dispatcher"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.json(ListServicesResponse.parse([]));
      return;
    }
    const services = await db
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.companyId, company.id))
      .orderBy(servicesTable.id);
    res.json(ListServicesResponse.parse(services));
  },
);

router.post(
  "/services",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const parsed = CreateServiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const [service] = await db
      .insert(servicesTable)
      .values({ ...parsed.data, companyId: company.id })
      .returning();
    res.status(201).json(CreateServiceResponse.parse(service));
  },
);

router.patch(
  "/services/:id",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const params = UpdateServiceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateServiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const [service] = await db
      .update(servicesTable)
      .set(parsed.data)
      .where(
        and(
          eq(servicesTable.id, params.data.id),
          eq(servicesTable.companyId, company.id),
        ),
      )
      .returning();
    if (!service) {
      res.status(404).json({ error: "Service not found" });
      return;
    }
    res.json(UpdateServiceResponse.parse(service));
  },
);

router.delete(
  "/services/:id",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const params = DeleteServiceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const [service] = await db
      .delete(servicesTable)
      .where(
        and(
          eq(servicesTable.id, params.data.id),
          eq(servicesTable.companyId, company.id),
        ),
      )
      .returning();
    if (!service) {
      res.status(404).json({ error: "Service not found" });
      return;
    }
    res.sendStatus(204);
  },
);

export default router;
