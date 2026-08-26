import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "pawsh.drafts.v1";

export type DraftState = "pending" | "sending" | "failed";

/**
 * One piece of writing a groomer has committed to but the server has not accepted yet.
 *
 * Only additive, order-independent work is queued. Status transitions never are — see
 * `docs/offline.md` reasoning reproduced in `src/features/appointments/transition.ts`.
 */
export interface Draft {
  id: string;
  kind: "appointment-operational-notes";
  /** The record the text belongs to, used to route the groomer back to it. */
  targetId: string;
  /** What to call the target in a list, so "Pending changes" is readable away from the screen. */
  targetLabel: string;
  text: string;
  createdAt: number;
  state: DraftState;
  /** The server's own words when it refused, shown verbatim. */
  error?: string;
  /** Set once the failure is one that retrying will not fix. */
  permanent?: boolean;
}

function parse(raw: string | null): Draft[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Draft =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as Draft).id === "string" &&
        typeof (entry as Draft).text === "string"
    );
  } catch {
    // A corrupted queue file is not a reason to refuse to start. The loss is already done.
    return [];
  }
}

/**
 * The persisted queue.
 *
 * Reads and writes are whole-list, which is right for a queue that holds a handful of entries and
 * removes the read-modify-write race a per-key layout would have between two screens.
 */
export const draftStorage = {
  async read(): Promise<Draft[]> {
    try {
      return parse(await AsyncStorage.getItem(STORAGE_KEY));
    } catch {
      return [];
    }
  },

  async write(drafts: Draft[]): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    } catch {
      // Persistence failed, but the in-memory queue is still authoritative for this launch and
      // the text is still on screen. Refusing the save would be the worse outcome.
    }
  },

  async clear(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to recover from.
    }
  }
};

export function upsertDraft(drafts: readonly Draft[], draft: Draft): Draft[] {
  const index = drafts.findIndex((entry) => entry.id === draft.id);
  if (index === -1) return [...drafts, draft];
  return drafts.map((entry) => (entry.id === draft.id ? draft : entry));
}

export function removeDraft(drafts: readonly Draft[], id: string): Draft[] {
  return drafts.filter((entry) => entry.id !== id);
}

/** One draft per target: a second edit of the same notes replaces the first, it does not queue. */
export function draftIdFor(kind: Draft["kind"], targetId: string): string {
  return `${kind}:${targetId}`;
}

export function unsentCount(drafts: readonly Draft[]): number {
  return drafts.filter((draft) => draft.state !== "sending").length;
}
