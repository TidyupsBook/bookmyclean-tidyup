import React, { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClerk } from "@clerk/expo";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCurrentUserQueryKey,
  useCancelJoinRequest,
  useRequestToJoinCompany,
  type CurrentUser,
} from "@workspace/api-client-react";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { GradientFill, GradientRule, SparkleLogo } from "@/components/Brand";
import colors from "@/constants/colors";

const c = colors.light;

/**
 * Shown instead of the tabs when a signed-in account has no workspace yet.
 *
 * On the web there's a full onboarding page for this (create a company, or
 * ask to join one with the office's join code). A cleaner who signs up on
 * their phone used to land in an empty tab set where every API call 403'd —
 * or worse, they'd go create a second, empty company on the website. This
 * screen gives them the one path that makes sense on a phone: enter the join
 * code, then wait for the office to let them in.
 *
 * Creating a company stays web-only on purpose — setting up lines, services
 * and pricing is desk work.
 */
export function WorkspaceGate({ me }: { me: CurrentUser }) {
  const insets = useSafeAreaInsets();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const requestToJoin = useRequestToJoinCompany();
  const cancelRequest = useCancelJoinRequest();

  const [joinCode, setJoinCode] = useState("");
  const [name, setName] = useState(me.name ?? "");
  const [phone, setPhone] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const refreshMe = () =>
    queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });

  // While they're waiting on the office, check for a verdict on a timer so
  // approval moves them into the app without anyone hammering "Check again".
  const waiting = Boolean(me.pendingCompanyName);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refreshMe(), 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  const submit = () => {
    setFormError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Add your name — your boss needs to know who's asking.");
      return;
    }
    requestToJoin.mutate(
      {
        data: {
          joinCode: joinCode.trim(),
          name: trimmedName,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        },
      },
      {
        onSuccess: () => void refreshMe(),
        onError: (error: unknown) => {
          setFormError(
            (error as { data?: { error?: string } })?.data?.error ??
              "Couldn't send your request. Check the code with your office and try again.",
          );
        },
      },
    );
  };

  const paddingTop = (Platform.OS === "web" ? 67 : insets.top) + 48;
  const paddingBottom = (Platform.OS === "web" ? 34 : insets.bottom) + 24;

  if (me.pendingCompanyName) {
    return (
      <View
        style={[
          styles.container,
          { flex: 1, paddingTop, paddingBottom, backgroundColor: c.background },
        ]}
        testID="workspace-gate-waiting"
      >
        <View style={styles.logoBlock}>
          <SparkleLogo size={56} />
          <Text style={styles.appName}>Waiting on {me.pendingCompanyName}</Text>
          <Text style={styles.tagline}>
            Your request went through — whoever runs the office has been told
            you're waiting. This screen checks on its own, and if you left a
            phone number you'll get a text the moment you're let in.
          </Text>
          <View style={{ alignSelf: "stretch", marginTop: 18 }}>
            <GradientRule />
          </View>
        </View>

        <Pressable
          testID="check-approval-button"
          onPress={() => void refreshMe()}
          style={({ pressed }) => [
            styles.primaryWrap,
            pressed && { opacity: 0.7 },
          ]}
        >
          <GradientFill style={styles.primaryButton}>
            <Text style={styles.primaryText}>Check again</Text>
          </GradientFill>
        </Pressable>
        <Pressable
          testID="withdraw-request-button"
          disabled={cancelRequest.isPending}
          onPress={() =>
            cancelRequest.mutate(undefined, {
              onSuccess: () => void refreshMe(),
            })
          }
          style={({ pressed }) => [
            styles.secondaryButton,
            (pressed || cancelRequest.isPending) && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.secondaryText}>
            {cancelRequest.isPending ? "Withdrawing…" : "Withdraw my request"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void signOut()}
          style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.link}>Sign out</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingTop, paddingBottom }]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <View style={styles.logoBlock} testID="workspace-gate-join">
        <SparkleLogo size={56} />
        <Text style={styles.appName}>Join your team</Text>
        <Text style={styles.tagline}>
          {me.email
            ? `${me.email} isn't part of a workspace yet. Enter your office's join code and they'll let you in.`
            : "This account isn't part of a workspace yet. Enter your office's join code and they'll let you in."}
        </Text>
        <View style={{ alignSelf: "stretch", marginTop: 18 }}>
          <GradientRule />
        </View>
      </View>

      <Text style={styles.label}>Join code</Text>
      <TextInput
        testID="join-code-input"
        style={[styles.input, styles.codeInput]}
        value={joinCode}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="e.g. K7RQ2M"
        placeholderTextColor={c.mutedForeground}
        onChangeText={(v) => setJoinCode(v.toUpperCase())}
      />
      <Text style={styles.hint}>
        Ask your office for the code — it's on their Staff page.
      </Text>

      <Text style={styles.label}>Your full name</Text>
      <TextInput
        testID="join-name-input"
        style={styles.input}
        value={name}
        placeholder="First and last name"
        placeholderTextColor={c.mutedForeground}
        onChangeText={setName}
      />

      <Text style={styles.label}>Your phone (optional)</Text>
      <TextInput
        testID="join-phone-input"
        style={styles.input}
        value={phone}
        placeholder="So they can text you when you're in"
        placeholderTextColor={c.mutedForeground}
        keyboardType="phone-pad"
        onChangeText={setPhone}
      />

      {formError && <Text style={styles.error}>{formError}</Text>}

      <Pressable
        testID="send-join-request-button"
        onPress={submit}
        disabled={requestToJoin.isPending || !joinCode.trim()}
        style={({ pressed }) => [
          styles.primaryWrap,
          (pressed || requestToJoin.isPending || !joinCode.trim()) && {
            opacity: 0.7,
          },
        ]}
      >
        <GradientFill style={styles.primaryButton}>
          <Text style={styles.primaryText}>
            {requestToJoin.isPending ? "Sending…" : "Ask to join"}
          </Text>
        </GradientFill>
      </Pressable>

      <Text style={styles.footNote}>
        Run your own cleaning business? Set it up on the web dashboard — then
        sign in here with the same account.
      </Text>

      <Pressable
        onPress={() => void signOut()}
        style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.link}>Use a different account</Text>
      </Pressable>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24 },
  logoBlock: { alignItems: "center", marginBottom: 24 },
  appName: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 24,
    color: c.foreground,
    marginTop: 14,
    textAlign: "center",
  },
  tagline: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.mutedForeground,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 20,
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
  codeInput: {
    fontFamily: "PlusJakartaSans_700Bold",
    letterSpacing: 4,
  },
  hint: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 6,
  },
  error: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.destructive,
    marginTop: 10,
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
  secondaryButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    alignItems: "center",
    paddingVertical: 14,
  },
  secondaryText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 15,
    color: c.foreground,
  },
  footNote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 20,
    textAlign: "center",
    lineHeight: 18,
  },
  linkRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 22,
  },
  link: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.brandPink,
  },
});
