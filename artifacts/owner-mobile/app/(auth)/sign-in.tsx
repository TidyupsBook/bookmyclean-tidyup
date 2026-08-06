import React, { useCallback, useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSignIn, useSSO } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import * as AuthSession from "expo-auth-session";
import * as Haptics from "expo-haptics";
import { type Href, Link, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { GradientFill, GradientRule, SparkleLogo } from "@/components/Brand";
import colors from "@/constants/colors";

const c = colors.light;

// Preloads the browser on Android to reduce authentication load time.
export const useWarmUpBrowser = () => {
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
};

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  useWarmUpBrowser();
  const insets = useSafeAreaInsets();
  const { signIn, errors, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();
  const router = useRouter();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const navigateHome = useCallback(
    (url: string) => {
      if (url.startsWith("http")) {
        window.location.href = url;
      } else {
        router.push(url as Href);
      }
    },
    [router],
  );

  const handleSubmit = async () => {
    setFormError(null);
    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setFormError(error.message ?? "Sign in failed. Check your details.");
      return;
    }
    if (signIn.status === "complete") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await signIn.finalize({
        navigate: ({ session, decorateUrl }) => {
          if (session?.currentTask) return;
          navigateHome(decorateUrl("/"));
        },
      });
    } else {
      setFormError(
        "Additional verification is required. Sign in on the web dashboard first.",
      );
    }
  };

  const onGooglePress = useCallback(async () => {
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: "oauth_google",
        redirectUrl: AuthSession.makeRedirectUri(),
      });
      if (createdSessionId && setActive) {
        await setActive({
          session: createdSessionId,
          navigate: async ({ session, decorateUrl }) => {
            if (session?.currentTask) return;
            router.push(decorateUrl("/") as Href);
          },
        });
      }
    } catch (err) {
      setFormError("Google sign-in did not complete. Try again.");
      console.error(JSON.stringify(err, null, 2));
    }
  }, [startSSOFlow, router]);

  const busy = fetchStatus === "fetching";

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={[
        styles.container,
        {
          paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 48,
          paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 24,
        },
      ]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <View style={styles.logoBlock}>
        <SparkleLogo size={56} />
        <Text style={styles.appName}>Book My Cleaning</Text>
        <Text style={styles.tagline}>Your jobs, from the van</Text>
        <View style={{ alignSelf: "stretch", marginTop: 18 }}>
          <GradientRule />
        </View>
      </View>

      <Text style={styles.label}>Email</Text>
      <TextInput
        testID="email-input"
        style={styles.input}
        autoCapitalize="none"
        autoComplete="email"
        value={emailAddress}
        placeholder="you@company.com"
        placeholderTextColor={c.mutedForeground}
        onChangeText={setEmailAddress}
        keyboardType="email-address"
      />
      {errors.fields.identifier && (
        <Text style={styles.error}>{errors.fields.identifier.message}</Text>
      )}

      <Text style={styles.label}>Password</Text>
      <TextInput
        testID="password-input"
        style={styles.input}
        value={password}
        placeholder="Your password"
        placeholderTextColor={c.mutedForeground}
        secureTextEntry
        onChangeText={setPassword}
      />
      {errors.fields.password && (
        <Text style={styles.error}>{errors.fields.password.message}</Text>
      )}
      {formError && <Text style={styles.error}>{formError}</Text>}

      <Pressable
        testID="sign-in-button"
        onPress={handleSubmit}
        disabled={!emailAddress || !password || busy}
        style={({ pressed }) => [
          styles.primaryWrap,
          (pressed || busy || !emailAddress || !password) && { opacity: 0.7 },
        ]}
      >
        <GradientFill style={styles.primaryButton}>
          <Text style={styles.primaryText}>
            {busy ? "Signing in…" : "Sign in"}
          </Text>
        </GradientFill>
      </Pressable>

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <Pressable
        testID="google-sign-in-button"
        onPress={onGooglePress}
        style={({ pressed }) => [
          styles.googleButton,
          pressed && { opacity: 0.7 },
        ]}
      >
        <Feather name="chrome" size={17} color={c.foreground} />
        <Text style={styles.googleText}>Continue with Google</Text>
      </Pressable>

      <View style={styles.linkRow}>
        <Text style={styles.linkMuted}>New here? </Text>
        <Link href="/(auth)/sign-up">
          <Text style={styles.link}>Create an account</Text>
        </Link>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 24,
  },
  logoBlock: {
    alignItems: "center",
    marginBottom: 32,
  },
  appName: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 24,
    color: c.foreground,
    marginTop: 14,
  },
  tagline: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.mutedForeground,
    marginTop: 4,
  },
  label: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.mutedForeground,
    marginBottom: 6,
    marginTop: 14,
  },
  input: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 15,
    color: c.foreground,
  },
  error: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.destructive,
    marginTop: 6,
  },
  primaryWrap: { marginTop: 24 },
  primaryButton: {
    borderRadius: colors.radius,
    alignItems: "center",
    paddingVertical: 14,
  },
  primaryText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: "#ffffff",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 20,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: c.border },
  dividerText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.mutedForeground,
  },
  googleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.card,
    borderRadius: colors.radius,
    paddingVertical: 13,
  },
  googleText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  linkRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 26,
  },
  linkMuted: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.mutedForeground,
  },
  link: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.brandPink,
  },
});
