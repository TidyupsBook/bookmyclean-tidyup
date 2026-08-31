import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCallQueryKey,
  useGetCall,
  useGetCurrentUser,
  useSaveCallAsLead,
  useUpdateCallNotes,
  type TranscriptSegment,
} from "@workspace/api-client-react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { GradientRule } from "@/components/Brand";
import { ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

const c = colors.light;

const STATUS_META: Record<string, { color: string; label: string }> = {
  booked: { color: c.success, label: "Booked" },
  completed: { color: c.brandPurple, label: "Completed" },
  missed: { color: c.destructive, label: "Missed" },
  in_progress: { color: c.warning, label: "Active" },
};

export default function CallDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const callId = Number(id);
  const me = useGetCurrentUser();
  const canTakeLiveCalls = me.data?.canTakeLiveCalls === true;
  const queryClient = useQueryClient();

  const call = useGetCall(callId, {
    query: {
      enabled: Number.isFinite(callId),
      queryKey: getGetCallQueryKey(callId),
    },
  });

  const [leadSaved, setLeadSaved] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const saveAsLead = useSaveCallAsLead();

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (call.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (call.isError || !call.data) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load this call."
          onRetry={() => call.refetch()}
        />
      </View>
    );
  }

  const detail = call.data;
  const meta = STATUS_META[detail.status] ?? {
    color: c.mutedForeground,
    label: detail.status,
  };

  // Offer "Save as lead" for real, unbooked calls where a lead hasn't just
  // been saved in this session.
  const canSaveAsLead = !detail.bookingId && !detail.isTest && !leadSaved;

  function handleSaveAsLead() {
    setLeadError(null);
    saveAsLead.mutate(
      { id: callId },
      {
        onSuccess: () => {
          setLeadSaved(true);
          // Drop into the leads tab so the new lead is visible immediately.
          queryClient.invalidateQueries({
            queryKey: getGetCallQueryKey(callId),
          });
          router.push("/leads");
        },
        onError: (err) => {
          const msg =
            err &&
            typeof err === "object" &&
            "response" in err &&
            err.response &&
            typeof err.response === "object" &&
            "data" in err.response &&
            err.response.data &&
            typeof err.response.data === "object" &&
            "error" in err.response.data &&
            typeof err.response.data.error === "string"
              ? (err.response.data.error as string)
              : "Couldn't save lead — try again.";
          setLeadError(msg);
        },
      },
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingTop: topPad + 8,
        paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 32,
        paddingHorizontal: 16,
        gap: 14,
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
        <View style={[styles.statusPill, { borderColor: meta.color }]}>
          <Text style={[styles.statusPillText, { color: meta.color }]}>
            {meta.label}
          </Text>
        </View>
        {canTakeLiveCalls ? (
          <Pressable
            testID="take-booking-button"
            onPress={() =>
              router.push({
                pathname: "/booking/new",
                params: { callId: String(detail.id) },
              })
            }
            hitSlop={8}
            style={({ pressed }) => [
              styles.takeBookingButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="calendar" size={14} color="#fff" />
          </Pressable>
        ) : (
          <View style={{ width: 36 }} />
        )}
      </View>

      <View>
        <Text style={styles.caller}>
          {detail.callerName || formatPhone(detail.callerPhone)}
        </Text>
        <Text style={styles.subtitle}>
          {timeAgo(detail.startedAt)} ·{" "}
          {Math.floor(detail.durationSeconds / 60)}m{" "}
          {detail.durationSeconds % 60}s{detail.isTest ? " · Test call" : ""}
        </Text>
      </View>

      {canSaveAsLead && (
        <Pressable
          testID="save-as-lead-button"
          onPress={handleSaveAsLead}
          disabled={saveAsLead.isPending}
          style={({ pressed }) => [
            styles.saveLeadButton,
            (pressed || saveAsLead.isPending) && { opacity: 0.7 },
          ]}
        >
          {saveAsLead.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Feather name="user-plus" size={14} color="#fff" />
          )}
          <Text style={styles.saveLeadButtonText}>
            {saveAsLead.isPending ? "Saving…" : "Save as lead"}
          </Text>
        </Pressable>
      )}
      {leadError && <Text style={styles.leadError}>{leadError}</Text>}

      <GradientRule height={2} />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Caller</Text>
        <Pressable
          onPress={() => Linking.openURL(`tel:${detail.callerPhone}`)}
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
        >
          <View style={styles.rowIcon}>
            <Feather name="phone" size={14} color={c.brandPink} />
          </View>
          <View>
            <Text style={styles.rowLabel}>Phone</Text>
            <Text style={styles.rowValue}>
              {formatPhone(detail.callerPhone)}
            </Text>
          </View>
        </Pressable>
        {detail.serviceRequested ? (
          <View style={styles.row}>
            <View style={styles.rowIcon}>
              <Feather name="tag" size={14} color={c.brandOrange} />
            </View>
            <View>
              <Text style={styles.rowLabel}>Service requested</Text>
              <Text style={styles.rowValue}>{detail.serviceRequested}</Text>
            </View>
          </View>
        ) : null}
      </View>

      {detail.summary ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Summary</Text>
          <Text style={styles.bodyText}>{detail.summary}</Text>
        </View>
      ) : null}

      <CallNotesPad
        key={detail.id}
        callId={detail.id}
        initialNotes={detail.notes ?? ""}
      />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Transcript</Text>
        {detail.transcript.length === 0 ? (
          <Text style={styles.mutedNote}>No transcript available.</Text>
        ) : (
          detail.transcript.map((segment: TranscriptSegment, i: number) => (
            <View
              key={i}
              style={[
                styles.bubble,
                segment.speaker === "ai"
                  ? styles.bubbleAi
                  : styles.bubbleCaller,
              ]}
            >
              <Text style={styles.bubbleSpeaker}>
                {segment.speaker === "ai" ? "AI" : "Caller"}
              </Text>
              <Text style={styles.bodyText}>{segment.text}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

/**
 * Same behavior as the web pad (calls.tsx CallNotesPad): autosave a moment
 * after typing stops, flush unsaved keystrokes on unmount, and keep the
 * detail cache in step with what the server accepted. Same field
 * (CallDetail.notes), same PATCH endpoint — the desk and the road stay in
 * sync. Empty string clears; the API caps notes at 20,000 characters.
 */
function CallNotesPad({
  callId,
  initialNotes,
}: {
  callId: number;
  initialNotes: string;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const savedRef = useRef(initialNotes);
  const notesRef = useRef(initialNotes);
  notesRef.current = notes;
  const queryClient = useQueryClient();
  const updateNotes = useUpdateCallNotes({
    mutation: {
      onSuccess: (detail, variables) => {
        savedRef.current = variables.data.notes;
        if (notesRef.current === variables.data.notes) setStatus("saved");
        queryClient.setQueryData(getGetCallQueryKey(callId), detail);
      },
      onError: () => setStatus("error"),
    },
  });
  const mutateRef = useRef(updateNotes.mutate);
  mutateRef.current = updateNotes.mutate;

  // Autosave a moment after typing stops.
  useEffect(() => {
    if (notes === savedRef.current) return;
    setStatus("saving");
    const t = setTimeout(() => {
      mutateRef.current({ id: callId, data: { notes } });
    }, 800);
    return () => clearTimeout(t);
  }, [notes, callId]);

  // Flush unsaved keystrokes if the screen closes mid-pause.
  useEffect(() => {
    return () => {
      if (notesRef.current !== savedRef.current) {
        mutateRef.current({ id: callId, data: { notes: notesRef.current } });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.card}>
      <View style={styles.notesHeader}>
        <Text style={styles.cardTitle}>Notes</Text>
        <Text style={styles.saveState}>
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && (
            <Text style={{ color: c.destructive }}>Couldn't save</Text>
          )}
        </Text>
      </View>
      <TextInput
        testID="call-notes-input"
        value={notes}
        onChangeText={setNotes}
        multiline
        maxLength={20000}
        placeholder="Jot anything about this call — only your team sees it."
        placeholderTextColor={c.mutedForeground}
        style={styles.notesInput}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  takeBookingButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  statusPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusPillText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
  },
  caller: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 24,
    color: c.foreground,
  },
  subtitle: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.mutedForeground,
    marginTop: 2,
  },
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 14,
    color: c.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 11,
    color: c.mutedForeground,
  },
  rowValue: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
    marginTop: 1,
  },
  bodyText: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.foreground,
    lineHeight: 20,
  },
  mutedNote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  bubble: {
    borderRadius: colors.radius,
    padding: 10,
    gap: 4,
  },
  bubbleAi: {
    backgroundColor: c.secondary,
  },
  bubbleCaller: {
    backgroundColor: c.muted,
  },
  bubbleSpeaker: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 11,
    color: c.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  notesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  saveState: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  notesInput: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 14,
    color: c.foreground,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.input,
    borderRadius: 10,
    padding: 10,
    minHeight: 110,
    textAlignVertical: "top",
  },
  saveLeadButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.brandOrange,
    borderRadius: colors.radius,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  saveLeadButtonText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: "#fff",
  },
  leadError: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.destructive,
    textAlign: "center",
  },
});
