import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE SALON'S IDENTITY AT THE HEAD OF THE RECEIPT.
 *
 * ADR-011 puts the salon's name, phone, email and address on the receipt's own printed header,
 * and the server half shipped: `GET /api/invoices/:id/receipt` selects all four and resolves the
 * address through the INVOICE'S OWN APPOINTMENT'S location, which
 * `tests/database/tender-amount-and-receipt.test.ts` holds. The client half was missing — the
 * receipt printed the business name alone while the internal Ticket printed the full block, the
 * inverse of what the record asks for — so the gap this file closes is the RENDERED one.
 *
 * A LINE IS DRAWN ONLY WHEN THERE IS SOMETHING ON IT. Phone, email and address are all nullable,
 * and the contract in both the ADR and the route comment is that a salon which has not filled the
 * Business settings form in gets a header with the line ABSENT rather than a header with an empty
 * row in it. That is the half a payload test cannot see, and it is asserted below in both
 * directions.
 *
 * `public/app.js` is served as a plain module with no bundler and has top-level side effects that
 * need a document, so the block is sliced out by its own two boundaries and evaluated against
 * stubs — the same harness `tests/ui/business-settings.test.ts` uses, and both anchors are
 * declarations this file would have to be rewritten for anyway.
 */
const source = readFileSync("public/app.js", "utf8");
const blockStart = source.indexOf("function salonIdentityOf(");
const blockEnd = source.indexOf("\n// Scoped to the copy of the receipt that was just rendered");

interface SalonIdentity {
  name: string;
  phone: string;
  email: string;
  address: string;
}

interface ReceiptModule {
  salonIdentityOf(fields: Partial<Record<keyof SalonIdentity, unknown>>): SalonIdentity;
  salonIdentityMarkup(salon: SalonIdentity, testid: string): string;
  receiptBodyMarkup(receipt: unknown): string;
}

function loadReceiptModule(): ReceiptModule {
  // `escape` in the browser serialises a text node; the entity set that matters for these
  // assertions is the same one, restated here because there is no document.
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const prelude = `
    "use strict";
    // The money statement's own figures are not what this file is about — the receipt fixture
    // below has no items, discounts, payments or refunds, so only these three are ever reached.
    const money = (minor) => "$" + (Number(minor || 0) / 100).toFixed(2);
    const clientName = (record) =>
      [record.firstName, record.lastName].filter(Boolean).join(" ").trim() || "Not set";
    const allowed = () => false;
  `;
  const exported = `return { salonIdentityOf, salonIdentityMarkup, receiptBodyMarkup };`;
  const factory = new Function(
    "escape",
    "escapeAttr",
    prelude + source.slice(blockStart, blockEnd) + exported
  ) as (escape: unknown, escapeAttr: unknown) => ReceiptModule;
  return factory(escape, escapeAttr);
}

/**
 * A settled receipt with nothing owing and one service line under it.
 *
 * It carries an item so that the head can be asserted to sit ABOVE the money — the statement draws
 * its Services group only when it has services to group, so a receipt with none would put nothing
 * below the head for the ordering assertions to be about.
 */
function receiptFixture(invoice: Record<string, unknown>) {
  return {
    invoice: {
      firstName: "Emma",
      lastName: "Johnson",
      subtotalMinor: 8500,
      discountMinor: 0,
      taxMinor: 0,
      tipMinor: 0,
      totalMinor: 8500,
      balanceMinor: 0,
      ...invoice
    },
    items: [{ description: "Full Groom", amountMinor: 8500, petName: null }],
    discounts: [],
    payments: [],
    refunds: [],
    refundedMinor: 0
  };
}

/**
 * The rendered header, cut out of the statement below it.
 *
 * It is a <header> rather than a <div> for a reason worth stating here, because this helper is
 * what would quietly stop finding it if that changed back: `.receipt>div` is the statement's money
 * row - a flex line with a rule above it - and anything walking the receipt's div children is
 * walking money. `tests/e2e/currency-display.spec.ts` does exactly that to prove no cell was
 * rounded, and a head shaped like a row put a label with no amount into its sweep.
 */
function headerOf(markup: string): string {
  const opening = markup.indexOf('<header class="salon-identity"');
  expect(opening).toBeGreaterThan(-1);
  return markup.slice(opening, markup.indexOf("</header>", opening) + "</header>".length);
}

