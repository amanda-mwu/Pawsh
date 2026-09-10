import { describe, expect, it } from "vitest";
import { dialogHarness, evaluate, slice, type DialogHarness } from "./support/stacked-dialog.js";

/**
 * VOIDING A PAYMENT RECORD IS ASKED IN PAWSH'S OWN DIALOG, AND NOTHING ELSE ABOUT IT MOVED.
 *
 * It used to be two of the BROWSER'S dialogs in a row — a `prompt` for the reason, then a
 * `confirm` for the warning — drawn by the browser, titled "127.0.0.1:3000 says", and nowhere near
 * the receipt being corrected. They are now one `#stacked-dialog` carrying both halves.
 *
 * This is a money correction, so the fix is only acceptable if the behaviour around it is
 * untouched. Every assertion below is about something that must be TRUE BOTH BEFORE AND AFTER:
 *
 *   a reason is required                 `prompt` returned "" when left blank and null when
 *                                        dismissed, and both aborted. Still nothing is sent.
 *   dismissal sends nothing              Cancel, and Escape, and the receipt is left alone.
 *   confirming sends EXACTLY ONE         one `payment.void`, one path, one body — `{reason}`,
 *                                        with the reason verbatim, no trim of its own, because
 *                                        `voidPaymentSchema` is `trim().min(3).max(500)` and the
 *                                        server is the authority on what a reason has to be.
 *   the warnings are the same sentences  including the credit sentence, which names the money
 *                                        going back onto the client's balance.
 *   a terminal payment still refuses     toast, no dialog, no request.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   delete `if(!reason){...return false;}`
 *       a blank reason is sent. "an empty reason sends nothing" fails.
 *
 *   `onConfirm` calling `financialMutation` outside `runOnce`
 *       a double-press sends two voids. "a second press sends nothing more" fails.
 *
 *   dropping the credit branch from `warning`
 *       "the credit warning still names the money going back" fails.
 *
 * The dialog itself is EXECUTED, against `tests/ui/support/stacked-dialog.ts`. Its body
 * `querySelector` answers only for hooks the markup actually renders, so deleting the reason field
 * from the body does not quietly return an empty string — it throws.
 */

/** The void path, whole, from its own declaration to the block after it. */
const VOID = slice("function voidPayment(", "\nlet clientRowMenusBound");
/** The dialog it opens. */
const DIALOG = slice("function openStackedDialog({", "\n// Pets whose rabies record has already lapsed");
/** The in-flight guard, real, because "exactly one request" is what it exists to hold. */
const RUN_ONCE = slice("async function runOnce(", "\nasync function financialMutation(");

const PAYMENT_ID = "8f1c2ade-0000-4000-8000-000000000001";
const INVOICE_ID = "3c9a0011-0000-4000-8000-0000000000aa";

interface VoidRequest {
  path: string;
  operation: string;
  payload: Record<string, unknown>;
}

interface Client {
  voidPayment(
    paymentId: string, invoiceId: string, provider: string | null,
    method: string, amountMinor?: number
  ): void;
  /** Every `financialMutation` the client sent, in order. */
  sent: VoidRequest[];
  /** Every `reopenReceipt` the client asked for, in order. */
  reopened: { invoiceId: string; message: string }[];
  /** What the next `financialMutation` should do instead of succeeding. */
  refuse: { with: Error | null };
}

function loadClient(): { client: Client; dialog: DialogHarness } {
  const dialog = dialogHarness();
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const sent: VoidRequest[] = [];
  const reopened: { invoiceId: string; message: string }[] = [];
  const refuse: { with: Error | null } = { with: null };
  const client = evaluate<Client>(
    [RUN_ONCE, DIALOG, VOID],
    {
      ...dialog.stubs,
      escape,
      money: (minor: number) => `$${(Number(minor || 0) / 100).toFixed(2)}`,
      pendingActions: new Set<string>(),
      financialMutation: (path: string, operation: string, payload: Record<string, unknown>) => {
        sent.push({ path, operation, payload });
        if (refuse.with) return Promise.reject(refuse.with);
        return Promise.resolve({});
      },
      reopenReceipt: (invoiceId: string, message: string) => {
        reopened.push({ invoiceId, message });
        return Promise.resolve();
      },
      runDetached: (task: () => Promise<void> | void) => { void Promise.resolve().then(task); },
      sent, reopened, refuse
    },
    `return {voidPayment, sent, reopened, refuse};`
  );
  return { client, dialog };
}

/** Opens the dialog for a manually recorded payment and types a reason into it. */
function openVoid(
  client: Client, dialog: DialogHarness,
  { method = "cash", amountMinor = 4000, reason = "keyed twice" } = {}
): void {
  client.voidPayment(PAYMENT_ID, INVOICE_ID, null, method, amountMinor);
  const field = dialog.field('[name="voidReason"]');
  if (!field) throw new Error("the void dialog no longer renders a reason field");
  field.value = reason;
}

