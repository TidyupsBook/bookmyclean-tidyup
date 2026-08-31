import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
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
  getGetStaffConversationQueryKey,
  getListStaffConversationsQueryKey,
  useGetStaffConversation,
  useSendStaffMessage,
  type StaffMessage,
} from "@workspace/api-client-react";
import { ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";

const c = colors.light;

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/**
 * Per-member avatar row for group chats: everyone's initials, with the same
 * green corner dot the chat list uses on members who are live right now.
 */
function MemberAvatars({
  members,
}: {
  members: { id: number; name: string; isLive: boolean }[];
}) {
  return (
    <View style={styles.memberRow}>
      {members.map((member) => (
        <View key={member.id} style={styles.memberAvatar}>
          <Text style={styles.memberInitials}>{initials(member.name)}</Text>
          {member.isLive ? <View style={styles.liveDot} /> : null}
        </View>
      ))}
    </View>
  );
}

function Bubble({
  message,
  mine,
  showAuthor,
}: {
  message: StaffMessage;
  mine: boolean;
  showAuthor: boolean;
}) {
  return (
    <View style={[styles.bubbleRow, mine && { justifyContent: "flex-end" }]}>
      <View style={{ maxWidth: "82%" }}>
        {showAuthor && !mine ? (
          <Text style={styles.author}>{message.authorName}</Text>
        ) : null}
        <View
          style={[
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
          ]}
        >
          <Text style={[styles.bubbleText, mine && { color: "#fff" }]}>
            {message.body}
          </Text>
        </View>
        <Text style={[styles.meta, mine && { textAlign: "right" }]}>
          {timeAgo(message.createdAt)}
        </Text>
      </View>
    </View>
  );
}

export default function TeamConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = Number(id);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<StaffMessage>>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  const conversation = useGetStaffConversation(conversationId, {
    query: {
      queryKey: getGetStaffConversationQueryKey(conversationId),
      refetchInterval: 10_000,
      enabled: Number.isFinite(conversationId),
    },
  });
  const send = useSendStaffMessage();

  // Opening the conversation clears its unread count server-side, so the
  // inbox list behind this screen is now stale.
  const messageCount = conversation.data?.messages.length ?? 0;
  useEffect(() => {
    queryClient.invalidateQueries({
      queryKey: getListStaffConversationsQueryKey(),
    });
  }, [conversationId, messageCount, queryClient]);

  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setSendError(null);
    send.mutate(
      { id: conversationId, data: { body } },
      {
        onSuccess: () => {
          setDraft("");
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          queryClient.invalidateQueries({
            queryKey: getGetStaffConversationQueryKey(conversationId),
          });
          queryClient.invalidateQueries({
            queryKey: getListStaffConversationsQueryKey(),
          });
        },
        onError: (err: unknown) => {
          setSendError(
            err instanceof Error
              ? err.message
              : "That message didn't go through.",
          );
        },
      },
    );
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (conversation.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }
  if (conversation.isError || !conversation.data) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't open that conversation."
          onRetry={() => conversation.refetch()}
        />
      </View>
    );
  }

  const { conversation: convo, myMemberId, messages } = conversation.data;
  const isGroup = convo.kind === "group";
  const subtitle = convo.memberNames.join(", ");
  // Same "live" the map uses: their phone reported a position minutes ago.
  const liveCount = convo.members.filter((m) => m.isLive).length;

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
            {convo.title || subtitle}
          </Text>
          {isGroup ? (
            <MemberAvatars members={convo.members} />
          ) : (
            <Text style={styles.subtitle} numberOfLines={1}>
              {liveCount > 0 ? (
                <Text style={styles.subtitleLive}>● Live now</Text>
              ) : (
                subtitle
              )}
            </Text>
          )}
        </View>
        {isGroup ? (
          <Feather name="users" size={20} color={c.brandPink} />
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <Bubble
            message={item}
            mine={item.memberId === myMemberId}
            showAuthor={isGroup}
          />
        )}
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
          placeholder="Write a message…"
          placeholderTextColor={c.mutedForeground}
          style={styles.input}
          multiline
          maxLength={2000}
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
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 3,
  },
  memberAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${c.brandPink}1f`,
  },
  memberInitials: {
    color: c.brandPink,
    fontSize: 9,
    fontFamily: "PlusJakartaSans_700Bold",
  },
  // Same green "out working right now" marker the chat list pins to avatars.
  liveDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#10B981",
    borderWidth: 2,
    borderColor: c.background,
  },
  subtitleLive: {
    color: "#059669",
    fontSize: 12,
    fontFamily: "PlusJakartaSans_600SemiBold",
  },
  author: {
    color: c.mutedForeground,
    fontSize: 11,
    fontFamily: "PlusJakartaSans_600SemiBold",
    marginBottom: 3,
    marginLeft: 4,
  },
  bubbleRow: { flexDirection: "row", marginBottom: 12 },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  bubbleMine: { backgroundColor: c.brandPink },
  bubbleTheirs: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
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
