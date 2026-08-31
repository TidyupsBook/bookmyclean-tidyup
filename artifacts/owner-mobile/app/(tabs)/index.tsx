import React, { useMemo } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClerk } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import {
  getGetDashboardSummaryQueryKey,
  useGetCompany,
  useGetCurrentUser,
  useGetDashboardSummary,
  useListBookings,
  type Booking,
} from "@workspace/api-client-react";
import { type Href, useRouter } from "expo-router";
import { BrandHeaderTitle, GradientRule } from "@/components/Brand";
import { BookingCard } from "@/components/Bookings";
import {
  EmptyView,
  ErrorView,
  LoadingView,
  OutageBanner,
} from "@/components/StateViews";
import colors from "@/constants/colors";
import { canSeeBusinessDetails } from "@/lib/roles";
import {
  dayKeyInTz,
  formatDayFromKey,
  isValidTimeZone,
  nextDayKey,
} from "@/lib/format";

const c = colors.light;

export default function JobsScreen() {
  const insets = useSafeAreaInsets();
  const { signOut } = useClerk();

  // The company record carries the timezone every booking time must be
  // rendered in. Never fall back to UTC/device time — wait for it instead.
  const company = useGetCompany();

  // Only fetch a tight window around today and tomorrow. The mobile home
  // screen only shows two days, so there's no reason to pull years of history.
  // ±7 days from today in UTC covers any timezone offset and DST edge case;
  // the client-side dayKeyInTz filter below still picks the exact two days.
  const mobileBookingsParams = (() => {
    const sevenDayMs = 7 * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - sevenDayMs).toISOString().slice(0, 10);
    const until = new Date(Date.now() + sevenDayMs).toISOString().slice(0, 10);
    return { since, until };
  })();
  const bookings = useListBookings(mobileBookingsParams);
  // Cleaners see their schedule, not the business's money — pricing stays
  // off their cards entirely.
  const me = useGetCurrentUser();
  const router = useRouter();
  const showBusinessDetails = canSeeBusinessDetails(me.data?.role);
  // New-leads count is business detail — the endpoint 403s a cleaner, so
  // don't even ask until the role proves it's allowed.
  const summary = useGetDashboardSummary({
    query: {
      queryKey: getGetDashboardSummaryQueryKey(),
      enabled: showBusinessDetails,
    },
  });
  const newLeads = summary.data?.newLeads ?? 0;

  const rawTimezone = company.data?.timezone;
  // Strict: an unusable timezone is an error state, never a device fallback.
  const timezone =
    rawTimezone && isValidTimeZone(rawTimezone) ? rawTimezone : undefined;

  const { todayKey, tomorrowKey, today, tomorrow } = useMemo(() => {
    if (!timezone) {
      return {
        todayKey: "",
        tomorrowKey: "",
        today: [] as Booking[],
        tomorrow: [] as Booking[],
      };
    }
    const list: Booking[] = bookings.data ?? [];
    const key = dayKeyInTz(new Date(), timezone);
    // Advance by civil calendar day (DST-safe), not by +24 hours.
    const nextKey = nextDayKey(key);
    const active = list.filter((b) => b.status !== "canceled");
    const byTime = (a: Booking, b: Booking) =>
      new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime();
    return {
      todayKey: key,
      tomorrowKey: nextKey,
      today: active
        .filter((b) => dayKeyInTz(b.scheduledFor, timezone) === key)
        .sort(byTime),
      tomorrow: active
        .filter((b) => dayKeyInTz(b.scheduledFor, timezone) === nextKey)
        .sort(byTime),
    };
  }, [bookings.data, timezone]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (bookings.isLoading || company.isLoading || me.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  // The role gates what's visible — never render with an unknown role, or a
  // cleaner could briefly get the owner view.
  if (
    bookings.isError ||
    company.isError ||
    me.isError ||
    !me.data ||
    !timezone
  ) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load your schedule. Check your connection."
          onRetry={() => {
            bookings.refetch();
            company.refetch();
            me.refetch();
          }}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: topPad + 12,
        paddingBottom: 110,
        paddingHorizontal: 16,
        gap: 14,
      }}
      refreshControl={
        <RefreshControl
          refreshing={bookings.isRefetching}
          onRefresh={() => {
            bookings.refetch();
            company.refetch();
            if (showBusinessDetails) summary.refetch();
          }}
          tintColor={c.brandPink}
        />
      }
    >
      <View style={styles.headerRow}>
        <BrandHeaderTitle title="Jobs" />
        <View style={styles.headerActions}>
          {showBusinessDetails ? (
            <Pressable
              testID="booking-form-settings-button"
              onPress={() => router.push("/booking-form-settings" as Href)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.iconButton,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Feather name="sliders" size={18} color={c.mutedForeground} />
            </Pressable>
          ) : null}
          <Pressable
            testID="sign-out-button"
            onPress={() => signOut()}
            hitSlop={8}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Feather name="log-out" size={18} color={c.mutedForeground} />
          </Pressable>
        </View>
      </View>

      {company.data?.quoNeedsReauth ? (
        <OutageBanner workspaceName={company.data?.quoWorkspaceName} />
      ) : null}

      {showBusinessDetails && newLeads > 0 ? (
        <Pressable
          testID="new-leads-banner"
          onPress={() => router.push("/leads")}
          style={({ pressed }) => [
            styles.leadsBanner,
            pressed && { opacity: 0.7 },
          ]}
        >
          {/* Orange = leads, matching the web sidebar's leads badge; pink
              is customer texts, purple is chat, red is calls. */}
          <View style={styles.leadsIconWrap}>
            <Feather name="user-plus" size={16} color={c.brandOrange} />
          </View>
          <Text style={styles.leadsBannerText}>
            {newLeads === 1 ? "1 new lead" : `${newLeads} new leads`} to review
          </Text>
          <Feather name="chevron-right" size={16} color={c.mutedForeground} />
        </Pressable>
      ) : null}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Today</Text>
        <Text style={styles.sectionDate}>{formatDayFromKey(todayKey)}</Text>
      </View>
      <GradientRule height={2} />
      {today.length === 0 ? (
        <EmptyView
          icon="coffee"
          title="Nothing on today"
          subtitle="No jobs scheduled for today."
        />
      ) : (
        today.map((b) => (
          <BookingCard
            key={b.id}
            booking={b}
            timezone={timezone}
            showPricing={showBusinessDetails}
          />
        ))
      )}

      <View style={[styles.sectionHeader, { marginTop: 14 }]}>
        <Text style={styles.sectionTitle}>Tomorrow</Text>
        <Text style={styles.sectionDate}>{formatDayFromKey(tomorrowKey)}</Text>
      </View>
      <GradientRule height={2} />
      {tomorrow.length === 0 ? (
        <EmptyView
          icon="calendar"
          title="Nothing tomorrow yet"
          subtitle="New bookings from calls will show up here."
        />
      ) : (
        tomorrow.map((b) => (
          <BookingCard
            key={b.id}
            booking={b}
            timezone={timezone}
            showPricing={showBusinessDetails}
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
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
  leadsBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 12,
  },
  leadsIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: `${c.brandOrange}1f`,
    alignItems: "center",
    justifyContent: "center",
  },
  leadsBannerText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: 4,
  },
  sectionTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 17,
    color: c.foreground,
  },
  sectionDate: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.mutedForeground,
  },
});
