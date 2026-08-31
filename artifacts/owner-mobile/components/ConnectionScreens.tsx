/**
 * Full-screen holding states for the launch gate.
 *
 * These stand in for the sign-in screen while the app can't be sure about the
 * stored session. Showing the password form because a token refresh timed out
 * is how a signed-in cleaner ends up locked out of their day.
 */
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SparkleLogo } from "@/components/Brand";
import colors from "@/constants/colors";

const c = colors.light;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.screen}>
      <SparkleLogo size={48} />
      {children}
    </View>
  );
}

/** Boot: the stored session is still loading. */
export function AuthLoadingScreen() {
  return (
    <Shell>
      <ActivityIndicator
        testID="auth-loading-spinner"
        color={c.brandPink}
        style={{ marginTop: 24 }}
      />
    </Shell>
  );
}

/** Signed in, but Clerk can't be reached to confirm it right now. */
export function ReconnectingScreen() {
  return (
    <Shell>
      <ActivityIndicator color={c.brandPink} style={{ marginTop: 24 }} />
      <Text testID="reconnecting-message" style={styles.title}>
        Reconnecting…
      </Text>
      <Text style={styles.body}>
        You&apos;re still signed in. We&apos;ll pick up where you left off as
        soon as there&apos;s a connection.
      </Text>
    </Shell>
  );
}

/** Clerk failed to start at all — nothing to wait for, so say what to do. */
export function AuthUnavailableScreen() {
  return (
    <Shell>
      <Text testID="auth-unavailable-message" style={styles.title}>
        Can&apos;t reach Book My Cleaning
      </Text>
      <Text style={styles.body}>
        Check your phone&apos;s connection, then close and reopen the app.
      </Text>
    </Shell>
  );
}

/**
 * Signed in, but the profile (role/workspace) is still on its way. Shown
 * instead of a blank screen between "signed in" and "tabs visible".
 */
export function ProfileLoadingScreen() {
  return (
    <Shell>
      <ActivityIndicator
        testID="profile-loading-spinner"
        color={c.brandPink}
        style={{ marginTop: 24 }}
      />
      <Text style={styles.body}>Setting up your workspace…</Text>
    </Shell>
  );
}

/** The profile call keeps failing — say so and offer a retry. */
export function ProfileErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <Shell>
      <Text testID="profile-error-message" style={styles.title}>
        We couldn&apos;t load your profile
      </Text>
      <Text style={styles.body}>
        You&apos;re signed in, but we couldn&apos;t reach the server to set up
        your workspace. Check your connection and try again.
      </Text>
      <Pressable
        testID="profile-error-retry"
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [styles.button, pressed && { opacity: 0.8 }]}
      >
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
    </Shell>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    backgroundColor: c.background,
  },
  title: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 18,
    color: c.foreground,
    marginTop: 20,
    textAlign: "center",
  },
  button: {
    marginTop: 24,
    backgroundColor: c.brandPink,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  buttonText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: "#fff",
  },
  body: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.mutedForeground,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 20,
  },
});
