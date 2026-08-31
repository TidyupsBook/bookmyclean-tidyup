import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  cleanerLocationsTable,
  companiesTable,
  staffDevicesTable,
  teamMembersTable,
} from "@workspace/db";
import {
  ReportStaffLocationBody,
  ReportStaffLocationResponse,
  GetStaffPresenceResponse,
  ListStaffDevicesResponse,
  RenameStaffDeviceBody,
  RenameStaffDeviceParams,
  RenameStaffDeviceResponse,
  DeleteStaffDeviceParams,
  SetOfficeDeviceBody,
  SetOfficeDeviceParams,
  SetOfficeDeviceResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCaller } from "../middlewares/requireRole";
import { liveMemberIds, LIVE_WITHIN_MS } from "../lib/presence";
import { resolveChatSeat } from "../lib/staffChat";
import { roleLabel } from "../lib/roleLabel";
import { livePositionAccess } from "../lib/livePositionAccess";
import { geocodeAddress, GeocodeConfigError } from "../services/geocode";
import { logger } from "../lib/logger";
import {
  registerDevice,
  findSeat,
  findDevice,
  renameDevice,
  deleteDevice,
  sharingEnabledFor,
} from "../lib/staffDevices";

const router: IRouter = Router();

// A signed-in client — a cleaner's phone, or the owner's dashboard — posts its
// own GPS every ~30s. The caller can only ever write their OWN row: the team
// member id comes from the resolved caller, NEVER from the body, so nobody can
// spoof another cleaner's position, and a device key only picks among that
// caller's own devices. An owner's authority comes from owning the company, so
// caller.teamMemberId is null for them — but the owner does have a roster row
// (created with the company), and that's the same seat chat attributes their
// messages to. Resolving it here lets the boss light up live like anyone else,
// keyed by the same id every screen already uses.
//
// A device is the thing being tracked, not a person: four devices belonging to
// one person are four rows and four pins, instead of four clients overwriting
// each other's single pin.
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
    // The caller's own seat: their team_members row, or for an owner the
    // owner-role row the company was created with. Without any row there is
    // genuinely nowhere to write.
    const seat = await resolveChatSeat(caller.company, caller);
    if (!seat) {
      res.status(400).json({
        error: "Only team members with a seat can report a location.",
      });
      return;
    }

    const member = await findSeat(caller.company.id, seat.id);
    if (!member) {
      res.status(400).json({
        error: "Only team members with a seat can report a location.",
      });
      return;
    }

    const device = await registerDevice({
      companyId: caller.company.id,
      teamMemberId: member.id,
      deviceKey: parsed.data.deviceKey ?? null,
      recoveryKey: parsed.data.recoveryKey ?? null,
      label: parsed.data.deviceLabel ?? null,
      platform: parsed.data.platform ?? null,
      locationHealth: parsed.data.locationHealth ?? "granted",
      healthOnly: parsed.data.lat == null || parsed.data.lng == null,
    });

    const { lat, lng } = parsed.data;
    if (
      !device ||
      lat == null ||
      lng == null ||
      device.locationHealth === "storage-cleared"
    ) {
      res.json(
        ReportStaffLocationResponse.parse({
          status: "recorded",
          teamMemberId: member.id,
          deviceId: device?.id ?? null,
          deviceLabel: device?.label ?? null,
          platform: device?.platform ?? null,
          lat: null,
          lng: null,
          accuracy: null,
          updatedAt: null,
          message: null,
          recoveryMatched: device !== null,
        }),
      );
      return;
    }
    const accuracy = parsed.data.accuracy ?? null;
    const now = new Date();

    // Upsert on the unique device row: a client updates its single current
    // position rather than appending a trail.
    const [row] = await db
      .insert(cleanerLocationsTable)
      .values({
        companyId: caller.company.id,
        teamMemberId: member.id,
        deviceId: device.id,
        lat,
        lng,
        accuracy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: cleanerLocationsTable.deviceId,
        set: {
          companyId: caller.company.id,
          teamMemberId: member.id,
          lat,
          lng,
          accuracy,
          updatedAt: now,
        },
      })
      .returning();

    res.json(
      ReportStaffLocationResponse.parse({
        status: "recorded",
        teamMemberId: row!.teamMemberId,
        deviceId: device.id,
        deviceLabel: device.label,
        platform: device.platform,
        lat: row!.lat,
        lng: row!.lng,
        accuracy: row!.accuracy ?? null,
        updatedAt: row!.updatedAt.toISOString(),
        message: null,
      }),
    );
  },
);

