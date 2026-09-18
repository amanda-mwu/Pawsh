import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * FIVE-MINUTE SCHEDULING, THE ARITHMETIC.
 *
 * The server refuses any appointment or block whose wall-clock minute is not on a five-minute mark.
 * The client's job is to make sure nothing it sends can be off one: a typed or picked time is
 * snapped as the field changes, and a dragged card lands at the mark nearest to where the pointer
 * let go inside the 30-minute row. Those are pure functions in `public/app.js`, and they are run
 * here rather than restated: the drag test in `tests/e2e/five-minute-scheduling.spec.ts` lands one
 * card, this holds every edge of the rounding.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────────
 *
 *   `Math.round` → `Math.floor` in `snapMinutes`      "snaps to the NEAREST mark" fails on :08.
 *   dropping the `30-SCHEDULING_MINUTE_STEP` ceiling   "never lands in the next row" fails.
 *   the change listener ignoring `time` inputs          "the block editor's clock is snapped" fails.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

const SNAPPING = slice("const SCHEDULING_MINUTE_STEP=", "\n// The click that follows a completed drag");

interface FakeInput { type: string; step: string; value: string }
interface FakeSlot { dataset: { slot: string }; getBoundingClientRect(): { top: number; height: number } }
interface Module {
  snapMinutes(minutes: number): number;
  snapLocalDateTime(value: string): string;
  snapLocalTime(value: string): string;
  slotOffsetMinutes(fraction: number): number;
  dropLocalStart(slot: FakeSlot, y: number): string;
  change(input: FakeInput): void;
  stepAttr: string;
}

function load(): Module {
  class HTMLInputElement { tagName = "INPUT"; type = ""; step = ""; value = ""; }
  let handler: ((event: { target: unknown }) => void) | null = null;
  const document = {
    addEventListener(name: string, listener: (event: { target: unknown }) => void) {
      if (name === "change") handler = listener;
    }
  };
  const prelude = `
    "use strict";
    const dateShift=(value,days)=>{
      const date=new Date(String(value).slice(0,10)+"T00:00:00Z");
      date.setUTCDate(date.getUTCDate()+days);
      return date.toISOString().slice(0,10);
    };
  `;
  const exported = `return { snapMinutes, snapLocalDateTime, snapLocalTime, slotOffsetMinutes, dropLocalStart,
    stepAttr: FIVE_MINUTE_STEP_ATTR };`;
  const factory = new Function("document", prelude + SNAPPING + exported) as
    (document: unknown) => Omit<Module, "change">;
  const module = factory(document);
  return {
    ...module,
    change: (input) => {
      if (!handler) throw new Error("the change listener was never registered");
      const target = Object.assign(new HTMLInputElement(), input);
      handler({ target });
      input.value = target.value;
    }
  };
}

describe("a typed or picked time snaps to the nearest five-minute mark", () => {
  it("snaps to the NEAREST mark, in both directions", () => {
    const app = load();
    expect(app.snapMinutes(9 * 60 + 7)).toBe(9 * 60 + 5);
    expect(app.snapMinutes(9 * 60 + 8)).toBe(9 * 60 + 10);
    expect(app.snapMinutes(9 * 60 + 2)).toBe(9 * 60);
    expect(app.snapMinutes(9 * 60 + 5)).toBe(9 * 60 + 5);
  });

  it("keeps the date, carries the hour, and rolls midnight over to the next day", () => {
    const app = load();
    expect(app.snapLocalDateTime("2026-09-21T09:07")).toBe("2026-09-21T09:05");
    expect(app.snapLocalDateTime("2026-09-21T09:58")).toBe("2026-09-21T10:00");
    expect(app.snapLocalDateTime("2026-09-21T09:57:30")).toBe("2026-09-21T09:55");
    expect(app.snapLocalDateTime("2026-09-30T23:58")).toBe("2026-10-01T00:00");
    expect(app.snapLocalDateTime("2026-09-21T10:00")).toBe("2026-09-21T10:00");
  });

  it("leaves what it cannot read alone, so the field's own validation still speaks", () => {
    const app = load();
    expect(app.snapLocalDateTime("")).toBe("");
    expect(app.snapLocalDateTime("not a time")).toBe("not a time");
    expect(app.snapLocalTime("nope")).toBe("nope");
  });

  it("snaps a bare clock too, wrapping at midnight", () => {
    const app = load();
    expect(app.snapLocalTime("09:07")).toBe("09:05");
    expect(app.snapLocalTime("23:59")).toBe("00:00");
    expect(app.snapLocalTime("12:12:00")).toBe("12:10");
  });

  it("the step attribute the fields carry is five minutes in seconds", () => {
    expect(load().stepAttr).toBe('step="300"');
  });

  it("the change listener snaps only the fields that carry the step", () => {
    const app = load();
    const booked: FakeInput = { type: "datetime-local", step: "300", value: "2026-09-21T09:07" };
    app.change(booked);
    expect(booked.value).toBe("2026-09-21T09:05");
    // The block editor's clock is snapped as well.
    const clock: FakeInput = { type: "time", step: "300", value: "12:12" };
    app.change(clock);
    expect(clock.value).toBe("12:10");
    // A field without the step - the report date, a signed-at stamp - is not touched.
    const other: FakeInput = { type: "datetime-local", step: "", value: "2026-09-21T09:07" };
    app.change(other);
    expect(other.value).toBe("2026-09-21T09:07");
  });
});

describe("a dragged card lands on the mark nearest the pointer inside its 30-minute row", () => {
  it("reads the pointer's fraction of the row as minutes, rounded to five", () => {
    const app = load();
    expect(app.slotOffsetMinutes(0)).toBe(0);
    expect(app.slotOffsetMinutes(0.1)).toBe(5);
    expect(app.slotOffsetMinutes(0.5)).toBe(15);
    expect(app.slotOffsetMinutes(2 / 3)).toBe(20);
  });

  it("never lands in the next row: the ceiling is :25 into the row", () => {
    const app = load();
    expect(app.slotOffsetMinutes(0.95)).toBe(25);
    expect(app.slotOffsetMinutes(1)).toBe(25);
    expect(app.slotOffsetMinutes(1.4)).toBe(25);
    expect(app.slotOffsetMinutes(-0.2)).toBe(0);
    expect(app.slotOffsetMinutes(Number.NaN)).toBe(0);
  });

  it("adds the offset to the row's own time", () => {
    const app = load();
    const slot = (time: string, top = 100, height = 36): FakeSlot => ({
      dataset: { slot: `2026-09-21T${time}` },
      getBoundingClientRect: () => ({ top, height })
    });
    expect(app.dropLocalStart(slot("11:30"), 124)).toBe("2026-09-21T11:50");
    expect(app.dropLocalStart(slot("11:00"), 100)).toBe("2026-09-21T11:00");
    expect(app.dropLocalStart(slot("11:00"), 135)).toBe("2026-09-21T11:25");
    // A row with no height - never in practice - lands at the row's own time.
    expect(app.dropLocalStart(slot("09:30", 100, 0), 130)).toBe("2026-09-21T09:30");
  });
});
