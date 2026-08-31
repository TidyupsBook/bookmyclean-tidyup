import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListChatContactsQueryKey,
  getListStaffConversationsQueryKey,
  useListChatContacts,
  useListStaffConversations,
  useStartStaffConversation,
  type ChatContact,
  type StaffConversation,
} from "@workspace/api-client-react";
import { BrandHeaderTitle } from "@/components/Brand";
import { EmptyView, ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";

const c = colors.light;

/**
 * The staff chat inbox. Unlike the customer Messages tab, this is visible to
 * everyone on the team — cleaners included — so people on a job can reach
 * dispatch and each other.
 */
function ConversationRow({
  conversation,
  onPress,
}: {
  conversation: StaffConversation;
  onPress: () => void;
}) {
  const unread = conversation.unreadCount > 0;
  const group = conversation.kind === "group";
  // At least one person in this chat is out working with location on — the
  // same signal that draws their live car on the map.
  const anyLive = conversation.members.some((m) => m.isLive);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.avatar}>
        <Feather
          name={group ? "users" : "message-circle"}
          size={16}
          color={c.brandPink}
        />
        {anyLive ? <View style={styles.liveDot} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <Text
            style={[styles.name, unread && styles.nameUnread]}
            numberOfLines={1}
          >
            {conversation.title || conversation.memberNames.join(", ")}
          </Text>
          <Text style={styles.when}>{timeAgo(conversation.lastMessageAt)}</Text>
        </View>
        <View style={styles.rowBottom}>
          <Text style={styles.preview} numberOfLines={1}>
            {conversation.lastMessagePreview || "No messages yet"}
          </Text>
          {unread ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{conversation.unreadCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function NewChatSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<number[]>([]);
  const [groupName, setGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const contacts = useListChatContacts({
    query: {
      queryKey: getListChatContactsQueryKey(),
      enabled: visible,
    },
  });
  const start = useStartStaffConversation();

  const reset = () => {
    setSelected([]);
    setGroupName("");
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggle = (id: number) => {
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const submit = () => {
    if (selected.length === 0 || start.isPending) return;
    setError(null);
    const title =
      selected.length > 1 && groupName.trim() ? groupName.trim() : null;
    start.mutate(
      { data: { memberIds: selected, title } },
      {
        onSuccess: (conversation) => {
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          queryClient.invalidateQueries({
            queryKey: getListStaffConversationsQueryKey(),
          });
          close();
          router.push({
            pathname: "/team-chat/[id]",
            params: { id: String(conversation.id) },
          });
        },
        onError: (err: unknown) => {
          setError(
            err instanceof Error
              ? err.message
              : "Couldn't start that conversation.",
          );
        },
      },
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <View style={[styles.sheet, { paddingTop: insets.top + 8 }]}>
        <View style={styles.sheetHeader}>
          <Pressable onPress={close} hitSlop={12}>
            <Text style={styles.sheetCancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>New chat</Text>
          <Pressable
            onPress={submit}
            disabled={selected.length === 0 || start.isPending}
            hitSlop={12}
          >
            {start.isPending ? (
              <ActivityIndicator color={c.brandPink} size="small" />
            ) : (
              <Text
                style={[
                  styles.sheetStart,
                  selected.length === 0 && { opacity: 0.4 },
                ]}
              >
                Start
              </Text>
            )}
          </Pressable>
        </View>

        {selected.length > 1 ? (
          <View style={styles.groupNameWrap}>
            <TextInput
              value={groupName}
              onChangeText={setGroupName}
              placeholder="Group name (optional)"
              placeholderTextColor={c.mutedForeground}
              style={styles.groupNameInput}
              maxLength={80}
            />
          </View>
        ) : null}

        {error ? <Text style={styles.sheetError}>{error}</Text> : null}

        {contacts.isLoading ? (
          <LoadingView />
        ) : contacts.isError ? (
          <ErrorView
            message="Couldn't load your teammates."
            onRetry={() => contacts.refetch()}
          />
        ) : (
          <FlatList
            data={contacts.data ?? []}
            keyExtractor={(item: ChatContact) => String(item.id)}
            ListEmptyComponent={
              <EmptyView
                icon="users"
                title="No teammates yet"
                subtitle="Once other people join your team they'll show up here."
              />
            }
            renderItem={({ item }) => {
              const checked = selected.includes(item.id);
              return (
                <Pressable
                  onPress={() => toggle(item.id)}
                  style={({ pressed }) => [
                    styles.contactRow,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.avatar}>
                    <Feather name="user" size={16} color={c.brandPink} />
                    {item.isLive ? <View style={styles.liveDot} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.contactName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.contactRole}>
                      {item.isLive ? (
                        <Text style={styles.contactLive}>Live now · </Text>
                      ) : null}
                      {item.isLead ? "Lead · " : ""}
                      {item.role}
                    </Text>
                  </View>
                  <View style={[styles.checkbox, checked && styles.checkboxOn]}>
                    {checked ? (
                      <Feather name="check" size={14} color="#fff" />
                    ) : null}
                  </View>
                </Pressable>
              );
            }}
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          />
        )}
      </View>
    </Modal>
  );
}

export default function TeamChatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);

  // A message can land while the screen is open, so poll rather than wait for
  // a pull-to-refresh nobody thinks to do.
  const conversations = useListStaffConversations({
    query: {
      queryKey: getListStaffConversationsQueryKey(),
      refetchInterval: 15_000,
    },
  });

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (conversations.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (conversations.isError) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load your chats."
          onRetry={() => conversations.refetch()}
        />
      </View>
    );
  }

  const items = conversations.data ?? [];

  return (
    <View style={[styles.screen, { paddingTop: topPad }]}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.headerRow}>
              <BrandHeaderTitle title="Team chat" />
              <Pressable
                onPress={() => setSheetOpen(true)}
                hitSlop={12}
                style={({ pressed }) => [
                  styles.newButton,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Feather name="edit" size={18} color="#fff" />
              </Pressable>
            </View>
            <Text style={styles.subtitle}>
              Message your teammates and dispatch.
            </Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyView
            icon="message-square"
            title="No chats yet"
            subtitle="Tap the pencil to start a conversation with a teammate."
          />
        }
        renderItem={({ item }) => (
          <ConversationRow
            conversation={item}
            onPress={() =>
              router.push({
                pathname: "/team-chat/[id]",
                params: { id: String(item.id) },
              })
            }
          />
        )}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={conversations.isRefetching}
            onRefresh={() => conversations.refetch()}
            tintColor={c.brandPink}
          />
        }
      />

      <NewChatSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  newButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.brandPink,
    alignItems: "center",
    justifyContent: "center",
  },
  subtitle: {
    color: c.mutedForeground,
    fontSize: 13,
    fontFamily: "PlusJakartaSans_400Regular",
    marginTop: 4,
  },
  row: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${c.brandPink}1f`,
  },
  // Green "out working right now" marker, pinned to the avatar's corner the
  // way messaging apps show who's online.
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
  contactLive: {
    color: "#059669",
    fontFamily: "PlusJakartaSans_600SemiBold",
    textTransform: "none",
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  name: {
    flex: 1,
    color: c.foreground,
    fontSize: 15,
    fontFamily: "PlusJakartaSans_600SemiBold",
  },
  nameUnread: { fontFamily: "PlusJakartaSans_700Bold" },
  when: { color: c.mutedForeground, fontSize: 11 },
  preview: {
    flex: 1,
    color: c.mutedForeground,
    fontSize: 13,
    fontFamily: "PlusJakartaSans_400Regular",
  },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: c.brandPink,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 11,
    fontFamily: "PlusJakartaSans_700Bold",
  },
  sheet: { flex: 1, backgroundColor: c.background },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  sheetTitle: {
    color: c.foreground,
    fontSize: 16,
    fontFamily: "PlusJakartaSans_700Bold",
  },
  sheetCancel: {
    color: c.mutedForeground,
    fontSize: 15,
    fontFamily: "PlusJakartaSans_500Medium",
  },
  sheetStart: {
    color: c.brandPink,
    fontSize: 15,
    fontFamily: "PlusJakartaSans_700Bold",
  },
  sheetError: {
    color: c.destructive,
    fontSize: 12,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  groupNameWrap: {
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  groupNameInput: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    color: c.foreground,
    fontSize: 14,
    fontFamily: "PlusJakartaSans_400Regular",
  },
  contactRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  contactName: {
    color: c.foreground,
    fontSize: 15,
    fontFamily: "PlusJakartaSans_600SemiBold",
  },
  contactRole: {
    color: c.mutedForeground,
    fontSize: 12,
    fontFamily: "PlusJakartaSans_400Regular",
    marginTop: 2,
    textTransform: "capitalize",
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: c.brandPink,
    borderColor: c.brandPink,
  },
});
