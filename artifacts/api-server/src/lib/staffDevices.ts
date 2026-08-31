/**
 * Devices, and who is allowed to be tracked at all.
 *
 * Two rules live here so nothing can hold a different opinion:
 *
 *  1. **Sharing.** A seat is tracked when the owner has switched it on — or
 *     when it IS the owner's own seat, which is always on. Nothing is stored
 *     for anybody else, and switching someone off deletes what was stored, so
 *     "off" means there is no position anywhere rather than one that happens
 *     not to be drawn.
 *  2. **Devices.** A person reports from a device, and the device is what
 *     carries a position. The seat always comes from the session; a device key
 *     only ever picks among that caller's own devices.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  teamMembersTable,
  staffDevicesTable,
  cleanerLocationsTable,
  LEGACY_DEVICE_KEY,
  type StaffDevice,
} from "@workspace/db";

/** Labels a client may claim for a device; anything else lands on "other". */
const PLATFORMS = new Set(["web", "ios", "android", "other"]);

export function normalizePlatform(value: string | null | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  return PLATFORMS.has(v) ? v : "other";
}

export const LOCATION_HEALTH = new Set([
  "unknown",
  "granted",
  "permission-denied",
  "storage-cleared",
]);

/** The default name for a device that registered without offering one. */
export function defaultDeviceLabel(platform: string): string {
  if (platform === "ios") return "iPhone";
  if (platform === "android") return "Android";
  if (platform === "web") return "Computer";
  return "Phone";
}

/**
 * Is this seat tracked? The owner's seat always is — their authority over the
 * company is what the tracking page rests on — everybody else only once the
 * owner has switched them on.
 */
export function sharingEnabledFor(member: {
  role: string;
  locationSharing?: boolean;
}): boolean {
  // The old owner-controlled roster switch is retained only for database
  // compatibility; individual device consent is the reporting gate.
  return true;
}

/**
 * The same rule as SQL, for the queries that filter positions down to people
 * who may be shown. Written once so a new read can't quietly forget it.
 */
export function sharingEnabledSql(): SQL {
  // Keep the helper for old query call sites, but never filter by the retired
  // per-person switch.
  return sql`TRUE`;
}

/**
 * Find or create the device a caller is reporting from, and keep its name and
 * platform current — renaming a device is simply its next report carrying a
 * new label.
 *
 * A client that predates devices sends no key; those fold onto the one legacy
 * device per person that the devices migration backfilled, so an un-upgraded
 * phone keeps exactly the single pin it always had.
 */
export async function registerDevice(opts: {
  companyId: number;
  teamMemberId: number;
  deviceKey?: string | null;
  recoveryKey?: string | null;
  label?: string | null;
  platform?: string | null;
  locationHealth?: string | null;
  healthOnly?: boolean;
  /**
   * Default true: the label a client offers only names a device the first
   * time it appears. Pass false to let the report rename it as well — nothing
   * does today, and anything that starts to will fight the rename route.
   */
  keepExistingLabel?: boolean;
}): Promise<StaffDevice | null> {
  const deviceKey = (opts.deviceKey ?? "").trim() || LEGACY_DEVICE_KEY;
  const recoveryKey = (opts.recoveryKey ?? "").trim() || null;
  const platform = normalizePlatform(opts.platform);
  const label = (opts.label ?? "").trim() || defaultDeviceLabel(platform);
  const now = new Date();
  const knownByRecovery = recoveryKey
    ? (
        await db
          .select()
          .from(staffDevicesTable)
          .where(
            and(
              eq(staffDevicesTable.teamMemberId, opts.teamMemberId),
              eq(staffDevicesTable.recoveryKey, recoveryKey),
            ),
          )
          .limit(1)
      )[0]
    : null;

  // A reset client may not know to send a health-only report: its first
  // request can be a location report with a freshly minted key. Recognize
  // that transition by recovery identity, discard the coordinates, and make
  // the owner-facing status explicit.
  if (
    knownByRecovery &&
    deviceKey !== knownByRecovery.deviceKey &&
    opts.locationHealth !== "storage-cleared"
  ) {
    const [recovered] = await db
      .update(staffDevicesTable)
      .set({
        deviceKey,
        platform,
        locationHealth: "storage-cleared",
      })
      .where(eq(staffDevicesTable.id, knownByRecovery.id))
      .returning();
    await db
      .delete(cleanerLocationsTable)
      .where(eq(cleanerLocationsTable.deviceId, knownByRecovery.id));
    return recovered ?? null;
  }

  // A reset report is deliberately health-only. If its coarse recovery
  // identity is not already known, do not create a row that would mislead the
  // owner into thinking a never-used install needs attention.
  if (opts.healthOnly && opts.locationHealth === "storage-cleared") {
    if (!recoveryKey) return null;
    if (!knownByRecovery) return null;
  }

  // Prefer the recovery match for a storage-reset report. This changes the
  // device key in place, preserving the owner's name and row id, but never
  // touches the location table.
  if (
    opts.healthOnly &&
    opts.locationHealth === "storage-cleared" &&
    recoveryKey
  ) {
    const [recovered] = await db
      .update(staffDevicesTable)
      .set({
        deviceKey,
        platform,
        locationHealth: "storage-cleared",
      })
      .where(
        and(
          eq(staffDevicesTable.teamMemberId, opts.teamMemberId),
          eq(staffDevicesTable.recoveryKey, recoveryKey),
        ),
      )
      .returning();
    if (recovered) {
      await db
        .delete(cleanerLocationsTable)
        .where(eq(cleanerLocationsTable.deviceId, recovered.id));
    }
    return recovered ?? null;
  }

  const [row] = await db
    .insert(staffDevicesTable)
    .values({
      companyId: opts.companyId,
      teamMemberId: opts.teamMemberId,
      deviceKey,
      label,
      platform,
      locationHealth: LOCATION_HEALTH.has(opts.locationHealth ?? "")
        ? opts.locationHealth!
        : "unknown",
      recoveryKey,
      lastSeenAt: opts.healthOnly ? null : now,
    })
    .onConflictDoUpdate({
      target: [staffDevicesTable.teamMemberId, staffDevicesTable.deviceKey],
      set: {
        companyId: opts.companyId,
        platform,
        locationHealth: LOCATION_HEALTH.has(opts.locationHealth ?? "")
          ? opts.locationHealth!
          : "unknown",
        ...(recoveryKey ? { recoveryKey } : {}),
        ...(opts.healthOnly ? {} : { lastSeenAt: now }),
        // The name a device was GIVEN wins over the name it calls itself.
        // Renaming happens in one place (PATCH /staff/devices/:id); if a
        // reporting device could overwrite the label, the owner's rename of
        // his PC to "Tidyups Location" would be undone within thirty seconds
        // by that same PC's next position report.
        ...(opts.keepExistingLabel === false ? { label } : {}),
      },
    })
    .returning();
  return row!;
}

