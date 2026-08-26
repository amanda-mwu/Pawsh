import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack, useRootNavigationState, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { ConnectivityProvider } from "../src/net/connectivity";
import { DraftProvider } from "../src/offline/DraftProvider";
import { createQueryClient } from "../src/query/client";
import { ThemeProvider, useTheme } from "../src/theme/theme";

/**
 * Routes the user to the one screen their session allows.
 *
 * This runs after the navigator has mounted — navigating before then is silently dropped — and
 * only ever replaces, so the back gesture can never walk backwards into a signed-out screen.
 */
function useSessionRoute(): void {
  const { status, mustChooseLocation } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const navigationState = useRootNavigationState();

  useEffect(() => {
    if (!navigationState?.key) return;
    if (status === "loading") return;
    const root = segments[0];
    const onLogin = root === "login";
    const onLocationPicker = root === "location";

    if (status === "signed-out") {
      if (!onLogin) router.replace("/login");
      return;
    }
    if (mustChooseLocation) {
      if (!onLocationPicker) router.replace("/location");
      return;
    }
    if (onLogin || onLocationPicker) router.replace("/");
  }, [status, mustChooseLocation, segments, router, navigationState?.key]);
}

function RootNavigator(): React.ReactElement {
  const { status } = useAuth();
  const { colors } = useTheme();
  useSessionRoute();

  if (status === "loading") {
    return (
      <View
        testID="session-restoring"
        style={[styles.splash, { backgroundColor: colors.bg }]}
        accessibilityLabel="Starting Pawsh"
      >
        <ActivityIndicator color={colors.brandText} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg }
      }}
    />
  );
}

export default function RootLayout(): React.ReactElement {
  // One client for the life of the app. Recreating it on a re-render would drop every cached
  // read, which on a flaky connection is the difference between a working schedule and a spinner.
  const [queryClient] = useState(createQueryClient);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ConnectivityProvider>
            <AuthProvider>
              <DraftProvider>
                <StatusBar style="auto" />
                <RootNavigator />
              </DraftProvider>
            </AuthProvider>
          </ConnectivityProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center" }
});
