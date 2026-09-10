import { test, expect, login } from "./fixtures/tenant.js";
import { expectCriticalTarget } from "./helpers/responsive.js";

/**
 * THE EYE, DRIVEN THE WAY AN OPERATOR DRIVES IT.
 *
 * `tests/ui/password-reveal.test.ts` guards coverage and wiring from the source. This drives the
 * control in a real browser, because the three things most likely to be got wrong here are things
 * only a browser can answer: whether pressing it submits the form it is standing in, whether the
 * typed value survives the flip, and whether the target is really 44 square once the stylesheet
 * has had its say.
 */
const CREATE_MODE = /already have an account/i;

test("a typed password can be revealed and re-concealed on the sign-in form", async ({ page }) => {
  await page.goto("/");
  const secret = page.getByTestId("login-password");
  const reveal = page.getByTestId("login-password-reveal");

  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await expect(reveal).toHaveAccessibleName("Show password");
  await expect(secret).toHaveAttribute("type", "password");

  await secret.fill("correct horse browser smoke");
  await reveal.click();

  // The form must not have been submitted: the sign-in screen is still here and no error appeared.
  await expect(page.getByTestId("auth-form")).toBeVisible();
  await expect(page.locator("#auth-error")).toHaveText("");
  await expect(secret).toHaveAttribute("type", "text");
  // THE VALUE SURVIVES. The input is never replaced, only re-typed, so nothing is copied out of
  // it and nothing is lost - which is also what keeps the caret and a password manager's fill.
  await expect(secret).toHaveValue("correct horse browser smoke");
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await expect(reveal).toHaveAccessibleName("Hide password");

  await reveal.click();
  await expect(secret).toHaveAttribute("type", "password");
  await expect(secret).toHaveValue("correct horse browser smoke");
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await expect(reveal).toHaveAccessibleName("Show password");
});

test("the reveal is reachable and operable from the keyboard alone", async ({ page }) => {
  await page.goto("/");
  const secret = page.getByTestId("login-password");
  const reveal = page.getByTestId("login-password-reveal");

  await secret.fill("keyboard only");
  await secret.focus();
  // Tab from the field lands on its own reveal: the control sits in the field, so it sits next to
  // it in the tab order too, and nobody has to hunt for it.
  await page.keyboard.press("Tab");
  await expect(reveal).toBeFocused();

  // Enter and Space both, because a real `<button>` answers to both and anything hand-rolled out
  // of a `<div>` answers to neither.
  await page.keyboard.press("Enter");
  await expect(secret).toHaveAttribute("type", "text");
  await page.keyboard.press(" ");
  await expect(secret).toHaveAttribute("type", "password");
  await expect(secret).toHaveValue("keyboard only");
  // Still on the sign-in screen: neither key submitted the form.
  await expect(page.getByTestId("auth-form")).toBeVisible();
});

test("the reveal meets the touch-target contract the rest of the app is held to", async ({ page }) => {
  await page.goto("/");
  await expectCriticalTarget(page.getByTestId("login-password-reveal"));
});

test("switching the shared form between sign-up and sign-in re-conceals it", async ({ page }) => {
  await page.goto("/");
  const secret = page.getByTestId("login-password");
  const reveal = page.getByTestId("login-password-reveal");

  await secret.fill("half typed signup");
  await reveal.click();
  await expect(secret).toHaveAttribute("type", "text");

  await page.getByRole("button", { name: CREATE_MODE }).click();

  // The box now means a different credential, so it must not still be showing the last one.
  await expect(secret).toHaveAttribute("type", "password");
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await expect(reveal).toHaveAccessibleName("Show password");
  // And the browser is now told this is a credential it may already have saved. `new-password`
  // here would suppress the very fill the operator came to use.
  await expect(secret).toHaveAttribute("autocomplete", "current-password");

  await page.getByRole("button", { name: /create a workspace/i }).click();
  await expect(secret).toHaveAttribute("autocomplete", "new-password");
});

test("a revealed password is not still on screen after a successful sign-in", async ({ page, tenant }) => {
  await page.goto("/");
  await page.getByRole("button", { name: CREATE_MODE }).click();
  await page.getByTestId("login-email").fill(tenant.ownerEmail);
  await page.getByTestId("login-password").fill(tenant.password);
  await page.getByTestId("login-password-reveal").click();
  await expect(page.getByTestId("login-password")).toHaveAttribute("type", "text");

  await page.getByTestId("auth-submit").click();
  await expect(page.locator("#app-view")).toBeVisible();

  // The sign-in screen is only hidden, never reloaded, so a session that lapses an hour later
  // brings it back exactly as it was left. It must not come back with a password on display.
  await page.getByTestId("account-trigger").click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("auth-form")).toBeVisible();
  await expect(page.getByTestId("login-password")).toHaveAttribute("type", "password");
  await expect(page.getByTestId("login-password-reveal")).toHaveAttribute("aria-pressed", "false");
});

test("all three account password fields carry their own reveal", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await page.getByTestId("account-trigger").click();
  await page.getByTestId("profile-account-link").click();
  await expect(page.getByTestId("current-password")).toBeVisible();

  const boxes = ["current-password", "new-password", "confirm-password"] as const;
  for (const name of boxes) {
    const input = page.getByTestId(name);
    const reveal = page.getByTestId(`${name}-reveal`);
    await input.fill(`secret for ${name}`);
    await expectCriticalTarget(reveal);
    await reveal.click();
    await expect(input).toHaveAttribute("type", "text");
    await expect(input).toHaveValue(`secret for ${name}`);
    await expect(reveal).toHaveAccessibleName("Hide password");
    // Revealing one field must not reveal its neighbours: three boxes, three independent states.
    for (const other of boxes.filter((candidate) => candidate !== name)) {
      await expect(page.getByTestId(other)).toHaveAttribute("type", "password");
    }
    await reveal.click();
    await expect(input).toHaveAttribute("type", "password");
  }

  // Nothing here submitted the change form.
  await expect(page.locator("#password-error")).toHaveText("");
});
