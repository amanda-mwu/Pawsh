import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * TWO APPOINTMENTS AT THE SAME TIME ARE TWO CARDS SIDE BY SIDE.
 *
 * Overlapping appointments are permitted - a caller holding `appointments.override_conflict`
 * books one directly - and a card drawn over another hides a dog that is on the day's schedule.
 * Human QA found the second booking sitting on top of Charlie, and which of the two was on top
 * changed with the order the server returned them in. `appointmentColumnLayout` assembles one
 * groomer's column for one day and hands every card a lane and its cluster's lane count, through
 * the same `columnLanes` scan the blocked-time bands use.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────────
 *
 *   dropping the sort in `appointmentColumnLayout`     "the order is the schedule's, not the read's"
 *   `laneEnds.findIndex(value=>value<=from)` → `<`      "a visit that starts as another ends reuses the lane"
 *   `cluster.length&&from>=clusterEnd` removed          "clusters are independent" fails
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

const LANES = slice("function columnLanes(entries){", "\n/**\n * The band itself.");

interface Item { id: string; startAt: string; endAt: string }
interface Laid { item: Item; row: number; span: number; lane: number; lanes: number }
interface Module { appointmentColumnLayout(items: Item[], day: string, start: number, slots: number, firstRow: number): Laid[] }

function load(): Module {
  const prelude = `
    "use strict";
    // The fixtures are written as local wall-clock ISO strings, so the local value is the string.
    const appointmentLocalValue = (item) => item.startAt.slice(0, 16);
    const blockedTimePlacement = () => { throw new Error("not exercised here"); };
  `;
  const factory = new Function(prelude + LANES + "return { appointmentColumnLayout };") as () => Module;
  return factory();
}

/** A visit on 2026-09-21, from `from` to `to` as `HH:MM`. */
function visit(id: string, from: string, to: string): Item {
  return { id, startAt: `2026-09-21T${from}`, endAt: `2026-09-21T${to}` };
}

const DAY = "2026-09-21";
const START = 8 * 60;

describe("appointmentColumnLayout", () => {
  it("gives a lone visit the whole column, on its row, spanning its rows", () => {
    const [laid] = load().appointmentColumnLayout([visit("a", "09:00", "10:30")], DAY, START, 20, 3);
    expect(laid).toMatchObject({ row: 5, span: 3, lane: 0, lanes: 1 });
  });

  it("puts two overlapping visits side by side, and the order is the schedule's, not the read's", () => {
    const app = load();
    const first = app.appointmentColumnLayout([visit("b", "09:00", "10:30"), visit("a", "09:00", "10:30")], DAY, START, 20, 3);
    const second = app.appointmentColumnLayout([visit("a", "09:00", "10:30"), visit("b", "09:00", "10:30")], DAY, START, 20, 3);
    const shape = (laid: Laid[]) => laid.map((each) => [each.item.id, each.lane, each.lanes]);
    expect(shape(first)).toEqual([["a", 0, 2], ["b", 1, 2]]);
    expect(shape(second)).toEqual(shape(first));
  });

  it("sorts by start, then the longer visit first, so a long visit takes the first lane", () => {
    const laid = load().appointmentColumnLayout([visit("short", "09:00", "09:30"), visit("long", "09:00", "11:00")], DAY, START, 20, 3);
    expect(laid.map((each) => [each.item.id, each.lane])).toEqual([["long", 0], ["short", 1]]);
  });

  it("a visit that starts as another ends reuses the lane, and is not in its cluster", () => {
    const laid = load().appointmentColumnLayout([visit("a", "09:00", "10:00"), visit("b", "10:00", "11:00")], DAY, START, 20, 3);
    expect(laid.map((each) => [each.item.id, each.lane, each.lanes])).toEqual([["a", 0, 1], ["b", 0, 1]]);
  });

  it("clusters are independent: three at ten share thirds, the one at two has the column", () => {
    const laid = load().appointmentColumnLayout([
      visit("x", "10:00", "11:00"), visit("y", "10:15", "11:15"), visit("z", "10:30", "11:30"), visit("w", "14:00", "15:00")
    ], DAY, START, 20, 3);
    expect(laid.map((each) => [each.item.id, each.lane, each.lanes]))
      .toEqual([["x", 0, 3], ["y", 1, 3], ["z", 2, 3], ["w", 0, 1]]);
  });

  it("leaves out what is not on this day or outside the drawn rows", () => {
    const laid = load().appointmentColumnLayout([
      { id: "other-day", startAt: "2026-09-22T09:00", endAt: "2026-09-22T10:00" },
      visit("too-early", "06:00", "07:00"),
      visit("in", "09:00", "10:00")
    ], DAY, START, 20, 3);
    expect(laid.map((each) => each.item.id)).toEqual(["in"]);
  });
});
