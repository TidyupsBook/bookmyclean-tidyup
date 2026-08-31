import { Router, type IRouter, type Response } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  savedRoutesTable,
  savedRouteStopsTable,
  teamMembersTable,
} from "@workspace/db";
import {
  ListSavedRoutesResponse,
  CreateSavedRouteBody,
  CreateSavedRouteResponse,
  GetSavedRouteParams,
  GetSavedRouteResponse,
  UpdateSavedRouteParams,
  UpdateSavedRouteBody,
  UpdateSavedRouteResponse,
  DeleteSavedRouteParams,
  AddSavedRouteStopParams,
  AddSavedRouteStopBody,
  AddSavedRouteStopResponse,
  ReorderSavedRouteStopsParams,
  ReorderSavedRouteStopsBody,
  ReorderSavedRouteStopsResponse,
  GetSavedRouteStopParams,
  GetSavedRouteStopResponse,
  UpdateSavedRouteStopParams,
  UpdateSavedRouteStopBody,
  UpdateSavedRouteStopResponse,
  DeleteSavedRouteStopParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";

const router: IRouter = Router();
// This router is mounted at `/`, alongside all other API routers. Applying the
// guard with router.use would guard routers mounted after it as well.
const savedRouteGuards = [requireAuth, requireRole("owner", "dispatcher")];

const parse = <T>(
  result: { success: boolean; data?: T; error?: { message: string } },
  res: Response,
) =>
  result.success
    ? result.data!
    : (res.status(400).json({ error: result.error!.message }), null);

async function routeFor(companyId: number, id: number) {
  const [route] = await db
    .select()
    .from(savedRoutesTable)
    .where(
      and(
        eq(savedRoutesTable.id, id),
        eq(savedRoutesTable.companyId, companyId),
      ),
    );
  return route;
}
async function serialize(
  route: NonNullable<Awaited<ReturnType<typeof routeFor>>>,
) {
  const stops = await db
    .select()
    .from(savedRouteStopsTable)
    .where(eq(savedRouteStopsTable.routeId, route.id))
    .orderBy(asc(savedRouteStopsTable.position));
  return {
    id: route.id,
    name: route.name,
    teamMemberId: route.teamMemberId,
    createdAt: route.createdAt.toISOString(),
    updatedAt: route.updatedAt.toISOString(),
    stops: stops.map(stopJson),
  };
}
async function validMember(companyId: number, id: number) {
  const [member] = await db
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.id, id),
        eq(teamMembersTable.companyId, companyId),
        eq(teamMembersTable.active, true),
      ),
    );
  return member;
}

