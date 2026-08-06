import React, { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth, useSignUp } from "@clerk/expo";
import * as Haptics from "expo-haptics";
import { type Href, Link, useRouter } from "expo-router";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { GradientFill, GradientRule, SparkleLogo } from "@/components/Brand";
import colors from "@/constants/colors";

const c = colors.light;

export default function SignUpScreen() {
  const insets = useSafeAreaInsets();
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isSignedIn } = useAuth();
  const router = useRouter();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const busy = fetchStatus === "fetching";

  const handleSubmit = async () => {
    setFormError(null);
    const { error } = await signUp.password({ emailAddress, password });
    if (error) {
      setFormError(error.message ?? "Sign up failed. Check your details.");
      return;
    }
    await signUp.verifications.sendEmailCode();
  };

  const handleVerify = async () => {
    setFormError(null);
    await signUp.verifications.verifyEmailCode({ code });
    if (signUp.status === "complete") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await signUp.finalize({
        navigate: ({ session, decorateUrl }) => {
          if (session?.currentTask) return;
          const url = decorateUrl("/");
          if (url.startsWith("http")) {
            window.location.href = url;
          } else {
            router.push(url as Href);
          }
        },
      });
    }
  };

  if (signUp.status === "complete" || isSignedIn) {
    return null;
  }

  const verifying =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields.includes("email_address") &&
    signUp.missingFields.length === 0;

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
        <Text style={styles.appName}>
          {verifying ? "Check your email" : "Create your account"}
        </Text>
        <Text style={styles.tagline}>
          {verifying
            ? "Enter the verification code we sent you"
            : "Same account as your web dashboard"}
        </Text>
        <View style={{ alignSelf: "stretch", marginTop: 18 }}>
          <GradientRule />
        </View>
      </View>

      {verifying ? (
        <>
          <Text style={styles.label}>Verification code</Text>
          <TextInput
            testID="code-input"
            style={styles.input}
            value={code}
            placeholder="123456"
            placeholderTextColor={c.mutedForeground}
            onChangeText={setCode}
            keyboardType="numeric"
          />
          {errors.fields.code && (
            <Text style={styles.error}>{errors.fields.code.message}</Text>
          )}
          <Pressable
            testID="verify-button"
            onPress={handleVerify}
            disabled={busy || !code}
            style={({ pressed }) => [
              styles.primaryWrap,
              (pressed || busy || !code) && { opacity: 0.7 },
            ]}
          >
            <GradientFill style={styles.primaryButton}>
              <Text style={styles.primaryText}>
                {busy ? "Verifying…" : "Verify"}
              </Text>
            </GradientFill>
          </Pressable>
          <Pressable
            onPress={() => signUp.verifications.sendEmailCode()}
            style={({ pressed }) => [
              styles.linkRow,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.link}>I need a new code</Text>
          </Pressable>
        </>
      ) : (
        <>
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
          {errors.fields.emailAddress && (
            <Text style={styles.error}>
              {errors.fields.emailAddress.message}
            </Text>
          )}

          <Text style={styles.label}>Password</Text>
          <TextInput
            testID="password-input"
            style={styles.input}
            value={password}
            placeholder="Choose a password"
            placeholderTextColor={c.mutedForeground}
            secureTextEntry
            onChangeText={setPassword}
          />
          {errors.fields.password && (
            <Text style={styles.error}>{errors.fields.password.message}</Text>
          )}
          {formError && <Text style={styles.error}>{formError}</Text>}

          <Pressable
            testID="sign-up-button"
            onPress={handleSubmit}
            disabled={!emailAddress || !password || busy}
            style={({ pressed }) => [
              styles.primaryWrap,
              (pressed || busy || !emailAddress || !password) && {
                opacity: 0.7,
              },
            ]}
          >
            <GradientFill style={styles.primaryButton}>
              <Text style={styles.primaryText}>
                {busy ? "Creating…" : "Sign up"}
              </Text>
            </GradientFill>
          </Pressable>

          <View style={styles.linkRow}>
            <Text style={styles.linkMuted}>Already have an account? </Text>
            <Link href="/(auth)/sign-in">
              <Text style={styles.link}>Sign in</Text>
            </Link>
          </View>
        </>
      )}

      {/* Required for sign-up flows: Clerk bot protection */}
      <View nativeID="clerk-captcha" />
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24 },
  logoBlock: { alignItems: "center", marginBottom: 32 },
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
