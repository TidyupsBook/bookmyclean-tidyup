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
import { clerkAppDestination } from "@/lib/clerk-navigation";
import { codeErrorMessage } from "@/lib/sign-in-steps";

const c = colors.light;

export default function SignUpScreen() {
  const insets = useSafeAreaInsets();
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isSignedIn } = useAuth();
  const router = useRouter();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // The email already has an account: don't leave people staring at Clerk's
  // raw "taken" message — tell them plainly and put a sign-in button in
  // front of them, or they retry sign-up forever.
  const [emailTaken, setEmailTaken] = useState(false);

  const busy = fetchStatus === "fetching";

  const handleSubmit = async () => {
    setFormError(null);
    setNotice(null);
    setEmailTaken(false);
    try {
      const { error } = await signUp.password({ emailAddress, password });
      if (error) {
        const code = (error as { code?: string }).code;
        const message = error.message ?? "";
        if (
          code === "form_identifier_exists" ||
          /taken|already/i.test(message)
        ) {
          setEmailTaken(true);
          setFormError(
            "You already have an account with this email — no need to sign up again. Tap below to sign in.",
          );
        } else {
          setFormError(message || "Sign up failed. Check your details.");
        }
        return;
      }
      const sent = await signUp.verifications.sendEmailCode();
      if (sent.error) {
        setFormError(
          sent.error.message ??
            "We couldn't send your code. Check your connection and try again.",
        );
      }
    } catch {
      setFormError(
        "We couldn't reach Book My Cleaning. Check your connection and try again.",
      );
    }
  };

  const handleResend = async () => {
    setFormError(null);
    setNotice(null);
    try {
      const { error } = await signUp.verifications.sendEmailCode();
      if (error) {
        setFormError(
          error.message ??
            "We couldn't send a new code. Check your connection and try again.",
        );
        return;
      }
      setCode("");
      setNotice("New code sent.");
    } catch {
      setFormError(
        "We couldn't reach Book My Cleaning. Check your connection and try again.",
      );
    }
  };

  const handleVerify = async () => {
    setFormError(null);
    setNotice(null);
    // A wrong code has to read as "try again", not as a screen that ignored you.
    try {
      const { error } = await signUp.verifications.verifyEmailCode({ code });
      if (error) {
        setFormError(codeErrorMessage(error));
        return;
      }
    } catch {
      setFormError(
        "We couldn't reach Book My Cleaning. Check your connection and try again.",
      );
      return;
    }
    if (signUp.status === "complete") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await signUp.finalize({
        navigate: ({ session, decorateUrl }) => {
          if (session?.currentTask) return;
          router.push(
            clerkAppDestination(
              decorateUrl("/"),
              Platform.OS === "web" ? window.location.origin : undefined,
            ) as Href,
          );
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
          {formError && <Text style={styles.error}>{formError}</Text>}
          {notice && !formError && <Text style={styles.notice}>{notice}</Text>}
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
            testID="resend-code-button"
            onPress={handleResend}
            disabled={busy}
            style={({ pressed }) => [
              styles.linkRow,
              (pressed || busy) && { opacity: 0.7 },
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

          {emailTaken && (
            <Pressable
              testID="email-taken-sign-in-button"
              onPress={() => router.push("/(auth)/sign-in" as Href)}
              style={({ pressed }) => [
                styles.primaryWrap,
                pressed && { opacity: 0.7 },
              ]}
            >
              <GradientFill style={styles.primaryButton}>
                <Text style={styles.primaryText}>Sign in instead</Text>
              </GradientFill>
            </Pressable>
          )}

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
  notice: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 6,
  },
  link: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.brandPink,
  },
});
