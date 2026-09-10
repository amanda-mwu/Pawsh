import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * BLOCK TIME: THE BANDS ON THE GRID, AND THE CLOCK IN THE DIALOG.
 *
 * `tests/e2e/blocked-time-visibility.spec.ts` and `tests/e2e/blocked-time-editing.spec.ts` drive
 * both of these in a real browser, which is where the pointer, the focus order and the geometry
 * belong. This file exists for the half that is arithmetic and markup, because both defects it
 * covers are silent:
 *
 *   - two blocks for one groomer at one time painted EXACTLY ON TOP OF EACH OTHER. Nothing errored,
 *     nothing looked wrong, and the operator who had just created the second one read the unchanged
 *     grid as the create having failed - so their next move was to create it again.
 *   - a create dialog whose End did not follow its Start, so the commonest block anybody makes -
 *     the next hour - was a time typed out in full every time.
 *
 * `public/app.js` is served as a plain file with no bundler and has top-level side effects that
 * need a document, so the two regions are sliced out by their own boundaries and evaluated against
 * stubs, exactly as `tests/ui/business-settings.test.ts` does. Both anchors are declarations this
 * file would have to be rewritten for anyway.
 */
const source = readFileSync("public/app.js", "utf8");
const css = readFileSync("public/styles.css", "utf8");

/** The bands: placement, lane assignment, and the band markup itself. */
const bandStart = source.indexOf("function blockedTimeMinutes(wall)");
const bandEnd = source.indexOf("\nfunction calendarBlockedTimes()");
/** The dialog's own helpers, the one-hour rule, and the whole scroll picker. */
const clockStart = source.indexOf("/** The block's own colour, or null.");
// Found INSIDE a line and then walked back to the comment that opens the next region, rather than
// anchored across the line break between them. `core.autocrlf` is on for this repository, so a
// Windows checkout of the client has CRLF endings, and an anchor holding a bare "\n" followed by
// anything other than a line start matches nothing at all - which would slice this file's harness
// off in the middle of a comment and fail as a syntax error rather than as a moved anchor.
const clockEnd = source.lastIndexOf("/**", source.indexOf(" * The colour picker, and it is the STAFF one."));

interface Block {
  id: string;
  employeeId?: string;
  employeeName?: string;
  reason?: string | null;
  colorSlot?: number | null;
  scheduledLocalStart: string;
  scheduledLocalEnd: string;
}
interface Placed {
  block: Block;
  place: { offset: number; span: number };
  lane: number;
  lanes: number;
}
interface Selection { hour: number; minute: number; meridiem: string | null }
interface BlockModule {
  blockedTimePlacement(block: Block, day: string, start: number, end: number): { offset: number; span: number } | null;
  blockedTimeColumnLayout(blocks: Block[], day: string, start: number, end: number): Placed[];
  blockedTimeBand(block: Block, style: string, lanes?: { lane: number; lanes: number }): string;
  blockedTimeAccessibleName(block: Block, lanes?: { lane: number; lanes: number }): string;
  blockedTimePlusHour(value: string): string;
  blockedTimeClockField(options: Record<string, unknown>): string;
  timePickerSelection(clock: string): Selection;
  timePickerClockOf(selection: Selection): string;
  timePickerValues(column: string, selection: Selection): Array<number | string>;
  timePickerMarkup(id: string, selection: Selection, testid: string): string;
  timePickerClock(input: { type: string; value: string }): string;
  timePickerWrite(input: { type: string; value: string }, clock: string): void;
  setHourFormat(format: "12" | "24"): void;
}

/**
 * The two regions, run against the smallest set of stubs that keeps them honest.
 *
 * `formatPrefClock` is written out rather than mocked away, because half of what this file asserts
 * about the picker is that the workspace's hour format reaches it - a stub that always said "2:00
 * PM" would let a 24-hour regression through with every test still green.
 */
