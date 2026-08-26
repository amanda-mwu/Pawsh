import { useCallback, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  appointmentPrimaryActions,
  canTransition,
  permissionForTransition,
  type AppointmentStatus,
  type Permission
} from "@pawsh/domain";
import { api } from "../../api/endpoints";
import { isApiError, messageFor } from "../../api/errors";
import { invalidateAfterAppointmentChange } from "../../query/client";
import type { AppointmentView } from "./model";

/**
 * Status changes are never queued offline. On purpose.
 *
 * Check in, start service, complete and checkout advance a state machine the server owns; they
 * are ordered relative to what other staff are doing on the same appointment, and checkout
 * creates financial records. A phone that replays "Complete" three minutes later against a server
 * whose state has already moved produces a mess no groomer can untangle.
 *
 * Notes are queued instead, because they are additive, order-independent, and losing them
 * destroys work that cannot be recreated. That is the whole distinction.
 */
export const statusChangesAreOnlineOnly = true;

export interface PrimaryActionPlan {
  label: string;
  permission: Permission;
  target: AppointmentStatus | null;
  /** False when the API has no route for it in this release — checkout takes payment. */
  available: boolean;
}

/**
 * The one action that advances this appointment, or null when there is none.
 *
 * A missing permission removes the action rather than disabling it, which is what the web app
 * does: it only inserts the button when the check passes. This is presentation. The server
 * derives the same permission from the target status and refuses independently, and that refusal
 * is the one that authorizes anything.
 */
export function planPrimaryAction(
  view: AppointmentView,
  allowed: (permission: Permission) => boolean
): PrimaryActionPlan | null {
  const action = appointmentPrimaryActions[view.status];
  if (!action) return null;
  if (!allowed(action.permission)) return null;
  if (action.target && !canTransition(view.status, action.target)) return null;
  return {
    label: action.label,
    permission: action.permission,
    target: action.target,
    // Checkout takes payment, which this release does not do. Rather than offering a button that
    // opens "coming soon", the action zone drops to its secondary row.
    available: action.target !== null
  };
}

export interface TransitionState {
  busy: boolean;
  error: string | null;
  conflict: boolean;
}

export function useAppointmentTransition(view: AppointmentView | null): {
  state: TransitionState;
  run: (target: AppointmentStatus, reason?: string) => Promise<boolean>;
  dismissError: () => void;
} {
  const queryClient = useQueryClient();
  const [state, setState] = useState<TransitionState>({
    busy: false,
    error: null,
    conflict: false
  });

  const run = useCallback(
    async (target: AppointmentStatus, reason?: string): Promise<boolean> => {
      if (!view) return false;
      setState({ busy: true, error: null, conflict: false });
      try {
        await api.transition(view.id, {
          status: target,
          version: view.version,
          ...(reason ? { reason } : {})
        });
        // The response is the bare appointments row without any of the calendar projection's
        // joins, so it is never written into the cache. Refetching is the only correct move.
        await invalidateAfterAppointmentChange(queryClient, {
          customerId: view.customerId,
          petId: view.petId
        });
        AccessibilityInfo.announceForAccessibility(
          `${view.petName} is now ${target.replace("_", " ")}.`
        );
        setState({ busy: false, error: null, conflict: false });
        return true;
      } catch (error) {
        const conflict = isApiError(error) && error.kind === "conflict";
        if (conflict) {
          // Somebody else moved this appointment. Pull the truth back in before the groomer acts
          // on a screen that is already wrong.
          await invalidateAfterAppointmentChange(queryClient, {
            customerId: view.customerId,
            petId: view.petId
          });
        }
        setState({ busy: false, error: messageFor(error), conflict });
        return false;
      }
    },
    [queryClient, view]
  );

  const dismissError = useCallback(() => {
    setState((current) => ({ ...current, error: null, conflict: false }));
  }, []);

  return { state, run, dismissError };
}

export { permissionForTransition };
