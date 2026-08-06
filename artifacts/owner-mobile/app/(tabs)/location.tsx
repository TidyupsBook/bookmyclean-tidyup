import React from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { BrandHeaderTitle, GradientRule } from "@/components/Brand";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";
import {
  useLocationTracking,
  type TrackingStatus,
} from "@/lib/location-tracking";

const c = colors.light;

const STATUS_META: Record<
  TrackingStatus,
  {
    label: string;
    detail: string;
    icon: keyof typeof Feather.glyphMap;
    color: string;
  }
> = {
  sharing: {
    label: "Sharing location",
    detail: "Your dispatcher can see where you are while you're on shift.",
    icon: "navigation",
    color: c.success,
  },
  off: {
    label: "Off",
    detail: "Location sharing is turned off. Flip the switch to share.",
    icon: "slash",
    color: c.mutedForeground,
  },
  denied: {
    label: "Permission denied",
    detail:
      "We need location permission to share your position. Enable it in Settings, then try again.",
    icon: "alert-triangle",
    color: c.warning,
  },
  "outside-hours": {
    label: "Outside working hours",
    detail:
      "Sharing is on but paused. It runs automatically between 8am and 8pm.",
    icon: "clock",
    color: c.warning,
  },
  unsupported: {
    label: "Not available here",
    detail: "Open the app on your phone to share your location.",
    icon: "smartphone",
    color: c.mutedForeground,
  },
};

export default function LocationScreen() {
  const insets = useSafeAreaInsets();
  const {
    status,
    enabled,
    permissionGranted,
    canAskAgain,
    lastSentAt,
    enable,
    disable,
  } = useLocationTracking();

  const meta = STATUS_META[status];
  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const isWeb = Platform.OS === "web";

  const onToggle = (next: boolean) => {
    if (next) void enable();
    else disable();
  };

  const showSettingsButton =
    enabled && !permissionGranted && !canAskAgain && !isWeb;
  const showRetryButton =
    enabled && !permissionGranted && canAskAgain && !isWeb;

  const openSettings = () => {
    if (isWeb) return;
    try {
      void Linking.openSettings();
    } catch {
      // best-effort — some environments can't deep-link to Settings
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: topPad + 12,
        paddingBottom: 110,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
      <BrandHeaderTitle title="Location" />
      <GradientRule height={2} />

      <View style={styles.card}>
        <View style={styles.toggleRow}>
          <View style={styles.toggleText}>
            <Text style={styles.toggleTitle}>Share my location</Text>
            <Text style={styles.toggleSubtitle}>
              Sends your position every 30 seconds while you're on shift.
            </Text>
          </View>
          <Switch
            testID="location-toggle"
            value={enabled}
            onValueChange={onToggle}
            disabled={isWeb}
            trackColor={{ false: c.border, true: c.brandPink }}
            thumbColor="#ffffff"
            ios_backgroundColor={c.border}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.statusRow}>
          <View
            style={[styles.iconWrap, { backgroundColor: `${meta.color}1f` }]}
          >
            <Feather name={meta.icon} size={16} color={meta.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.statusLabel, { color: meta.color }]}>
              {meta.label}
            </Text>
            <Text style={styles.statusDetail}>{meta.detail}</Text>
          </View>
        </View>

        {lastSentAt ? (
          <Text style={styles.lastSent}>Last sent {timeAgo(lastSentAt)}</Text>
        ) : null}

        {showSettingsButton ? (
          <Pressable
            testID="open-settings-button"
            onPress={openSettings}
            style={({ pressed }) => [
              styles.actionButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="settings" size={16} color={c.foreground} />
            <Text style={styles.actionText}>Open Settings</Text>
          </Pressable>
        ) : null}

        {showRetryButton ? (
          <Pressable
            testID="retry-permission-button"
            onPress={() => void enable()}
            style={({ pressed }) => [
              styles.actionButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="refresh-cw" size={16} color={c.foreground} />
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.footnote}>
        Your location is only shared while this switch is on and you're signed
        in, between 8am and 8pm. Turn it off any time.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 16,
    gap: 14,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  toggleText: { flex: 1, gap: 3 },
  toggleTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 16,
    color: c.foreground,
  },
  toggleSubtitle: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
  },
  statusDetail: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
    marginTop: 2,
  },
  lastSent: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.mutedForeground,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.secondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingVertical: 12,
  },
  actionText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  footnote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    lineHeight: 18,
    paddingHorizontal: 4,
  },
});