function loadBlockModule(hourFormat: "12" | "24" = "12"): BlockModule {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const prelude = `
    "use strict";
    let HOUR_FORMAT=${JSON.stringify(hourFormat)};
    const groomerSlotNames=["Plum","Steel blue","Teal","Amber","Olive","Mulberry","Umber","Indigo","Rose","Ocean"];
    const groomerPaletteSize=groomerSlotNames.length;
    const prefHourFormat=()=>HOUR_FORMAT;
    const prefPad=(value,width=2)=>String(value).padStart(width,"0");
    const formatPrefClock=(hour,minute)=>{
      const shown=prefPad(minute);
      if(prefHourFormat()==="24")return prefPad(hour)+":"+shown;
      return (hour%12===0?12:hour%12)+":"+shown+" "+(hour<12?"AM":"PM");
    };
    const timeLabel=(minutes)=>formatPrefClock(Math.floor(minutes/60),minutes%60);
    const dateShift=(value,days)=>{
      const date=new Date(String(value).slice(0,10)+"T00:00:00Z");
      date.setUTCDate(date.getUTCDate()+days);
      return date.toISOString().slice(0,10);
    };
    const businessDate=()=>"2026-09-08";
    const formatPrefLocalWeekdayDate=(value)=>String(value);
    const state={calendar:{selectedDate:"2026-09-08"}};
    const allowed=()=>true;
  `;
  const exported = `
    return {blockedTimePlacement,blockedTimeColumnLayout,blockedTimeBand,blockedTimeAccessibleName,
      blockedTimePlusHour,blockedTimeClockField,timePickerSelection,
      timePickerClockOf,timePickerValues,timePickerMarkup,timePickerClock,timePickerWrite,
      setHourFormat:(format)=>{HOUR_FORMAT=format;}};
  `;
  const factory = new Function(
    "escape", "escapeAttr", "document",
    prelude + source.slice(bandStart, bandEnd) + source.slice(clockStart, clockEnd) + exported
  ) as (escape: unknown, escapeAttr: unknown, document: unknown) => BlockModule;
  return factory(escape, escapeAttr, undefined);
}

/** A block on 2026-09-08, named by its own times so a failure reads as a clock rather than an id. */
function block(from: string, to: string, extra: Partial<Block> = {}): Block {
  return {
    id: `${from}-${to}`,
    employeeId: "grace",
    employeeName: "Grace",
    reason: null,
    colorSlot: null,
    scheduledLocalStart: `2026-09-08T${from}`,
    scheduledLocalEnd: `2026-09-08T${to}`,
    ...extra
  };
}
/** The calendar's default drawn window: 08:00 to 19:00, in minutes. */
const WINDOW: [string, number, number] = ["2026-09-08", 8 * 60, 19 * 60];

let blocks: BlockModule;
beforeEach(() => { blocks = loadBlockModule(); });

describe("the client slices a real block out of itself", () => {
  it("finds both regions", () => {
    expect(bandStart).toBeGreaterThan(-1);
    expect(bandEnd).toBeGreaterThan(bandStart);
    expect(clockStart).toBeGreaterThan(bandEnd);
    expect(clockEnd).toBeGreaterThan(clockStart);
  });
});

