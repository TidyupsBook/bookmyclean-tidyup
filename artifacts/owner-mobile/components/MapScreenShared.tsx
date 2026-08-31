/**
 * Chrome shared by the Map tab's native and web variants: the header, the
 * loading/empty/error states, and the trail legend listing each live cleaner
 * with their ETA sentence. The map itself is platform-specific (map.tsx /
 * map.web.tsx); everything around it renders identically so the two variants
 * can't drift apart in copy.
 */
import React from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { BrandHeaderTitle, GradientRule } from "@/components/Brand";
import colors from "@/constants/colors";
import {
  colorForTeamMember,
  headingLabel,
  type MapRouteLeg,
} from "@/lib/routeTrails";

const c = colors.light;

export function MapScreenFrame({
  insetsTop,
  loading,
  error,
  empty,
  errorText,
  onRetry,
  children,
}: {
  insetsTop: number;
  loading: boolean;
  error: boolean;
  empty: boolean;
  errorText?: string;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  const topPad = Platform.OS === "web" ? 67 : insetsTop;
  return (
    <View style={styles.screen}>
      <View
        style={[styles.header, { paddingTop: topPad + 12 }]}
        pointerEvents="box-none"
      >
        <BrandHeaderTitle title="Map" />
        <GradientRule height={2} />
      </View>
      <View style={styles.body}>
        {children}
        {loading ? (
          <StateNote icon="loader" text="Loading the live map…" />
        ) : error ? (
          <StateNote
            icon="alert-triangle"
            text={
              errorText ??
              "We couldn't load the live map. It retries on its own."
            }
            onRetry={onRetry}
          />
        ) : empty ? (
          <StateNote
            icon="map"
            text="No one is on the road right now. Trails appear when a cleaner sharing their location has a job to head to."
          />
        ) : null}
      </View>
    </View>
  );
}

function StateNote({
  icon,
  text,
  onRetry,
}: {
  icon: keyof typeof Feather.glyphMap;
  text: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.noteWrap} pointerEvents="box-none">
      <View style={styles.noteCard} pointerEvents="auto">
        <Feather name={icon} size={16} color={c.mutedForeground} />
        <Text style={styles.noteText}>{text}</Text>
        {onRetry ? (
          <Text
            accessibilityRole="button"
            onPress={onRetry}
            style={styles.retry}
          >
            Try again
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The owner's "draw the trails" switch, floating over the top of the map.
 *
 * Only the boss is offered it, and it changes only what he is looking at on
 * this phone — dispatch's map is untouched by what he switches off here.
 */
export function TrailsSwitch({
  value,
  onValueChange,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.trailsWrap}>
      <View style={styles.trailsCard}>
        <Feather
          name="git-branch"
          size={14}
          color={value ? c.brandPink : c.mutedForeground}
        />
        <Text style={styles.trailsLabel}>Trails</Text>
        <Switch
          testID="trails-toggle"
          value={value}
          onValueChange={onValueChange}
          trackColor={{ false: c.border, true: c.brandPink }}
          thumbColor="#ffffff"
          ios_backgroundColor={c.border}
        />
      </View>
    </View>
  );
}

/**
 * One row per live trail: who, in their trail colour, and the same heading
 * sentence the web dashboard shows — "Heading to … · N min away · arrives
 * H:MM · on time / behind schedule".
 */
export function TrailLegend({
  routes,
  timezone,
  nowMs,
}: {
  routes: MapRouteLeg[];
  timezone: string;
  nowMs: number;
}) {
  return (
    <View style={styles.legendWrap} pointerEvents="none">
      <ScrollView
        style={styles.legendScroll}
        contentContainerStyle={{ gap: 8 }}
        scrollEnabled={false}
      >
        {routes.map((r) => {
          const color = colorForTeamMember(r.teamMemberId, r.color);
          return (
            <View key={r.teamMemberId} style={styles.legendRow}>
              <View
                style={[
                  styles.legendSwatch,
                  { backgroundColor: color },
                  r.source === "estimate" && [
                    styles.legendSwatchEstimate,
                    { borderColor: color },
                  ],
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.legendName}>{r.name}</Text>
                <Text
                  style={styles.legendDetail}
                  testID={`trail-eta-${r.teamMemberId}`}
                >
                  {headingLabel(r, timezone, nowMs)}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 14,
    backgroundColor: c.background,
    zIndex: 2,
  },
  body: { flex: 1 },
  noteWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  noteCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingHorizontal: 14,
    paddingVertical: 12,
    maxWidth: 420,
  },
  noteText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.mutedForeground,
    lineHeight: 18,
  },
  retry: {
    color: c.brandPink,
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
  },
  trailsWrap: {
    position: "absolute",
    right: 12,
    top: 12,
    zIndex: 3,
    alignItems: "flex-end",
  },
  trailsCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 6,
  },
  trailsLabel: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
  legendWrap: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: Platform.OS === "web" ? 96 : 100,
  },
  legendScroll: { maxHeight: 190 },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  legendSwatch: {
    width: 18,
    height: 6,
    borderRadius: 3,
  },
  legendSwatchEstimate: {
    // The dashed-line stand-in: a hollow swatch says "estimate" the same way
    // the dashed trail does.
    height: 8,
    backgroundColor: "transparent",
    borderWidth: 2,
    borderStyle: "dashed",
    borderRadius: 2,
  },
  legendName: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 13,
    color: c.foreground,
  },
  legendDetail: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 1,
  },
});
