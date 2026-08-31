import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import {
  getGetMapDataQueryKey,
  getListStaffDevicesQueryKey,
  useDeleteStaffDevice,
  useListStaffDevices,
  useRenameStaffDevice,
  type StaffDeviceEntry,
  type StaffTrackedPerson,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";

const c = colors.light;

/**
 * Owner-only device housekeeping, mirroring the web Tracking page: every
 * device signed in to the company, renameable, and permanently deletable
 * behind a confirm step. The server refuses non-owners on both endpoints;
 * the caller of this component gates rendering on the owner role so a
 * cleaner never sees the whole crew's hardware list.
 */

// Alert.alert is a no-op on web (where the Expo preview runs) — fall back to
// the browser's own confirm so delete can't silently do nothing there.
function confirmDeleteAsync(label: string): Promise<boolean> {
  const title = `Delete “${label}” for good?`;
  const message =
    "This removes the device and its stored location — it disappears from " +
    "this list and the map, and there is no undo. If it ever reports again, " +
    "it will show up as a new device.";
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Keep it", style: "cancel", onPress: () => resolve(false) },
      {
        text: "Delete device",
        style: "destructive",
        onPress: () => resolve(true),
      },
    ]);
  });
}

function notify(title: string, message: string) {
  if (Platform.OS === "web") {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

function platformIcon(
  platform: string,
): React.ComponentProps<typeof Feather>["name"] {
  if (platform === "ios" || platform === "android") return "smartphone";
  if (platform === "tablet") return "tablet";
  if (platform === "web") return "monitor";
  return "hard-drive";
}

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
    return "This device's app storage was reset, so sharing is paused. Have the crew member open Location on that device and tap Turn on sharing. The status clears after its next report.";
  }
  return null;
}

function DeviceRow({
  device,
  deleting,
  onRename,
  onDelete,
}: {
  device: StaffDeviceEntry;
  deleting: boolean;
  onRename: (device: StaffDeviceEntry) => void;
  onDelete: (device: StaffDeviceEntry) => void;
}) {
  return (
    <View style={styles.deviceRow} testID={`row-device-${device.id}`}>
      <Feather
        name={platformIcon(device.platform)}
        size={14}
        color={c.mutedForeground}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.deviceLabel} numberOfLines={1}>
          {device.label}
        </Text>
        <Text
          style={[styles.deviceStatus, device.live && styles.deviceLive]}
          numberOfLines={1}
        >
          {device.live
            ? "Live now"
            : device.lastSeenAt
              ? `Last seen ${timeAgo(device.lastSeenAt)}`
              : "Never reported"}
        </Text>
        {healthLabel(device.locationHealth, device.live, device.lastSeenAt) ? (
          <Text style={styles.deviceHealth}>
            {healthLabel(device.locationHealth, device.live, device.lastSeenAt)}
          </Text>
        ) : null}
        {healthHelp(device.locationHealth) ? (
          <Text style={styles.deviceHealthHelp}>
            {healthHelp(device.locationHealth)}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => onRename(device)}
        hitSlop={8}
        style={({ pressed }) => [
          styles.iconButton,
          pressed && { opacity: 0.6 },
        ]}
        testID={`button-rename-device-${device.id}`}
      >
        <Feather name="edit-2" size={14} color={c.brandPink} />
      </Pressable>
      <Pressable
        onPress={() => onDelete(device)}
        disabled={deleting}
        hitSlop={8}
        style={({ pressed }) => [
          styles.iconButton,
          (pressed || deleting) && { opacity: 0.6 },
        ]}
        testID={`button-delete-device-${device.id}`}
      >
        {deleting ? (
          <ActivityIndicator size="small" color={c.destructive} />
        ) : (
          <Feather name="trash-2" size={14} color={c.destructive} />
        )}
      </Pressable>
    </View>
  );
}

/**
 * The same rename sheet pattern the Team tab uses for the caller's own name:
 * seed with the current label, Save disabled until it actually changes, and
 * errors kept inline so the sheet never closes on a failure.
 */