describe("the void reason is asked in Pawsh's dialog, not the browser's", () => {
  it("opens one stacked dialog carrying the warning AND the reason field", () => {
    const { client, dialog } = loadClient();
    client.voidPayment(PAYMENT_ID, INVOICE_ID, null, "cash", 4000);

    expect(dialog.opens).toHaveLength(1);
    expect(dialog.isOpen()).toBe(true);
    const opened = dialog.current();
    expect(opened?.title).toBe("Void payment record");
    expect(opened?.confirmLabel).toBe("Void payment");
    expect(opened?.dismissLabel).toBe("Cancel");
    // BOTH halves of the two browser dialogs, in the one dialog that replaced them.
    expect(opened?.body).toContain("Void this Pawsh payment record? This does not refund external funds.");
    expect(opened?.body).toContain('name="voidReason"');
    // A question with two answers wants no third control saying what Cancel already says.
    expect(opened?.headCloseLabel).toBeNull();
    expect(client.sent).toEqual([]);
  });

  it("still says the credit sentence, naming the money going back onto the balance", () => {
    const { client, dialog } = loadClient();
    client.voidPayment(PAYMENT_ID, INVOICE_ID, null, "client_credit", 4000);

    expect(dialog.current()?.body)
      .toContain("Void this credit payment? The $40.00 goes back to this client's credit balance.");
  });

  it("still refuses a terminal payment with a toast, opening no dialog and sending nothing", () => {
    const { client, dialog } = loadClient();
    client.voidPayment(PAYMENT_ID, INVOICE_ID, "square", "external_card", 6160);

    expect(dialog.opens).toEqual([]);
    expect(dialog.toasts)
      .toEqual(["This payment was taken on a card terminal, so it has to be refunded rather than voided."]);
    expect(client.sent).toEqual([]);
  });
});

describe("dismissing sends nothing", () => {
  it("Cancel closes the dialog and sends no request", async () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog);
    await dialog.dismiss();

    expect(dialog.isOpen()).toBe(false);
    expect(client.sent).toEqual([]);
    expect(client.reopened).toEqual([]);
  });

  it("Escape closes the dialog and sends no request", () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog);
    dialog.escape();

    expect(dialog.isOpen()).toBe(false);
    expect(client.sent).toEqual([]);
  });
});

describe("a reason is required, exactly as the prompt required one", () => {
  it("an empty reason sends nothing and keeps the dialog open to say why", async () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog, { reason: "" });
    await dialog.confirm();

    expect(client.sent).toEqual([]);
    expect(dialog.isOpen()).toBe(true);
    expect(dialog.field(".error")?.textContent)
      .toBe("Give a reason for voiding this payment record.");
  });

  it("typing one afterwards sends it, from the dialog that stayed open", async () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog, { reason: "" });
    await dialog.confirm();
    dialog.field('[name="voidReason"]')!.value = "keyed twice";
    await dialog.confirm();

    expect(client.sent).toHaveLength(1);
    expect(dialog.isOpen()).toBe(false);
  });
});

describe("confirming sends exactly one void, with the payload it always sent", () => {
  it("one request, one path, one body", async () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog, { reason: "keyed twice" });
    await dialog.confirm();

    expect(client.sent).toEqual([{
      path: `/api/payments/${PAYMENT_ID}/void`,
      operation: "payment.void",
      payload: { reason: "keyed twice" }
    }]);
    expect(dialog.isOpen()).toBe(false);
  });

  it("sends the reason VERBATIM, leaving the server's own trim and floor as the authority", async () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog, { reason: "  wrong tender  " });
    await dialog.confirm();

    expect(client.sent[0]!.payload).toEqual({ reason: "  wrong tender  " });
  });

  it("re-reads the receipt only after the dialog has gone, and says what the void did", async () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog, { method: "client_credit", reason: "keyed twice" });
    await dialog.confirm();

    // Deferred a tick, because `reopenReceipt` closes and reopens `#modal` and must not do it
    // underneath a stacked dialog that is about to close.
    expect(client.reopened).toEqual([]);
    dialog.runTimers();
    await Promise.resolve();
    expect(client.reopened).toEqual([{
      invoiceId: INVOICE_ID,
      message: "Payment record voided; $40.00 returned to the client's credit balance."
    }]);
  });

  it("a second press sends nothing more while the first is still in flight", async () => {
    const { client, dialog } = loadClient();
    openVoid(client, dialog, { reason: "keyed twice" });
    const first = dialog.confirm();
    const second = dialog.confirm();
    await Promise.all([first, second]);

    expect(client.sent).toHaveLength(1);
  });

  it("a refusal is toasted and the receipt is not re-read, exactly as before", async () => {
    const { client, dialog } = loadClient();
    client.refuse.with = new Error("This payment was already voided.");
    openVoid(client, dialog, { reason: "keyed twice" });
    await dialog.confirm();

    expect(client.sent).toHaveLength(1);
    expect(dialog.toasts).toEqual(["This payment was already voided."]);
    dialog.runTimers();
    expect(client.reopened).toEqual([]);
  });
});
