import React, { useState } from "react";
import {
  ActivityIndicator,
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
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCompanyQueryKey,
  useGetCompany,
  useGetCurrentUser,
  useUpdateCompany,
  BOOKING_FORM_FIELDS,
  ALL_BOOKING_FORM_FIELD_KEYS,
  CALL_WINDOW_CHOICES,
  DEFAULT_CALL_WINDOW_MINUTES,
} from "@workspace/api-client-react";
import { BrandHeaderTitle } from "@/components/Brand";
import { ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";

const c = colors.light;

/**
 * Owner-only screen: flip which booking fields are required before a booking
 * can be saved. Mirrors the "Booking form" tab in the web Settings page.
 *
 * Each toggle saves immediately and reverts on failure so the phone never
 * shows a rule the server isn't enforcing.
 */
export default function BookingFormSettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const me = useGetCurrentUser();
  const company = useGetCompany();
  const update = useUpdateCompany();

  // Local copy of required fields — mirrors the server state and reverts on
  // save failure so the toggle never lies about what the server enforces.
  const [required, setRequired] = useState<string[] | null>(null);
  // Initialise once from the company record; after that the local state leads.
  const serverRequired = company.data?.bookingRequiredFields ?? [];
  const effective = required ?? serverRequired;

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (me.isLoading || company.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (me.isError || company.isError) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load booking settings."
          onRetry={() => {
            me.refetch();
            company.refetch();
          }}
        />
      </View>
    );
  }

  // Only owners may reach this screen — a cleaner navigating here directly
  // gets a plain "owner only" message instead of 403 toasts.
  if (me.data?.role !== "owner") {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
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
          <BrandHeaderTitle title="Booking form" />
          <View style={{ width: 36 }} />
        </View>
        <View style={styles.accessDenied}>
          <Text style={styles.accessDeniedText}>
            Only the owner can change booking-form settings.
          </Text>
        </View>
      </View>
    );
  }

  const save = (next: string[]) => {
    const previous = effective;
    setRequired(next);
    update.mutate(
      { data: { bookingRequiredFields: next as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
        },
        onError: () => {
          // Revert — the server didn't accept this, so don't show it as active.
          setRequired(previous);
        },
      },
    );
  };

  const allOn = ALL_BOOKING_FORM_FIELD_KEYS.every((k) => effective.includes(k));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: topPad + 8,
        paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 32,
        paddingHorizontal: 16,
        gap: 16,
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
        <BrandHeaderTitle title="Booking form" />
        {/* Right-side spacer keeps the title centred. */}
        <View style={{ width: 36 }} />
      </View>

      <Text style={styles.description}>
        Choose which fields must be filled in before a booking can be saved.
        With everything off, a booking saves with as little as a name or phone
        number. Bookings always need a date.
      </Text>

      <View style={styles.card}>
        {/* Master toggle — flips every field at once. */}
        <View style={[styles.row, styles.masterRow]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>Require all fields</Text>
            <Text style={styles.rowSub}>
              Turn every field on or off at once.
            </Text>
          </View>
          {update.isPending ? (
            <ActivityIndicator size="small" color={c.brandPink} />
          ) : (
            <Switch
              testID="switch-require-all"
              value={allOn}
              onValueChange={(on) =>
                save(on ? [...ALL_BOOKING_FORM_FIELD_KEYS] : [])
              }
              trackColor={{ false: c.border, true: c.brandPink }}
              thumbColor={c.foreground}
            />
          )}
        </View>

        <View style={styles.divider} />

        {/* Per-field toggles. */}
        {BOOKING_FORM_FIELDS.map((field, i) => {
          const isLast = i === BOOKING_FORM_FIELDS.length - 1;
          const on = effective.includes(field.key);
          return (
            <React.Fragment key={field.key}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { flex: 1 }]}>
                  {field.label}
                </Text>
                {update.isPending ? (
                  <ActivityIndicator size="small" color={c.brandPink} />
                ) : (
                  <Switch
                    testID={`switch-require-${field.key}`}
                    value={on}
                    onValueChange={(checked) =>
                      save(
                        checked
                          ? [...effective, field.key]
                          : effective.filter((k) => k !== field.key),
                      )
                    }
                    trackColor={{ false: c.border, true: c.brandPink }}
                    thumbColor={c.foreground}
                  />
                )}
              </View>
              {!isLast && <View style={styles.divider} />}
            </React.Fragment>
          );
        })}
      </View>

      <Text style={styles.footer}>
        These rules apply to the New Booking screen, the Bookings page and the
        web dashboard alike.
      </Text>

      <RecentCallWindowSection
        serverMinutes={
          company.data?.recentCallWindowMinutes ?? DEFAULT_CALL_WINDOW_MINUTES
        }
        onSaved={() =>
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() })
        }
      />
    </ScrollView>
  );
}

function formatWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} h` : `${minutes} min`;
}

function RecentCallWindowSection({
  serverMinutes,
  onSaved,
}: {
  serverMinutes: number;
  onSaved: () => void;
}) {
  const update = useUpdateCompany();
  // Local copy mirrors the server value and reverts on failure, same pattern
  // as the required-field toggles above.
  const [minutes, setMinutes] = useState<number | null>(null);
  const effective = minutes ?? serverMinutes;

  const save = (next: number) => {
    if (next === effective) return;
    const previous = effective;
    setMinutes(next);
    update.mutate(
      { data: { recentCallWindowMinutes: next } },
      {
        onSuccess: onSaved,
        onError: () => setMinutes(previous),
      },
    );
  };

  return (
    <>
      <Text style={styles.sectionTitle}>Take booking shortcut</Text>
      <Text style={styles.description}>
        How long the calendar button stays on a finished call in the Calls list.
        Pick a shorter time to keep the list clean, or longer if bookings often
        come in a while after the call.
      </Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { flex: 1 }]}>Keep for</Text>
          {update.isPending && (
            <ActivityIndicator size="small" color={c.brandPink} />
          )}
        </View>
        <View style={styles.chipRow}>
          {CALL_WINDOW_CHOICES.map((m) => {
            const selected = effective === m;
            return (
              <Pressable
                key={m}
                testID={`window-choice-${m}`}
                disabled={update.isPending}
                onPress={() => save(m)}
                style={({ pressed }) => [
                  styles.chip,
                  selected && styles.chipSelected,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text
                  style={[styles.chipText, selected && styles.chipTextSelected]}
                >
                  {formatWindow(m)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </>
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
  sectionTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 16,
    color: c.foreground,
    marginTop: 8,
    marginBottom: -6,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.secondary,
  },
  chipSelected: {
    backgroundColor: c.brandPink,
    borderColor: c.brandPink,
  },
  chipText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
  chipTextSelected: {
    color: "#fff",
  },
  description: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.mutedForeground,
    lineHeight: 20,
  },
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    overflow: "hidden",
  },
  masterRow: {
    backgroundColor: c.secondary,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  rowLabel: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 15,
    color: c.foreground,
  },
  rowSub: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginHorizontal: 16,
  },
  footer: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    lineHeight: 17,
  },
  accessDenied: {
    margin: 16,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 16,
  },
  accessDeniedText: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.mutedForeground,
  },
});
