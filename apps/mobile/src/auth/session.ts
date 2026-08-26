import type { MeResponse, Permission } from "@pawsh/domain";
import { can } from "@pawsh/domain";

export type SessionStatus = "loading" | "signed-out" | "signed-in";

export interface SessionState {
  status: SessionStatus;
  token: string | null;
  me: MeResponse | null;
}

export const initialSessionState: SessionState = {
  status: "loading",
  token: null,
  me: null
};

export type SessionAction =
  | { type: "restored"; token: string | null }
  | { type: "signed-in"; token: string }
  | { type: "identified"; me: MeResponse }
  | { type: "signed-out" };

/**
 * Session transitions, kept as a pure reducer so the rules can be tested without a renderer.
 *
 * `signed-in` deliberately does not clear `me`: the identity request that follows a sign-in
 * replaces it, and blanking it first makes the app flash an empty account for a frame.
 */
export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "restored":
      return action.token
        ? { status: "signed-in", token: action.token, me: state.me }
        : { status: "signed-out", token: null, me: null };
    case "signed-in":
      return { status: "signed-in", token: action.token, me: state.me };
    case "identified":
      return { ...state, me: action.me };
    case "signed-out":
      return { status: "signed-out", token: null, me: null };
    default:
      return state;
  }
}

/**
 * Whether the signed-in user holds a permission.
 *
 * This hides affordances. It is **not** authorization — the server checks every one of these
 * again, and that check is the one that decides. A missing permission removes a control rather
 * than disabling it, matching the web app, which only inserts a button when the check passes.
 */
export function hasPermission(me: MeResponse | null, permission: Permission): boolean {
  if (!me) return false;
  return can({ isOwner: me.isOwner, permissions: me.permissions }, permission);
}

/** The location picker is worth showing only when there is a choice to make. */
export function needsLocationChoice(me: MeResponse | null): boolean {
  return (me?.business?.locationCount ?? 0) > 1;
}