describe("blocks at the same time are laid out side by side", () => {
  /** [id, lane, lanes] for every band the column draws, which is the whole answer in one line. */
  function laid(items: Block[]): Array<[string, number, number]> {
    return blocks.blockedTimeColumnLayout(items, ...WINDOW)
      .map((entry) => [entry.block.id, entry.lane, entry.lanes]);
  }

  it("leaves a lone block at the full width of its column", () => {
    expect(laid([block("12:00", "12:30")])).toEqual([["12:00-12:30", 0, 1]]);
  });

  it("splits two identical blocks into two lanes", () => {
    // The defect, exactly as human QA found it: a seeded lunch and a block created over it, same
    // groomer, same half hour. One band was drawn and the operator believed the create had failed.
    const lunch = block("12:00", "12:30", { id: "lunch", reason: "QA seed: Lunch" });
    const need = block("12:00", "12:30", { id: "need", reason: "NEED TIME" });
    expect(laid([lunch, need])).toEqual([["lunch", 0, 2], ["need", 1, 2]]);
  });

  it("splits three into three, so none of them is the one underneath", () => {
    // Two lanes would be enough for a boolean `overlap` flag and is exactly where that flag stops
    // being enough. The third block must get its own lane rather than landing back on the second.
    const items = [
      block("10:00", "11:00", { id: "a" }),
      block("10:30", "11:30", { id: "b" }),
      block("10:30", "11:00", { id: "c" })
    ];
    expect(laid(items)).toEqual([["a", 0, 3], ["b", 1, 3], ["c", 2, 3]]);
  });

  it("reads a partial overlap as an overlap", () => {
    const items = [block("10:00", "11:00"), block("10:30", "11:30")];
    expect(laid(items)).toEqual([["10:00-11:00", 0, 2], ["10:30-11:30", 1, 2]]);
  });

  it("leaves two blocks that merely touch at the full width", () => {
    // 10:00-10:30 ends exactly where 10:30-11:00 begins. They share an edge and no pixels, so
    // halving either of them would be a narrowing nobody asked for.
    expect(laid([block("10:00", "10:30"), block("10:30", "11:00")]))
      .toEqual([["10:00-10:30", 0, 1], ["10:30-11:00", 0, 1]]);
  });

  it("separates two blocks that share a painted row but not a minute", () => {
    // 12:00-12:15 and 12:20-12:30 do not overlap on the clock, and DO overlap on the grid: a band
    // is snapped to whole half-hour rows, so both of these fill the single 12:00 row. Comparing
    // minutes here would leave exactly the pair this seam exists to unstack.
    expect(laid([block("12:00", "12:15"), block("12:20", "12:30")]))
      .toEqual([["12:00-12:15", 0, 2], ["12:20-12:30", 1, 2]]);
  });

  it("counts lanes per cluster rather than per column", () => {
    // A 9:00 pair must not halve the width of an unrelated 16:00 block eight rows below it.
    expect(laid([block("09:00", "10:00"), block("09:30", "10:30"), block("16:00", "16:30")]))
      .toEqual([["09:00-10:00", 0, 2], ["09:30-10:30", 1, 2], ["16:00-16:30", 0, 1]]);
  });

  it("chains a cluster through the block that connects it, and reuses a lane that has cleared", () => {
    // A staircase: A and B overlap, B and C overlap, A and C never touch. All three belong to one
    // cluster because B chains them - so they are all measured against the same column width - but
    // the width only has to be two, because no instant of the morning has three bands in it. C
    // takes the lane A has already finished with, which is what stops a long staircase narrowing
    // the column one lane per step.
    expect(laid([block("09:00", "10:00"), block("09:30", "10:30"), block("10:00", "11:00")]))
      .toEqual([["09:00-10:00", 0, 2], ["09:30-10:30", 1, 2], ["10:00-11:00", 0, 2]]);
  });

  it("draws nothing for a block outside the window, and does not count it as a lane", () => {
    // 06:00-07:00 is before the calendar's first drawn row. It must not silently make the block
    // that IS on screen half as wide as it should be.
    expect(laid([block("06:00", "07:00"), block("12:00", "12:30")]))
      .toEqual([["12:00-12:30", 0, 1]]);
  });

  it("orders a stack the same way every time it is drawn", () => {
    // The read route makes no ordering promise, and a stack whose lanes swapped between two paints
    // would move under the operator's cursor for no reason they could see.
    const first = laid([block("12:00", "12:30", { id: "b" }), block("12:00", "12:30", { id: "a" })]);
    const second = laid([block("12:00", "12:30", { id: "a" }), block("12:00", "12:30", { id: "b" })]);
    expect(first).toEqual(second);
  });
});

