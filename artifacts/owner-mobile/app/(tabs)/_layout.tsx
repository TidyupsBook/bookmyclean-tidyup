import React, { useEffect, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import {
  setAuthTokenGetter,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Redirect, Tabs } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import colors from "@/constants/colors";
import { LocationTrackingProvider } from "@/lib/location-tracking";

const c = colors.light;

// iOS 26 native tabs with liquid glass; system-level appearance, no custom
// brand colors on this path.
function NativeTabLayout({ showActivity }: { showActivity: boolean }) {
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
      <NativeTabs.Trigger name="location">
        <Icon sf={{ default: "location", selected: "location.fill" }} />
        <Label>Location</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout({ showActivity }: { showActivity: boolean }) {
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
  const { isSignedIn, isLoaded, getToken } = useAuth();
  // Cleaners get a jobs-only app: the activity feed is owner/dispatcher
  // territory (its API 403s a cleaner anyway).
  const me = useGetCurrentUser();

  // On mobile there is no browser cookie jar — attach a Clerk bearer token
  // to every generated API client request. Registration must happen
  // SYNCHRONOUSLY during render, before any child screen mounts and fires
  // its first query; a passive effect here would run after child effects
  // and let the first request go out without an Authorization header.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  setAuthTokenGetter(() => getTokenRef.current());

  useEffect(() => {
    return () => setAuthTokenGetter(null);
  }, []);

  if (!isLoaded) return null;
  if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
  // Wait for the role before laying out tabs so an owner never sees the
  // Activity tab pop in (or a cleaner see it flash and vanish).
  if (me.isLoading) return null;

  const showActivity = me.data ? me.data.role !== "cleaner" : false;

  // The location tracker lives at the tab layout level so it survives tab
  // switches but is torn down on sign-out (when this whole tree unmounts).
  return (
    <LocationTrackingProvider>
      {isLiquidGlassAvailable() ? (
        <NativeTabLayout showActivity={showActivity} />
      ) : (
        <ClassicTabLayout showActivity={showActivity} />
      )}
    </LocationTrackingProvider>
  );
}
