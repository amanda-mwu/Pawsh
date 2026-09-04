import {
  test,
  expect,
  login,
  createMember,
  completeAppointment,
  appointmentAction
} from "./fixtures/tenant.js";
import { chooseMethod } from "./helpers/checkout.js";
import type { APIRequestContext, Dialog, Page } from "@playwright/test";

/**
 * Client credit — the profile tile, the ledger drawer, the grant/adjust dialog, the checkout
 * payment option and the receipt line.
 *
 * WHAT THESE SPECS ARE REALLY GUARDING is a set of rules that are invisible until they are broken.
 * The ledger is append-only in the database, so the interface must offer no edit and no delete
 * anywhere; `balanceAfterMinor` is the server's number, so the browser must render it rather than
 * add up the rows it was sent; credit is a PAYMENT and never a discount, so it must reach the
 * server as `method: "client_credit"` and never through the discount path; and the balance shown at
 * checkout belongs to the client being checked out rather than to whoever was checked out first in
 * this session.
 */

async function grantCredit(
  api: APIRequestContext,
  customerId: string,
  amountMinor: number,
  reason: string
): Promise<void> {
  const response = await api.post(`/api/customers/${customerId}/credit`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "grant", amountMinor, reason }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function creditLedger(api: APIRequestContext, customerId: string) {
  const response = await api.get(`/api/customers/${customerId}/credit`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as {
    balanceMinor: number; grantedMinor: number; usedMinor: number; entryTotal: number;
    entries: Array<{ kind: string; amountMinor: number; balanceAfterMinor: number }>;
  };
}

async function openProfile(page: Page, customerId: string): Promise<void> {
  await page.getByTestId("nav-customers").click();
  // THE NAME IN THE ROW, and never `.customer-detail` on its own. The directory row carries that
  // class twice — on the client's name and on the row menu's "Client profile" item — so the bare
  // class is a strict-mode violation that kills the test before it asserts anything. Scoped to
  // `.clients-name` rather than opened through the menu because the name is one click and is what
  // a front desk actually presses; `tests/e2e/ticket-surface.spec.ts` drives the menu instead,
  // and between them both affordances stay covered.
  await page.locator(`[data-customer-id="${customerId}"] .clients-name .customer-detail`).click();
  await expect(page.getByTestId("client-profile-view")).toBeVisible();
}

async function openLedger(page: Page, customerId: string): Promise<void> {
  await openProfile(page, customerId);
  await page.getByTestId("open-credit-ledger").click();
  await expect(page.getByTestId("credit-ledger")).toBeVisible();
  await expect(page.getByTestId("credit-totals")).toBeVisible();
}

async function openCheckout(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
  await expect(card).toBeVisible();
  await expect(async () => {
    await (await appointmentAction(card, "appointment-completed")).click({ timeout: 2_000 });
    await expect(page.getByTestId("checkout-surface")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

test("the tile shows the identity Added − Used = Balance, and the ledger renders the server's running balance",
  async ({ page, request, tenant }) => {
    await grantCredit(request, tenant.customerId, 6000, "Goodwill for the late finish");
    await login(page, tenant.ownerEmail);
    await openProfile(page, tenant.customerId);

    // Third of four tiles, between Outstanding and Appointments, so the three money figures group
    // together. Brand ink rather than `.owing`: credit is money the salon already owes, not a debt.
    await expect(page.getByTestId("summary-credit")).toHaveText("$60.00");
    await expect(page.getByTestId("summary-credit")).toHaveClass(/credit/);
    await expect(page.getByTestId("summary-credit")).not.toHaveClass(/owing/);
    await expect(page.getByTestId("client-credit-tile")).toContainText("Added: $60.00");
    await expect(page.getByTestId("client-credit-tile")).toContainText("Used: $0.00");
    // The count is on the button, so the operator knows there is something to open before opening it.
    await expect(page.getByTestId("open-credit-ledger")).toHaveText("Credit ledger (1)");
    await expect(page.getByTestId("open-credit-ledger")).toHaveAttribute("aria-haspopup", "dialog");

    await page.getByTestId("open-credit-ledger").click();
    await expect(page.getByTestId("credit-ledger")).toBeVisible();
    // The heading is the client; the eyebrow carries the feature name so it can be. Scoped to the
    // drawer: the profile standing behind it is headed with the same client's name, which is
    // right on both, so an unscoped query matches twice.
    await expect(page.getByTestId("credit-ledger")
      .getByRole("heading", { name: "Emma Johnson" })).toBeVisible();
    await expect(page.getByTestId("credit-total-balance")).toHaveText("$60.00");
    await expect(page.getByTestId("credit-total-added")).toHaveText("$60.00");
    await expect(page.getByTestId("credit-total-used")).toHaveText("$0.00");

    const entry = page.getByTestId("credit-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Credit added");
    await expect(entry).toContainText("+$60.00");
    await expect(entry).toContainText("Goodwill for the late finish");
    // The SERVER's figure. A browser accumulating what it was sent would be right on page one and
    // wrong on page two, so this line exists to say the number came off the wire.
    await expect(entry).toContainText("Balance after $60.00");
    await expect(page.getByTestId("credit-ledger-count")).toHaveText("Showing 1–1 of 1 entries");

    // NO EDIT, NO DELETE, ANYWHERE. The table refuses both at a trigger, so the only action a row
    // may carry is the one that writes a new compensating entry.
    const actions = entry.getByRole("button");
    await expect(actions).toHaveCount(1);
    await expect(actions).toHaveText("Correct this entry");
  });

test("an empty ledger says so, and the tile still stands at zero", async ({ page, tenant }) => {
  await login(page, tenant.ownerEmail);
  await openProfile(page, tenant.customerId);
  // A tile is a standing question about the client, so it renders at $0.00 the way Outstanding
  // does — unlike the Refunded detail line, which is a fact about an event and is suppressed.
  await expect(page.getByTestId("summary-credit")).toHaveText("$0.00");
  await expect(page.getByTestId("summary-credit")).not.toHaveClass(/credit/);
  await expect(page.getByTestId("open-credit-ledger")).toHaveText("Credit ledger");

  await page.getByTestId("open-credit-ledger").click();
  await expect(page.getByTestId("credit-ledger-empty"))
    .toHaveText("No credit has been added or spent for this client.");
  await expect(page.getByTestId("credit-total-balance")).toHaveText("$0.00");
  await expect(page.getByTestId("credit-ledger-count")).toHaveText("No entries");
  await expect(page.getByTestId("credit-entry")).toHaveCount(0);
});

test("credit is granted and deducted from the drawer, and both move the tile",
  async ({ page, tenant }) => {
    // The deduction confirms before it is written; the grant deliberately does not.
    const accept = (dialog: Dialog) => dialog.accept();
    page.on("dialog", accept);
    await login(page, tenant.ownerEmail);
    await openLedger(page, tenant.customerId);

    await page.getByTestId("credit-add").click();
    await expect(page.getByTestId("credit-kind")).toBeVisible();
    // A grant has one direction and the schema enforces it, so there is nothing to choose.
    await expect(page.getByTestId("credit-direction")).toBeHidden();
    await page.getByTestId("field-amountMinor").fill("50");
    await expect(page.getByTestId("credit-preview")).toHaveText("Balance after this: $50.00");
    await page.getByTestId("field-reason").fill("Apology for the rescheduled visit");
    await expect(page.getByTestId("credit-reason-count")).toHaveText("33/500");
    await expect(page.getByTestId("modal-submit")).toHaveText("Add credit");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // The drawer re-reads page 1 rather than prepending a row: every running balance below a new
    // entry has changed too.
    await expect(page.getByTestId("credit-total-balance")).toHaveText("$50.00");
    await expect(page.getByTestId("credit-entry")).toHaveCount(1);

    await page.getByTestId("credit-add").click();
    await page.getByTestId("credit-kind-adjustment").check();
    await expect(page.getByTestId("credit-direction")).toBeVisible();
    await page.getByTestId("credit-direction").getByRole("button", { name: "Take off balance" }).click();
    await expect(page.getByTestId("modal-submit")).toHaveText("Take off balance");
    // The helper hardens with the direction: a deduction is the more contestable half.
    await expect(page.getByTestId("credit-reason-help"))
      .toContainText("A deduction takes money off this client's account");
    await page.getByTestId("field-amountMinor").fill("20");
    await expect(page.getByTestId("credit-preview")).toHaveText("Balance after this: $30.00");
    await page.getByTestId("field-reason").fill("Applied to the wrong client");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    await expect(page.getByTestId("credit-total-balance")).toHaveText("$30.00");
    // "Added" is grants AND adjustments net, which is what keeps the subtraction true on screen.
    await expect(page.getByTestId("credit-total-added")).toHaveText("$30.00");
    await expect(page.getByTestId("credit-total-used")).toHaveText("$0.00");
    await expect(page.getByTestId("credit-entry")).toHaveCount(2);
    await expect(page.getByTestId("credit-entry").first()).toContainText("−$20.00");

    // The drawer closes back onto a tile that has moved with it.
    await page.getByTestId("credit-ledger-dismiss").click();
    await expect(page.getByTestId("credit-ledger")).toBeHidden();
    await expect(page.getByTestId("summary-credit")).toHaveText("$30.00");
    await expect(page.getByTestId("client-credit-tile")).toContainText("Added: $30.00");
    // Focus goes back to the control that opened the drawer, even though a re-read replaced it.
    await expect(page.getByTestId("open-credit-ledger")).toBeFocused();
    page.off("dialog", accept);
  });

test("a deduction larger than the balance is refused before it is sent", async ({ page, request, tenant }) => {
  await grantCredit(request, tenant.customerId, 1000, "Small goodwill");
  await login(page, tenant.ownerEmail);
  await openLedger(page, tenant.customerId);

  await page.getByTestId("credit-add").click();
  await page.getByTestId("credit-kind-adjustment").check();
  await page.getByTestId("credit-direction").getByRole("button", { name: "Take off balance" }).click();
  await page.getByTestId("field-amountMinor").fill("25");
  await expect(page.getByTestId("credit-preview"))
    .toHaveText("Balance after this: −$15.00 — more than this client has.");
  await expect(page.getByTestId("credit-preview")).toHaveClass(/is-over/);
  await expect(page.getByTestId("field-amountMinor")).toHaveAttribute("aria-invalid", "true");

  await page.getByTestId("field-reason").fill("Typed the wrong figure");
  await page.getByTestId("modal-submit").click();
  // Blocked client-side with the same sentence, and the dialog keeps what was typed.
  await expect(page.getByTestId("modal")).toBeVisible();
  await expect(page.locator("#modal-error")).toContainText("more than this client has");
  await expect(page.getByTestId("field-reason")).toHaveValue("Typed the wrong figure");
  // Nothing was written: the balance behind the dialog is untouched.
  expect((await creditLedger(request, tenant.customerId)).balanceMinor).toBe(1000);
});

test("a correction is a new compensating entry, and the corrected row keeps its own amount",
  async ({ page, request, tenant }) => {
    await grantCredit(request, tenant.customerId, 5000, "Granted by mistake");
    await login(page, tenant.ownerEmail);
    await openLedger(page, tenant.customerId);

    await page.getByTestId("credit-correct-entry").click();
    // The kind is fixed and the correcting line names what is being put right.
    await expect(page.getByTestId("credit-kind")).toHaveCount(0);
    await expect(page.getByTestId("credit-correcting")).toContainText("Credit added +$50.00");
    await expect(page.getByTestId("modal-submit")).toHaveText("Save correction");
    await page.getByTestId("credit-direction").getByRole("button", { name: "Take off balance" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("field-amountMinor").fill("50");
    await page.getByTestId("field-reason").fill("Reversing the grant that was meant for another client");
    await page.getByTestId("modal-submit").click();
    await expect(page.getByTestId("modal")).toBeHidden();

    await expect(page.getByTestId("credit-total-balance")).toHaveText("$0.00");
    // TWO ROWS, NEVER ONE. The grant really did happen and keeps its amount; the correction is a
    // second row that says what the first should have said.
    await expect(page.getByTestId("credit-entry")).toHaveCount(2);
    const rows = page.getByTestId("credit-entry");
    await expect(rows.first()).toContainText("−$50.00");
    await expect(rows.first()).toContainText("Corrects Credit added +$50.00");
    await expect(rows.last()).toContainText("+$50.00");
    await expect(rows.last()).toContainText("Granted by mistake");
    await expect(page.getByTestId("credit-chip-corrected")).toBeVisible();
    // A corrected entry cannot be corrected again — the compensating entry already exists.
    await expect(rows.last().getByTestId("credit-correct-entry")).toHaveCount(0);
    // Still no edit and no delete, on either row.
    await expect(page.getByTestId("credit-ledger").getByRole("button", { name: /delete|remove/i }))
      .toHaveCount(0);
  });

test("credit settles an invoice at checkout, and the receipt names it as a payment",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);
    await grantCredit(request, tenant.customerId, 15000, "Prepaid package");
    await login(page, tenant.ownerEmail);
    await openCheckout(page, appointment.id);

    // Last in the list and NOT the default: spending a client's balance is a decision, and a
    // checkout that pre-selected it would drain accounts by inattention.
    const methods = page.getByTestId("checkout-method");
    await expect(methods.last()).toHaveValue("client-credit");
    await expect(methods.last()).not.toBeChecked();
    await expect(methods.first()).toBeChecked();
    await expect(page.getByTestId("checkout-credit-available")).toHaveText("$150.00 available");
    // Furniture until it is chosen.
    await expect(page.getByTestId("checkout-credit-note")).toBeHidden();

    await chooseMethod(page, "Client credit");
    await expect(page.getByTestId("checkout-credit-note"))
      .toContainText("This settles the invoice from the client's balance — no money is collected.");
    await expect(page.getByTestId("field-pay")).toHaveValue("92.01");
    // What is left ON ACCOUNT, which is a different figure from what is left owed.
    await expect(page.getByTestId("checkout-balance"))
      .toHaveText("Balance $92.01 · $57.99 credit will remain");

    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $0.00");
    // The operator's words, not the raw column: `client credit` is what the receipt used to print.
    await expect(page.getByTestId("receipt")).toContainText("Client credit · recorded");
    // Credit is a payment and never a discount. Routing it through the discount path would shrink
    // the taxable base and under-collect tax on every redemption, so the bill's discount line has to
    // still read nothing at all.
    await expect(page.getByTestId("receipt-discount")).toContainText("-$0.00");

    const ledger = await creditLedger(request, tenant.customerId);
    expect(ledger.balanceMinor).toBe(15000 - 9201);
    expect(ledger.usedMinor).toBe(9201);
    expect(ledger.entries[0]!.kind).toBe("redemption");
    expect(ledger.entries[0]!.amountMinor).toBe(-9201);

    // A redemption is undone by voiding its payment, so its row names that door instead of
    // offering a second one from the profile. Asserted HERE, on a redemption that still stands:
    // once the payment is voided the sentence is an instruction for something already done, and
    // "voiding a credit payment…" below is where its absence is checked.
    await page.getByTestId("checkout-surface").getByRole("button", { name: "Close check out" }).click();
    await expect(page.getByTestId("checkout-surface")).toBeHidden();
    await openLedger(page, tenant.customerId);
    const redemption = page.locator('[data-credit-kind="redemption"]');
    await expect(redemption).toContainText("To undo this, void the payment on invoice");
    await expect(redemption.getByTestId("credit-correct-entry")).toHaveCount(0);
  });

test("a balance smaller than the bill is offered as a part payment, and more than it is refused",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);
    await grantCredit(request, tenant.customerId, 4000, "Partial goodwill");
    await login(page, tenant.ownerEmail);
    await openCheckout(page, appointment.id);

    // A part payment from credit is legitimate: the redemption is keyed on the PAYMENT, not the
    // invoice, precisely so several payments may settle one.
    await chooseMethod(page, "Client credit");
    await expect(page.getByTestId("field-pay")).toHaveValue("40.00");
    await expect(page.getByTestId("checkout-balance"))
      .toHaveText("Balance $92.01 · $52.01 will remain · $0.00 credit will remain");

    await page.getByTestId("field-pay").fill("60.00");
    await page.getByTestId("checkout-submit").click();
    // Refused inline rather than discovered as a 409 after the invoice was raised.
    await expect(page.getByTestId("checkout-error"))
      .toContainText("That is more than the $40.00 this client has on account.");
    expect((await creditLedger(request, tenant.customerId)).balanceMinor).toBe(4000);
  });

test("no option is offered when the client has nothing on account", async ({ page, request, tenant }) => {
  const appointment = await completeAppointment(request, tenant);
  await login(page, tenant.ownerEmail);
  await openCheckout(page, appointment.id);
  // A zero balance and an unnamed client render the same — no option at all — because an inert
  // radio for money that is not there is furniture.
  await expect(page.getByTestId("checkout-credit-available")).toHaveCount(0);
  await expect(page.getByTestId("checkout-credit-note")).toHaveCount(0);
  await expect(page.getByTestId("checkout-method").filter({ hasText: "Client credit" })).toHaveCount(0);
});

test("voiding a credit payment says where the money goes, and the ledger shows the return",
  async ({ page, request, tenant }) => {
    const appointment = await completeAppointment(request, tenant);
    await grantCredit(request, tenant.customerId, 15000, "Prepaid package");
    await login(page, tenant.ownerEmail);
    await openCheckout(page, appointment.id);
    await chooseMethod(page, "Client credit");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $0.00");

    // Voiding asks for a reason and then confirms, so one handler answers both in order. The
    // confirmation for a credit payment says the money goes back on the balance rather than
    // reassuring the operator that nothing was refunded.
    const messages: string[] = [];
    const answer = (dialog: Dialog) => {
      messages.push(dialog.message());
      return dialog.accept(dialog.type() === "prompt" ? "Applied to the wrong visit" : "");
    };
    page.on("dialog", answer);
    await page.getByTestId("checkout-surface").getByRole("button", { name: "Void record" }).click();
    await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $92.01");
    expect(messages.some((message) => message.includes("goes back to this client's credit balance")))
      .toBe(true);
    // The handler stays registered across the close: the surface has its own leave guard, and this
    // spec is not the place to assert which way that one falls.
    await page.getByTestId("checkout-surface").getByRole("button", { name: "Close check out" }).click();
    await expect(page.getByTestId("checkout-surface")).toBeHidden();
    page.off("dialog", answer);

    // The reversal is a row of its own, not an edit of the redemption: both stand, and the
    // redemption is chipped rather than struck through.
    const ledger = await creditLedger(request, tenant.customerId);
    expect(ledger.balanceMinor).toBe(15000);
    expect(ledger.usedMinor).toBe(0);
    expect(ledger.entryTotal).toBe(3);

    await openLedger(page, tenant.customerId);
    await expect(page.getByTestId("credit-entry")).toHaveCount(3);
    await expect(page.getByTestId("credit-chip-reversed")).toBeVisible();
    await expect(page.getByTestId("credit-ledger"))
      .toContainText("Returns the credit applied to invoice");
    await expect(page.getByTestId("credit-total-used")).toHaveText("$0.00");
    // A redemption is corrected by voiding its payment, so its row never offers a Correct button.
    // Selected on the kind attribute rather than on text: the reversal's own back-reference sentence
    // contains the redemption's wording too.
    await expect(page.locator('[data-credit-kind="redemption"]')
      .getByTestId("credit-correct-entry")).toHaveCount(0);
    // And the line that points at the void is GONE, because the void has happened. Telling the
    // operator to undo something already undone is the one sentence this row must not carry now;
    // what it says instead is that the money went back, and when. The live case is asserted in
    // "credit settles an invoice at checkout…" above.
    await expect(page.locator('[data-credit-kind="redemption"]'))
      .not.toContainText("To undo this, void the payment");
    await expect(page.locator('[data-credit-kind="redemption"]')).toContainText("Returned on");
  });

test("a viewer who may read the balance but not move it gets the ledger and no write affordance",
  async ({ page, request, tenant }) => {
    await grantCredit(request, tenant.customerId, 5000, "Goodwill");
    const email = `reader+${tenant.runId}@pawsh-test.example`;
    await createMember(request, email, ["customers.view", "payments.view", "appointments.view"]);
    await login(page, email);
    await openLedger(page, tenant.customerId);

    // `canEdit` off the drawer's own read is the ONLY flag consulted. Reading it from the session's
    // permission list would be a guess, because `customers.credit_edit` does not override
    // `payments.view` on the server and the two are checked in that order.
    await expect(page.getByTestId("credit-total-balance")).toHaveText("$50.00");
    await expect(page.getByTestId("credit-entry")).toHaveCount(1);
    await expect(page.getByTestId("credit-add")).toHaveCount(0);
    await expect(page.getByTestId("credit-correct-entry")).toHaveCount(0);
  });

test("a viewer without payments.view is shown nothing credit-shaped at all",
  async ({ page, request, tenant }) => {
    await grantCredit(request, tenant.customerId, 5000, "Goodwill");
    const email = `viewer+${tenant.runId}@pawsh-test.example`;
    await createMember(request, email, ["customers.view", "appointments.view"]);
    await login(page, email);
    await openProfile(page, tenant.customerId);

    // ABSENT, NOT ZEROED. `summary` is null for them, so a withheld balance can never be mistaken
    // for a client who has never been given any — which matters more here than for the other
    // figures, because a zero balance is itself a perfectly normal state.
    await expect(page.getByTestId("client-summary")).toContainText("Sales figures need the payments permission.");
    await expect(page.getByTestId("client-credit-tile")).toHaveCount(0);
    await expect(page.getByTestId("summary-credit")).toHaveCount(0);
    await expect(page.getByTestId("open-credit-ledger")).toHaveCount(0);
  });