// Who is out working right now — the ids behind every green "live" dot. Any
// role may ask: the map already shows each colleague's live car to the whole
// crew, so this reveals nothing the map doesn't. Ids only, no positions —
// but it still says who is where at this hour, so it observes the same
// watching window as the map itself.
router.get(
  "/staff/presence",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    if (!caller.company) {
      res.json(
        GetStaffPresenceResponse.parse({
          liveMemberIds: [],
          livePositions: { allowed: true, reason: null },
        }),
      );
      return;
    }
    const watch = livePositionAccess(caller.role, caller.company);
    if (!watch.allowed) {
      res.json(
        GetStaffPresenceResponse.parse({
          liveMemberIds: [],
          livePositions: watch,
        }),
      );
      return;
    }
    const live = await liveMemberIds(caller.company.id);
    res.json(
      GetStaffPresenceResponse.parse({
        liveMemberIds: [...live].sort((a, b) => a - b),
        livePositions: watch,
      }),
    );
  },
);

// The owner's tracking page: every device in the company, grouped by the
// person carrying it, with last-seen times and the per-person switch.
//
// Owner only, and not because of what it shows one at a time — the map shows
// a car too — but because it is the whole company's whereabouts and the
// controls over them on one screen. A dispatcher who navigates here directly
// is refused by this guard, not by the missing sidebar link.
router.get(
  "/staff/devices",
  requireAuth,
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const caller = await getCaller(req);
    const company = caller.company;
    if (!company) {
      res.json(
        ListStaffDevicesResponse.parse({
          people: [],
          livePositions: { allowed: true, reason: null },
        }),
      );
      return;
    }

    const rows = await db
      .select({
        member: teamMembersTable,
        device: staffDevicesTable,
        lat: cleanerLocationsTable.lat,
        lng: cleanerLocationsTable.lng,
        accuracy: cleanerLocationsTable.accuracy,
        updatedAt: cleanerLocationsTable.updatedAt,
      })
      .from(teamMembersTable)
      .leftJoin(
        staffDevicesTable,
        eq(staffDevicesTable.teamMemberId, teamMembersTable.id),
      )
      .leftJoin(
        cleanerLocationsTable,
        eq(cleanerLocationsTable.deviceId, staffDevicesTable.id),
      )
      // Retired seats retain history but are not people the owner is tracking.
      // Keeping them out of this response also means an old imported record
      // cannot make the live tracking page work through stale device data.
      .where(
        and(
          eq(teamMembersTable.companyId, company.id),
          eq(teamMembersTable.active, true),
        ),
      );

    const liveCutoff = Date.now() - LIVE_WITHIN_MS;
    const byMember = new Map<
      number,
      ReturnType<typeof emptyPerson> & { order: string }
    >();

    function emptyPerson(member: typeof teamMembersTable.$inferSelect) {
      return {
        teamMemberId: member.id,
        name: member.name,
        roleLabel: roleLabel(member),
        color: member.color,
        isOwner: member.role === "owner",
        sharingEnabled: sharingEnabledFor(member),
        canChangeSharing: member.role !== "owner",
        devices: [] as Array<{
          id: number;
          label: string;
          platform: string;
          isOffice: boolean;
          lastSeenAt: string | null;
          live: boolean;
          lat: number | null;
          lng: number | null;
          accuracy: number | null;
          locationHealth: string;
        }>,
      };
    }

    for (const row of rows) {
      let person = byMember.get(row.member.id);
      if (!person) {
        person = { ...emptyPerson(row.member), order: row.member.name };
        byMember.set(row.member.id, person);
      }
      if (!row.device) continue;
      const seenAt = row.updatedAt ?? row.device.lastSeenAt;
      person.devices.push({
        id: row.device.id,
        label: row.device.label,
        platform: row.device.platform,
        isOffice: row.device.isOffice,
        lastSeenAt: seenAt ? seenAt.toISOString() : null,
        live: seenAt !== null && seenAt.getTime() > liveCutoff,
        lat: row.lat ?? null,
        lng: row.lng ?? null,
        accuracy: row.accuracy ?? null,
        locationHealth: row.device.locationHealth,
      });
    }

    const people = [...byMember.values()]
      .map(({ order: _order, ...person }) => ({
        ...person,
        // Live devices first, then the most recently seen — the owner opens
        // this to find who is out, not to read an alphabet of hardware.
        devices: person.devices.sort((a, b) => {
          if (a.live !== b.live) return a.live ? -1 : 1;
          return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
        }),
      }))
      .sort((a, b) => {
        if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

    res.json(
      ListStaffDevicesResponse.parse({
        people,
        livePositions: livePositionAccess(caller.role, company),
      }),
    );
  },
);

// Turn one person's live location on or off. Owner only — this decides
// whether anything of theirs is stored at all, which is not a day-to-day
// dispatch call.
// Rename a device. The owner names anything in his company — his desktop is
// "Tidyups Location", not "Boss PC" — and everybody else may name only the
// device in their own hand. A name set here is final: `registerDevice` keeps
// it on every subsequent position report, so a rename can't be undone thirty
// seconds later by the device it renamed.
router.patch(
  "/staff/devices/:id",
  requireAuth,
  requireRole("owner", "dispatcher", "cleaner"),
  async (req, res): Promise<void> => {
    const params = RenameStaffDeviceParams.safeParse(req.params);
    const body = RenameStaffDeviceBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: (params.success ? body : params).error!.message,
      });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    const label = body.data.label.trim();
    if (!label) {
      res.status(400).json({ error: "A device name is required" });
      return;
    }

    const device = await findDevice(caller.company.id, params.data.id);
    if (!device) {
      res.status(404).json({ error: "No such device" });
      return;
    }

    // Anyone but the owner may only rename their own. The seat comes from the
    // session — an owner-role caller has no teamMemberId of their own, and
    // they don't need one, since the branch above already let them through.
    if (caller.role !== "owner") {
      const seat = await resolveChatSeat(caller.company, caller);
      if (!seat || seat.id !== device.teamMemberId) {
        res
          .status(403)
          .json({ error: "You can only rename your own devices." });
        return;
      }
    }

    const renamed = await renameDevice({
      companyId: caller.company.id,
      deviceId: device.id,
      label,
    });
    if (!renamed) {
      res.status(404).json({ error: "No such device" });
      return;
    }

    const lastSeenAt = renamed.lastSeenAt;
    res.json(
      RenameStaffDeviceResponse.parse({
        id: renamed.id,
        label: renamed.label,
        platform: renamed.platform,
        locationHealth: renamed.locationHealth,
        isOffice: renamed.isOffice,
        lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
        live: lastSeenAt
          ? Date.now() - lastSeenAt.getTime() <= LIVE_WITHIN_MS
          : false,
        lat: null,
        lng: null,
        accuracy: null,
      }),
    );
  },
);