/** The longest a device name may be, matching the API contract. */
export const MAX_DEVICE_LABEL_LENGTH = 60;

/**
 * Rename one device. Returns null when the device isn't this company's, so a
 * guessed id from another tenant is indistinguishable from one that never
 * existed.
 */
export async function renameDevice(opts: {
  companyId: number;
  deviceId: number;
  label: string;
}): Promise<StaffDevice | null> {
  const [row] = await db
    .update(staffDevicesTable)
    .set({ label: opts.label.slice(0, MAX_DEVICE_LABEL_LENGTH) })
    .where(
      and(
        eq(staffDevicesTable.id, opts.deviceId),
        eq(staffDevicesTable.companyId, opts.companyId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently forget one device. The row's stored position goes with it —
 * `cleaner_locations.device_id` cascades — so nothing of the device remains
 * anywhere. Scoped by company so a guessed id from another tenant deletes
 * nothing. Returns false when no row was removed.
 */
export async function deleteDevice(opts: {
  companyId: number;
  deviceId: number;
}): Promise<boolean> {
  const rows = await db
    .delete(staffDevicesTable)
    .where(
      and(
        eq(staffDevicesTable.id, opts.deviceId),
        eq(staffDevicesTable.companyId, opts.companyId),
      ),
    )
    .returning({ id: staffDevicesTable.id });
  return rows.length > 0;
}

/** One company's device, by id. Null when it belongs to somebody else. */
export async function findDevice(
  companyId: number,
  deviceId: number,
): Promise<StaffDevice | null> {
  const [row] = await db
    .select()
    .from(staffDevicesTable)
    .where(
      and(
        eq(staffDevicesTable.id, deviceId),
        eq(staffDevicesTable.companyId, companyId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Forget everything stored about where one person's devices are.
 *
 * Used when the owner switches somebody off: the switch has to mean "nothing
 * of theirs is kept", not "nothing of theirs is drawn". The device rows stay —
 * they are just an identity and a last-seen — but every position goes.
 */
export async function clearStoredPositions(
  teamMemberId: number,
): Promise<void> {
  await db
    .delete(cleanerLocationsTable)
    .where(eq(cleanerLocationsTable.teamMemberId, teamMemberId));
  await db
    .update(staffDevicesTable)
    .set({ lastSeenAt: null })
    .where(eq(staffDevicesTable.teamMemberId, teamMemberId));
}

/** One company's seat, by id — used by the tracking switch. */
export async function findSeat(companyId: number, teamMemberId: number) {
  const [seat] = await db
    .select()
    .from(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.id, teamMemberId),
        eq(teamMembersTable.companyId, companyId),
      ),
    );
  return seat ?? null;
}

/**
 * The freshest position per PERSON, as a SQL fragment other queries can join
 * against. Several devices for one person must collapse to one row wherever
 * the question is about the person (their trail, their distance ranking)
 * rather than about a pin on the map.
 */
export function latestPerMemberRank() {
  return sql<number>`row_number() over (partition by ${cleanerLocationsTable.teamMemberId} order by ${cleanerLocationsTable.updatedAt} desc)`;
}
