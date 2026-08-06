import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import colors from "@/constants/colors";

const c = colors.light;

export function LoadingView() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={c.brandPink} size="large" />
    </View>
  );
}

export function ErrorView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.center}>
      <Feather name="alert-circle" size={28} color={c.destructive} />
      <Text style={styles.errorText}>{message}</Text>
      <Pressable
        testID="retry-button"
        onPress={onRetry}
        style={({ pressed }) => [styles.retry, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

export function EmptyView({
  icon,
  title,
  subtitle,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Feather name={icon} size={22} color={c.mutedForeground} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </View>
  );
}

/** Banner shown when the company's Quo key is failing (phone line outage). */
export function OutageBanner({
  workspaceName,
}: {
  workspaceName?: string | null;
}) {
  return (
    <View style={styles.banner} testID="quo-outage-banner">
      <Feather name="phone-off" size={16} color={c.destructive} />
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>Quo phone connection is down</Text>
        <Text style={styles.bannerBody}>
          {workspaceName ? `${workspaceName}'s` : "Your"} Quo API key stopped
          working — calls and texts are paused. Reconnect it from the web
          dashboard.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 32,
  },
  errorText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.mutedForeground,
    textAlign: "center",
  },
  retry: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 8,
    backgroundColor: c.card,
  },
  retryText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
  empty: {
    alignItems: "center",
    gap: 6,
    paddingVertical: 28,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.secondary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  emptySubtitle: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
    textAlign: "center",
  },
  banner: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    backgroundColor: "rgba(239,68,68,0.10)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.35)",
    borderRadius: colors.radius,
    padding: 12,
  },
  bannerTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 13,
    color: c.destructive,
  },
  bannerBody: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
});
