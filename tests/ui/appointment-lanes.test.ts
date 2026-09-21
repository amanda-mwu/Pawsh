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
 * AND EVERY CARD IS PAINTED AT ITS TRUE MINUTES. The grid is 30-minute rows, but a 10:45 visit is
 * not a 10:30 visit: `minutePlacement` hands each card the rows it spans AND the minute pair the
 * stylesheet places it by within them (`--minute-offset`, `--minute-span`), so the painted box and
 * the strip on it can no longer disagree. Human QA read the old whole-row paint as the calendar
 * rounding a 4:15 drop to the half hour.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────────
 *
 *   dropping the sort in `appointmentColumnLayout`     "the order is the schedule's, not the read's"
 *   `laneEnds.findIndex(value=>value<=from)` → `<`      "a visit that starts as another ends reuses the lane"
 *   `cluster.length&&from>=clusterEnd` removed          "clusters are independent" fails
 *   `Math.max(5, ...)` back to `Math.max(30, ...)`      "a 20-minute visit paints 20 minutes tall" fails
 *   `minuteOffset` back to 0                            "a 10:45 visit begins 15 minutes into" fails
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
interface Place { offset: number; span: number; from: number; to: number; minuteOffset: number; minutes: number }
interface Laid { item: Item; row: number; span: number; place: Place; lane: number; lanes: number }
interface Module {
  appointmentColumnLayout(items: Item[], day: string, start: number, slots: number, firstRow: number): Laid[];
  minutePlacement(from: number, to: number, start: number): Place;
  minutePaintStyle(place: Place): string;
}

function load(): Module {
  const prelude = `
    "use strict";
    // The fixtures are written as local wall-clock ISO strings, so the local value is the string.
    const appointmentLocalValue = (item) => item.startAt.slice(0, 16);
    const blockedTimePlacement = () => { throw new Error("not exercised here"); };
  `;
  const factory = new Function(prelude + LANES + "return { appointmentColumnLayout, minutePlacement, minutePaintStyle };") as () => Module;
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

  it("compares the visits' own minutes, so 12:00-12:15 and 12:20-12:30 keep the full column", () => {
    // Neither overlaps the other on the clock, and both are painted at their own minutes now, so
    // there is daylight between them on the grid too. Halving both would be a narrowing for an
    // overlap nobody can see.
    const laid = load().appointmentColumnLayout([visit("a", "12:00", "12:15"), visit("b", "12:20", "12:30")], DAY, START, 20, 3);
    expect(laid.map((each) => [each.item.id, each.lane, each.lanes])).toEqual([["a", 0, 1], ["b", 0, 1]]);
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

describe("every card is painted at its true minutes", () => {
  it("a 10:45 visit begins 15 minutes into the 10:30 row and is 65 minutes tall", () => {
    // Rocky, as human QA saw him: 10:45-11:50 drawn from the 10:30 line to the 12:00 line. The grid
    // rows still run 10:30 through 11:30 (three rows); the minute pair says where inside them.
    const [laid] = load().appointmentColumnLayout([visit("rocky", "10:45", "11:50")], DAY, START, 20, 3);
    expect(laid).toMatchObject({ row: 8, span: 3, place: { minuteOffset: 15, minutes: 65, from: 10 * 60 + 45, to: 11 * 60 + 50 } });
  });

  it("a 20-minute visit paints 20 minutes tall, not a half hour", () => {
    const [laid] = load().appointmentColumnLayout([visit("trim", "14:00", "14:20")], DAY, START, 20, 3);
    expect(laid).toMatchObject({ row: 15, span: 1, place: { minuteOffset: 0, minutes: 20 } });
  });

  it("a visit that runs past the last drawn row is painted to the row and no further", () => {
    // 20 rows from 08:00 end at 18:00. The card still competes for lanes with its true end, so a
    // visit that only meets it after closing still narrows it.
    const laid = load().appointmentColumnLayout([visit("late", "17:45", "18:30"), visit("beside", "17:55", "18:40")], DAY, START, 20, 3);
    expect(laid[0]).toMatchObject({ item: { id: "late" }, row: 22, span: 1, place: { minuteOffset: 15, minutes: 15 }, lane: 0, lanes: 2 });
  });

  it("hands the stylesheet the pair it paints by", () => {
    const app = load();
    const place = app.minutePlacement(10 * 60 + 45, 11 * 60 + 50, START);
    expect(place).toEqual({ offset: 5, span: 3, from: 645, to: 710, minuteOffset: 15, minutes: 65 });
    expect(app.minutePaintStyle(place)).toBe("--minute-offset:15;--minute-span:65");
  });

  it("both grids write that pair onto every card and every band", () => {
    // The renderers need a document, so they are held to the contract by their own text: a card
    // or a band placed without the pair is one painted at whole rows again.
    const paints = source.match(/grid-row:\$\{[^}]+\}\/span \$\{[^}]+\};\$\{minutePaintStyle\(place\)\}/gu) ?? [];
    expect(paints, "week cards, day cards, week bands, day bands and the drop ghost").toHaveLength(5);
    expect(source).not.toMatch(/grid-row:\$\{[^}]+\}\/span \$\{[^}]+\}`/u);
  });

  it("the stylesheet turns the pair into a margin and a height against the row height", () => {
    const css = readFileSync("public/styles.css", "utf8");
    const rule = css.match(/\.week-appointment,\.calendar-block,\.calendar-drop-preview\{[^}]+\}/u)?.[0] ?? "";
    expect(rule).toContain("align-self:start");
    expect(rule).toContain("margin-top:calc(var(--slot-height)*var(--minute-offset,0)/30 + 2px)");
    expect(rule).toContain("height:calc(var(--slot-height)*var(--minute-span,30)/30 - 4px)");
  });
});
