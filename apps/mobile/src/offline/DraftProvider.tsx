import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { isApiError, messageFor } from "../api/errors";
import { useConnectivity } from "../net/connectivity";
import { invalidateAfterAppointmentChange } from "../query/client";
import {
  draftIdFor,
  draftStorage,
  removeDraft,
  upsertDraft,
  type Draft
} from "./drafts";

export interface DraftContextValue {
  drafts: Draft[];
  ready: boolean;
  /** Persists the text, shows it immediately, then attempts to send it. Never throws. */
  queueOperationalNotes: (input: {
    appointmentId: string;
    targetLabel: string;
    text: string;
    version?: number | undefined;
  }) => Promise<void>;
  retry: (id: string) => Promise<void>;
  retryAll: () => Promise<void>;
  discard: (id: string) => Promise<void>;
  draftFor: (appointmentId: string) => Draft | undefined;
}

const DraftContext = createContext<DraftContextValue | null>(null);

export function DraftProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [ready, setReady] = useState(false);
  const queryClient = useQueryClient();
  const { online } = useConnectivity();
  // Sends read the queue through a ref so a retry started from one screen sees writes made on
  // another without either of them re-rendering the other.
  const draftsRef = useRef<Draft[]>([]);

  const commit = useCallback((next: Draft[]) => {
    draftsRef.current = next;
    setDrafts(next);
    void draftStorage.write(next);
  }, []);

  useEffect(() => {
    void draftStorage.read().then((stored) => {
      // A draft interrupted mid-send on the previous launch is pending again, not stuck sending.
      const restored = stored.map((draft) =>
        draft.state === "sending" ? { ...draft, state: "pending" as const } : draft
      );
      draftsRef.current = restored;
      setDrafts(restored);
      setReady(true);
    });
  }, []);

  const send = useCallback(
    async (draft: Draft): Promise<void> => {
      commit(upsertDraft(draftsRef.current, { ...draft, state: "sending" }));
      try {
        await api.updateOperationalNotes(draft.targetId, { operationalNotes: draft.text });
        commit(removeDraft(draftsRef.current, draft.id));
        await invalidateAfterAppointmentChange(queryClient);
      } catch (error) {
        // A refusal the server will keep refusing — a validation error, a missing permission, an
        // appointment that has left the states this endpoint accepts — is permanent. Everything
        // else is worth retrying, automatically on reconnect and manually at any time.
        const permanent = isApiError(error) && !error.retryable && error.kind !== "unauthenticated";
        commit(
          upsertDraft(draftsRef.current, {
            ...draft,
            state: "failed",
            error: messageFor(error),
            permanent
          })
        );
      }
    },
    [commit, queryClient]
  );

  const queueOperationalNotes = useCallback<DraftContextValue["queueOperationalNotes"]>(
    async ({ appointmentId, targetLabel, text }) => {
      const draft: Draft = {
        id: draftIdFor("appointment-operational-notes", appointmentId),
        kind: "appointment-operational-notes",
        targetId: appointmentId,
        targetLabel,
        text,
        createdAt: Date.now(),
        state: "pending"
      };
      // Written locally before the network is touched. Not after, not concurrently: the moment
      // the groomer taps Save their words must already be somewhere that survives the app dying.
      commit(upsertDraft(draftsRef.current, draft));
      await send(draft);
    },
    [commit, send]
  );

  const retry = useCallback(
    async (id: string): Promise<void> => {
      const draft = draftsRef.current.find((entry) => entry.id === id);
      if (!draft || draft.state === "sending") return;
      await send({ ...draft, error: undefined, permanent: false });
    },
    [send]
  );

  const retryAll = useCallback(async (): Promise<void> => {
    const pending = draftsRef.current.filter((draft) => draft.state !== "sending");
    for (const draft of pending) {
      await send({ ...draft, error: undefined, permanent: false });
    }
  }, [send]);

  const discard = useCallback(
    async (id: string): Promise<void> => {
      commit(removeDraft(draftsRef.current, id));
    },
    [commit]
  );

  useEffect(() => {
    if (!online || !ready) return;
    const retryable = draftsRef.current.filter(
      (draft) => draft.state !== "sending" && !draft.permanent
    );
    if (!retryable.length) return;
    void (async () => {
      for (const draft of retryable) {
        await send({ ...draft, error: undefined });
      }
    })();
    // Reconnecting is the event worth acting on. There is no countdown and no attempt number in
    // the UI: a visible timer invites watching a screen instead of grooming a dog.
  }, [online, ready, send]);

  const value = useMemo<DraftContextValue>(
    () => ({
      drafts,
      ready,
      queueOperationalNotes,
      retry,
      retryAll,
      discard,
      draftFor: (appointmentId: string) =>
        drafts.find((draft) => draft.id === draftIdFor("appointment-operational-notes", appointmentId))
    }),
    [drafts, ready, queueOperationalNotes, retry, retryAll, discard]
  );

  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useDrafts(): DraftContextValue {
  const value = useContext(DraftContext);
  if (!value) throw new Error("useDrafts must be used inside DraftProvider");
  return value;
}
