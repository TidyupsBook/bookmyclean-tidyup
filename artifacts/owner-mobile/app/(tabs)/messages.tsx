import React from "react";
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  getListMessageThreadsQueryKey,
  useListMessageThreads,
  type MessageThread,
} from "@workspace/api-client-react";
import { BrandHeaderTitle } from "@/components/Brand";
import { EmptyView, ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

const c = colors.light;

/**
 * The customer inbox on the phone. Same threads the dashboard shows — the
 * business line follows whoever is holding a phone, which is the point of
 * having it here at all.
 */
function ThreadRow({
  thread,
  onPress,
}: {
  thread: MessageThread;
  onPress: () => void;
}) {
  const unread = thread.unreadCount > 0;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.avatar}>
        <Feather name="message-circle" size={16} color={c.brandPink} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <Text
            style={[styles.name, unread && styles.nameUnread]}
            numberOfLines={1}
          >
            {thread.customerName || formatPhone(thread.customerPhone)}
          </Text>
          <Text style={styles.when}>{timeAgo(thread.lastMessageAt)}</Text>
        </View>
        <View style={styles.rowBottom}>
          <Text style={styles.preview} numberOfLines={1}>
            {thread.lastDirection === "outbound" ? "You: " : ""}
            {thread.lastMessagePreview || "No messages yet"}
          </Text>
          {unread ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{thread.unreadCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export default function MessagesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // A text can land while the screen is open, so poll rather than wait for a
  // pull-to-refresh nobody thinks to do.
  const threads = useListMessageThreads({
    query: {
      queryKey: getListMessageThreadsQueryKey(),
      refetchInterval: 15_000,
    },
  });

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (threads.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (threads.isError) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load your messages."
          onRetry={() => threads.refetch()}
        />
      </View>
    );
  }

  const items = threads.data ?? [];

  return (
    <View style={[styles.screen, { paddingTop: topPad }]}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={
          <View style={styles.header}>
            <BrandHeaderTitle title="Messages" />
            <Text style={styles.subtitle}>
              Texts to and from your customers.
            </Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyView
            icon="message-square"
            title="No texts yet"
            subtitle="When someone texts your business number it shows up here."
          />
        }
        renderItem={({ item }) => (
          <ThreadRow
            thread={item}
            onPress={() =>
              router.push({
                pathname: "/messages/[id]",
                params: { id: String(item.id) },
              })
            }
          />
        )}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={threads.isRefetching}
            onRefresh={() => threads.refetch()}
            tintColor={c.brandPink}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
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
});
