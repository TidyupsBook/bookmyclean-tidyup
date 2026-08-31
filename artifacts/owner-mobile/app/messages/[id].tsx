import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMessageThreadQueryKey,
  getGetUnreadMessageCountQueryKey,
  getListMessageThreadsQueryKey,
  useGetMessageThread,
  useSendClientMessage,
  type ClientMessage,
} from "@workspace/api-client-react";
import { ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";
import { formatPhone, telHref } from "@/lib/phone";

const c = colors.light;

function Bubble({ message }: { message: ClientMessage }) {
  const mine = message.direction === "outbound";
  const failed = message.status === "failed";
  return (
    <View style={[styles.bubbleRow, mine && { justifyContent: "flex-end" }]}>
      <View style={{ maxWidth: "82%" }}>
        <View
          style={[
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            failed && styles.bubbleFailed,
          ]}
        >
          <Text style={[styles.bubbleText, mine && { color: "#fff" }]}>
            {message.body}
          </Text>
        </View>
        <Text style={[styles.meta, mine && { textAlign: "right" }]}>
          {failed
            ? message.errorText || "Not delivered"
            : timeAgo(message.createdAt)}
          {mine && message.sentByName ? ` · ${message.sentByName}` : ""}
        </Text>
      </View>
    </View>
  );
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadId = Number(id);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<ClientMessage>>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  const thread = useGetMessageThread(threadId, {
    query: {
      queryKey: getGetMessageThreadQueryKey(threadId),
      refetchInterval: 10_000,
      enabled: Number.isFinite(threadId),
    },
  });
  const send = useSendClientMessage();

  // Reading the thread clears its unread count server-side, so the inbox list
  // behind this screen is now stale.
  const messageCount = thread.data?.messages.length ?? 0;
  useEffect(() => {
    queryClient.invalidateQueries({
      queryKey: getListMessageThreadsQueryKey(),
    });
    // ...and the tab-bar unread badge along with it.
    queryClient.invalidateQueries({
      queryKey: getGetUnreadMessageCountQueryKey(),
    });
  }, [threadId, messageCount, queryClient]);

  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setSendError(null);
    send.mutate(
      { id: threadId, data: { body } },
      {
        onSuccess: () => {
          setDraft("");
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          queryClient.invalidateQueries({
            queryKey: getGetMessageThreadQueryKey(threadId),
          });
          queryClient.invalidateQueries({
            queryKey: getListMessageThreadsQueryKey(),
          });
        },
        onError: (err: unknown) => {
          setSendError(
            err instanceof Error ? err.message : "That text didn't go through.",
          );
        },
      },
    );
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (thread.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }
  if (thread.isError || !thread.data) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't open that conversation."
          onRetry={() => thread.refetch()}
        />
      </View>
    );
  }

  const dial = telHref(thread.data.thread.customerPhone);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Feather name="chevron-left" size={24} color={c.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {thread.data.thread.customerName ||
              formatPhone(thread.data.thread.customerPhone)}
          </Text>
          <Text style={styles.subtitle}>
            {formatPhone(thread.data.thread.customerPhone)}
          </Text>
        </View>
        {dial ? (
          <Pressable onPress={() => Linking.openURL(dial)} hitSlop={12}>
            <Feather name="phone" size={20} color={c.brandPink} />
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        data={thread.data.messages}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <Bubble message={item} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
        onContentSizeChange={() =>
          listRef.current?.scrollToEnd({ animated: false })
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            Nothing sent yet. Write the first message below.
          </Text>
        }
      />

      {sendError ? <Text style={styles.sendError}>{sendError}</Text> : null}

      <View style={[styles.composer, { paddingBottom: insets.bottom + 10 }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Write a text…"
          placeholderTextColor={c.mutedForeground}
          style={styles.input}
          multiline
          maxLength={1600}
        />
        <Pressable
          onPress={submit}
          disabled={!draft.trim() || send.isPending}
          style={({ pressed }) => [
            styles.sendButton,
            (!draft.trim() || send.isPending) && { opacity: 0.5 },
            pressed && { opacity: 0.8 },
          ]}
        >
          {send.isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Feather name="send" size={18} color="#fff" />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  title: {
    color: c.foreground,
    fontSize: 16,
    fontFamily: "PlusJakartaSans_700Bold",
  },
  subtitle: { color: c.mutedForeground, fontSize: 12 },
  bubbleRow: { flexDirection: "row", marginBottom: 12 },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  bubbleMine: { backgroundColor: c.brandPink },
  bubbleTheirs: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
  },
  bubbleFailed: {
    backgroundColor: `${c.destructive}22`,
    borderWidth: 1,
    borderColor: c.destructive,
  },
  bubbleText: {
    color: c.foreground,
    fontSize: 14,
    fontFamily: "PlusJakartaSans_400Regular",
    lineHeight: 20,
  },
  meta: { color: c.mutedForeground, fontSize: 11, marginTop: 4 },
  emptyText: {
    color: c.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    marginTop: 40,
  },
  sendError: {
    color: c.destructive,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    backgroundColor: c.background,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    color: c.foreground,
    fontSize: 14,
    fontFamily: "PlusJakartaSans_400Regular",
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.brandPink,
    alignItems: "center",
    justifyContent: "center",
  },
});
