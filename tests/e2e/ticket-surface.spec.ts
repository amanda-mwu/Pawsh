import {
  test,
  expect,
  login,
  createAppointment,
  completeAppointment,
  type TenantFixture
} from "./fixtures/tenant.js";
import { openCheckout, chooseMethod, checkoutSurface } from "./helpers/checkout.js";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * The Ticket — level 3 of the appointment stack, and the one surface that is a document.
 *
 * IT IS A PRINTABLE WORK SHEET AND IT CARRIES NO MONEY. No price, no total, no tax, no payment,
 * no balance and no invoice status, at any stage of any visit — so it has no money states to
 * cover, no `payments.view` gate to exercise, and no completion gate either: the sheet is most
 * useful before the visit, so a future scheduled appointment has one exactly as a finished one
 * does. What these specs cover is the sheet itself: the salon and visit head, one services row
 * per pet-service pair, and three note rows whose empty case is a dash.
 *
 * THE SINGLE MONEY STATEMENT INVARIANT IS STILL GUARDED HERE, and the first spec is where. Every
 * money value the product shows about an invoice is a value `GET /api/invoices/:id/receipt`
 * returned for that invoice, rendered by one call to `receiptBodyMarkup`, and no surface
 * re-derives, re-sums, re-orders or re-formats a figure. THREE hosts now share that one body —
 * the settled Check Out panel, the receipt print root and the receipt modal — because the Ticket
 * is no longer one of them and must not become one again. The assertion is a COMPARISON BETWEEN
 * HOSTS rather than a golden file: it fails when the three drift and not when the design changes.
 */

const ticket = (page: Page): Locator => page.getByTestId("ticket-surface");
const detail = (page: Page): Locator => page.getByTestId("appointment-detail-surface");

/**
 * Print, made observable.
 *
 * `printTicket` and `printReceipt` append a `.print-root` to <body>, call `print()` and remove the
 * root 1000ms later. Neither of those is something a browser test can wait on, so the dialog is
 * stubbed out and the root is kept: `Element.prototype.remove` is neutered FOR PRINT ROOTS ONLY,
 * which leaves every other removal in the client — the checkout's withdrawn controls, the terminal
 * device select — working exactly as it does in production. Nothing about how the root is BUILT is
 * touched, which is the part under test.
 */
async function observePrinting(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "print", { value: () => {}, writable: true });
    const remove = Element.prototype.remove;
    Element.prototype.remove = function (this: Element) {
      if (this.classList?.contains("print-root")) return;
      remove.call(this);
    };
  });
}

/**
 * One receipt's money statement, as text, from whichever host it is rendered into.
 *
 * Only the `<span>` and `<strong>` cells of each row are read. The buttons are deliberately
 * excluded: Refund, Void record and Check refund are CONTROLS, the print stylesheet is allowed to
 * hide them, and hiding them cannot change a number. `refund-exhausted` is a `<span>` and a fact,
 * so it is read like any other cell.
 *
 * `innerText` rather than `textContent`, so a print rule that introduced a `text-transform` inside
 * `.receipt` would show up here as a difference rather than passing unnoticed.
 */
async function moneyStatement(host: Locator): Promise<string[]> {
  const receipt = host.locator(".receipt");
  await expect(receipt).toHaveCount(1);
  return receipt.evaluate((node) =>
    [...node.children]
      .filter((row) => row.tagName === "DIV")
      .map((row) =>
        [...row.children]
          .filter((cell) => cell.tagName === "SPAN" || cell.tagName === "STRONG")
          .map((cell) => (cell as HTMLElement).innerText.replace(/\s+/gu, " ").trim())
          .join(" | ")
      )
  );
}

/** Raises the invoice through the API so the discount and the tip are fixed before the browser. */
async function raiseInvoice(
  api: APIRequestContext,
  appointmentId: string
): Promise<{ id: string; balanceMinor: number }> {
  const response = await api.post(`/api/appointments/${appointmentId}/checkout`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { discountMinor: 500, discountType: "manual", tipMinor: 1500 }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string; balanceMinor: number };
}

