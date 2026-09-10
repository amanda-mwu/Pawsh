import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE BROWSER'S LOCALE MUST NOT DECIDE WHAT A WORKSPACE READS.
 *
 * `public/app.js` formats every date and clock time through its own preference layer:
 * `Intl` resolves an instant into numeric parts in the right time zone, which is real calendar
 * arithmetic, and the layout is assembled from `PREF_WEEKDAYS`, `PREF_MONTHS` and the
 * `Settings -> Business -> Date format` and hour-format preferences. Ask `Intl.DateTimeFormat`
 * with an EMPTY LOCALE LIST and it answers with whatever the operator's laptop is set to instead,
 * so two people at the same front desk read the same appointment differently and the preference
 * they were shown changes nothing.
 *
 * THIS IS A DRIFT GUARD, NOT A DESIGN NOTE. The file's own comment claimed the leak was closed
 * while fourteen sites were still open — including the `<h2>` of the appointment surface, which
 * titled a German-configured browser's appointment "Mittwoch, 2. September" while every other
 * date on that screen was en-US. A sentence cannot hold that invariant; a scan of the source can,
 * and it fails on the first one that comes back rather than on whatever a reviewer happens to
 * notice.
 *
 * A static scan is the right shape here for the reason `tests/ui/business-settings.test.ts`
 * gives: the client is served as a plain module with no bundler and has top-level side effects
 * that need a document, so the source is the thing that can be checked whole.
 */
const CLIENT_SOURCES = ["public/app.js", "public/money.js"] as const;

/** `file:line` for every match, so a failure names the call site rather than a character offset. */
function siteList(file: string, pattern: RegExp): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(pattern)].map(
    (match) => `${file}:${source.slice(0, match.index).split("\n").length}`
  );
}

describe("the web client never formats on the browser's locale", () => {
  it.each(CLIENT_SOURCES)("%s asks for no empty locale list", (file) => {
    // `Intl.DateTimeFormat([])` and `Intl.NumberFormat([])` both mean "whatever this browser is
    // set to". Whitespace inside the call is allowed for, so reformatting cannot hide one.
    expect(siteList(file, /Intl\.(?:DateTimeFormat|NumberFormat)\(\s*\[\s*\]/g)).toEqual([]);
  });

  it.each(CLIENT_SOURCES)("%s names an explicit locale at every formatter", (file) => {
    // Omitting the argument entirely — `new Intl.DateTimeFormat({...})` — is the same defect
    // written a shorter way, and so is passing a variable nothing in this client sets. Every
    // construction must open with a quoted locale tag: "en-US" for the parts the preference layer
    // lays out itself, "en-CA" for the ISO wall-clock reads, "en-GB" for the one coupon date whose
    // shape is deliberately fixed.
    const constructions = /new Intl\.(?:DateTimeFormat|NumberFormat)\(\s*(?!")/g;
    expect(siteList(file, constructions)).toEqual([]);
  });

  it("keeps the hard-coded English month and weekday names the layout is assembled from", () => {
    // The arrays are what makes the layout local. If they go, the labels above have gone back to
    // asking ICU what September is called.
    const source = readFileSync("public/app.js", "utf8");
    expect(source).toContain('const PREF_WEEKDAYS=["Sunday","Monday"');
    expect(source).toContain('const PREF_SHORT_WEEKDAYS=["Sun","Mon"');
    expect(source).toContain('const PREF_MONTHS=["January","February"');
    expect(source).toContain('const PREF_SHORT_MONTHS=["Jan","Feb"');
  });
});
