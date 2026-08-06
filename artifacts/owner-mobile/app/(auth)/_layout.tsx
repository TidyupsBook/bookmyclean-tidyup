import React from "react";
import { useAuth } from "@clerk/expo";
import { Redirect, Stack } from "expo-router";
import colors from "@/constants/colors";

export default function AuthLayout() {
  const { isSignedIn } = useAuth();
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