async function grantCredit(
  api: APIRequestContext,
  customerId: string,
  amountMinor: number
): Promise<void> {
  const response = await api.post(`/api/customers/${customerId}/credit`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "grant", amountMinor, reason: "Prepaid package for the Ticket spec" }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** Opens the appointment detail surface from the calendar, the way an operator reaches it. */
async function openDetail(page: Page, appointmentId: string): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-appointment-id="${appointmentId}"] .calendar-open`).first().click();
  await expect(detail(page)).toBeVisible();
}

/**
 * The Ticket, opened the way the reference puts it: the print icon in the detail header.
 *
 * That icon is the entry point for EVERY appointment, whatever its status, which is the whole
 * reason it sits with the surface's chrome instead of among the footer controls that act on the
 * visit.
 */
async function openTicketFromHeader(page: Page, appointmentId: string): Promise<void> {
  await openDetail(page, appointmentId);
  await page.getByTestId("appointment-ticket-print").click();
  await expect(ticket(page)).toBeVisible();
}

/** The second service the tenant fixture configures: Nail Trim, 30 minutes. */
async function nailTrimId(api: APIRequestContext): Promise<string> {
  const response = await api.get("/api/services");
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as { items?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
  const items = Array.isArray(payload) ? payload : payload.items ?? [];
  const service = items.find((entry) => entry.name === "Nail Trim");
  expect(service, "the tenant fixture configures a Nail Trim service").toBeTruthy();
  return service!.id;
}

/** Books a visit with a booking note, which `createAppointment` has no parameter for. */
async function bookWithNote(
  api: APIRequestContext,
  tenant: TenantFixture,
  serviceIds: string[],
  notes: string
): Promise<{ id: string }> {
  const response = await api.post("/api/appointments", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      locationId: tenant.locationId,
      customerId: tenant.customerId,
      petId: tenant.petId,
      employeeId: tenant.employeeId,
      serviceIds,
      notes,
      localStart: `${tenant.anchor}T09:00`,
      expectedLocationVersion: tenant.locationVersion
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function addNote(api: APIRequestContext, path: string, body: string): Promise<void> {
  const response = await api.post(path, { data: { body } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** Reads one column out of a table on the sheet, in document order. */
function column(table: Locator, index: number): Locator {
  return table.locator(`tbody tr td:nth-child(${index})`);
}

test("one invoice, three hosts, one money statement — and the Ticket is not one of them", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await completeAppointment(request, tenant);
  await raiseInvoice(request, appointment.id);
  await grantCredit(request, tenant.customerId, 15_000);
  await observePrinting(page);
  await login(page, tenant.ownerEmail);
  // `openCheckout` opens the calendar card's own action menu; it does not navigate. Login lands on
  // the dashboard, so the calendar has to be reached first — the same two lines every other spec
  // that uses this helper carries.
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
  await openCheckout(page, appointment.id);

  // Two payments, so the comparison covers a payment list rather than a single row — and one of
  // them is credit, which is the method whose label the browser has to supply.
  await chooseMethod(page, "Client credit");
  await page.getByTestId("field-pay").fill("40.00");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $61.60");
  await chooseMethod(page, "Cash");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("checkout-balance")).toHaveText("Balance $0.00");

  // Host 1: the settled Check Out panel.
  const settled = await moneyStatement(checkoutSurface(page));
  expect(settled).toContain("Subtotal | $85.00");
  expect(settled).toContain("Balance | $0.00");
  // The operator's words, not the raw column. `client credit` is what the receipt used to print.
  expect(settled).toContain("Client credit · recorded | $40.00");

  // Host 2: the receipt on paper, read under the print stylesheet the printer would apply. The
  // receipt keeps its own two identity lines in every host it has: there is no longer a host that
  // states the salon and the client above them, so nothing suppresses them anywhere.
  await page.getByTestId("checkout-print-receipt").click();
  const receiptPrint = page.locator(".print-root");
  await expect(receiptPrint).toHaveCount(1);
  await page.emulateMedia({ media: "print" });
  const printed = await moneyStatement(receiptPrint);
  await expect(receiptPrint.locator(".receipt > p").first()).toBeVisible();
  // A control may be hidden on paper; a fact may not. Nothing that carries a figure is hidden.
  await expect(receiptPrint.locator(".receipt .text-button").first()).toBeHidden();
  await page.emulateMedia({ media: null });
  // Read, so the kept root goes rather than standing between the rest of this spec and the app.
  await page.evaluate(() => {
    for (const root of document.querySelectorAll(".print-root")) root.parentNode?.removeChild(root);
  });

  // THE TICKET IS NOT A MONEY HOST. It is reachable from this settled panel and from the detail
  // header, and in neither case does it carry a receipt, a figure, or a currency symbol.
  await page.getByTestId("checkout-ticket").click();
  await expect(ticket(page)).toBeVisible();
  await expect(ticket(page).locator(".receipt")).toHaveCount(0);
  await expect(ticket(page).getByTestId("ticket-document")).not.toContainText("$");
  for (const absent of ["Subtotal", "Total", "Tax", "Balance", "Payment", "Invoice"]) {
    await expect(ticket(page).getByTestId("ticket-document"), absent).not.toContainText(absent);
  }
  await page.getByTestId("ticket-print").click();
  await expect(page.locator(".print-root.print-ticket .receipt")).toHaveCount(0);
  await expect(page.locator(".print-root.print-ticket")).not.toContainText("$");
  await page.evaluate(() => {
    for (const root of document.querySelectorAll(".print-root")) root.parentNode?.removeChild(root);
  });

  // Host 3: the receipt modal, reached the way the front desk reaches it — a fresh read of the
  // same invoice, rendered by the same function into the shared dialog.
  await page.keyboard.press("Escape");
  await expect(ticket(page)).toBeHidden();
  await page.getByTestId("checkout-done").click();
  await page.getByTestId("nav-customers").click();
  const row = page.locator(`[data-customer-id="${tenant.customerId}"]`);
  await row.getByTestId("client-row-actions").click();
  await row.getByTestId("client-appointment-history").click();
  const modal = page.getByTestId("modal");
  await modal.getByRole("button", { name: "Receipt" }).click();
  await expect(modal.locator(".receipt")).toBeVisible();
  const inModal = await moneyStatement(modal);

  // THE ASSERTION. Identical text for every money cell, in every host, in the order the server
  // sent it. A second renderer, a re-sum, a re-order, a second formatter or a print-time re-read
  // each break exactly this.
  expect(printed).toEqual(settled);
  expect(inModal).toEqual(settled);
});

test("the work sheet: one row per pet-service pair, and the three notes", async ({
  page,
  request,
  tenant
}) => {
  const appointment = await bookWithNote(
    request,
    tenant,
    [tenant.serviceId, await nailTrimId(request)],
    "Owner collecting at 4pm sharp."
  );
  // Two entries in each thread, written in order, so the sheet has to pick the LATEST rather than
  // the first row the endpoint happens to return.
  await addNote(request, `/api/pets/${tenant.petId}/notes`, "Older pet note.");
  await addNote(request, `/api/pets/${tenant.petId}/notes`, "One inch reverse, round head.");
  await addNote(request, `/api/customers/${tenant.customerId}/notes`, "Older client note.");
  await addNote(request, `/api/customers/${tenant.customerId}/notes`, "Text before the dog is ready.");

  await observePrinting(page);
  await login(page, tenant.ownerEmail);
  await openTicketFromHeader(page, appointment.id);

  const reference = appointment.id.slice(0, 8);
  // The panel bar carries the reference; the sheet repeats it as its own opening line.
  await expect(ticket(page).getByTestId("ticket-reference")).toHaveText(`Ticket #: ${reference}`);
  await expect(ticket(page).getByTestId("ticket-appointment-reference"))
    .toHaveText(`Appointment #: ${reference}`);
  // The bar's reference IS the dialog's accessible name, so the surface announces as a ticket.
  await expect(ticket(page).getByRole("heading", { level: 2 })).toHaveText(`Ticket #: ${reference}`);

  // The document's own identity, from the session's active location. A label with nothing after it
  // is never drawn: this fixture's business has no phone, email or address on file.
  await expect(ticket(page).getByTestId("ticket-salon")).toContainText(`PW Smoke ${tenant.runId}`);
  await expect(ticket(page).getByTestId("ticket-salon")).not.toContainText("Phone:");
  await expect(ticket(page).getByTestId("ticket-client")).toHaveText("Client: Emma Johnson");
  await expect(ticket(page).getByTestId("ticket-date")).toContainText("Date: ");

  // ONE ROW PER PET-SERVICE PAIR: two services on one pet is two rows that repeat the pet, the
  // breed and the groomer rather than one row that inherits them from the one above.
  const services = ticket(page).getByTestId("ticket-services");
  await expect(ticket(page).getByTestId("ticket-service-row")).toHaveCount(2);
  await expect(column(services, 1)).toHaveText(["Charlie", "Charlie"]);
  await expect(column(services, 2)).toHaveText(["Golden Retriever", "Golden Retriever"]);
  await expect(column(services, 3)).toHaveText(["Grace Groomer", "Grace Groomer"]);
  await expect(column(services, 4)).toHaveText(["Full Groom", "Nail Trim"]);
  await expect(column(services, 5)).toHaveText(["1 h 30 m", "30 m"]);

  // Three rows, in the reference's order, and the newest entry in each thread.
  const notes = ticket(page).getByTestId("ticket-notes");
  await expect(column(notes, 1)).toHaveText(["Charlie (Pet)", "Emma Johnson (Client)", "Appointment Note"]);
  await expect(column(notes, 2)).toHaveText([
    "One inch reverse, round head.",
    "Text before the dog is ready.",
    "Owner collecting at 4pm sharp."
  ]);
  // Read-only wherever it appears: neither note thread has a writer on this surface.
  await expect(ticket(page).locator("textarea")).toHaveCount(0);

  // The sheet is the sheet, on screen and on paper: one markup function, two hosts.
  await ticket(page).getByTestId("ticket-print").click();
  const printRoot = page.locator(".print-root.print-ticket");
  await expect(printRoot).toHaveCount(1);
  await expect(printRoot.getByTestId("ticket-service-row")).toHaveCount(2);
  await expect(printRoot.getByTestId("ticket-notes")).toContainText("One inch reverse, round head.");
  await page.evaluate(() => {
    for (const root of document.querySelectorAll(".print-root")) root.parentNode?.removeChild(root);
  });

  // Level 3 still: Escape dismisses exactly one level and the detail underneath is still open.
  await page.keyboard.press("Escape");
  await expect(ticket(page)).toBeHidden();
  await expect(detail(page)).toBeVisible();
  await expect(detail(page).locator("[data-surface-close]")).toBeFocused();
});

