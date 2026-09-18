import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { permissions } from "@pawsh/domain";

/**
 * A PERMISSION KEY IS NOT A SENTENCE.
 *
 * Human QA read every refusal that carried one - "You do not have permission to change the groomer
 * or the time (appointments.edit)", "Price changes need Edit service prices
 * (appointments.service_price_edit)", "assigned to another groomer (appointments.edit_all_staff)" -
 * as the product's internals leaking onto the screen. The keys are the names of switches in the
 * Roles editor, which is the ONE screen allowed to show them, in its technical sheet.
 *
 * Every refusal the interface draws now goes through three helpers in `public/app.js` -
 * `permissionRefusalSentence`, `refusalAttributes` and `userFacingErrorMessage` - and this file
 * holds two lines:
 *
 *   RUN THE BUILDERS. Each refusal builder and each refusal constant - the titles, the two scope
 *       sentences, the drag-reassignment toast, the lock note - is executed against a session
 *       holding nothing, and what it returns is checked against the whole permission tuple: no
 *       key, and no dotted token shaped like one, in any title, sentence, toast or rail.
 *   READ THE SOURCE. A builder somebody adds tomorrow without going through the helpers would be
 *       invisible to the first line, so the second reads every string literal in the file - the
 *       static text of each template, with its `${…}` walked past rather than read - and fails on
 *       a permission-family token sitting in prose. Not only a key in parentheses, which was the
 *       shape of the first leaks: the drag toast then leaked one bare, after a "needs".
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────────
 *
 *   `refusalAttributes` → the old `title="You do not have permission to ${action} (${permission})"`
 *       "no builder puts a key in a title" fails on the appointment refusals.
 *   `bookingRefusalReason` naming the missing keys again
 *       "the calendar's two refusal sentences carry no key" fails.
 *   `CALENDAR_REASSIGN_REFUSAL` → "Moving this to another groomer needs appointments.edit_all_staff."
 *       "the drag toast and the lock note carry no key" fails, and so does the source scan.
 *   `BLOCK_SCOPE_REFUSAL` → `APPOINTMENT_SCOPE_REFUSAL` (the drawer borrowing the visit's sentence)
 *       "the block drawer's scope refusal is about a block" fails.
 *   `userFacingErrorMessage` returning the body verbatim
 *       "a server refusal is reworded before it reaches a toast" fails.
 *   the read-only price reason restored with its key
 *       "the source carries no parenthesised key" and "no string an operator can read" both fail.
 *   a key written bare into any sentence - `Price changes need appointments.service_price_edit.`
 *       "no string an operator can read carries a key" fails.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

const REFUSAL_COPY = slice("const SERVER_PERMISSION_REFUSAL=", "\nfunction settleUnauthenticated() {");
const GATES = slice("function calendarBookingAvailable(){", "\n/**\n * Why the Move affordance is not there");
const SURFACE = slice("function appointmentPermissionRefusal(action){", "\n// \"(n)\" from the server's own count");

const escape = (value = "") =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (value = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");

interface Module {
  permissionRefusalSentence(action: string): string;
  refusalAttributes(sentence: string): string;
  userFacingErrorMessage(message: string | undefined): string;
  bookingRefusalReason(): string | null;
  blockingRefusalReason(): string | null;
  appointmentPermissionRefusal(action: string): string;
  appointmentScopeRefusal(): string;
  appointmentRefusal(item: unknown, action: string, permission: string): string;
  clientRailRefusalMarkup(): string;
  scope: string;
  blockScope: string;
  reassign: string;
  lock: string;
}

/** Every builder, seen by a session that holds nothing and owns nothing. */
function builders(): Module {
  const prelude = `
    "use strict";
    const state = { me: { employeeId: null } };
    const allowed = () => false;
  `;
  const exported = `return { permissionRefusalSentence, refusalAttributes, userFacingErrorMessage,
    bookingRefusalReason, blockingRefusalReason, appointmentPermissionRefusal, appointmentScopeRefusal,
    appointmentRefusal, clientRailRefusalMarkup, scope: APPOINTMENT_SCOPE_REFUSAL,
    blockScope: BLOCK_SCOPE_REFUSAL, reassign: CALENDAR_REASSIGN_REFUSAL, lock: APPOINTMENT_LOCK_MESSAGE };`;
  const factory = new Function("escape", "escapeAttr",
    [prelude, REFUSAL_COPY, GATES, SURFACE, exported].join("\n")) as (a: unknown, b: unknown) => Module;
  return factory(escape, escapeAttr);
}

/** A dotted token in the shape every permission key takes, whether or not it is a real one. */
const KEY_SHAPE = /\b[a-z_]+\.[a-z_]+(?:\.[a-z_]+)*\b/u;

function expectNoKey(text: string, what: string): void {
  for (const key of permissions) expect(text, `${what} names ${key}`).not.toContain(key);
  expect(text, `${what} carries a key-shaped token`).not.toMatch(KEY_SHAPE);
}

