import React from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListBookingsQueryKey,
  useGetCompany,
  useGetCurrentUser,
  useListBookings,
  useUpdateBooking,
  type Booking,
} from "@workspace/api-client-react";
import { GradientRule } from "@/components/Brand";
import { QuotePills, StatusBadge } from "@/components/Bookings";
import { ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { canSeeBusinessDetails } from "@/lib/roles";
import {
  formatDayInTz,
  formatMoney,
  formatTimeInTz,
  isValidTimeZone,
} from "@/lib/format";

const c = colors.light;

function Row({
  icon,
  label,
  value,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const inner = (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Feather name={icon} size={15} color={c.mutedForeground} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowValue, onPress && { color: c.brandPink }]}>
          {value}
        </Text>
      </View>
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && { opacity: 0.7 }}
    >
      {inner}
    </Pressable>
  );
}

function QuoteSection({ booking }: { booking: Booking }) {
  // A texted quote is frozen at send; prefer what the customer was promised.
  const totals = booking.quoteSentTotals ?? booking.quoteTotals;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Quote & deposit</Text>
      <QuotePills booking={booking} />
      {totals ? (
        <View style={{ marginTop: 10, gap: 6 }}>
          {totals.lineItems.map((li, i) => (
            <View key={`${li.name}-${i}`} style={styles.totalRow}>
              <Text style={styles.totalLabel} numberOfLines={1}>
                {li.name}
              </Text>
              <Text style={styles.totalValue}>
                {formatMoney(li.quantity * li.unitPrice)}
              </Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>{totals.taxLabel}</Text>
            <Text style={styles.totalValue}>
              {formatMoney(totals.taxAmount)}
            </Text>
          </View>
          {totals.feesAmount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{totals.feesLabel}</Text>
              <Text style={styles.totalValue}>
                {formatMoney(totals.feesAmount)}
              </Text>
            </View>
          )}
          <View style={[styles.totalRow, styles.grandTotalRow]}>
            <Text style={styles.grandTotalLabel}>Total</Text>
            <Text style={styles.grandTotalValue}>
              {formatMoney(totals.total)}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>
              {booking.depositPaidAt ? "Deposit paid" : "Deposit due"}
            </Text>
            <Text
              style={[
                styles.totalValue,
                booking.depositPaidAt ? { color: c.success } : null,
              ]}
            >
              {formatMoney(booking.depositPaidAmount ?? totals.deposit)}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={styles.mutedNote}>No quote drafted for this job yet.</Text>
      )}
      {!booking.quoteSentAt && totals ? (
        <Text style={styles.mutedNote}>
          Quote hasn't been texted to the customer yet.
        </Text>
      ) : null}
    </View>
  );
}

function CrewSection({
  booking,
  myTeamMemberId,
}: {
  booking: Booking;
  myTeamMemberId: number | null | undefined;
}) {
  const crew = booking.crew ?? [];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Crew</Text>
      {crew.length === 0 ? (
        <Text style={styles.mutedNote}>No one assigned to this job yet.</Text>
      ) : (
        crew.map((m) => (
          <View key={m.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Feather name="user" size={15} color={c.mutedForeground} />
            </View>
            <Text style={styles.rowValue}>
              {m.name}
              {myTeamMemberId != null && m.id === myTeamMemberId
                ? " (you)"
                : ""}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

/** The one action a cleaner takes from the van: this job is done. */
function MarkCompletedButton({ booking }: { booking: Booking }) {
  const queryClient = useQueryClient();
  const update = useUpdateBooking({
    mutation: {
      onSuccess: () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        queryClient.invalidateQueries({
          queryKey: getListBookingsQueryKey(),
        });
      },
    },
  });

  if (booking.status === "completed" || booking.status === "canceled") {
    return null;
  }

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        testID="mark-completed-button"
        disabled={update.isPending}
        onPress={() =>
          update.mutate({ id: booking.id, data: { status: "completed" } })
        }
        style={({ pressed }) => [
          styles.completeButton,
          (pressed || update.isPending) && { opacity: 0.7 },
        ]}
      >
        {update.isPending ? (
          <ActivityIndicator color={c.background} size="small" />
        ) : (
          <Feather name="check-circle" size={18} color={c.background} />
        )}
        <Text style={styles.completeButtonText}>Mark job completed</Text>
      </Pressable>
      {update.isError ? (
        <Text style={styles.completeError}>
          Couldn't update the job. Check your connection and try again.
        </Text>
      ) : null}
    </View>
  );
}

export default function BookingDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Times must render in the company timezone — wait for it, never fall
  // back to UTC/device time.
  const company = useGetCompany();
  const bookings = useListBookings();
  // A cleaner gets the job essentials — when, where, who — never the
  // business's pricing or Jobber plumbing.
  const me = useGetCurrentUser();
  const isCleaner = !canSeeBusinessDetails(me.data?.role);

  const rawTimezone = company.data?.timezone;
  // Strict: an unusable timezone is an error state, never a device fallback.
  const timezone =
    rawTimezone && isValidTimeZone(rawTimezone) ? rawTimezone : undefined;
  const booking = (bookings.data ?? []).find((b) => String(b.id) === id);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (bookings.isLoading || company.isLoading || me.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  // The role gates what's visible — never render with an unknown role, or a
  // cleaner could briefly get the owner view (pricing, Jobber state).
  if (
    bookings.isError ||
    company.isError ||
    me.isError ||
    !me.data ||
    !timezone ||
    !booking
  ) {
    const failedToLoad =
      bookings.isError ||
      company.isError ||
      me.isError ||
      !me.data ||
      !timezone;
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message={failedToLoad ? "Couldn't load this job." : "Job not found."}
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
        paddingTop: topPad + 8,
        paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 32,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
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
        <StatusBadge status={booking.status} />
      </View>

      <View>
        <Text style={styles.customer}>{booking.customerName}</Text>
        <Text style={styles.service}>{booking.service}</Text>
      </View>
      <GradientRule height={2} />

      {booking.needsTimeReview ? (
        <View style={styles.reviewBanner}>
          <Feather name="clock" size={14} color={c.warning} />
          <Text style={styles.reviewText}>
            Time needs review after a timezone change — confirm it on the web
            dashboard.
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Job details</Text>
        <Row
          icon="calendar"
          label="When"
          value={`${formatDayInTz(booking.scheduledFor, timezone)} · ${formatTimeInTz(booking.scheduledFor, timezone)}`}
        />
        <Row
          icon="phone"
          label="Phone"
          value={booking.customerPhone}
          onPress={() => Linking.openURL(`tel:${booking.customerPhone}`)}
        />
        {booking.customerAddress ? (
          <Row
            icon="map-pin"
            label="Address"
            value={booking.customerAddress}
            onPress={() =>
              Linking.openURL(
                Platform.select({
                  ios: `maps:0,0?q=${encodeURIComponent(booking.customerAddress!)}`,
                  default: `https://maps.google.com/?q=${encodeURIComponent(booking.customerAddress!)}`,
                }),
              )
            }
          />
        ) : null}
        {booking.quoteNotes ? (
          <Row icon="file-text" label="Notes" value={booking.quoteNotes} />
        ) : null}
      </View>

      <CrewSection
        booking={booking}
        myTeamMemberId={isCleaner ? me.data?.teamMemberId : null}
      />

      {isCleaner ? <MarkCompletedButton booking={booking} /> : null}

      {isCleaner ? null : <QuoteSection booking={booking} />}

      {isCleaner ? null : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Jobber</Text>
          {booking.jobberSyncError ? (
            <View style={styles.syncErrorWrap}>
              <Feather name="alert-circle" size={15} color={c.destructive} />
              <Text style={styles.syncErrorText}>
                {booking.jobberSyncError}
              </Text>
            </View>
          ) : booking.jobberSynced ? (
            <View style={styles.syncOkWrap}>
              <Feather name="check-circle" size={15} color={c.success} />
              <Text style={styles.syncOkText}>Synced to Jobber</Text>
            </View>
          ) : (
            <Text style={styles.mutedNote}>Not synced to Jobber.</Text>
          )}
        </View>
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
  customer: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 24,
    color: c.foreground,
  },
  service: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.mutedForeground,
    marginTop: 2,
  },
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 14,
    color: c.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 11,
    color: c.mutedForeground,
  },
  rowValue: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
    marginTop: 1,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  totalLabel: {
    flex: 1,
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  totalValue: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
  grandTotalRow: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 8,
    marginTop: 2,
  },
  grandTotalLabel: {
    flex: 1,
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 14,
    color: c.foreground,
  },
  grandTotalValue: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: c.brandOrange,
  },
  mutedNote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  reviewBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(251,191,36,0.10)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
    borderRadius: colors.radius,
    padding: 10,
  },
  reviewText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.warning,
  },
  syncErrorWrap: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  syncErrorText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
  },
  syncOkWrap: { flexDirection: "row", gap: 8, alignItems: "center" },
  syncOkText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.success,
  },
  completeButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.brandPink,
    borderRadius: colors.radius,
    paddingVertical: 14,
  },
  completeButtonText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: c.background,
  },
  completeError: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.destructive,
    textAlign: "center",
  },
});
