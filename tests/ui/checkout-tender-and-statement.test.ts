import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * TWO DEFECTS FOUND ON THE CHECK OUT SURFACE IN HUMAN QA, AND THE RULES THAT NOW HOLD THEM SHUT.
 *
 * ─── DEFECT 1: A PAYMENT WAS RECORDED AS CASH THAT NOBODY CHOSE ──────────────────────────────
 *
 * The owner pressed Take Payment on a visit whose invoice a void had reopened, and a full cash
 * payment landed against it. She was never asked which tender it was.
 *
 * The payment form was rendering the whole time — the amount field, the four salon methods and
 * the control that submits them were all on screen and in the viewport. Nothing auto-submitted
 * either: opening the surface sends no request at all. What was wrong is that the surface had
 * ALREADY ANSWERED THE QUESTION. `checkoutMethodMarkup` checked the first radio (`index===0`,
 * which is Cash), and `syncMoney` pre-filled the amount with the whole balance. So Check Out
 * opened holding a complete, valid, submittable cash payment.
 *
 * That would be a trap on its own, and the layout makes it one that springs: the appointment
 * footer's primary reads `Take Payment` at x=1136,y=672 and Check Out's own primary reads
 * `Take payment` at x=1135,y=672 — the same size, the same slot, one pixel apart, differing by a
 * capital letter. A second press of what looks like the same button is a settled invoice.
 *
 * THE RULE NOW: nothing is selected for the operator. `readMethod()` returns `""` until they
 * choose, and `submitCheckout` answers `""` with "Choose a payment method." rather than a tender.
 *
 * ─── DEFECT 2: THE SAME MONEY, STATED TWICE, ON ONE SCREEN ───────────────────────────────────
 *
 * On a settled invoice the bill column drew `Subtotal / Discount / Tax / Tip / Total` off the
 * invoice while the rail drew `receiptBodyMarkup` beside it — the same five figures in two
 * different shapes, a hand apart. The bill column also said "Only the payment is still open" over
 * an invoice whose payment was closed.
 *
 * NOT CAUSED BY THE STATEMENT REGROUPING, and this file exists partly to record that.
 * `checkoutBillMarkup` and `checkoutSurfaceMarkup` are byte-identical either side of the workspace
 * commit; rendering the previous client against the same server shows both lists already there.
 * What the regrouping changed is that the rail's statement grew headings and an emphasised
 * `Invoice total`, so a duplication that had always been quiet became obvious.
 *
 * THE RULE NOW is by MODE rather than by "is there an invoice":
 *   build    the bill column is the only statement there is. It estimates, and it keeps its money.
 *   collect  the bill column is still the only statement — the rail is the payment form. It keeps
 *            its money and the "already raised" note, which is true exactly here.
 *   settled  the rail states the money in full, once. The bill column states NONE of it.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   restoring `${index===0?" checked":""}` to `checkoutMethodMarkup`'s radio
 *       Check Out opens with Cash chosen again. "no mode that takes money pre-selects a tender"
 *       fails.
 *
 *   `settled` → `frozen` in `checkoutBillMarkup`'s `money_`
 *       the duplicated totals list comes back on a settled invoice. "the settled surface states
 *       the money exactly once" fails.
 *
 *   dropping the `co.terminals.length` guard on the Card terminal option
 *       a workspace with no Square connection offers a tender it cannot take. "a workspace with
 *       no card terminal is not offered one" fails.
 *
 * Each of the three was applied to `public/app.js`, run against this file, and reverted; the file
 * was verified byte-identical by hash afterwards.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** Which of the three modes a checkout is in, read off the invoice rather than off a flag. */
const MODE = slice("function checkoutMode(co){", "\nfunction checkoutEstimate(");
/** The settlement gates the footer's two print controls are decided by. */
const GATES = slice("function receiptHasPayment(", "\nfunction toast(");
/** The two tender sentinels and the credit-availability rule. */
const CREDIT = slice("const CHECKOUT_TERMINAL_METHOD=", "\nconst taxPayState=");
/** The surface itself: the bill column, the method control, the money column and the shell. */
const SURFACE = slice("function checkoutDisclosureMarkup(", "\nasync function checkout(id)");

/** What the rail draws when it hosts the shared statement, distinctive enough to count. */
const STATEMENT = "«shared money statement»";

interface ClientModule {
  checkoutMode(co: unknown): string;
  checkoutBillMarkup(co: unknown): string;
  checkoutMethodMarkup(co: unknown): string;
  checkoutMoneyMarkup(co: unknown): string;
  checkoutSurfaceMarkup(co: unknown): string;
}