// prettier-ignore
router.get("/saved-routes", ...savedRouteGuards, async (req, res) => {
  const company = await getCompanyForUser(req.userId!);
  if (!company) return void res.json(ListSavedRoutesResponse.parse([]));
  const routes = await db.select().from(savedRoutesTable).where(eq(savedRoutesTable.companyId, company.id)).orderBy(asc(savedRoutesTable.name));
  res.json(ListSavedRoutesResponse.parse(await Promise.all(routes.map(serialize))));
});
// prettier-ignore
router.post("/saved-routes", ...savedRouteGuards, async (req, res) => {
  const data = parse(CreateSavedRouteBody.safeParse(req.body), res); if (!data) return;
  const company = await getCompanyForUser(req.userId!); if (!company) return void res.status(404).json({ error: "No company yet" });
  if (!await validMember(company.id, data.teamMemberId)) return void res.status(400).json({ error: "Team member is not on your active team" });
  const [route] = await db.insert(savedRoutesTable).values({ companyId: company.id, ...data }).returning();
  res.status(201).json(CreateSavedRouteResponse.parse(await serialize(route!)));
});
// prettier-ignore
router.get("/saved-routes/:id", ...savedRouteGuards, async (req, res) => {
  const p = parse(GetSavedRouteParams.safeParse(req.params), res); if (!p) return;
  const company = await getCompanyForUser(req.userId!); const route = company && await routeFor(company.id, p.id);
  if (!route) return void res.status(404).json({ error: "Saved route not found" });
  res.json(GetSavedRouteResponse.parse(await serialize(route)));
});
// prettier-ignore
router.patch("/saved-routes/:id", ...savedRouteGuards, async (req, res) => {
  const p = parse(UpdateSavedRouteParams.safeParse(req.params), res), data = parse(UpdateSavedRouteBody.safeParse(req.body), res); if (!p || !data) return;
  const company = await getCompanyForUser(req.userId!); if (!company) return void res.status(404).json({ error: "Saved route not found" });
  if (data.teamMemberId !== undefined && !await validMember(company.id, data.teamMemberId)) return void res.status(400).json({ error: "Team member is not on your active team" });
  if (!Object.keys(data).length) return void res.status(400).json({ error: "Nothing to change" });
  const [route] = await db.update(savedRoutesTable).set({ ...data, updatedAt: new Date() }).where(and(eq(savedRoutesTable.id, p.id), eq(savedRoutesTable.companyId, company.id))).returning();
  if (!route) return void res.status(404).json({ error: "Saved route not found" });
  res.json(UpdateSavedRouteResponse.parse(await serialize(route)));
});
// prettier-ignore
router.delete("/saved-routes/:id", ...savedRouteGuards, async (req, res) => {
  const p = parse(DeleteSavedRouteParams.safeParse(req.params), res); if (!p) return;
  const company = await getCompanyForUser(req.userId!); const deleted = company && await db.delete(savedRoutesTable).where(and(eq(savedRoutesTable.id, p.id), eq(savedRoutesTable.companyId, company.id))).returning();
  if (!deleted?.length) return void res.status(404).json({ error: "Saved route not found" }); res.status(204).end();
});
// prettier-ignore
router.post("/saved-routes/:id/stops", ...savedRouteGuards, async (req, res) => {
  const p = parse(AddSavedRouteStopParams.safeParse(req.params), res), data = parse(AddSavedRouteStopBody.safeParse(req.body), res); if (!p || !data) return;
  const company = await getCompanyForUser(req.userId!); const route = company && await routeFor(company.id, p.id); if (!route) return void res.status(404).json({ error: "Saved route not found" });
  const stop = await db.transaction(async (tx) => {
    // Route-local serialization makes appends deterministic under simultaneous
    // requests, without blocking stops on another cleaner's route.
    await tx.execute(
      sql`select pg_advisory_xact_lock(510, ${route.id}::int)`,
    );
    const [{ next }] = await tx
      .select({
        next: sql<number>`coalesce(max(${savedRouteStopsTable.position}), -1) + 1`,
      })
      .from(savedRouteStopsTable)
      .where(eq(savedRouteStopsTable.routeId, route.id));
    const [created] = await tx
      .insert(savedRouteStopsTable)
      .values({
        routeId: route.id,
        position: next,
        ...data,
        address: data.address ?? null,
      })
      .returning();
    return created!;
  });
  res.status(201).json(AddSavedRouteStopResponse.parse(stopJson(stop)));
});
// prettier-ignore
router.put("/saved-routes/:id/stops/reorder", ...savedRouteGuards, async (req, res) => {
  const p = parse(ReorderSavedRouteStopsParams.safeParse(req.params), res), data = parse(ReorderSavedRouteStopsBody.safeParse(req.body), res); if (!p || !data) return;
  const company = await getCompanyForUser(req.userId!); const route = company && await routeFor(company.id, p.id); if (!route) return void res.status(404).json({ error: "Saved route not found" });
  const validOrder = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(510, ${route.id}::int)`,
    );
    const current = await tx
      .select({ id: savedRouteStopsTable.id })
      .from(savedRouteStopsTable)
      .where(eq(savedRouteStopsTable.routeId, route.id));
    if (
      new Set(data.stopIds).size !== current.length ||
      current.some((stop) => !data.stopIds.includes(stop.id))
    ) {
      return false;
    }
    // Move all rows outside the final range before assigning final positions:
    // the unique route/position index otherwise rejects a simple swap.
    await tx
      .update(savedRouteStopsTable)
      .set({
        position: sql`${savedRouteStopsTable.position} + ${current.length}`,
        updatedAt: new Date(),
      })
      .where(eq(savedRouteStopsTable.routeId, route.id));
    for (const [position, id] of data.stopIds.entries()) {
      await tx
        .update(savedRouteStopsTable)
        .set({ position, updatedAt: new Date() })
        .where(eq(savedRouteStopsTable.id, id));
    }
    return true;
  });
  if (!validOrder) {
    return void res.status(400).json({
      error: "stopIds must contain every route stop exactly once",
    });
  }
  res.json(ReorderSavedRouteStopsResponse.parse(await serialize(route)));
});
// prettier-ignore
async function stopFor(companyId: number, routeId: number, stopId: number) {
  const route = await routeFor(companyId, routeId); if (!route) return null;
  const [stop] = await db.select().from(savedRouteStopsTable).where(and(eq(savedRouteStopsTable.id, stopId), eq(savedRouteStopsTable.routeId, routeId))); return stop ? { route, stop } : null;
}
// prettier-ignore
const stopJson = (s: typeof savedRouteStopsTable.$inferSelect) => ({ ...s, address: s.address ?? null, linkedBookingId: s.linkedBookingId ?? null, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() });
router.get(
  "/saved-routes/:routeId/stops/:stopId",
  ...savedRouteGuards,
  async (req, res) => {
    const p = parse(GetSavedRouteStopParams.safeParse(req.params), res);
    if (!p) return;
    const company = await getCompanyForUser(req.userId!);
    const found = company && (await stopFor(company.id, p.routeId, p.stopId));
    if (!found)
      return void res.status(404).json({ error: "Saved route stop not found" });
    res.json(GetSavedRouteStopResponse.parse(stopJson(found.stop)));
  },
);
router.patch(
  "/saved-routes/:routeId/stops/:stopId",
  ...savedRouteGuards,
  async (req, res) => {
    const p = parse(UpdateSavedRouteStopParams.safeParse(req.params), res);
    const data = parse(UpdateSavedRouteStopBody.safeParse(req.body), res);
    if (!p || !data) return;
    const company = await getCompanyForUser(req.userId!);
    const found = company && (await stopFor(company.id, p.routeId, p.stopId));
    if (!found)
      return void res.status(404).json({ error: "Saved route stop not found" });
    if (!Object.keys(data).length)
      return void res.status(400).json({ error: "Nothing to change" });
    const [stop] = await db
      .update(savedRouteStopsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(savedRouteStopsTable.id, found.stop.id))
      .returning();
    res.json(UpdateSavedRouteStopResponse.parse(stopJson(stop!)));
  },
);
router.delete(
  "/saved-routes/:routeId/stops/:stopId",
  ...savedRouteGuards,
  async (req, res) => {
    const p = parse(DeleteSavedRouteStopParams.safeParse(req.params), res);
    if (!p) return;
    const company = await getCompanyForUser(req.userId!);
    const found = company && (await stopFor(company.id, p.routeId, p.stopId));
    if (!found)
      return void res.status(404).json({ error: "Saved route stop not found" });
    await db
      .delete(savedRouteStopsTable)
      .where(eq(savedRouteStopsTable.id, found.stop.id));
    res.status(204).end();
  },
);
export default router;
