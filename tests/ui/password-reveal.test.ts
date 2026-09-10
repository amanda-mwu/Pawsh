import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * EVERY PASSWORD BOX GETS AN EYE, OR THE FEATURE IS WORSE THAN NOT HAVING ONE.
 *
 * Human QA asked why a typed password could not be revealed on the web when it can be on the
 * phone. `apps/mobile/app/login.tsx` had the control already; this client had none. The risk in
 * closing that gap is not that the control fails to work, it is that it lands on SOME of the four
 * password fields - the sign-in form gets one, the three on the account screen do not - and an
 * operator learns an affordance that then disappears under them. A partial rollout teaches a lie.
 *
 * A STATIC SCAN IS THE RIGHT SHAPE HERE, for the reason `tests/ui/client-locale.test.ts` and
 * `tests/ui/business-settings.test.ts` both give: the client is served as plain files with no
 * bundler and `public/app.js` has top-level side effects that need a document, so the source is
 * the thing that can be checked whole. What this file guards is COVERAGE AND WIRING - that all
 * four fields have the control, that it is the right kind of element, that the browser's own
 * reveal is suppressed, and that every route which abandons one of these forms conceals it again.
 * `tests/e2e/password-reveal.spec.ts` drives the behaviour in a real browser.
 */
const HTML = readFileSync("public/index.html", "utf8");
const CSS = readFileSync("public/styles.css", "utf8");
const APP = readFileSync("public/app.js", "utf8");

/** The four boxes, named by the test id already used to fill them, plus their reveal control. */
const FIELDS = [
  { input: "login-password", reveal: "login-password-reveal" },
  { input: "current-password", reveal: "current-password-reveal" },
  { input: "new-password", reveal: "new-password-reveal" },
  { input: "confirm-password", reveal: "confirm-password-reveal" }
] as const;

/**
 * The wrapper is written on one line and holds no nested `<div>`, so a lazy match is enough to cut
 * one field out of the document without pulling in a parser the rest of this suite does not use.
 */
function passwordFields(): string[] {
  return [...HTML.matchAll(/<div class="password-field">(.*?)<\/div>/g)].map((match) => match[1] ?? "");
}