// Permanently forget one device — an old browser, a retired phone. Owner
// only, like the page it lives on: this deletes company data for good. The
// stored position cascades away with the row, so the pin is gone from the map
// the moment the caches refresh. The person and their seat are untouched, and
// the same physical device simply registers as a new device if it ever
// reports again.
router.delete(
  "/staff/devices/:id",
  requireAuth,
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const params = DeleteStaffDeviceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const caller = await getCaller(req);
    if (!caller.company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }
    const deleted = await deleteDevice({
      companyId: caller.company.id,
      deviceId: params.data.id,
    });
    if (!deleted) {
      res.status(404).json({ error: "No such device" });
      return;
    }
    res.status(204).end();
  },
);

// Mark one device as the office, or put it back to normal tracking. Owner
// only — it redefines what a marker on the company map MEANS.
//
// The office is a place, not a crew member: from the moment the flag is set,
// the map draws this device as a building parked on the company's stored
// office spot and ignores whatever the browser reports. The spot itself lives
// on the company (geocoded here, server-side), so refreshing, reopening, or a
// bad geolocation reading can never move the shop. One office per company:
// flagging a new device clears the old one in the same request.
router.put(
  "/staff/devices/:id/office",
  requireAuth,
  requireRole("owner"),
  async (req, res): Promise<void> => {
    const params = SetOfficeDeviceParams.safeParse(req.params);
    const body = SetOfficeDeviceBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: (params.success ? body : params).error!.message,
      });
      return;
    }
    const caller = await getCaller(req);
    const company = caller.company;
    if (!company) {
      res.status(404).json({ error: "No company yet" });
      return;
    }

    const device = await findDevice(company.id, params.data.id);
    if (!device) {
      res.status(404).json({ error: "No such device" });
      return;
    }

    let officeAddress = company.officeAddress;
    let officeLat = company.officeLat;
    let officeLng = company.officeLng;

    if (body.data.office) {
      // A new address re-places the office; otherwise the stored spot is
      // reused so switching WHICH device is the office never moves the shop.
      const typed = body.data.address?.trim() ?? "";
      if (typed && typed !== (company.officeAddress ?? "")) {
        try {
          const coords = await geocodeAddress(typed);
          if (!coords) {
            res
              .status(400)
              .json({ error: "Couldn't find that address on the map." });
            return;
          }
          officeAddress = typed;
          officeLat = coords.lat;
          officeLng = coords.lng;
        } catch (err) {
          if (err instanceof GeocodeConfigError) {
            logger.warn({ err }, "[staff] office geocoding unavailable");
            res.status(400).json({
              error: "Address lookup is unavailable right now — try again.",
            });
            return;
          }
          throw err;
        }
      } else if (officeLat == null || officeLng == null) {
        // No stored spot and nothing typed: refusing beats an office marker
        // that would have to fall back to a browser fix — the exact drift
        // this flag exists to prevent.
        res.status(400).json({
          error: "Enter the office address so the marker knows where to sit.",
        });
        return;
      }

      // One office per company: clear everything else's flag, then set this
      // one, atomically. The transaction serializes concurrent switches (the
      // company-wide clear locks every device row, so a second request waits
      // for the first to commit), and the partial unique index
      // staff_devices_one_office_idx makes the invariant a database
      // guarantee even if some future writer skips this path.
      await db.transaction(async (tx) => {
        await tx
          .update(companiesTable)
          .set({ officeAddress, officeLat, officeLng })
          .where(eq(companiesTable.id, company.id));
        await tx
          .update(staffDevicesTable)
          .set({ isOffice: false })
          .where(eq(staffDevicesTable.companyId, company.id));
        await tx
          .update(staffDevicesTable)
          .set({ isOffice: true })
          .where(
            and(
              eq(staffDevicesTable.id, device.id),
              eq(staffDevicesTable.companyId, company.id),
            ),
          );
      });
    } else {
      await db
        .update(staffDevicesTable)
        .set({ isOffice: false })
        .where(
          and(
            eq(staffDevicesTable.id, device.id),
            eq(staffDevicesTable.companyId, company.id),
          ),
        );
    }

    res.json(
      SetOfficeDeviceResponse.parse({
        deviceId: device.id,
        isOffice: body.data.office,
        address: officeAddress ?? null,
        lat: officeLat ?? null,
        lng: officeLng ?? null,
      }),
    );
  },
);

export default router;
