import { Router, type IRouter } from "express";
import { db, cleanerLocationsTable } from "@workspace/db";
import {
  ReportStaffLocationBody,
  ReportStaffLocationResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCaller } from "../middlewares/requireRole";

const router: IRouter = Router();

// A team member's phone posts its own GPS every ~30s. The caller can only ever
// write their OWN row — the team member id comes from the resolved caller, NEVER
// from the body, so nobody can spoof another cleaner's position. Owners have no
// seat row, so they simply have nowhere to write; the route still accepts them
// for the guard's sake but records nothing.
router.post(
  "/staff/location",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const parsed = ReportStaffLocationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    // Only a real team seat has a row to upsert. The owner is the Clerk account
    // on the company, not a locatable crew member.
    if (caller.teamMemberId === null) {
      res.status(400).json({
        error: "Only team members with a seat can report a location.",
      });
      return;
    }

    const { lat, lng } = parsed.data;
    const accuracy = parsed.data.accuracy ?? null;

    // Upsert on the unique team-member row: the phone updates its single
    // current position rather than appending a trail.
    const [row] = await db
      .insert(cleanerLocationsTable)
      .values({
        companyId: caller.company.id,
        teamMemberId: caller.teamMemberId,
        lat,
        lng,
        accuracy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: cleanerLocationsTable.teamMemberId,
        set: {
          companyId: caller.company.id,
          lat,
          lng,
          accuracy,
          updatedAt: new Date(),
        },
      })
      .returning();

    res.json(
      ReportStaffLocationResponse.parse({
        teamMemberId: row!.teamMemberId,
        lat: row!.lat,
        lng: row!.lng,
        accuracy: row!.accuracy ?? null,
        updatedAt: row!.updatedAt.toISOString(),
      }),
    );
  },
);

export default router;