describe("the receipt's salon identity header", () => {
  it("slices a real block out of the client", () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
  });

  it("prints the name, phone, email and address the payload carried", () => {
    const markup = loadReceiptModule().receiptBodyMarkup(
      receiptFixture({
        businessName: "Riverside Grooming",
        businessPhone: "626-555-0101",
        businessEmail: "hello@riverside.example",
        locationAddress: "18 Mill Lane, Riverside"
      })
    );
    const header = headerOf(markup);
    expect(header).toContain('data-testid="receipt-salon"');
    expect(header).toContain('<p class="salon-identity-name">Riverside Grooming</p>');
    expect(header).toContain("<span>Phone:</span> 626-555-0101");
    expect(header).toContain("<span>Email:</span> hello@riverside.example");
    expect(header).toContain("<span>Address:</span> 18 Mill Lane, Riverside");
    // The order the ADR sets: who it is, how to reach them, where they are.
    expect([...header.matchAll(/<span>(\w+):<\/span>/g)].map((match) => match[1]))
      .toEqual(["Phone", "Email", "Address"]);
    // The head sits above the client the statement is about, and above every money row. The first
    // of those rows is the Services group now rather than a generic `Subtotal`, which the
    // statement no longer states when a `Service subtotal` says what it is a subtotal of.
    expect(markup.indexOf("salon-identity")).toBeLessThan(markup.indexOf("Emma Johnson"));
    expect(markup.indexOf("Emma Johnson")).toBeLessThan(markup.indexOf("Services"));
    expect(markup.indexOf("Services")).toBeLessThan(markup.indexOf("Full Groom"));
  });

  it("omits a line entirely rather than printing an empty one", () => {
    // A salon that has never opened Settings → Business: the server sends null for all three.
    const markup = loadReceiptModule().receiptBodyMarkup(
      receiptFixture({
        businessName: "Riverside Grooming",
        businessPhone: null,
        businessEmail: null,
        locationAddress: null
      })
    );
    const header = headerOf(markup);
    expect(header).toContain('<p class="salon-identity-name">Riverside Grooming</p>');
    expect(header).not.toContain("Phone:");
    expect(header).not.toContain("Email:");
    expect(header).not.toContain("Address:");
    // No empty row, either: the name is the only line in the block.
    expect(header).not.toContain("salon-identity-line");
  });

  it("treats a blank string as the same absence as null", () => {
    // `PUT /api/business/settings` stores what the operator typed, and an operator who cleared the
    // field and saved leaves whitespace behind rather than null.
    const header = headerOf(
      loadReceiptModule().receiptBodyMarkup(
        receiptFixture({
          businessName: "Riverside Grooming",
          businessPhone: "   ",
          businessEmail: "",
          locationAddress: "18 Mill Lane, Riverside"
        })
      )
    );
    expect(header).not.toContain("Phone:");
    expect(header).not.toContain("Email:");
    expect(header).toContain("<span>Address:</span> 18 Mill Lane, Riverside");
  });

  it("escapes what the salon typed", () => {
    const header = headerOf(
      loadReceiptModule().receiptBodyMarkup(
        receiptFixture({
          businessName: "Wag & <b>Wash</b>",
          businessPhone: null,
          businessEmail: null,
          locationAddress: "12 O'Hara St & Vine"
        })
      )
    );
    expect(header).toContain("Wag &amp; &lt;b&gt;Wash&lt;/b&gt;");
    expect(header).toContain("12 O'Hara St &amp; Vine");
    expect(header).not.toContain("<b>Wash</b>");
  });

  it("renders the Ticket and the Receipt through ONE renderer", () => {
    // ADR-011: both documents read the same `businesses` row, so they cannot disagree today, and
    // one helper is what stops a later change making them. The test id is the only difference.
    const receipt = loadReceiptModule();
    const salon = receipt.salonIdentityOf({
      name: "Riverside Grooming",
      phone: "626-555-0101",
      email: "hello@riverside.example",
      address: "18 Mill Lane, Riverside"
    });
    const ticketHead = receipt.salonIdentityMarkup(salon, "ticket-salon");
    const receiptHead = receipt.salonIdentityMarkup(salon, "receipt-salon");
    expect(ticketHead.replace("ticket-salon", "receipt-salon")).toEqual(receiptHead);
    // And the Ticket still calls it with the test id its own suite asserts.
    expect(source).toContain('salonIdentityMarkup(salonIdentity(),"ticket-salon")');
  });

  it("normalises both documents' sources into the same four trimmed fields", () => {
    expect(loadReceiptModule().salonIdentityOf({
      name: " Riverside Grooming ",
      phone: undefined,
      email: null,
      address: "  18 Mill Lane  "
    })).toEqual({
      name: "Riverside Grooming",
      phone: "",
      email: "",
      address: "18 Mill Lane"
    });
  });
});