describe("the web client can reveal a typed password", () => {
  it("puts exactly one reveal control on each of the four password fields", () => {
    // Anchored on the inputs rather than on the controls: the count that matters is that no
    // password box was left out, so the census starts from the boxes.
    const inputs = [...HTML.matchAll(/type="password"/g)];
    expect(inputs).toHaveLength(FIELDS.length);
    expect(passwordFields()).toHaveLength(FIELDS.length);
    for (const field of FIELDS) {
      const wrapper = passwordFields().find((markup) =>
        markup.includes(`data-testid="${field.input}"`)
      );
      expect(wrapper, `${field.input} is not inside a .password-field wrapper`).toBeTruthy();
      expect(wrapper).toContain(`data-testid="${field.reveal}"`);
      expect(wrapper).toContain('class="password-reveal"');
    }
  });

  it.each(FIELDS)("$reveal is a button that cannot submit its form", ({ reveal }) => {
    const control = HTML.match(
      new RegExp(`<button type="button" class="password-reveal" data-testid="${reveal}"[^>]*>`)
    );
    // `type="button"` is the whole guard. A `<button>` inside a form defaults to `type="submit"`,
    // so an eye pressed while filling in a password would try to sign the operator in with a
    // half-typed one; and a `<div>` with a click handler would be neither tabbable nor operable
    // by Enter and Space. The element type is what buys keyboard support, not a handler.
    expect(control, `${reveal} must be a <button type="button">`).toBeTruthy();
    expect(control?.[0]).toContain('aria-pressed="false"');
    expect(control?.[0]).toContain('aria-label="Show password"');
    // `public/app.js` binds every `.close` in the document to closing the shared modal. A reveal
    // that borrowed that class would dismiss whatever dialog happened to be open.
    expect(control?.[0]).not.toMatch(/class="[^"]*\bclose\b/);
  });

  it("starts the shared sign-up form on new-password and moves it with the mode", () => {
    // `#auth-form` is one form in two modes. `new-password` is right while it says "Create
    // workspace" - it tells the browser to offer a generated credential rather than a saved one -
    // and wrong the moment `#toggle-auth` turns it into "Sign in", where it suppresses the saved
    // credential the operator is trying to use. The attribute has to move with the mode.
    expect(HTML).toMatch(/data-testid="login-password"[^>]*autocomplete="new-password"/);
    expect(APP).toContain(
      '$("#auth-form input[name=password]").autocomplete=state.login?"current-password":"new-password";'
    );
    // The account screen's current-password box is already right and must stay that way.
    expect(HTML).toMatch(/data-testid="current-password"[^>]*autocomplete="current-password"/);
  });

  it("still names the shared form's submit button by its type, not by being first", () => {
    // THE HAZARD THIS CONTROL INTRODUCES. `$("#auth-form button")` meant the submit button only
    // because it was the ONLY button in the form; the reveal now precedes it in document order, so
    // the sign-up/sign-in toggle and the invitation screen would have relabelled the eye "Sign in"
    // and left the real button saying whatever it said last. Both sites say `[type=submit]` now.
    expect(APP).not.toMatch(/\$\("#auth-form button"\)/);
    expect(APP.match(/\$\("#auth-form button\[type=submit\]"\)/g)).toHaveLength(2);
    // The control carries no `name`, so it contributes nothing to the submitted form data either.
    for (const wrapper of passwordFields()) {
      expect(wrapper).not.toMatch(/<button[^>]*class="password-reveal"[^>]*\sname=/);
    }
  });

  it("conceals the field again on every route that abandons the form", () => {
    // `form.reset()` restores VALUES. Being revealed is a property of the element, so it survives
    // a reset, a re-render and a view swap - which is exactly how a password ends up sitting
    // legible on a shared front-desk screen that its owner walked away from.
    const call = /concealPasswordFields\(/g;
    expect(APP.match(call)?.length ?? 0).toBeGreaterThanOrEqual(5);
    // Signing out and a lapsed session both land in resetAuthForm, immediately after the line
    // that blanks the values. Line endings are left open because this file is stored CRLF.
    expect(APP).toMatch(
      /\$\$\("#auth-form input"\)\.forEach\(\(input\)=>\{input\.value="";\}\);\r?\n\s*concealPasswordFields\(form\);/
    );
    // The sign-up/sign-in toggle re-purposes the same box for a different credential.
    expect(APP).toContain('concealPasswordFields($("#auth-form"));');
    // A password change that went through.
    expect(APP).toContain('form.reset();concealPasswordFields(form);');
  });

  it("flips the accessible name and exposes the state it cannot say", () => {
    // The name is the ACTION, matching the mobile app word for word; `aria-pressed` is the STATE.
    // Both, because the name alone cannot answer "is my password on screen right now?" and
    // `aria-pressed` alone would leave the button called "Show password" while it hides one.
    expect(APP).toContain('const PASSWORD_REVEAL_SHOWN="Hide password",PASSWORD_REVEAL_HIDDEN="Show password";');
    expect(APP).toContain('button.setAttribute("aria-pressed",revealed?"true":"false");');
    expect(APP).toContain(
      'button.setAttribute("aria-label",revealed?PASSWORD_REVEAL_SHOWN:PASSWORD_REVEAL_HIDDEN);'
    );
    // The element is never replaced - only its `type` moves - so the caret, the focus and a
    // password manager's fill all survive the flip. Rebuilding the input instead would blur it
    // mid-word and throw away whatever a password manager had put there.
    expect(APP).toContain('input.type=revealed?"text":"password";');
  });

  it("draws one glyph from the repository's own icon idiom, chosen off the same attribute", () => {
    // Two inline SVGs in the repository's existing shape - `viewBox="0 0 24 24"`, `aria-hidden`,
    // stroked with `currentColor` - and CSS picks between them on `aria-pressed`. No icon font and
    // no CDN asset, and no second source of truth for which eye is showing.
    expect(HTML.match(/class="reveal-eye"/g)).toHaveLength(FIELDS.length);
    expect(HTML.match(/class="reveal-eye-off"/g)).toHaveLength(FIELDS.length);
    expect(CSS).toContain('.password-reveal .reveal-eye-off{display:none}');
    expect(CSS).toContain('.password-reveal[aria-pressed="true"] .reveal-eye{display:none}');
    expect(CSS).toContain('.password-reveal[aria-pressed="true"] .reveal-eye-off{display:block}');
    expect(CSS).toContain('.password-reveal svg{display:block;width:20px;height:20px;fill:none;stroke:currentColor');
  });

  it("gives the control a 44px target and leaves the browser no eye of its own", () => {
    // The same contract `expectCriticalTarget` enforces in the responsive suite, declared here so
    // a styling change that shrinks it fails without needing a browser to notice.
    expect(CSS).toMatch(/\.password-reveal\{[^}]*width:44px;height:44px/);
    // Edge draws its own reveal inside every password field and Chrome does not, so without this
    // the same screen has two eyes in one browser and one in another.
    expect(CSS).toContain('input[type="password"]::-ms-reveal,input[type="password"]::-ms-clear{display:none}');
  });
});
