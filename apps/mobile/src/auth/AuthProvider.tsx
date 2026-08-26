import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MeResponse, Permission } from "@pawsh/domain";
import { api } from "../api/endpoints";
import { configureApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import { tokenStore } from "./token-store";
import {
  hasPermission,
  initialSessionState,
  needsLocationChoice,
  sessionReducer,
  type SessionState
} from "./session";

export interface AuthContextValue extends SessionState {
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setMe: (me: MeResponse) => void;
  allowed: (permission: Permission) => boolean;
  /** True immediately after a sign-in when the business has more than one active location. */
  mustChooseLocation: boolean;
  locationChosen: () => void;
}

/**
 * Exported so a test can mount a screen against a fixed session — a permission set, a business
 * currency, a signed-out state — without standing up the whole sign-in flow to get there.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const queryClient = useQueryClient();
  // The API client reads the token synchronously on every request, so it reads a ref rather than
  // the render-scoped value: a request started before a re-render must still carry the new token.
  const tokenRef = useRef<string | null>(null);
  const [mustChooseLocation, setMustChooseLocation] = useState(false);

  tokenRef.current = state.token;

  const signOut = useCallback(async (): Promise<void> => {
    // Order matters. The revoke is *started* while the token is still readable — `request()`
    // builds its headers before it awaits, so the call carries the credential even though local
    // state is dropped on the next line. Clearing first and calling afterwards would send an
    // unauthenticated logout and leave a live 14-day session on the server.
    const revoked = tokenRef.current
      ? api.logout().catch(() => undefined)
      : Promise.resolve(undefined);

    // Local state goes unconditionally and without waiting: a groomer who taps Sign out on a dead
    // connection must not be held on the screen, and must not be left holding a credential the
    // app has already said is gone.
    dispatch({ type: "signed-out" });
    tokenRef.current = null;
    setMustChooseLocation(false);
    await tokenStore.clear();
    queryClient.clear();
    await revoked;
  }, [queryClient]);

  useEffect(() => {
    configureApiClient({
      readToken: () => tokenRef.current,
      onUnauthorized: () => {
        // Sessions last 14 days with no refresh and no sliding expiry, so a 401 means the
        // session is over. Drop it and let the router send the user to sign in.
        if (!tokenRef.current) return;
        void signOut();
      }
    });
  }, [signOut]);

  useEffect(() => {
    let cancelled = false;
    void tokenStore.read().then((token) => {
      if (cancelled) return;
      tokenRef.current = token;
      dispatch({ type: "restored", token });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (input: { email: string; password: string }): Promise<void> => {
      const response = await api.login(input);
      if (!response.token) {
        // The server only withholds the token when the request did not declare itself native,
        // which would be a client bug rather than a credential problem.
        throw new ApiError({
          kind: "rejected",
          status: 200,
          message: "Sign-in did not return a session token."
        });
      }
      tokenRef.current = response.token;
      await tokenStore.write(response.token);
      dispatch({ type: "signed-in", token: response.token });
      const me = await api.me();
      queryClient.setQueryData(["me"], me);
      setMustChooseLocation(needsLocationChoice(me));
      dispatch({ type: "identified", me });
    },
    [queryClient]
  );

  const setMe = useCallback((me: MeResponse) => {
    dispatch({ type: "identified", me });
  }, []);

  const locationChosen = useCallback(() => {
    setMustChooseLocation(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signIn,
      signOut,
      setMe,
      allowed: (permission: Permission) => hasPermission(state.me, permission),
      mustChooseLocation,
      locationChosen
    }),
    [state, signIn, signOut, setMe, mustChooseLocation, locationChosen]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
