import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, servicesTable } from "@workspace/db";
import {
  ListServicesResponse,
  CreateServiceBody,
  CreateServiceResponse,
  UpdateServiceParams,
  UpdateServiceBody,
  UpdateServiceResponse,
  DeleteServiceParams,
  ImportSuggestedServicesResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";

const router: IRouter = Router();

export const SUGGESTED_SERVICES = [
  { name: "1Bed 1Bath Moveout Cleaning", price: 200 },
  { name: "2Bed 2Bath Moveout Cleaning", price: 105 },
  { name: "Standard Home Cleaning", price: 150 },
  { name: "Deep Cleaning Service", price: 300 },
  { name: "Move-Out Cleaning", price: 400 },
  { name: "3Bed 3Bath Moveout Cleaning", price: 105 },
  { name: "1Bed 1Bath Deep Cleaning", price: null },
  { name: "2Bed 1Bath Deep Cleaning", price: null },
  { name: "3Bed 1Bath Deep Cleaning", price: null },
  { name: "2Bed 2Bath Deep Cleaning", price: null },
  { name: "3Bed 2Bath Deep Cleaning", price: null },
  { name: "3Bed 3Bath Deep Cleaning", price: null },
  { name: "2Bed 3Bath Moveout Cleaning", price: null },
  { name: "3Bed 1Bath Moveout Cleaning", price: null },
  { name: "3Bed 2Bath Move In Cleaning", price: null },
  { name: "2Bed 2Bath Move In Cleaning", price: null },
  { name: "3Bed 3Bath Move In Cleaning", price: null },
  { name: "Basic Initial Cleaning", price: null },
  { name: "Bathroom Cleaning", price: null },
  { name: "Steam Cleaning", price: null },
] as const;

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

router.post(
  "/services/suggested-catalog",
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const company = await getCompanyForUser(req.userId!);
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      // Two tabs can press the button together. Serialize this one company's
      // import so "add missing names" cannot create the same service twice.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${company.id}, 20260725)`,
      );
      const existing = await tx
        .select()
        .from(servicesTable)
        .where(eq(servicesTable.companyId, company.id));
      const existingNames = new Set(
        existing.map((service) => service.name.trim().toLocaleLowerCase()),
      );
      const missing = SUGGESTED_SERVICES.filter(
        (service) => !existingNames.has(service.name.toLocaleLowerCase()),
      );
      const created =
        missing.length === 0
          ? []
          : await tx
              .insert(servicesTable)
              .values(
                missing.map((service) => ({
                  companyId: company.id,
                  name: service.name,
                  priceMin: service.price,
                  priceMax: service.price,
                })),
              )
              .returning();
      return { created: created.length, services: [...existing, ...created] };
    });

    res.json(ImportSuggestedServicesResponse.parse(result));
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
