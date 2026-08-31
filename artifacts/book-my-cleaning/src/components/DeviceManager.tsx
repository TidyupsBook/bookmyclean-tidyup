import { useState } from "react";
import {
  getListStaffDevicesQueryKey,
  useDeleteStaffDevice,
  useListStaffDevices,
  useRenameStaffDevice,
  type StaffDeviceEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Pencil, Check } from "lucide-react";

function healthLabel(
  health: StaffDeviceEntry["locationHealth"],
  live: boolean,
  lastSeenAt: string | null | undefined,
): string | null {
  if (health === "permission-denied") return "Permission needed";
  if (health === "storage-cleared") return "Sharing reset — re-enable";
  if (!live && lastSeenAt) return "Needs attention — check sharing";
  return null;
}

function healthHelp(health: StaffDeviceEntry["locationHealth"]): string | null {
  if (health === "storage-cleared") {
    return "This device's app storage was reset, so sharing is paused. Have the crew member open Location on that device and choose Turn it on; this status clears after it reports.";
  }
  return null;
}

/** Owner-only device housekeeping embedded in the Live Map. */
export function DeviceManager() {
  const queryClient = useQueryClient();
  const devices = useListStaffDevices({
    query: { queryKey: getListStaffDevicesQueryKey(), refetchInterval: 30_000 },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: getListStaffDevicesQueryKey(),
    });
    void queryClient.invalidateQueries({ queryKey: ["/api/map/data"] });
  };
  const remove = useDeleteStaffDevice({ mutation: { onSuccess: refresh } });
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const rename = useRenameStaffDevice({
    mutation: {
      onSuccess: () => {
        setEditing(null);
        refresh();
      },
    },
  });

  const edit = (device: StaffDeviceEntry) => {
    setEditing(device.id);
    setDraft(device.label);
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Live devices</h2>
        <p className="text-xs text-muted-foreground">
          Rename a device or remove a retired device. Location sharing is
          decided by each person on that device.
        </p>
      </div>
      {devices.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading devices…</p>
      ) : (
        <ul className="space-y-2">
          {(devices.data?.people ?? []).flatMap((person) =>
            person.devices.map((device) => (
              <li key={device.id} className="flex items-center gap-2 text-sm">
                {editing === device.id ? (
                  <>
                    <Input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      className="h-8 flex-1"
                      maxLength={60}
                      aria-label={`Name for ${device.label}`}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!draft.trim() || rename.isPending}
                      onClick={() =>
                        rename.mutate({
                          id: device.id,
                          data: { label: draft.trim() },
                        })
                      }
                    >
                      <Check className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">
                      {device.label}{" "}
                      <span className="text-xs text-muted-foreground">
                        · {person.name}
                      </span>
                      {healthLabel(
                        device.locationHealth,
                        device.live,
                        device.lastSeenAt,
                      ) ? (
                        <span className="ml-2 text-xs font-medium text-amber-600">
                          ·{" "}
                          {healthLabel(
                            device.locationHealth,
                            device.live,
                            device.lastSeenAt,
                          )}
                        </span>
                      ) : null}
                      {healthHelp(device.locationHealth) ? (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {healthHelp(device.locationHealth)}
                        </span>
                      ) : null}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => edit(device)}
                      aria-label={`Rename ${device.label}`}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${device.label} and its stored location?`,
                          )
                        )
                          remove.mutate({ id: device.id });
                      }}
                      aria-label={`Remove ${device.label}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            )),
          )}
        </ul>
      )}
    </section>
  );
}

/** Compatibility export for device-row tests and old deep imports. */
export function DeviceRow({ device }: { device: StaffDeviceEntry }) {
  const rename = useRenameStaffDevice();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.label);
  if (editing) {
    return (
      <li className="flex items-center gap-2 text-xs">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 flex-1"
          maxLength={60}
          aria-label={`Name for ${device.label}`}
          data-testid={`input-device-name-${device.id}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const label = draft.trim();
            if (!label || label === device.label) {
              setEditing(false);
              return;
            }
            rename.mutate({ id: device.id, data: { label } });
            setEditing(false);
          }}
          disabled={rename.isPending}
          data-testid={`button-save-device-name-${device.id}`}
        >
          <Check className="size-3.5" />
        </Button>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="flex-1 truncate">{device.label}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setDraft(device.label);
          setEditing(true);
        }}
        data-testid={`button-rename-device-${device.id}`}
      >
        {device.label}
        <Pencil className="size-3.5" />
      </Button>
    </li>
  );
}
