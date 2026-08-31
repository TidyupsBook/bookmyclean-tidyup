import React from "react";
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import {
  useListCalls,
  useGetCurrentUser,
  useGetCompany,
  type Call,
} from "@workspace/api-client-react";
import { useRouter } from "expo-router";
import { BrandHeaderTitle } from "@/components/Brand";
import { EmptyView, ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

const c = colors.light;

// Owner/dispatcher territory, like the Activity feed this screen is reached
// from — the calls API 403s a cleaner, which lands in the error state below.

/**
 * How long after a call ends the "Take booking" button stays visible on a
 * completed or missed row, in minutes. The owner tapped the call list to act
 * on a fresh lead — beyond this window they're more likely browsing history,
 * and the button would clutter old rows. Owners tune the real value in
 * settings (company.recentCallWindowMinutes); this is only the fallback while
 * the company record hasn't loaded yet, matching the server default.
 */
const DEFAULT_RECENT_CALL_WINDOW_MINUTES = 30;

/**
 * True when the call ended within the company's recent-call window. Uses
 * startedAt + durationSeconds as the end time because the list payload
 * doesn't carry endedAt.
 */
function isRecentCall(call: Call, windowMinutes: number): boolean {
  const endMs =
    new Date(call.startedAt).getTime() + call.durationSeconds * 1000;
  return Date.now() - endMs <= windowMinutes * 60 * 1000;
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  booked: { color: c.success, label: "Booked" },
  completed: { color: c.brandPurple, label: "Completed" },
  missed: { color: c.destructive, label: "Missed" },
  in_progress: { color: c.warning, label: "Active" },
};

function CallRow({
  call,
  canTakeLiveCalls,
  recentWindowMinutes,
  onPress,
  onTakeBooking,
}: {
  call: Call;
  canTakeLiveCalls: boolean;
  recentWindowMinutes: number;
  onPress: () => void;
  onTakeBooking: () => void;
}) {
  const meta = STATUS_META[call.status] ?? {
    color: c.mutedForeground,
    label: call.status,
  };
  const minutes = Math.floor(call.durationSeconds / 60);
  const seconds = call.durationSeconds % 60;
  // Show for active calls, and for completed/missed calls that ended recently
  // and haven't been converted to a booking yet.
  const showTakeBooking =
    canTakeLiveCalls &&
    (call.status === "in_progress" ||
      (call.status !== "booked" && isRecentCall(call, recentWindowMinutes)));
  return (
    <Pressable
      testID={`call-row-${call.id}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: `${meta.color}1f` }]}>
        <Feather name="phone-incoming" size={16} color={meta.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.caller} numberOfLines={1}>
          {call.callerName || formatPhone(call.callerPhone)}
        </Text>
        <Text style={styles.rowMeta}>
          {timeAgo(call.startedAt)} · {minutes}m {seconds}s
          {call.isTest ? " · Test" : ""}
        </Text>
      </View>
      <Text style={[styles.statusLabel, { color: meta.color }]}>
        {meta.label}
      </Text>
      {showTakeBooking ? (
        <Pressable
          testID={`take-booking-${call.id}`}
          onPress={onTakeBooking}
          hitSlop={8}
          style={({ pressed }) => [
            styles.takeBookingButton,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Feather name="calendar" size={13} color="#fff" />
        </Pressable>
      ) : (
        <Feather name="chevron-right" size={16} color={c.mutedForeground} />
      )}
    </Pressable>
  );
}

export default function CallsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const calls = useListCalls();
  const me = useGetCurrentUser();
  const company = useGetCompany();
  const canTakeLiveCalls = me.data?.canTakeLiveCalls === true;
  // Fall back to the server default while the company record loads so the
  // button doesn't pop in/out of existence on refresh.
  const recentWindowMinutes =
    company.data?.recentCallWindowMinutes ?? DEFAULT_RECENT_CALL_WINDOW_MINUTES;

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (calls.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (calls.isError) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load calls."
          onRetry={() => calls.refetch()}
        />
      </View>
    );
  }

  const items = calls.data ?? [];

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        scrollEnabled={items.length > 0}
        contentContainerStyle={{
          paddingTop: topPad + 8,
          paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 32,
          paddingHorizontal: 16,
          gap: 10,
        }}
        refreshControl={
          <RefreshControl
            refreshing={calls.isRefetching}
            onRefresh={() => calls.refetch()}
            tintColor={c.brandPink}
          />
        }
        ListHeaderComponent={
          <View style={styles.headerRow}>
            <Pressable
              testID="back-button"
              onPress={() => router.back()}
              hitSlop={8}
              style={({ pressed }) => [
                styles.iconButton,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Feather name="chevron-left" size={20} color={c.foreground} />
            </Pressable>
            <BrandHeaderTitle title="Calls" />
            <View style={{ width: 36 }} />
          </View>
        }
        ListEmptyComponent={
          <EmptyView
            icon="phone"
            title="No calls yet"
            subtitle="Calls answered by your AI receptionist will appear here."
          />
        }
        renderItem={({ item }) => (
          <CallRow
            call={item}
            canTakeLiveCalls={canTakeLiveCalls}
            recentWindowMinutes={recentWindowMinutes}
            onPress={() => router.push(`/call/${item.id}`)}
            onTakeBooking={() =>
              router.push({
                pathname: "/booking/new",
                params: { callId: String(item.id) },
              })
            }
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 12,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  caller: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  rowMeta: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  statusLabel: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
  },
  takeBookingButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: c.warning,
    alignItems: "center",
    justifyContent: "center",
  },
});
