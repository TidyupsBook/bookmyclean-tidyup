import { Router, type IRouter } from "express";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db, clientsTable, type Client } from "@workspace/db";
import {
  CreateClientBody,
  CreateClientResponse,
  UpdateClientBody,
  UpdateClientParams,
  UpdateClientResponse,
  ListClientsResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";
import { toE164 } from "../lib/quo";
import { syncContactToQuo } from "../services/quoContactSync";
import { relinkClientCallers } from "../services/callerDirectory";

const router: IRouter = Router();

router.use(requireAuth);

/**
 * The client directory is names, numbers and home addresses — same audience
 * as Calls and Leads. Guards are per-route, never router-level: routers all
 * mount at `/`, and a `router.use(requireRole)` here would guard other
 * routers' routes too.
 */
const dispatchOnly = requireRole("owner", "dispatcher");

function serializeClient(c: Client) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    phoneE164: c.phoneE164,
    tag: c.tag ?? null,
    email: c.email,
    streetAddress: c.streetAddress,
    city: c.city,
    province: c.province,
    postalCode: c.postalCode,
    jobberClientId: c.jobberClientId,
    source: c.source,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/clients", dispatchOnly, async (req, res): Promise<void> => {
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.json(ListClientsResponse.parse([]));
    return;
  }
  // The whole directory in one response, A→Z; the page searches locally.
  // A cleaning company's client list is hundreds, not millions.
  const rows = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.companyId, company.id))
    .orderBy(asc(clientsTable.name), asc(clientsTable.id));
  res.json(ListClientsResponse.parse(rows.map(serializeClient)));
});

router.post("/clients", dispatchOnly, async (req, res): Promise<void> => {
  const body = CreateClientBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.status(404).json({ error: "No company yet" });
    return;
  }
  const phone = body.data.phone?.trim() || null;
  const phoneE164 = phone ? toE164(phone) : null;
  if (phone && !phoneE164) {
    res.status(400).json({
      error: "Enter a valid dialable phone number, or leave it blank.",
    });
    return;
  }
  const values = {
    name: body.data.name.trim(),
    phone,
    phoneE164,
    email: body.data.email?.trim() || null,
    streetAddress: body.data.streetAddress?.trim() || null,
    city: body.data.city?.trim() || null,
    province: body.data.province?.trim() || null,
    postalCode: body.data.postalCode?.trim() || null,
  };
  const result = await db.transaction(async (tx) => {
    if (phoneE164) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${company.id}::int, hashtext(${phoneE164})::int)`,
      );
    }
    const [existing] = phoneE164
      ? await tx
          .select()
          .from(clientsTable)
          .where(
            and(
              eq(clientsTable.companyId, company.id),
              eq(clientsTable.phoneE164, phoneE164),
            ),
          )
          .limit(1)
      : [];
    if (existing) return { collision: true as const, client: null };
    const [saved] = await tx
      .insert(clientsTable)
      .values({
        companyId: company.id,
        ...values,
        source: "manual",
      })
      .returning();
    return { collision: false as const, client: saved! };
  });
  if (result.collision) {
    res.status(409).json({
      error: "A client with that phone number already exists.",
    });
    return;
  }
  const client = result.client;
  await relinkClientCallers(client);
  res.status(201).json(CreateClientResponse.parse(serializeClient(client)));
  void syncContactToQuo(company, client);
});

router.patch("/clients/:id", dispatchOnly, async (req, res): Promise<void> => {
  const params = UpdateClientParams.safeParse(req.params);
  const body = UpdateClientBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: !params.success ? params.error.message : body.error!.message,
    });
    return;
  }
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  const changes = { ...body.data };
  if (Object.keys(changes).length === 0) {
    res.status(400).json({ error: "Enter at least one change." });
    return;
  }
  const phone = changes.phone;
  if (phone?.trim() && !toE164(phone)) {
    res.status(400).json({
      error: "Enter a valid dialable phone number, or leave it blank.",
    });
    return;
  }
  const update: Partial<typeof clientsTable.$inferInsert> = {
    ...changes,
    ...(phone !== undefined
      ? {
          phone: phone?.trim() || null,
          phoneE164: phone?.trim() ? toE164(phone) : null,
        }
      : {}),
  };
  const result = await db.transaction(async (tx) => {
    const newPhoneE164 =
      typeof update.phoneE164 === "string" ? update.phoneE164 : null;
    if (newPhoneE164) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${company.id}::int, hashtext(${newPhoneE164})::int)`,
      );
      const [collision] = await tx
        .select({ id: clientsTable.id })
        .from(clientsTable)
        .where(
          and(
            eq(clientsTable.companyId, company.id),
            eq(clientsTable.phoneE164, newPhoneE164),
            ne(clientsTable.id, params.data.id),
          ),
        )
        .limit(1);
      if (collision) return { collision: true as const, client: null };
    }
    const [saved] = await tx
      .update(clientsTable)
      .set(update)
      .where(
        and(
          eq(clientsTable.id, params.data.id),
          eq(clientsTable.companyId, company.id),
        ),
      )
      .returning();
    return { collision: false as const, client: saved ?? null };
  });
  if (result.collision) {
    res.status(409).json({
      error: "Another client already uses that phone number.",
    });
    return;
  }
  const client = result.client;
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  await relinkClientCallers(client);
  res.json(UpdateClientResponse.parse(serializeClient(client)));
  void syncContactToQuo(company, client);
});

export default router;