function loadClient(): ClientModule {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") =>
    escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const prelude = `
    "use strict";
    const money = (minor) => "$" + (Number(minor || 0) / 100).toFixed(2);
    const clientName = (record) => record.clientName || "Not set";
    const petName = (record) => record.petName || "Unnamed pet";
    const field = (name, label, type = "text", extra = "", wide = false) =>
      \`<label class="\${wide ? "wide" : ""}">\${label}<input data-testid="field-\${name}" name="\${name}" type="\${type}" \${extra}></label>\`;
    const select = (name, label, options, wide = false, selectedValue = "", required = true) =>
      \`<label class="\${wide ? "wide" : ""}">\${label}<select data-testid="field-\${name}" name="\${name}" \${required?"required":""}><option value="">Choose…</option>\${options.map(([v,l]) => \`<option value="\${v}" \${String(v)===String(selectedValue)?"selected":""}>\${escape(l)}</option>\`).join("")}</select></label>\`;

    // THE SHARED MONEY STATEMENT, STUBBED TO A SENTINEL. Which figures it carries is
    // \`tests/ui/payment-receipt.test.ts\`; what matters here is HOW MANY TIMES this surface
    // states the money, so the statement has to be countable rather than readable.
    const receiptBodyMarkup = () => ${JSON.stringify(STATEMENT)};

    // The visit, as the bill column reads it. A 30-field calendar projection with its own spec.
    const appointmentPresentation = (item) => ({
      customerName: item.customerName, petName: item.petName, breed: item.breed,
      dateLabel: item.dateLabel, timeRange: item.timeRange, groomer: item.groomer,
      serviceSnapshots: item.serviceSnapshots || []
    });
    // Lifecycle rendering has its own spec; this column only has to place it.
    const appointmentLifecycleValues = () =>
      ({checkedIn:null, finished:null, minutes:null, stored:true});
    const lifecycleDurationLabel = () => "not recorded";
    const activityStamp = (value) => String(value);

    // THE SALON'S CONFIGURATION. Every one of these has its own read and its own spec; the
    // surface's job is to offer what they report and nothing else.
    const checkoutGrantsDiscount = () => false;
    const checkoutDiscountOptions = () => null;
    const checkoutStackingMode = () => "one_per_appointment";
    const checkoutTipPercents = () => [];
    const discountValueText = () => "";
    const discountApplyScopeLabel = () => "";

    // THE ACTOR. Correction controls on the statement are the statement's own business.
    const allowed = () => true;
  `;
  const exported = `return {
    checkoutMode, checkoutBillMarkup, checkoutMethodMarkup, checkoutMoneyMarkup,
    checkoutSurfaceMarkup
  };`;
  const factory = new Function(
    "escape",
    "escapeAttr",
    [prelude, MODE, GATES, CREDIT, SURFACE, exported].join("\n")
  ) as (escape: unknown, escapeAttr: unknown) => ClientModule;
  return factory(escape, escapeAttr);
}

const client = loadClient();

/** The salon's four built-in methods, as `/api/checkout/payment-options` reports them. */
const SALON_METHODS = [
  { value: "m-cash", label: "Cash", settlementType: "cash" },
  { value: "m-card", label: "Card", settlementType: "external_card" },
  { value: "m-check", label: "Check", settlementType: "check" },
  { value: "m-other", label: "Other", settlementType: "other" }
];

const APPOINTMENT = {
  id: "8f4c1d22-0000-0000-0000-000000000001",
  clientName: "Emma Johnson", customerName: "Emma Johnson", petName: "Charlie",
  breed: "Golden Retriever", dateLabel: "Monday, September 14",
  timeRange: "9:00 AM–10:30 AM", groomer: "Grace Groomer",
  serviceSnapshots: [{ name: "Full Groom", durationMinutes: 90, priceMinor: 8500 }],
  operationalNotes: ""
};

function invoiceReceipt(balanceMinor: number, payments: unknown[] = []) {
  return {
    invoice: {
      invoiceNumber: "INV-1F29A46701", clientName: "Emma Johnson",
      subtotalMinor: 8500, discountMinor: 500, taxMinor: 660, tipMinor: 1500,
      totalMinor: 10160, balanceMinor, status: balanceMinor > 0 ? "open" : "paid"
    },
    payments, refunds: [], items: []
  };
}