describe("every refusal builder speaks product language", () => {
  it("no builder puts a key in a title", () => {
    const app = builders();
    const item = { employeeId: "e9", groomers: [{ id: "e9" }] };
    const drawn = [
      ["appointmentPermissionRefusal", app.appointmentPermissionRefusal("change the groomer or the time")],
      ["appointmentScopeRefusal", app.appointmentScopeRefusal()],
      ["appointmentRefusal (no key)", app.appointmentRefusal(item, "cancel appointments", "appointments.cancel")],
      ["clientRailRefusalMarkup", app.clientRailRefusalMarkup()],
      ["refusalAttributes", app.refusalAttributes(app.scope)],
      ["refusalAttributes (block)", app.refusalAttributes(app.blockScope)]
    ] as const;
    for (const [name, markup] of drawn) {
      if (name !== "clientRailRefusalMarkup") expect(markup, name).toContain('disabled aria-disabled="true"');
      expectNoKey(markup, name);
    }
  });

  it("the drag toast and the lock note carry no key", () => {
    const app = builders();
    // The toast a drop onto a colleague's column raises, before any request: the same sentence
    // shape every other refusal takes, about the act and not the switch behind it.
    expect(app.reassign).toBe("You do not have permission to move this onto another groomer's calendar.");
    expectNoKey(app.reassign, "CALENDAR_REASSIGN_REFUSAL");
    expectNoKey(app.lock, "APPOINTMENT_LOCK_MESSAGE");
  });

  it("the block drawer's scope refusal is about a block, not a visit", () => {
    const app = builders();
    expect(app.blockScope).toBe("This blocked time is on another groomer's calendar");
    expect(app.blockScope).not.toBe(app.scope);
    expect(app.blockScope).not.toMatch(/appointment/iu);
    expectNoKey(app.blockScope, "BLOCK_SCOPE_REFUSAL");
  });

  it("the appointment refusals say what cannot be done, and the scope refusal says whose visit it is", () => {
    const app = builders();
    expect(app.appointmentPermissionRefusal("change the groomer or the time"))
      .toBe(' disabled aria-disabled="true" title="You do not have permission to change the groomer or the time"');
    expect(app.scope).toBe("This appointment is assigned to another groomer");
    expect(app.appointmentScopeRefusal()).toContain(`title="${app.scope}"`);
  });

  it("the calendar's two refusal sentences carry no key", () => {
    const app = builders();
    expect(app.bookingRefusalReason()).toBe("You do not have permission to book appointments");
    expect(app.blockingRefusalReason()).toBe("You do not have permission to block time");
    expectNoKey(app.bookingRefusalReason() ?? "", "bookingRefusalReason");
    expectNoKey(app.blockingRefusalReason() ?? "", "blockingRefusalReason");
  });

  it("the rail keeps the switch's own label and drops the key", () => {
    const rail = builders().clientRailRefusalMarkup();
    expect(rail).toContain("<strong>View appointments</strong>.");
    expect(rail).not.toContain("appointment-client-retry");
  });

  it("a server refusal is reworded before it reaches a toast, and every other message is left alone", () => {
    const app = builders();
    for (const key of permissions) {
      const reworded = app.userFacingErrorMessage(`Missing permission: ${key}`);
      expect(reworded).toBe("You do not have permission to do this.");
    }
    expect(app.userFacingErrorMessage("Appointment is already checked in")).toBe("Appointment is already checked in");
    expect(app.userFacingErrorMessage(undefined)).toBe("Something went wrong");
    expect(app.userFacingErrorMessage("")).toBe("Something went wrong");
  });

  it("a refusal sentence is attribute-safe: quotes cannot escape the title", () => {
    const attributes = builders().refusalAttributes('say "why" here');
    expect(attributes).toBe(' disabled aria-disabled="true" title="say &quot;why&quot; here"');
  });
});

/**
 * Every run of literal text in a script - the whole of a "…" or '…' string, and the static parts
 * of a `…` template with each `${…}` expression walked through rather than read as text - with the
 * line it starts on. Comments and regular expressions are stepped over, because a key named in a
 * comment is documentation and a key in a pattern is code. Small on purpose: it knows the shapes
 * in `public/app.js` and nothing more.
 */
