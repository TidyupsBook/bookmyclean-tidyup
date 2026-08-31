import React from "react";
import { useAuth } from "@clerk/expo";
import { Redirect, Stack } from "expo-router";
import colors from "@/constants/colors";
import { AuthLoadingScreen } from "@/components/ConnectionScreens";

export default function AuthLayout() {
  const { isSignedIn, isLoaded } = useAuth();
  // Never render the password form on a guess: until Clerk has read the
  // stored session back off the device, "not signed in" isn't a fact yet.
  if (!isLoaded) return <AuthLoadingScreen />;
  if (isSignedIn) return <Redirect href="/(tabs)" />;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.light.background },
      }}
    />
  );
}