/** One checkout, in the mode the caller names. */
function checkout(
  mode: "build" | "collect" | "settled",
  extra: Partial<{ terminals: unknown[]; creditAvailableMinor: number | null; choices: unknown[] }> = {}
) {
  const receipt = mode === "build"
    ? null
    : mode === "collect"
      ? invoiceReceipt(10160)
      : invoiceReceipt(0, [{ id: "p1", method: "cash", status: "recorded", amountMinor: 10160, provider: null }]);
  return {
    appointment: APPOINTMENT, receipt, awaitingReceipt: null,
    choices: extra.choices ?? SALON_METHODS,
    terminals: extra.terminals ?? [],
    base: 8500,
    creditAvailableMinor: extra.creditAvailableMinor ?? null
  };
}

/** Every `checked` attribute inside the rendered method control. */
function preselected(markup: string): string[] {
  return [...markup.matchAll(/<input[^>]*name="method"[^>]*>/gu)]
    .filter((match) => match[0].includes(" checked"))
    .map((match) => /value="([^"]*)"/u.exec(match[0])?.[1] ?? "");
}

/** Every money figure the markup states, in order. */
function figures(markup: string): string[] {
  return [...markup.matchAll(/\$\d[\d,]*\.\d{2}/gu)].map((match) => match[0]);
}

describe("the modes a checkout is in", () => {
  it("reads the mode off the invoice's own balance", () => {
    expect(client.checkoutMode(checkout("build"))).toBe("build");
    expect(client.checkoutMode(checkout("collect"))).toBe("collect");
    expect(client.checkoutMode(checkout("settled"))).toBe("settled");
  });
});

describe("DEFECT 1 — the operator chooses the tender, and the surface never chooses for them", () => {
  it("pre-selects no method in either mode that takes money", () => {
    // THE DEFECT EXACTLY. `index===0` checked the first salon method, which is Cash, so Check Out
    // opened holding a complete cash payment nobody had asked for.
    for (const mode of ["build", "collect"] as const) {
      const markup = client.checkoutMethodMarkup(checkout(mode));
      expect(markup, `${mode} must offer the methods`).toContain('data-testid="field-method"');
      expect(preselected(markup), `${mode} must pre-select nothing`).toEqual([]);
    }
  });

  it("still offers every method the workspace supports, as its own labels", () => {
    const markup = client.checkoutMethodMarkup(checkout("collect"));
    for (const method of SALON_METHODS) {
      expect(markup).toContain(`value="${method.value}"`);
      expect(markup).toContain(method.label);
    }
    // Four radios, four values, nothing chosen.
    expect([...markup.matchAll(/name="method"/gu)]).toHaveLength(4);
  });

  it("offers no card terminal to a workspace that has no card terminal", () => {
    // The QA workspace has no Square connection. An option that could only produce a refusal is
    // absent rather than drawn — and, crucially, its absence cannot silently become Cash, because
    // nothing is pre-selected either.
    const markup = client.checkoutMethodMarkup(checkout("collect", { terminals: [] }));
    expect(markup).not.toContain("Card terminal");
    expect(markup).not.toContain("terminal-capture");
    expect(preselected(markup)).toEqual([]);
  });

  it("offers the card terminal, unselected, to a workspace that has one", () => {
    const markup = client.checkoutMethodMarkup(
      checkout("collect", { terminals: [{ id: "dev-1", label: "Front desk reader" }] })
    );
    expect(markup).toContain("Card terminal");
    expect(markup).toContain("terminal-capture");
    // Named rather than offered as a second decision, because one terminal is not a choice.
    expect(markup).toContain("Front desk reader");
    expect(preselected(markup)).toEqual([]);
  });

  it("offers client credit only when the client has a balance, and never selects it", () => {
    const without = client.checkoutMethodMarkup(checkout("collect", { creditAvailableMinor: 0 }));
    expect(without).not.toContain("client-credit");

    const with_ = client.checkoutMethodMarkup(checkout("collect", { creditAvailableMinor: 4500 }));
    expect(with_).toContain("client-credit");
    expect(with_).toContain("$45.00 available");
    expect(preselected(with_)).toEqual([]);
  });

  it("opens the select fallback on its own placeholder once the methods outgrow the chips", () => {
    // Past the chip limit the control changes shape. The rule must survive the change: a select
    // whose first real option is `selected` is the same defect wearing a different control.
    const many = Array.from({ length: 8 }, (_, index) => ({
      value: `m-${index}`, label: `Method ${index}`, settlementType: "other"
    }));
    const markup = client.checkoutMethodMarkup(checkout("collect", { choices: many }));
    expect(markup).toContain("<select");
    expect(markup).toContain('<option value="">Choose…</option>');
    // Not one real option carries `selected`.
    const selected = [...markup.matchAll(/<option value="(m-[^"]*)"[^>]*selected/gu)];
    expect(selected).toEqual([]);
  });

  it("says so plainly when the workspace has enabled no method at all", () => {
    const markup = client.checkoutMethodMarkup(checkout("collect", { choices: [] }));
    expect(markup).toContain("No payment method is enabled");
    expect(preselected(markup)).toEqual([]);
  });
});

