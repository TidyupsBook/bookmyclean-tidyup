import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { isPausedDatabaseError } from "../lib/migrate";

/**
 * Full path of the liveness probe as mounted in app.ts (the router below
 * registers "/healthz" under the "/api" prefix). Exported so the canonical
 * host redirect can exempt it — the deployment health checker must never be
 * answered with a 301.
 */
export const HEALTHZ_PATH = "/api/healthz";

const router: IRouter = Router();

/**
 * Liveness plus a live database probe. The platform pauses idle production
 * databases; when that happens every query fails with the SQLSTATE 28000
 * "endpoint has been disabled" signature (classified by
 * isPausedDatabaseError — the same check the migration runner uses at
 * publish time). The dashboard polls this endpoint and shows the owner a
 * plain-language notice naming the fix instead of a generic error screen.
 *
 * The process itself is healthy even when the database is not, so `status`
 * stays "ok" — reporting the DB state must not make a load balancer recycle
 * the container.
 */
router.get("/healthz", async (_req, res) => {
  let database: "ok" | "paused" | "error" = "ok";
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    database = isPausedDatabaseError(err) ? "paused" : "error";
  }
  const data = HealthCheckResponse.parse({ status: "ok", database });
  res.json(data);
});

export default router;
