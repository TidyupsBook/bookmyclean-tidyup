import React from "react";
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  RefreshControl,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import {
  useGetCompany,
  useGetRecentActivity,
  type ActivityItem,
} from "@workspace/api-client-react";
import { BrandHeaderTitle } from "@/components/Brand";
import {
  EmptyView,
  ErrorView,
  LoadingView,
  OutageBanner,
} from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";

const c = colors.light;

const ICONS: Record<
  string,
  { icon: keyof typeof Feather.glyphMap; color: string }
> = {
  call_answered: { icon: "phone-forwarded", color: c.brandOrange },
  booking_created: { icon: "calendar", color: c.brandPink },
  jobber_synced: { icon: "check-circle", color: c.success },
  jobber_sync_failed: { icon: "alert-circle", color: c.destructive },
  quote_sent: { icon: "message-square", color: c.brandOrange },
  quote_approved: { icon: "thumbs-up", color: c.brandPink },
  deposit_paid: { icon: "credit-card", color: c.success },
  test_call: { icon: "phone-incoming", color: c.brandPurple },
  team_invited: { icon: "user-plus", color: c.brandPurple },
  reschedule_texted: { icon: "clock", color: c.warning },
  cleaner_running_late: { icon: "alert-triangle", color: c.warning },
  cleaner_back_on_time: { icon: "check-circle", color: c.success },
  lead_converted: { icon: "inbox", color: c.brandPink },
  lead_request_received: { icon: "globe", color: c.brandPurple },
};

function ActivityRow({
  item,
  onOpenCall,
  onOpenBooking,
}: {
  item: ActivityItem;
  onOpenCall: (callId: number) => void;
  onOpenBooking: (bookingId: number) => void;
}) {
  const meta = ICONS[item.type] ?? {
    icon: "activity" as const,
    color: c.mutedForeground,
  };
  const isFailure = item.type === "jobber_sync_failed";
  const callId = item.callId;

  const body = (
    <>
      <View style={[styles.iconWrap, { backgroundColor: `${meta.color}1f` }]}>
        <Feather name={meta.icon} size={16} color={meta.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.message}>{item.message}</Text>
        <Text style={styles.when}>{timeAgo(item.occurredAt)}</Text>
      </View>
    </>
  );

  // Only entries that carry a call or booking id are tappable — older rows
  // predate the links and everything else has nowhere to go.
  const bookingId = item.bookingId;
  if (callId == null && bookingId != null) {
    return (
      <Pressable
        testID={`activity-booking-${item.id}`}
        onPress={() => onOpenBooking(bookingId)}
        style={({ pressed }) => [
          styles.row,
          isFailure && styles.rowFailure,
          pressed && { opacity: 0.7 },
        ]}
      >
        {body}
        <Feather name="chevron-right" size={16} color={c.mutedForeground} />
      </Pressable>
    );
  }

  if (callId != null) {
    return (
      <Pressable
        testID={`activity-call-${item.id}`}
        onPress={() => onOpenCall(callId)}
        style={({ pressed }) => [
          styles.row,
          isFailure && styles.rowFailure,
          pressed && { opacity: 0.7 },
        ]}
      >
        {body}
        <Feather name="chevron-right" size={16} color={c.mutedForeground} />
      </Pressable>
    );
  }

  return (
    <View style={[styles.row, isFailure && styles.rowFailure]}>{body}</View>
  );
}

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const company = useGetCompany();
  const activity = useGetRecentActivity();

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (activity.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (activity.isError) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load recent activity."
          onRetry={() => activity.refetch()}
        />
      </View>
    );
  }

  const items = activity.data ?? [];

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        scrollEnabled={items.length > 0}
        contentContainerStyle={{
          paddingTop: topPad + 12,
          paddingBottom: 110,
          paddingHorizontal: 16,
          gap: 10,
        }}
        refreshControl={
          <RefreshControl
            refreshing={activity.isRefetching}
            onRefresh={() => {
              activity.refetch();
              company.refetch();
            }}
            tintColor={c.brandPink}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 14, marginBottom: 6 }}>
            <View style={styles.headerRow}>
              <BrandHeaderTitle title="Activity" />
              <Pressable
                testID="calls-button"
                onPress={() => router.push("/calls")}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.callsButton,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Feather name="phone" size={14} color={c.brandPink} />
                <Text style={styles.callsButtonText}>Calls</Text>
              </Pressable>
            </View>
            {company.data?.quoNeedsReauth ? (
              <OutageBanner workspaceName={company.data?.quoWorkspaceName} />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyView
            icon="activity"
            title="No activity yet"
            subtitle="Calls, bookings, quotes, and sync events will appear here."
          />
        }
        renderItem={({ item }) => (
          <ActivityRow
            item={item}
            onOpenCall={(callId) => router.push(`/call/${callId}`)}
            onOpenBooking={(bookingId) => router.push(`/booking/${bookingId}`)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
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
  rowFailure: {
    borderColor: "rgba(239,68,68,0.4)",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  callsButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  callsButtonText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  message: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.foreground,
  },
  when: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
});
