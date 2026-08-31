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
import {
  canResendCode,
  codeErrorMessage,
  codeStepSubtitle,
  codeStepTitle,
  planNextSignInStep,
  type SignInStep,
} from "@/lib/sign-in-steps";
import { clerkAppDestination } from "@/lib/clerk-navigation";

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
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Non-null once the password is accepted but Clerk still wants a code.
  const [codeStep, setCodeStep] = useState<Extract<
    SignInStep,
    { kind: "code" }
  > | null>(null);

  const navigateHome = useCallback(
    (url: string) =>
      router.push(
        clerkAppDestination(
          url,
          Platform.OS === "web" ? window.location.origin : undefined,
        ) as Href,
      ),
    [router],
  );

  const finalizeSession = useCallback(async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const { error } = await signIn.finalize({
      navigate: ({ session, decorateUrl }) => {
        if (session?.currentTask) return;
        navigateHome(decorateUrl("/"));
      },
    });
    if (error) {
      setFormError(
        error.message ??
          "We verified you but couldn't open the app. Check your connection and try again.",
      );
    }
  }, [signIn, navigateHome]);

  /** Sends the code for a step that has one to send. */
  const sendCodeFor = useCallback(
    async (step: Extract<SignInStep, { kind: "code" }>) => {
      if (step.phase === "first") {
        return step.channel === "email_code"
          ? signIn.emailCode.sendCode()
          : signIn.phoneCode.sendCode();
      }
      if (step.channel === "email_code") return signIn.mfa.sendEmailCode();
      if (step.channel === "phone_code") return signIn.mfa.sendPhoneCode();
      // Authenticator apps and backup codes have nothing to send.
      return { error: null };
    },
    [signIn],
  );

  /**
   * Reads whatever the sign-in still needs and drives it here, rather than
   * handing the person off to a computer. Called after every step so a
   * two-stage flow (code, then MFA) keeps moving without extra plumbing.
   */
  const advance = useCallback(async () => {
    const step = planNextSignInStep(signIn);
    if (step.kind === "complete") {
      setCodeStep(null);
      await finalizeSession();
      return;
    }
    if (step.kind === "blocked") {
      setCodeStep(null);
      setFormError(step.message);
      return;
    }
    setCode("");
    setFormError(null);
    setCodeStep(step);
    const { error } = await sendCodeFor(step);
    if (error) {
      setFormError(
        error.message ??
          "We couldn't send your code. Check your connection and try again.",
      );
      return;
    }
    if (canResendCode(step.channel)) setNotice("Code sent.");
  }, [signIn, finalizeSession, sendCodeFor]);

  const handleSubmit = async () => {
    setFormError(null);
    setNotice(null);
    try {
      const { error } = await signIn.password({ emailAddress, password });
      if (error) {
        setFormError(error.message ?? "Sign in failed. Check your details.");
        return;
      }
      await advance();
    } catch {
      setFormError(
        "We couldn't reach Book My Cleaning. Check your connection and try again.",
      );
    }
  };

  const verifyCode = useCallback(
    async (step: Extract<SignInStep, { kind: "code" }>, value: string) => {
      if (step.phase === "first") {
        return step.channel === "email_code"
          ? signIn.emailCode.verifyCode({ code: value })
          : signIn.phoneCode.verifyCode({ code: value });
      }
      switch (step.channel) {
        case "email_code":
          return signIn.mfa.verifyEmailCode({ code: value });
        case "phone_code":
          return signIn.mfa.verifyPhoneCode({ code: value });
        case "totp":
          return signIn.mfa.verifyTOTP({ code: value });
        case "backup_code":
          return signIn.mfa.verifyBackupCode({ code: value });
      }
    },
    [signIn],
  );

  const handleVerify = async () => {
    if (!codeStep) return;
    setFormError(null);
    setNotice(null);
    try {
      const { error } = await verifyCode(codeStep, code.trim());
      if (error) {
        // A wrong code leaves the screen exactly where it is, with a way out.
        setFormError(codeErrorMessage(error));
        return;
      }
      await advance();
    } catch {
      setFormError(
        "We couldn't reach Book My Cleaning. Check your connection and try again.",
      );
    }
  };

  const handleResend = async () => {
    if (!codeStep) return;
    setFormError(null);
    setNotice(null);
    try {
      const { error } = await sendCodeFor(codeStep);
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

  const handleStartOver = async () => {
    setFormError(null);
    setNotice(null);
    setCode("");
    setCodeStep(null);
    setPassword("");
    await signIn.reset();
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
            navigateHome(decorateUrl("/"));
          },
        });
      }
    } catch (err) {
      setFormError("Google sign-in did not complete. Try again.");
      console.error(JSON.stringify(err, null, 2));
    }
  }, [startSSOFlow, navigateHome]);

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
        <Text style={styles.appName}>
          {codeStep ? codeStepTitle(codeStep.channel) : "Book My Cleaning"}
        </Text>
        <Text style={styles.tagline}>
          {codeStep
            ? codeStepSubtitle(codeStep.channel, codeStep.sentTo)
            : "Your jobs, from the van"}
        </Text>
        <View style={{ alignSelf: "stretch", marginTop: 18 }}>
          <GradientRule />
        </View>
      </View>

      {codeStep ? (
        <>
          <Text style={styles.label}>
            {codeStep.channel === "backup_code"
              ? "Backup code"
              : "Verification code"}
          </Text>
          <TextInput
            testID="code-input"
            style={styles.input}
            value={code}
            placeholder={codeStep.channel === "backup_code" ? "" : "123456"}
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoFocus
            onChangeText={setCode}
            keyboardType={
              codeStep.channel === "backup_code" ? "default" : "number-pad"
            }
          />
          {errors.fields.code && (
            <Text style={styles.error}>{errors.fields.code.message}</Text>
          )}
          {formError && <Text style={styles.error}>{formError}</Text>}
          {notice && !formError && <Text style={styles.notice}>{notice}</Text>}

          <Pressable
            testID="verify-button"
            onPress={handleVerify}
            disabled={!code.trim() || busy}
            style={({ pressed }) => [
              styles.primaryWrap,
              (pressed || busy || !code.trim()) && { opacity: 0.7 },
            ]}
          >
            <GradientFill style={styles.primaryButton}>
              <Text style={styles.primaryText}>
                {busy ? "Checking…" : "Verify"}
              </Text>
            </GradientFill>
          </Pressable>

          {canResendCode(codeStep.channel) && (
            <Pressable
              testID="resend-code-button"
              onPress={handleResend}
              disabled={busy}
              style={({ pressed }) => [
                styles.linkRow,
                (pressed || busy) && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.link}>Send a new code</Text>
            </Pressable>
          )}

          <Pressable
            testID="start-over-button"
            onPress={handleStartOver}
            style={({ pressed }) => [
              styles.linkRowTight,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.linkMuted}>Use a different account</Text>
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
              (pressed || busy || !emailAddress || !password) && {
                opacity: 0.7,
              },
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
        </>
      )}
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
  linkRowTight: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 14,
  },
  notice: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 6,
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