describe("DEFECT 2 — the surface states the money once", () => {
  it("states it in the bill column while building, where it is the only statement", () => {
    const co = checkout("build");
    expect(figures(client.checkoutBillMarkup(co)).length).toBeGreaterThan(0);
    // The rail is the payment form, not a second statement.
    expect(client.checkoutMoneyMarkup(co)).not.toContain(STATEMENT);
  });

  it("states it in the bill column while collecting, where it is still the only statement", () => {
    const co = checkout("collect");
    const bill = client.checkoutBillMarkup(co);
    // The authoritative figures off the invoice the server wrote.
    expect(figures(bill)).toContain("$101.60");
    expect(bill).toContain('data-testid="checkout-frozen"');
    // "Only the payment is still open" is TRUE here, and this is the only mode in which it is.
    expect(bill).toContain("Only the payment is still open");
    expect(client.checkoutMoneyMarkup(co)).not.toContain(STATEMENT);
  });

  it("states it once, in the rail, on a settled invoice", () => {
    const co = checkout("settled");
    const bill = client.checkoutBillMarkup(co);
    const rail = client.checkoutMoneyMarkup(co);

    // THE DEFECT EXACTLY: the bill column drew its own Subtotal/Discount/Tax/Tip/Total beside the
    // rail's full statement. It states no money at all now.
    expect(figures(bill)).toEqual([]);
    expect(bill).not.toContain("checkout-line");
    // And it no longer says the payment is open on an invoice whose payment is closed.
    expect(bill).not.toContain("Only the payment is still open");
    expect(bill).not.toContain('data-testid="checkout-frozen"');

    // The rail carries the shared statement, exactly once.
    expect(rail.split(STATEMENT)).toHaveLength(2);

    // Over the whole surface: one statement, and no second reading of it.
    const surface = client.checkoutSurfaceMarkup(co);
    expect(surface.split(STATEMENT)).toHaveLength(2);
    expect(surface).not.toContain("checkout-line");
  });

  it("keeps the visit in the bill column when it takes the money out of it", () => {
    // The column is not emptied — it becomes what is left when the money is removed. A settled
    // Check Out still has to say whose visit this was and what was done.
    const bill = client.checkoutBillMarkup(checkout("settled"));
    expect(bill).toContain("Emma Johnson");
    expect(bill).toContain("Charlie");
    expect(bill).toContain("Full Groom");
    expect(bill).toContain("90 min");
    expect(bill).toContain('data-testid="checkout-lifecycle"');
    // The service row is still there; only its price went to the rail.
    expect(bill).toContain('data-testid="checkout-service-row"');
  });

  it("keeps the service price in the bill column in the modes that have no rail statement", () => {
    for (const mode of ["build", "collect"] as const) {
      expect(figures(client.checkoutBillMarkup(checkout(mode)))).toContain("$85.00");
    }
  });
});

describe("DEFECT 2 — the footer carries its controls in every mode", () => {
  const controls = (markup: string): string[] =>
    [...markup.matchAll(/data-testid="(checkout-(?:print-invoice|print-receipt|ticket|submit|done))"/gu)]
      .map((match) => match[1] ?? "");

  it("offers the Ticket and a primary in every mode, and never a payment control on a paid bill", () => {
    expect(controls(client.checkoutSurfaceMarkup(checkout("build"))))
      .toEqual(["checkout-ticket", "checkout-submit"]);

    // Print Invoice from the moment an invoice exists; no Receipt while money is owed.
    expect(controls(client.checkoutSurfaceMarkup(checkout("collect"))))
      .toEqual(["checkout-print-invoice", "checkout-ticket", "checkout-submit"]);

    // Both documents once the settlement completed, and Done instead of Take payment: returning
    // to a screen still offering to collect on a zero balance is a route to a double charge.
    expect(controls(client.checkoutSurfaceMarkup(checkout("settled"))))
      .toEqual([
        "checkout-print-invoice", "checkout-print-receipt", "checkout-ticket", "checkout-done"
      ]);
  });

  it("draws the footer as a footer in every mode, with the balance beside its actions", () => {
    for (const mode of ["build", "collect", "settled"] as const) {
      const markup = client.checkoutSurfaceMarkup(checkout(mode));
      expect(markup, mode).toContain('<footer class="surface-foot">');
      expect(markup, mode).toContain('data-testid="checkout-balance"');
      expect(markup, mode).toContain('<div class="surface-foot-actions">');
    }
  });
});