function literalText(code: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const size = code.length;
  let at = 0;
  let line = 1;
  // What the previous significant token was, so a `/` can be told apart: a regular expression
  // follows a punctuator or a keyword, a division follows a value.
  let prev = "";
  const regexAfter = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*",
    "%", "<", ">", "~", "^", "return", "typeof", "case", "do", "else", "in", "of", "void", "throw", "new", "delete", ""]);
  const skipTo = (stop: number): void => { for (; at < stop; at++) if (code[at] === "\n") line++; };
  const readString = (quote: string): void => {
    const start = line;
    let text = "";
    at++;
    while (at < size && code[at] !== quote) {
      if (code[at] === "\\") { text += code[at] + (code[at + 1] ?? ""); at += 2; continue; }
      text += code[at++];
    }
    at++;
    out.push({ text, line: start });
  };
  const readTemplate = (): void => {
    let start = line;
    let text = "";
    at++;
    while (at < size && code[at] !== "`") {
      if (code[at] === "\\") { text += code[at] + (code[at + 1] ?? ""); at += 2; continue; }
      if (code[at] === "$" && code[at + 1] === "{") {
        out.push({ text, line: start });
        text = "";
        at += 2;
        walk(true);
        start = line;
        continue;
      }
      if (code[at] === "\n") line++;
      text += code[at++];
    }
    at++;
    out.push({ text, line: start });
  };
  const readRegex = (): void => {
    at++;
    let inClass = false;
    while (at < size) {
      if (code[at] === "\\") { at += 2; continue; }
      if (code[at] === "[") inClass = true;
      else if (code[at] === "]") inClass = false;
      else if (code[at] === "/" && !inClass) break;
      at++;
    }
    at++;
    while (at < size && /[a-z]/u.test(code[at]!)) at++;
  };
  /** Reads code until the end, or - inside a template's `${…}` - until its closing brace. */
  const walk = (untilBrace: boolean): void => {
    let depth = 0;
    while (at < size) {
      const c = code[at]!;
      if (c === "\n") { line++; at++; continue; }
      if (c === '"' || c === "'") { readString(c); prev = "value"; continue; }
      if (c === "`") { readTemplate(); prev = "value"; continue; }
      if (c === "/" && code[at + 1] === "/") { while (at < size && code[at] !== "\n") at++; continue; }
      if (c === "/" && code[at + 1] === "*") {
        const end = code.indexOf("*/", at + 2);
        skipTo(end < 0 ? size : end + 2);
        continue;
      }
      if (c === "/" && regexAfter.has(prev)) { readRegex(); prev = "value"; continue; }
      if (untilBrace && c === "{") depth++;
      if (untilBrace && c === "}") { if (depth === 0) { at++; return; } depth--; }
      if (/[A-Za-z_$]/u.test(c)) {
        let word = "";
        while (at < size && /[A-Za-z0-9_$]/u.test(code[at]!)) word += code[at++];
        prev = regexAfter.has(word) ? word : "value";
        continue;
      }
      if (/[0-9]/u.test(c)) { while (at < size && /[0-9A-Za-z_.]/u.test(code[at]!)) at++; prev = "value"; continue; }
      if (/\s/u.test(c)) { at++; continue; }
      if (c === ")" || c === "]") { prev = "value"; at++; continue; }
      prev = c;
      at++;
    }
  };
  walk(false);
  return out;
}

describe("the source itself carries no key where an operator would read it", () => {
  /** The file with its comments removed, so a key named in prose does not count. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");

  it("the source carries no parenthesised key", () => {
    const leaks = code.match(/\((?:appointments|calendar|customers|payments|pets|operations|checkout|discounts|services|team|settings|reports|dashboard|payroll|sales)\.[a-z_]+(?:, [a-z_.]+)*\)/gu) ?? [];
    expect(leaks).toEqual([]);
  });

  it("every refusal title is built by the helper, never written by hand", () => {
    const byHand = code.match(/title="You do not have permission[^"]*"/gu) ?? [];
    expect(byHand).toEqual([]);
    expect(code).toContain("function refusalAttributes(sentence)");
    expect(code).toContain("function permissionRefusalSentence(action)");
  });

  it("no string an operator can read carries a key", () => {
    // The first segment of every key in the tuple - `appointments`, `calendar`, `payments`... -
    // read off the tuple rather than listed here, so a family added tomorrow is scanned tomorrow.
    const families = [...new Set(permissions.map((key) => key.split(".")[0]))].sort();
    const key = new RegExp(`\\b(?:${families.join("|")})\\.[a-z_]+(?:\\.[a-z_]+)*\\b`, "u");
    const runs = literalText(source);
    // The scan is only as good as the tokenizer under it, so the tokenizer proves it reached the
    // end of the file and read a bare key argument as the whole of its literal.
    expect(runs.length).toBeGreaterThan(5000);
    expect(runs.at(-1)!.line).toBeGreaterThan(source.split("\n").length - 200);
    expect(runs.some((run) => run.text === "appointments.edit_all_staff")).toBe(true);
    // A key alone is an argument - `allowed("appointments.edit")` - and never reaches a person.
    // A key with a space beside it is a sentence somebody will read.
    const leaks = runs
      .filter((run) => /\s/u.test(run.text) && key.test(run.text))
      .map((run) => `${run.line}: ${JSON.stringify(run.text.slice(0, 120))}`);
    expect(leaks).toEqual([]);
  });

  it("the read-only price reason keeps the switch's label and no key", () => {
    expect(code).toContain("Price changes need Edit service prices.");
    expect(code).not.toContain("appointments.service_price_edit)");
  });

  it("the lifecycle strip no longer explains where its times come from", () => {
    expect(code).not.toContain("Times are read from the appointment's recorded activity");
    expect(code).not.toContain("lifecycle-note");
  });
});
