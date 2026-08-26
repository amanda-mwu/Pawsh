import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  draftIdFor,
  draftStorage,
  removeDraft,
  unsentCount,
  upsertDraft,
  type Draft
} from "../../src/offline/drafts";

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "appointment-operational-notes:appointment-1",
    kind: "appointment-operational-notes",
    targetId: "appointment-1",
    targetLabel: "Biscuit · 9:00 – 10:30 AM",
    text: "Reacted badly to the dryer. Towel dried instead.",
    createdAt: 1_700_000_000_000,
    state: "pending",
    ...overrides
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("queue shape", () => {
  it("keys one draft per target, so a second edit replaces rather than queues", () => {
    const first = makeDraft();
    const second = makeDraft({ text: "Second pass." });
    expect(draftIdFor("appointment-operational-notes", "appointment-1")).toBe(first.id);
    const queue = upsertDraft(upsertDraft([], first), second);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.text).toBe("Second pass.");
  });

  it("removes by id", () => {
    expect(removeDraft([makeDraft()], makeDraft().id)).toEqual([]);
  });

  it("counts everything not currently in flight", () => {
    expect(
      unsentCount([
        makeDraft({ id: "a", state: "pending" }),
        makeDraft({ id: "b", state: "sending" }),
        makeDraft({ id: "c", state: "failed" })
      ])
    ).toBe(2);
  });
});

describe("persistence", () => {
  it("survives a round trip, so unsent writing outlives the app being killed", async () => {
    await draftStorage.write([makeDraft()]);
    const restored = await draftStorage.read();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.text).toBe("Reacted badly to the dryer. Towel dried instead.");
  });

  it("returns an empty queue rather than throwing on a corrupted store", async () => {
    await AsyncStorage.setItem("pawsh.drafts.v1", "{not json");
    await expect(draftStorage.read()).resolves.toEqual([]);
  });

  it("drops entries that are not drafts rather than crashing the launch", async () => {
    await AsyncStorage.setItem("pawsh.drafts.v1", JSON.stringify([{ nonsense: true }, makeDraft()]));
    await expect(draftStorage.read()).resolves.toHaveLength(1);
  });

  it("reads an empty queue when nothing has ever been written", async () => {
    await expect(draftStorage.read()).resolves.toEqual([]);
  });
});
