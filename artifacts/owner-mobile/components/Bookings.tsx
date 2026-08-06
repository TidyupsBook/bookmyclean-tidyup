import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import type { Booking } from "@workspace/api-client-react";
import colors from "@/constants/colors";
import { formatMoney, formatTimeInTz } from "@/lib/format";

const c = colors.light;

export const STATUS_META: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  pending: { label: "Pending", color: c.warning, bg: "rgba(251,191,36,0.12)" },
  confirmed: {
    label: "Confirmed",
    color: c.success,
    bg: "rgba(52,211,153,0.12)",
  },
  completed: {
    label: "Completed",
    color: c.brandPurple,
    bg: "rgba(168,85,247,0.14)",
  },
  canceled: {
    label: "Canceled",
    color: c.mutedForeground,
    bg: "rgba(155,143,168,0.14)",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META["pending"];
  return (
    <View style={[styles.badge, { backgroundColor: meta.bg }]}>
      <Text style={[styles.badgeText, { color: meta.color }]}>
        {meta.label}
      </Text>
    </View>
  );
}

/** Quote / deposit lifecycle pills, mirroring the web dashboard's icons. */
export function QuotePills({ booking }: { booking: Booking }) {
  const pills: {
    icon: keyof typeof Feather.glyphMap;
    label: string;
    color: string;
  }[] = [];
  if (booking.depositPaidAt) {
    pills.push({
      icon: "credit-card",
      label: "Deposit paid",
      color: c.success,
    });
  }
  if (booking.quoteApprovedAt) {
    pills.push({
      icon: "thumbs-up",
      label: "Quote approved",
      color: c.brandPink,
    });
  } else if (booking.quoteSentAt) {
    pills.push({
      icon: "message-square",
      label: "Quote sent",
      color: c.brandOrange,
    });
  }
  if (booking.jobberSyncError) {
    pills.push({
      icon: "alert-circle",
      label: "Jobber sync failed",
      color: c.destructive,
    });
  } else if (booking.jobberSynced) {
    pills.push({
      icon: "check-circle",
      label: "Jobber synced",
      color: c.brandPurple,
    });
  }
  if (pills.length === 0) return null;
  return (
    <View style={styles.pillRow}>
      {pills.map((p) => (
        <View key={p.label} style={styles.pill}>
          <Feather name={p.icon} size={12} color={p.color} />
          <Text style={[styles.pillText, { color: p.color }]}>{p.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function bookingTotal(booking: Booking): number | null {
  // A texted quote is frozen at send — show what the customer was promised.
  const totals = booking.quoteSentTotals ?? booking.quoteTotals;
  return totals ? totals.total : null;
}

export function BookingCard({
  booking,
  timezone,
  showPricing = true,
}: {
  booking: Booking;
  timezone: string;
  /** Cleaners see their schedule, never the money. */
  showPricing?: boolean;
}) {
  const router = useRouter();
  const total = showPricing ? bookingTotal(booking) : null;
  // QuotePills carries quote/deposit/Jobber state — business plumbing a
  // cleaner has no need (or right) to see.
  const showPills = showPricing;
  return (
    <Pressable
      testID={`booking-card-${booking.id}`}
      onPress={() => {
        Haptics.selectionAsync();
        router.push(`/booking/${booking.id}`);
      }}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}
    >
      <View style={styles.timeCol}>
        <Text style={styles.time}>
          {formatTimeInTz(booking.scheduledFor, timezone)}
        </Text>
        {total != null && (
          <Text style={styles.price}>{formatMoney(total)}</Text>
        )}
      </View>
      <View style={styles.mainCol}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {booking.customerName}
          </Text>
          <StatusBadge status={booking.status} />
        </View>
        <Text style={styles.service} numberOfLines={1}>
          {booking.service}
        </Text>
        {booking.customerAddress ? (
          <View style={styles.addressRow}>
            <Feather name="map-pin" size={12} color={c.mutedForeground} />
            <Text style={styles.address} numberOfLines={1}>
              {booking.customerAddress}
            </Text>
          </View>
        ) : null}
        {showPills ? <QuotePills booking={booking} /> : null}
      </View>
      <Feather name="chevron-right" size={18} color={c.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.card,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
  },
  timeCol: {
    width: 72,
    alignItems: "flex-start",
    gap: 4,
  },
  time: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: c.foreground,
  },
  price: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
    color: c.brandOrange,
  },
  mainCol: { flex: 1, gap: 3 },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  name: {
    flexShrink: 1,
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 15,
    color: c.foreground,
  },
  service: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.mutedForeground,
  },
  addressRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  address: {
    flex: 1,
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  badgeText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 11,
  },
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: c.secondary,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 11,
  },
});
