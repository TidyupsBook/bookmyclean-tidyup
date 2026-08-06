import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgGradient,
  Path,
  Stop,
} from "react-native-svg";
import colors from "@/constants/colors";

/** The four-pointed sparkle mark from the web app's logo.svg. */
export function SparkleLogo({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <SvgGradient id="brand" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={colors.light.brandOrange} />
          <Stop offset="0.5" stopColor={colors.light.brandPink} />
          <Stop offset="1" stopColor={colors.light.brandPurple} />
        </SvgGradient>
      </Defs>
      <Path
        d="M50 8 C54 34 66 46 92 50 C66 54 54 66 50 92 C46 66 34 54 8 50 C34 46 46 34 50 8 Z"
        fill="url(#brand)"
      />
      <Circle cx="82" cy="18" r="6" fill={colors.light.brandPink} />
      <Circle cx="18" cy="82" r="5" fill={colors.light.brandPurple} />
    </Svg>
  );
}

/** Thin horizontal brand gradient rule, used as an accent under headers. */
export function GradientRule({ height = 3 }: { height?: number }) {
  return (
    <LinearGradient
      colors={[
        colors.light.brandOrange,
        colors.light.brandPink,
        colors.light.brandPurple,
      ]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={{ height, borderRadius: height / 2 }}
    />
  );
}

/** Brand gradient filled pressable background. */
export function GradientFill({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  return (
    <LinearGradient
      colors={[
        colors.light.brandOrange,
        colors.light.brandPink,
        colors.light.brandPurple,
      ]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={style}
    >
      {children}
    </LinearGradient>
  );
}

export function BrandHeaderTitle({ title }: { title: string }) {
  return (
    <View style={styles.titleRow}>
      <SparkleLogo size={26} />
      <Text style={styles.titleText}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  titleText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 22,
    color: colors.light.foreground,
  },
});
