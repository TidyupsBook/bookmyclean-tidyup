import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import {
  getGetCurrentUserQueryKey,
  getGetUnreadMessageCountQueryKey,
  getListStaffConversationsQueryKey,
  useGetCurrentUser,
  useGetUnreadMessageCount,
  useListStaffConversations,
} from "@workspace/api-client-react";
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Redirect, Tabs } from "expo-router";
import {
  Badge,
  Icon,
  Label,
  NativeTabs,
} from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import colors from "@/constants/colors";
import {
  ProfileErrorScreen,
  ProfileLoadingScreen,
  ReconnectingScreen,
} from "@/components/ConnectionScreens";
import { WorkspaceGate } from "@/components/WorkspaceGate";
import { profileRetryPolicy } from "@/lib/auth-token";
import { isConnectionTrouble, useClerkStatus } from "@/lib/clerk-status";
import { LocationTrackingProvider } from "@/lib/location-tracking";
import { LocationPermissionAsk } from "@/components/LocationPermissionAsk";

const c = colors.light;

// iOS 26 native tabs with liquid glass; system-level appearance, no custom
// brand colors on this path.
function NativeTabLayout({
  showActivity,
  unread,
  chatUnread,
}: {
  showActivity: boolean;
  unread: number;
  chatUnread: number;
}) {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "calendar", selected: "calendar" }} />
        <Label>Jobs</Label>
      </NativeTabs.Trigger>
      {showActivity ? (
        <NativeTabs.Trigger name="activity">
          <Icon sf={{ default: "bolt", selected: "bolt.fill" }} />
          <Label>Activity</Label>
        </NativeTabs.Trigger>
      ) : null}
      {showActivity ? (
        <NativeTabs.Trigger name="messages">
          <Icon sf={{ default: "message", selected: "message.fill" }} />
          <Label>Messages</Label>
          <Badge hidden={unread === 0}>
            {unread > 99 ? "99+" : String(unread)}
          </Badge>
        </NativeTabs.Trigger>
      ) : null}
      {/* The whole crew gets the Team tab: cleaners see the roster (and can
          fix their own name); the applicant queue only reaches
          owners/dispatchers because the API filters it for cleaners. */}
      <NativeTabs.Trigger name="team">
        <Icon sf={{ default: "person.2", selected: "person.2.fill" }} />
        <Label>Team</Label>
      </NativeTabs.Trigger>
      {/* Staff chat is for the whole team, cleaners included — not gated. */}
      <NativeTabs.Trigger name="team-chat">
        <Icon
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
        />
        <Label>Chat</Label>
        <Badge hidden={chatUnread === 0}>
          {chatUnread > 99 ? "99+" : String(chatUnread)}
        </Badge>
      </NativeTabs.Trigger>
      {/* The whole crew gets the Map tab: the API scopes trails so a cleaner
          sees their own and dispatch sees the crew's. */}
      <NativeTabs.Trigger name="map">
        <Icon sf={{ default: "map", selected: "map.fill" }} />
        <Label>Map</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="location">
        <Icon sf={{ default: "location", selected: "location.fill" }} />
        <Label>Location</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout({
  showActivity,
  unread,
  chatUnread,
}: {
  showActivity: boolean;
  unread: number;
  chatUnread: number;
}) {
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: c.brandPink,
        tabBarInactiveTintColor: c.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : c.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: c.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint="dark"
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: c.background },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Jobs",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="calendar" tintColor={color} size={24} />
            ) : (
              <Feather name="calendar" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          // The activity feed is a business-operations view; cleaners get a
          // 403 from its API, so the tab simply doesn't exist for them.
          href: showActivity ? undefined : null,
          title: "Activity",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="bolt" tintColor={color} size={24} />
            ) : (
              <Feather name="zap" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          // Customer texts carry prices and addresses; the API 403s a
          // cleaner, so the tab doesn't exist for them.
          href: showActivity ? undefined : null,
          title: "Messages",
          tabBarBadge: unread > 0 ? (unread > 99 ? "99+" : unread) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: c.notifyMessages,
            color: "#fff",
          },
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="message" tintColor={color} size={24} />
            ) : (
              <Feather name="message-circle" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          // The whole crew gets the Team tab: cleaners see the roster (and
          // can fix their own name); the applicant queue only reaches
          // owners/dispatchers because the API filters it for cleaners.
          title: "Team",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.2" tintColor={color} size={24} />
            ) : (
              <Feather name="users" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="team-chat"
        options={{
          // Staff chat is for the whole team, cleaners included — not gated.
          title: "Chat",
          tabBarBadge:
            chatUnread > 0 ? (chatUnread > 99 ? "99+" : chatUnread) : undefined,
          // Purple = team chat. Red stays reserved for phone calls, pink is
          // customer texts, orange is leads — same scheme as the web app.
          tabBarBadgeStyle: {
            backgroundColor: c.notifyChat,
            color: "#fff",
          },
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView
                name="bubble.left.and.bubble.right"
                tintColor={color}
                size={24}
              />
            ) : (
              <Feather name="message-square" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          // The whole crew gets the Map tab: the API scopes trails so a
          // cleaner sees their own and dispatch sees the crew's.
          title: "Map",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="map" tintColor={color} size={24} />
            ) : (
              <Feather name="map" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="location"
        options={{
          title: "Location",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="location" tintColor={color} size={24} />
            ) : (
              <Feather name="navigation" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  const { isSignedIn, isLoaded } = useAuth();
  const clerkStatus = useClerkStatus();
  // Cleaners get a jobs-only app: the activity feed is owner/dispatcher
  // territory (its API 403s a cleaner anyway).
  // A transient 401 here (token expired mid-refresh, clock skew right after
  // sign-in) quietly retries with a forced-fresh token instead of flashing
  // the error screen; a revoked session exhausts the bounded retries and
  // Clerk's signed-out signal handles the redirect.
  const me = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      retry: profileRetryPolicy,
    },
  });

  if (!isLoaded) return null;
  if (!isSignedIn) {
    // Clerk only knows nobody is signed in when it can actually talk to its
    // servers. While it's degraded or failed, a stored session may still be
    // perfectly good — hold here instead of demanding the password again.
    if (isConnectionTrouble(clerkStatus)) return <ReconnectingScreen />;
    return <Redirect href="/(auth)/sign-in" />;
  }
  // Wait for the role before laying out tabs so an owner never sees the
  // Activity tab pop in (or a cleaner see it flash and vanish). Show the
  // brand loading state, never a blank screen — on a slow connection this
  // gap is the first thing a freshly signed-in person sees.
  if (!me.data) {
    // Exhausted retries with nothing cached: say what's happening and offer
    // a retry instead of hanging. (While the retry is in flight we're back
    // to the loading state below.)
    if (me.isError && !me.isFetching) {
      return <ProfileErrorScreen onRetry={() => me.refetch()} />;
    }
    return <ProfileLoadingScreen />;
  }

  // No workspace yet: show the join-with-code flow (and the waiting screen
  // once they've asked) instead of an empty tab set where every API 403s.
  if (me.data && !me.data.companyName) {
    return <WorkspaceGate me={me.data} />;
  }

  const showActivity = me.data ? me.data.role !== "cleaner" : false;

  return (
    <SignedInTabs showActivity={showActivity} canSeeMessages={showActivity} />
  );
}

// Split so the unread-count hook only mounts once the role is known — the
// messages API 403s a cleaner, so we never poll it for one.
function SignedInTabs({
  showActivity,
  canSeeMessages,
}: {
  showActivity: boolean;
  canSeeMessages: boolean;
}) {
  // A customer text should surface without the Messages tab being open.
  const unreadCount = useGetUnreadMessageCount({
    query: {
      queryKey: getGetUnreadMessageCountQueryKey(),
      enabled: canSeeMessages,
      refetchInterval: 15_000,
    },
  });
  const unread = canSeeMessages ? (unreadCount.data?.unread ?? 0) : 0;

  // Crew chat stopped texting people, so this badge is how a message gets
  // noticed. Everyone on the roster has the tab, cleaners included.
  const chats = useListStaffConversations({
    query: {
      queryKey: getListStaffConversationsQueryKey(),
      refetchInterval: 15_000,
    },
  });
  const chatUnread = (chats.data ?? []).reduce(
    (sum, conversation) => sum + Math.max(0, conversation.unreadCount),
    0,
  );

  // The location tracker lives at the tab layout level so it survives tab
  // switches but is torn down on sign-out (when this whole tree unmounts).
  return (
    <LocationTrackingProvider>
      {/* Asks this phone, once ever, whether it should join the crew map. */}
      <LocationPermissionAsk />
      {isLiquidGlassAvailable() ? (
        <NativeTabLayout
          showActivity={showActivity}
          unread={unread}
          chatUnread={chatUnread}
        />
      ) : (
        <ClassicTabLayout
          showActivity={showActivity}
          unread={unread}
          chatUnread={chatUnread}
        />
      )}
    </LocationTrackingProvider>
  );
}