function RenameDeviceSheet({
  device,
  onClose,
  onSaved,
}: {
  device: StaffDeviceEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const insets = useSafeAreaInsets();
  const rename = useRenameStaffDevice();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const deviceId = device?.id;
  React.useEffect(() => {
    if (device) {
      setLabel(device.label);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const trimmed = label.trim();
  const canSave =
    trimmed.length > 0 && trimmed !== device?.label && !rename.isPending;

  const submit = () => {
    if (!device || !canSave) return;
    setError(null);
    rename.mutate(
      { id: device.id, data: { label: trimmed } },
      {
        onSuccess: () => onSaved(),
        onError: () => setError("The new name didn't save. Try again."),
      },
    );
  };

  return (
    <Modal
      visible={device !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.sheet, { paddingTop: insets.top + 8 }]}>
        <View style={styles.sheetHeader}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.sheetCancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>Device name</Text>
          <Pressable
            onPress={submit}
            disabled={!canSave}
            hitSlop={12}
            testID="button-save-device-name"
          >
            {rename.isPending ? (
              <ActivityIndicator color={c.brandPink} size="small" />
            ) : (
              <Text style={[styles.sheetSave, !canSave && { opacity: 0.4 }]}>
                Save
              </Text>
            )}
          </Pressable>
        </View>
        <Text style={styles.sheetHint}>
          This name labels the device's pin on the map and in the device list.
          It sticks even after the device next reports.
        </Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="Device name"
          placeholderTextColor={c.mutedForeground}
          style={styles.sheetInput}
          maxLength={60}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          testID="input-device-name"
        />
        {error ? <Text style={styles.sheetError}>{error}</Text> : null}
      </View>
    </Modal>
  );
}

function PersonDevices({
  person,
  deletingId,
  onRename,
  onDelete,
}: {
  person: StaffTrackedPerson;
  deletingId: number | null;
  onRename: (device: StaffDeviceEntry) => void;
  onDelete: (device: StaffDeviceEntry) => void;
}) {
  return (
    <View
      style={styles.personBlock}
      testID={`devices-person-${person.teamMemberId}`}
    >
      <View style={styles.personHeader}>
        <Text style={[styles.personName, { flex: 1, minWidth: 0 }]}>
          {person.name}
          <Text style={styles.personRole}> {person.roleLabel}</Text>
        </Text>
        <Text style={styles.consentLabel}>Device consent</Text>
      </View>
      {person.devices.length === 0 ? (
        <Text style={styles.noDevices}>No devices signed in yet</Text>
      ) : (
        person.devices.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            deleting={deletingId === device.id}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))
      )}
    </View>
  );
}

/** Render only for owners — see the note at the top of this file. */
export function DeviceManager() {
  const queryClient = useQueryClient();
  const devices = useListStaffDevices({
    query: {
      queryKey: getListStaffDevicesQueryKey(),
      // Same half-minute cadence the devices report on and the map refreshes.
      refetchInterval: 30_000,
    },
  });
  const [renaming, setRenaming] = useState<StaffDeviceEntry | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Deleting or renaming must reach the map at the same moment: the pin (and
  // its label) come from the map data feed, so both queries are invalidated.
  const refreshDevicesAndMap = () => {
    void queryClient.invalidateQueries({
      queryKey: getListStaffDevicesQueryKey(),
    });
    void queryClient.invalidateQueries({ queryKey: getGetMapDataQueryKey() });
  };

  const remove = useDeleteStaffDevice({
    mutation: {
      onSuccess: refreshDevicesAndMap,
      onError: () =>
        notify(
          "Couldn't delete that device",
          "It's still in the list. Try again in a moment.",
        ),
      onSettled: () => setDeletingId(null),
    },
  });

  const handleDelete = async (device: StaffDeviceEntry) => {
    const ok = await confirmDeleteAsync(device.label);
    if (!ok) return;
    setDeletingId(device.id);
    remove.mutate({ id: device.id });
  };

  const people = devices.data?.people ?? [];

  return (
    <View style={styles.card} testID="device-manager">
      <View style={styles.headerRow}>
        <Feather name="smartphone" size={15} color={c.brandPink} />
        <Text style={styles.headerTitle}>Company devices</Text>
      </View>
      <Text style={styles.headerHint}>
        Every device signed in to your company. Rename one to label its map pin,
        or delete a retired phone to clear it off the map.
      </Text>
      {devices.isLoading ? (
        <ActivityIndicator
          color={c.brandPink}
          style={{ paddingVertical: 12 }}
        />
      ) : devices.isError ? (
        <Text style={styles.errorText}>
          The device list couldn't load. Pull to refresh or try again shortly.
        </Text>
      ) : people.length === 0 ? (
        <Text style={styles.noDevices}>Nobody on the roster yet.</Text>
      ) : (
        people.map((person) => (
          <PersonDevices
            key={person.teamMemberId}
            person={person}
            deletingId={deletingId}
            onRename={setRenaming}
            onDelete={(device) => void handleDelete(device)}
          />
        ))
      )}
      <RenameDeviceSheet
        device={renaming}
        onClose={() => setRenaming(null)}
        onSaved={() => {
          setRenaming(null);
          refreshDevicesAndMap();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 16,
    gap: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 16,
    color: c.foreground,
  },
  headerHint: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  personHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  consentLabel: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 10,
    color: c.mutedForeground,
  },
  personBlock: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 10,
    gap: 6,
  },
  personName: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  personRole: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  noDevices: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  errorText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  deviceLabel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.foreground,
  },
  deviceStatus: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 11,
    color: c.mutedForeground,
  },
  deviceHealth: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 11,
    color: "#b45309",
  },
  deviceHealthHelp: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 11,
    lineHeight: 16,
    color: c.mutedForeground,
  },
  deviceLive: {
    color: "#059669",
    fontFamily: "PlusJakartaSans_600SemiBold",
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  sheet: {
    flex: 1,
    backgroundColor: c.background,
    paddingHorizontal: 16,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  sheetTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 16,
    color: c.foreground,
  },
  sheetCancel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.mutedForeground,
  },
  sheetSave: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.brandPink,
  },
  sheetHint: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
    marginTop: 4,
    marginBottom: 12,
  },
  sheetInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    backgroundColor: c.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 15,
    color: c.foreground,
  },
  sheetError: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
    marginTop: 10,
  },
});
