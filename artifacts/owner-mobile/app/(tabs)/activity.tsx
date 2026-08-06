import React from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  RefreshControl,
  View,
} from "react-native";
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
};

function ActivityRow({ item }: { item: ActivityItem }) {
  const meta = ICONS[item.type] ?? {
    icon: "activity" as const,
    color: c.mutedForeground,
  };
  const isFailure = item.type === "jobber_sync_failed";
  return (
    <View style={[styles.row, isFailure && styles.rowFailure]}>
      <View style={[styles.iconWrap, { backgroundColor: `${meta.color}1f` }]}>
        <Feather name={meta.icon} size={16} color={meta.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.message}>{item.message}</Text>
        <Text style={styles.when}>{timeAgo(item.occurredAt)}</Text>
      </View>
    </View>
  );
}

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
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
            <BrandHeaderTitle title="Activity" />
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
        renderItem={({ item }) => <ActivityRow item={item} />}
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
