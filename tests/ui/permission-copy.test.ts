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
 *   RUN THE BUILDERS. Each refusal builder is executed against a session holding nothing, and
 *       what it returns is checked against the whole permission tuple: no key, and no dotted
 *       token shaped like one, in any title, sentence, toast or rail.
 *   READ THE SOURCE. A builder somebody adds tomorrow without going through the helpers would be
 *       invisible to the first line, so the second scans the file's own strings for a key in
 *       parentheses - the shape every leak took - and for a refusal title written by hand.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────────
 *
 *   `refusalAttributes` → the old `title="You do not have permission to ${action} (${permission})"`
 *       "no builder puts a key in a title" fails on the appointment refusals.
 *   `bookingRefusalReason` naming the missing keys again
 *       "the calendar's two refusal sentences carry no key" fails.
 *   `userFacingErrorMessage` returning the body verbatim
 *       "a server refusal is reworded before it reaches a toast" fails.
 *   the read-only price reason restored with its key
 *       "the source carries no parenthesised key" fails.
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
const GATES = slice("function calendarBookingAvailable(){", "\n// Drag is a fine-pointer affordance on top of that.");
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
    appointmentRefusal, clientRailRefusalMarkup, scope: APPOINTMENT_SCOPE_REFUSAL };`;
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
      ["refusalAttributes", app.refusalAttributes(app.scope)]
    ] as const;
    for (const [name, markup] of drawn) {
      if (name !== "clientRailRefusalMarkup") expect(markup, name).toContain('disabled aria-disabled="true"');
      expectNoKey(markup, name);
    }
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

  it("the read-only price reason keeps the switch's label and no key", () => {
    expect(code).toContain("Price changes need Edit service prices.");
    expect(code).not.toContain("appointments.service_price_edit)");
  });

  it("the lifecycle strip no longer explains where its times come from", () => {
    expect(code).not.toContain("Times are read from the appointment's recorded activity");
    expect(code).not.toContain("lifecycle-note");
  });
});