test("a future scheduled appointment gets a Ticket, and a note nobody has written is a dash",
  async ({ page, request, tenant }) => {
    // The default booking is next Monday at 09:00 and has never been checked in — the visit is
    // still ahead, which is exactly when the work sheet is printed and clipped to the run.
    const appointment = await createAppointment(request, tenant);

    // The Ticket must not ask for a receipt. There is no invoice to read one from, and firing the
    // request to find that out would leave a network entry for something already known.
    const receiptReads: string[] = [];
    page.on("request", (outgoing) => {
      if (/\/api\/invoices\/[^/]+\/receipt$/u.test(new URL(outgoing.url()).pathname)) {
        receiptReads.push(outgoing.url());
      }
    });

    await login(page, tenant.ownerEmail);
    await openDetail(page, appointment.id);
    await expect(page.getByTestId("appointment-status")).toHaveText("scheduled");
    // No completion gate on the sheet, and no footer churn either: the header icon is the entry
    // point at every stage, and the footer's own Ticket button is still a settled-visit control.
    await expect(page.getByTestId("appointment-ticket")).toHaveCount(0);
    await page.getByTestId("appointment-ticket-print").click();
    await expect(ticket(page)).toBeVisible();

    await expect(ticket(page).getByTestId("ticket-service-row")).toHaveCount(1);
    await expect(column(ticket(page).getByTestId("ticket-services"), 5)).toHaveText(["1 h 30 m"]);

    // Three rows, all empty, and an empty one is a dash rather than a dropped row: "nobody has
    // written a note about this pet" is a fact the groomer needs, and a table that silently omits
    // the row leaves them unable to tell it from a sheet that never had the row.
    const notes = ticket(page).getByTestId("ticket-notes");
    await expect(notes.locator("tbody tr")).toHaveCount(3);
    await expect(column(notes, 1))
      .toHaveText(["Charlie (Pet)", "Emma Johnson (Client)", "Appointment Note"]);
    await expect(column(notes, 2)).toHaveText(["-", "-", "-"]);

    // No money and no permission footnote: a work sheet discloses nothing financial, so it renders
    // the same for every operator who can open the appointment.
    await expect(ticket(page).locator(".receipt")).toHaveCount(0);
    await expect(ticket(page).getByTestId("ticket-document")).not.toContainText("$");
    await expect(ticket(page)).not.toContainText("access level");
    expect(receiptReads).toEqual([]);

    // Every level in this stack opens on its own close button.
    await expect(ticket(page).locator("[data-surface-close]")).toBeFocused();
  });