describe("a stacked band is still a band", () => {
  const pair = [
    block("12:00", "12:30", { id: "lunch", reason: "Lunch" }),
    block("12:00", "12:30", { id: "need", reason: "NEED TIME", colorSlot: 3 })
  ];
  function bands(items = pair): string[] {
    return blocks.blockedTimeColumnLayout(items, ...WINDOW)
      .map((entry) => blocks.blockedTimeBand(entry.block, "grid-column:2;grid-row:9", entry));
  }

  it("says nothing about lanes when there is only one", () => {
    const [only] = bands([block("12:00", "12:30")]);
    expect(only).not.toContain("data-block-lanes");
    expect(only).not.toContain("--block-lane");
  });

  it("carries its lane and its cluster size to the stylesheet", () => {
    const [first, second] = bands();
    expect(first).toContain('data-block-lane="0" data-block-lanes="2"');
    expect(first).toContain("--block-lane:0;--block-lanes:2");
    expect(second).toContain('data-block-lane="1" data-block-lanes="2"');
    expect(second).toContain("--block-lane:1;--block-lanes:2");
    // The grid placement it was given is still the grid placement it draws at.
    expect(first).toContain("grid-column:2;grid-row:9");
  });

  it("names each band in the stack individually", () => {
    const [first, second] = bands();
    expect(first).toContain('aria-label="Blocked time, 12:00 PM–12:30 PM, Grace, Lunch, 1 of 2"');
    expect(second).toContain('aria-label="Blocked time, 12:00 PM–12:30 PM, Grace, NEED TIME, Amber, 2 of 2"');
  });

  it("still names a lone band without a position nobody needs", () => {
    expect(blocks.blockedTimeAccessibleName(block("12:00", "12:30", { reason: "Lunch" })))
      .toBe("Blocked time, 12:00 PM–12:30 PM, Grace, Lunch");
  });

  it("distinguishes two blocks that are identical in every other word", () => {
    // No note and no colour on either, so the position is the ONLY thing that can tell a reader
    // which of the two bands they have landed on.
    const [first, second] = bands([
      block("12:00", "12:30", { id: "a" }), block("12:00", "12:30", { id: "b" })
    ]);
    const name = (markup = "") => /aria-label="([^"]+)"/.exec(markup)?.[1];
    expect(name(first)).toBeTruthy();
    expect(name(first)).not.toBe(name(second));
  });

  it("stays out of drag and drop however many lanes it is in", () => {
    for (const markup of bands()) {
      // The three attributes `calendarDragCard` and `calendarDropSlot` look for. A band that grew
      // any of them would become draggable, or a drop target, and stop being refused by the server.
      expect(markup).not.toContain("data-appointment-id");
      expect(markup).not.toContain("data-draggable");
      expect(markup).not.toContain("data-slot");
      // And the anatomy that says "block" rather than "booking" is untouched.
      expect(markup).toContain('class="calendar-block"');
      expect(markup).toContain('data-testid="calendar-block"');
      expect(markup).toContain("calendar-block-open");
    }
  });

  it("keeps a colour on a stacked band", () => {
    expect(bands()[1]).toContain('data-block-slot="3"');
  });

  it("has a stylesheet rule to spend the lane on", () => {
    // The band hands the geometry to CSS custom properties, so the markup alone proves nothing.
    expect(css).toContain(".calendar-block[data-block-lanes]{");
    expect(css).toContain("var(--block-lanes)");
    expect(css).toContain("var(--block-lane)");
  });
});

describe("a new block is an hour long until somebody says otherwise", () => {
  it("offers an End one hour after the slot that was clicked", () => {
    expect(blocks.blockedTimePlusHour("2026-09-08T14:00")).toBe("2026-09-08T15:00");
  });

  it("rolls into the next day rather than stopping at midnight", () => {
    expect(blocks.blockedTimePlusHour("2026-09-08T23:30")).toBe("2026-09-09T00:30");
  });

  it("still offers an hour when an hour runs past closing", () => {
    // The calendar's drawn window ends at 19:00 by default and salons close earlier than that.
    // Clamping here would put a time in the field nobody chose; whether the interval is ALLOWED is
    // the server's sentence, and it says it on submit with a message rather than in a form field.
    expect(blocks.blockedTimePlusHour("2026-09-08T18:30")).toBe("2026-09-08T19:30");
    expect(blocks.blockedTimePlusHour("2026-09-08T22:00")).toBe("2026-09-08T23:00");
  });

  it("suggests nothing at all when the Start is empty or unusable", () => {
    // The New menu opens the dialog with no preset. An End of "01:00" hung on nothing would be a
    // worse starting point than a blank one.
    expect(blocks.blockedTimePlusHour("")).toBe("");
    expect(blocks.blockedTimePlusHour("2026-09-08")).toBe("");
    expect(blocks.blockedTimePlusHour("not a time")).toBe("");
  });

  it("is wired to both fields of the create dialog", () => {
    // The default at open, and the link that keeps it while the End is still a suggestion.
    expect(source).toContain('blockedTimeClockField({name:"endAt",label:"End",value:blockedTimePlusHour(preset||"")');
    expect(source).toContain("function bindBlockedTimeCreateSchedule()");
    expect(source).toContain("bindBlockedTimeCreateSchedule();");
    // The latch is set from the End's own `input` event and nothing else: assigning `.value` in
    // script fires no event, so the link moving the End can never be read as the operator choosing
    // it. Change this and the End stops following the Start after the first suggestion.
    expect(source).toContain('end.addEventListener("input",()=>{endChosen=true;});');
  });
});

