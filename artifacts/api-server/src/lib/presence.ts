/**
 * Who is "live" right now.
 *
 * Live means exactly what the map means by it: at least one of this person's
 * devices reported a position recently (a phone sends one every ~30 seconds
 * while sharing is on, and so does the dashboard when the owner has switched
 * this browser on). One rule shared by the chat dots, the schedule lanes and
 * the map cars, so no screen ever disagrees with another about who is out
 * working.
 *
 * Multi-device is deliberately invisible here: a person carrying a phone and
 * a tablet is ONE live person, however many pins the map draws for them. The
 * `Set` return type is what makes that true by construction.
 *
 * The window mirrors STALE_AFTER_MS in the dashboard's mapMarkers.ts — a car
 * goes dim at the same moment a chat dot goes grey. Change both together.
 */
import { and, eq, gt } from "drizzle-orm";
import { db, cleanerLocationsTable, teamMembersTable } from "@workspace/db";
import { sharingEnabledSql } from "./staffDevices";

export const LIVE_WITHIN_MS = 5 * 60 * 1000;

/** Team member ids in this company with at least one device reporting lately. */
export async function liveMemberIds(companyId: number): Promise<Set<number>> {
  const cutoff = new Date(Date.now() - LIVE_WITHIN_MS);
  const rows = await db
    .select({ teamMemberId: cleanerLocationsTable.teamMemberId })
    .from(cleanerLocationsTable)
    .innerJoin(
      teamMembersTable,
      eq(cleanerLocationsTable.teamMemberId, teamMembersTable.id),
    )
    .where(
      and(
        eq(cleanerLocationsTable.companyId, companyId),
        gt(cleanerLocationsTable.updatedAt, cutoff),
        // Somebody switched off has nothing stored anyway; the filter is here
        // so a row that outlived its switch can never light a dot.
        sharingEnabledSql(),
      ),
    );
  return new Set(rows.map((r) => r.teamMemberId));
}
