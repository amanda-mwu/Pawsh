import React from "react";
import { render, type RenderResult } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { can, type MeResponse, type Permission } from "@pawsh/domain";
import { AuthContext, type AuthContextValue } from "../../src/auth/AuthProvider";
import { ConnectivityContext } from "../../src/net/connectivity";
import { DraftProvider } from "../../src/offline/DraftProvider";
import { ThemeProvider } from "../../src/theme/theme";
import { makeMe } from "./fixtures";

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 }
};

export interface HarnessOptions {
  me?: MeResponse | null;
  permissions?: Permission[];
  isOwner?: boolean;
  online?: boolean;
  signIn?: AuthContextValue["signIn"];
  signOut?: AuthContextValue["signOut"];
  queryClient?: QueryClient;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Retries turn a deliberate failure fixture into a multi-second test.
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false }
    }
  });
}

/**
 * Mounts a screen with a fixed session.
 *
 * `render` is awaited because the testing library resolves it asynchronously; the module-level
 * `screen` helper is therefore not populated until then, and every suite uses the returned
 * queries rather than that global.
 */
export async function renderScreen(
  ui: React.ReactElement,
  options: HarnessOptions = {}
): Promise<RenderResult & { queryClient: QueryClient }> {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const me =
    options.me === null
      ? null
      : (options.me ??
        makeMe({
          ...(options.permissions ? { permissions: options.permissions } : {}),
          ...(options.isOwner === undefined ? {} : { isOwner: options.isOwner })
        }));

  const auth: AuthContextValue = {
    status: me ? "signed-in" : "signed-out",
    token: me ? "test-token" : null,
    me,
    signIn: options.signIn ?? (async () => undefined),
    signOut: options.signOut ?? (async () => undefined),
    setMe: () => undefined,
    allowed: (permission: Permission) =>
      me ? can({ isOwner: me.isOwner, permissions: me.permissions }, permission) : false,
    mustChooseLocation: false,
    locationChosen: () => undefined
  };

  const result = await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ConnectivityContext.Provider value={{ online: options.online ?? true }}>
            <AuthContext.Provider value={auth}>
              <DraftProvider>{ui}</DraftProvider>
            </AuthContext.Provider>
          </ConnectivityContext.Provider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );

  return Object.assign(result, { queryClient });
}