describe("the scroll picker reads the workspace's hour format", () => {
  it("offers three columns and a twelve-hour clock", () => {
    const selection = blocks.timePickerSelection("14:05");
    expect(selection).toEqual({ hour: 2, minute: 5, meridiem: "PM" });
    expect(blocks.timePickerValues("hour", selection))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(blocks.timePickerValues("meridiem", selection)).toEqual(["AM", "PM"]);
  });

  it("offers two columns and a twenty-four-hour clock when the workspace asked for one", () => {
    const twentyFour = loadBlockModule("24");
    const selection = twentyFour.timePickerSelection("14:05");
    expect(selection).toEqual({ hour: 14, minute: 5, meridiem: null });
    expect(twentyFour.timePickerValues("hour", selection)).toHaveLength(24);
    expect(twentyFour.timePickerValues("hour", selection)[0]).toBe(0);
    expect(twentyFour.timePickerValues("hour", selection)[23]).toBe(23);
    // `meridiem: null` is what suppresses the third column, so the markup must not draw one.
    expect(twentyFour.timePickerMarkup("t", selection, "field-startAt")).not.toContain("AM or PM");
  });

  it("says midnight and noon the way a clock does rather than the way a modulo does", () => {
    expect(blocks.timePickerSelection("00:00")).toEqual({ hour: 12, minute: 0, meridiem: "AM" });
    expect(blocks.timePickerSelection("12:00")).toEqual({ hour: 12, minute: 0, meridiem: "PM" });
    expect(blocks.timePickerClockOf({ hour: 12, minute: 0, meridiem: "AM" })).toBe("00:00");
    expect(blocks.timePickerClockOf({ hour: 12, minute: 0, meridiem: "PM" })).toBe("12:00");
  });

  it("round-trips every minute of the day through the columns and back", () => {
    for (let minutes = 0; minutes < 24 * 60; minutes += 5) {
      const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      expect(blocks.timePickerClockOf(blocks.timePickerSelection(clock)), clock).toBe(clock);
    }
  });

  it("opens on a sensible hour when the field is empty rather than on a blank column", () => {
    expect(blocks.timePickerSelection("")).toEqual({ hour: 9, minute: 0, meridiem: "AM" });
  });

  it("offers the reference's five-minute ladder", () => {
    expect(blocks.timePickerValues("minute", { hour: 2, minute: 0, meridiem: "PM" }))
      .toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it("also offers a minute the field already holds that is not on the ladder", () => {
    // A block stored at 12:07 has to be openable and closeable without the picker quietly rounding
    // it. A control that cannot express the value it was handed edits by being looked at.
    const values = blocks.timePickerValues("minute", { hour: 12, minute: 7, meridiem: "PM" });
    expect(values).toContain(7);
    expect(values.indexOf(7)).toBe(values.indexOf(5) + 1);
    expect(values).toHaveLength(13);
  });
});

describe("the picker reads and writes the field without parsing it", () => {
  it("slices the time out of a datetime-local and out of a time", () => {
    expect(blocks.timePickerClock({ type: "datetime-local", value: "2026-09-08T14:30" })).toBe("14:30");
    expect(blocks.timePickerClock({ type: "time", value: "14:30" })).toBe("14:30");
    expect(blocks.timePickerClock({ type: "time", value: "" })).toBe("");
  });

  it("leaves a datetime-local's own date exactly where it found it", () => {
    // The wall clock is sliced, never `new Date(...)`-ed: parsing here would re-read a Los Angeles
    // block in a New York browser and move the day.
    const input = { type: "datetime-local", value: "2026-12-31T23:00" };
    blocks.timePickerWrite(input, "08:15");
    expect(input.value).toBe("2026-12-31T08:15");
  });

  it("falls back to the day on screen when the field carries no date yet", () => {
    const input = { type: "datetime-local", value: "" };
    blocks.timePickerWrite(input, "08:15");
    expect(input.value).toBe("2026-09-08T08:15");
  });

  it("writes a bare clock into a time field", () => {
    const input = { type: "time", value: "12:00" };
    blocks.timePickerWrite(input, "08:15");
    expect(input.value).toBe("08:15");
  });
});

describe("the picker is operable by something other than a mouse", () => {
  const markup = () =>
    loadBlockModule().timePickerMarkup("time-picker-startAt", { hour: 2, minute: 5, meridiem: "PM" }, "field-startAt");

  it("makes each column one named listbox with one tab stop", () => {
    const columns = [...markup().matchAll(/data-time-picker-column="(\w+)"/g)].map((match) => match[1]);
    expect(columns).toEqual(["hour", "minute", "meridiem"]);
    expect(markup().match(/role="listbox"/g)).toHaveLength(3);
    expect(markup().match(/tabindex="0"/g)).toHaveLength(3);
    // Named, so a reader arriving on a column of numbers is told which numbers they are.
    for (const name of ["Hour", "Minute", "AM or PM"]) expect(markup()).toContain(`>${name}<`);
    expect(markup().match(/aria-labelledby="time-picker-startAt-\w+-name"/g)).toHaveLength(3);
  });

  it("points each column at the option it is currently on", () => {
    expect(markup()).toContain('aria-activedescendant="time-picker-startAt-hour-2"');
    expect(markup()).toContain('aria-activedescendant="time-picker-startAt-minute-5"');
    expect(markup()).toContain('aria-activedescendant="time-picker-startAt-meridiem-pm"');
    expect(markup().match(/aria-selected="true"/g)).toHaveLength(3);
  });

  it("keeps the options out of the tab order and inside the listbox", () => {
    expect(markup().match(/role="option"/g)).toHaveLength(12 + 12 + 2);
    expect(markup().match(/tabindex="-1"/g)).toHaveLength(12 + 12 + 2);
    // Real buttons rather than clickable divs, so the pointer gets a control the browser already
    // knows how to press and hover.
    expect(markup()).toMatch(/<button type="button" role="option" tabindex="-1" class="time-picker-option"/);
  });

  it("commits from an OK the operator can find", () => {
    expect(markup()).toContain('data-testid="field-startAt-picker-ok"');
    expect(markup()).toContain(">OK</button>");
    expect(css).toContain(".time-picker-ok{min-width:64px;min-height:44px}");
  });

  it("draws its options at the tested target size", () => {
    expect(css).toContain(".time-picker-option{min-width:44px;min-height:44px");
  });

  it("dismisses on Escape without writing, and only OK writes", () => {
    // Two claims in one source read, because the pair is the whole contract: the Escape branch
    // closes and returns, and `timePickerWrite` is reached from `commitTimePicker` alone.
    expect(source).toContain('if(event.key==="Escape"){');
    expect(source).toMatch(/event\.preventDefault\(\);event\.stopPropagation\(\);closeTimePicker\(\{restoreFocus:true\}\);return;/);
    const writers = [...source.matchAll(/timePickerWrite\(/g)];
    expect(writers, "timePickerWrite is defined once and called once, from commitTimePicker").toHaveLength(2);
    expect(source).toContain("function commitTimePicker(){");
    expect(source.slice(source.indexOf("function commitTimePicker(){")))
      .toMatch(/^function commitTimePicker\(\)\{[\s\S]*?timePickerWrite\(input,clock\);/);
  });
});

describe("the field the picker hangs off is still a field", () => {
  const field = (options: Record<string, unknown> = {}) => loadBlockModule().blockedTimeClockField({
    name: "localStartTime", label: "Start", value: "12:00", type: "time",
    testid: "blocked-time-start", pickerLabel: "Choose the start time", ...options
  });

  it("keeps the name, type, value and test id the submit path already reads", () => {
    expect(field()).toContain('name="localStartTime"');
    expect(field()).toContain('type="time"');
    expect(field()).toContain('value="12:00"');
    expect(field()).toContain('data-testid="blocked-time-start"');
    expect(field()).toContain("required");
  });

  it("names the input with a span rather than wrapping it in a label", () => {
    // A `<button>` inside a `<label>` gets the label's click forwarded to it AND forwards its own
    // to the input, so a clock inside one would open the browser's picker over ours.
    expect(field()).toContain('aria-labelledby="time-picker-localStartTime-caption"');
    expect(field()).toContain('id="time-picker-localStartTime-caption"');
    expect(field()).not.toContain("<label");
  });

  it("gives the popover a trigger that says what it opens", () => {
    expect(field()).toContain('aria-haspopup="dialog"');
    expect(field()).toContain('aria-expanded="false"');
    expect(field()).toContain('aria-controls="time-picker-localStartTime"');
    expect(field()).toContain('aria-label="Choose the start time"');
    expect(field()).toContain('data-testid="blocked-time-start-picker"');
    // `public/app.js` binds every `.close` in the document to closing the shared modal, so a
    // control in here that borrowed that class would dismiss whatever dialog is open.
    expect(field()).not.toMatch(/class="[^"]*\bclose\b/);
  });

  it("speaks the committed value for a reader whose focus is back on the clock", () => {
    expect(field()).toContain('role="status" aria-live="polite" data-time-picker-live');
    expect(field()).toContain('class="visually-hidden"');
  });

  it("disables the clock with the field it belongs to", () => {
    // A block spanning more than a night has its whole schedule disabled, and so does a reader
    // without `calendar.blocks_edit`. A live clock beside a dead input would be a lie.
    const locked = field({ disabled: true });
    expect(locked).toMatch(/<input[^>]*\sdisabled/);
    expect(locked).toContain('disabled aria-disabled="true"');
  });

  it("starts its popover empty and hidden", () => {
    // Built on open, so it always reflects the value in the field and the workspace's CURRENT hour
    // format rather than the one in force when the dialog was drawn.
    expect(field()).toContain('<div class="time-picker-popover" id="time-picker-localStartTime" role="dialog" aria-label="Choose the start time" hidden></div>');
  });
});

describe("the picker is Block Time's and nothing else's", () => {
  it("is attached to exactly the four Block Time fields", () => {
    // Amanda scoped this seam to Block Time in as many words. Four call sites - Start and End of
    // the create dialog, Start and End of the drawer - plus the one declaration.
    const calls = [...source.matchAll(/blockedTimeClockField\(/g)];
    expect(calls).toHaveLength(5);
    for (const name of ["startAt", "endAt", "localStartTime", "localEndTime"])
      expect(source).toContain(`blockedTimeClockField({name:"${name}"`);
  });

  it("leaves the booking workspace's own times alone", () => {
    // The booking dialog builds its schedule from `field()`, and it still does. If this ever fails
    // it means the picker has spread past its seam rather than that a test needs updating.
    const booking = source.slice(source.indexOf("function renderBookingDetailPane()"), source.indexOf("function bookingLapsedPets()"));
    expect(booking.length).toBeGreaterThan(0);
    expect(booking).not.toContain("blockedTimeClockField");
    expect(booking).not.toContain("time-picker");
  });

  it("leaves Settings -> Business -> Hours alone", () => {
    const hours = source.slice(source.indexOf("function businessHoursTimesMarkup("), source.indexOf("function businessHoursRowMarkup("));
    expect(hours.length).toBeGreaterThan(0);
    expect(hours).not.toContain("blockedTimeClockField");
    expect(hours).not.toContain("time-picker");
  });

  it("brings no date library and no CDN asset with it", () => {
    const html = readFileSync("public/index.html", "utf8");
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
  });
});

describe("recurrence is still switched off in front of the operator", () => {
  it("draws the choice, disables it, and says why", () => {
    // Out of scope for this seam by name. It stays visible and disabled with its existing copy;
    // building any part of it here would draw bands the scheduler does not enforce.
    const repeat = source.slice(source.indexOf("function blockedTimeRepeatMarkup()"), source.indexOf("function blockedTimeStaffOptions("));
    expect(repeat.length).toBeGreaterThan(0);
    expect(repeat).toContain('value="recurring" disabled');
    expect(repeat).toContain('data-testid="blocked-time-recurring-note"');
    expect(repeat).toContain('value="once" checked');
  });

  it("sends nothing about repeating on either mutation", () => {
    const create = source.slice(source.indexOf('await api("/api/blocked-times",{method:"POST"'));
    expect(create.slice(0, 400)).not.toContain("repeat");
    const update = source.slice(source.indexOf("function blockedTimeUpdatePayload("), source.indexOf("async function submitBlockedTime()"));
    expect(update).not.toContain("repeat");
  });
});
