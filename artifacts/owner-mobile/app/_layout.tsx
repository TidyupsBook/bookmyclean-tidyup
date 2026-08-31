import React, { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ClerkLoaded, ClerkLoading, ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ApiAuthBridge } from "@/components/ApiAuthBridge";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  AuthLoadingScreen,
  AuthUnavailableScreen,
} from "@/components/ConnectionScreens";
import { useClerkStatus } from "@/lib/clerk-status";
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  useFonts,
} from "@expo-google-fonts/plus-jakarta-sans";
import { setBaseUrl } from "@workspace/api-client-react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import colors from "@/constants/colors";

// Expo bundles run outside the web proxy and need absolute URLs to reach the
// shared API server.
const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) setBaseUrl(`https://${domain}`);

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.light.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="booking/[id]" />
      <Stack.Screen name="booking-form-settings" />
      <Stack.Screen name="calls" />
      <Stack.Screen name="leads" />
      <Stack.Screen name="call/[id]" />
      <Stack.Screen name="messages/[id]" />
      <Stack.Screen name="team-chat/[id]" />
    </Stack>
  );
}

/**
 * What the user looks at while Clerk starts. If Clerk can't start at all
 * (offline at launch, its servers unreachable) waiting forever helps nobody,
 * so say what to do instead of spinning.
 */
function BootScreen() {
  const status = useClerkStatus();
  return status === "error" ? <AuthUnavailableScreen /> : <AuthLoadingScreen />;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      tokenCache={tokenCache}
      proxyUrl={proxyUrl}
    >
      {/*
        The session is kept in expo-secure-store and read back asynchronously
        on launch. Show the brand while that read happens: rendering nothing
        lets the first frame look signed out, and anything that routes off
        `isSignedIn` would bounce a returning user to the password screen.
      */}
      <ClerkLoading>
        <SafeAreaProvider>
          <BootScreen />
        </SafeAreaProvider>
      </ClerkLoading>
      <ClerkLoaded>
        <SafeAreaProvider>
          <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <GestureHandlerRootView>
                <KeyboardProvider>
                  <StatusBar style="light" />
                  <ApiAuthBridge>
                    <RootLayoutNav />
                  </ApiAuthBridge>
                </KeyboardProvider>
              </GestureHandlerRootView>
            </QueryClientProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
