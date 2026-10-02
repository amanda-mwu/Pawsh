import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * QA PASS — THE APPOINTMENT SURFACE, CHECK OUT, THE INVOICE, DIALOGS AND FORMS.
 *
 * One block per ledger item. Where the behaviour is a pure function it is RUN against fixtures
 * (the function is lifted out of `public/app.js` verbatim and given only the collaborators it
 * names); where it is a stylesheet rule or a guard inside a long handler, the exact text the fix
 * depends on is held, so reverting the fix fails here before it reaches a browser.
 *
 * The footer contract (UX-13 one Print Ticket look and no footer Close, D8 Book Again on
 * settled/cancelled visits, F6 a colleague's visit) is run in `appointment-dominant-slot.test.ts`
 * and `checkout-eligibility.test.ts`, which already build the whole surface.
 */
const source = readFileSync("public/app.js", "utf8");
const styles = readFileSync("public/styles.css", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}
/** One top-level function, by its opening, through the first column-0 closing brace. */
function fn(opening: string): string {
  return `${slice(opening, "\n}")}\n}`;
}
function build<T>(body: string, scope: Record<string, unknown>): T {
  const names = Object.keys(scope);
  return (new Function(...names, body) as (...args: unknown[]) => T)(...names.map((name) => scope[name]));
}
/** Every @media block with exactly this query. */
function media(query: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = styles.indexOf(`@media(${query}){`, from);
    if (at < 0) break;
    let depth = 0;
    let index = at + query.length + 9;
    for (; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      if (styles[index] === "}") { if (depth === 0) break; depth -= 1; }
    }
    blocks.push(styles.slice(at, index));
    from = index;
  }
  return blocks;
}
const escape = (value: unknown = "") =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (value: unknown = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");

describe("D1 · a successful Take Payment is not followed by a TypeError", () => {
  it("the checkout finally block tolerates a redraw that removed the submit button", () => {
    // `live===submit&&submit.isConnected` threw when both were null after the settled redraw,
    // and the error replaced the "Payment recorded" toast.
    expect(source).toContain("if(submit&&live===submit&&submit.isConnected){submit.disabled=false;submit.textContent=original;}");
    expect(source).toContain("finally{if(submit?.isConnected)submit.disabled=false;}");
    expect(source).not.toContain("if(live===submit&&submit.isConnected)");
  });
});

describe("F1 · an inline editor in a surface stays reachable with a phone keyboard up", () => {
  it("the shell steps its footer aside and shrinks its head while typing, at phone sizes only", () => {
    const block = media("max-width:640px),(max-height:500px").join("\n");
    expect(block).toContain(".surface-shell.is-typing>.surface-foot{display:none}");
    expect(block).toContain(".surface-shell.is-typing>.surface-head .surface-subhead{display:none}");
  });
  it("is driven by focus in a surface body's text field, never Check Out's money fields", () => {
    const typing = slice("const SURFACE_TYPING_QUERY=", "\nglobalThis.addEventListener(\"resize\",surfaceTypingResize);");
    expect(typing).toContain('globalThis.matchMedia("(max-width:640px), (max-height:500px)")');
    expect(typing).toContain('!body.classList.contains("checkout-body")');
    expect(typing).toContain('classList.add("is-typing")');
    // The editor's own action row is scrolled into view, and again when the keyboard resizes the
    // visual viewport.
    expect(typing).toContain("actions?.scrollIntoView({block:\"nearest\"})");
    expect(typing).toContain('globalThis.visualViewport?.addEventListener("resize",surfaceTypingResize)');
  });
});

describe("D2 · the Invoice after a void offers Take Payment and keeps not-built controls quiet", () => {
  type Actions = { markup(receipt: unknown): string; reason(receipt: unknown): string };
  const load = (granted: string[]): Actions => build<Actions>(
    [fn("function receiptHasPayment("), fn("function receiptBalanceOutstanding("), fn("function receiptSettlementComplete("),
      slice("const INVOICE_UNAVAILABLE_REASON=", "\n/**\n * BOTH DOCUMENTS ARE REACHABLE"),
      fn("function invoiceDocumentActionsMarkup("),
      "return {markup:invoiceDocumentActionsMarkup,reason:invoiceUnavailableReason};"].join("\n"),
    { escape, escapeAttr, allowed: (key: string) => granted.includes(key) }
  );
  const voided = { invoice: { id: "i1", appointmentId: "a1", status: "open", balanceMinor: 5954 },
    payments: [{ id: "p1", status: "voided", amountMinor: 5954 }] };
  const settled = { invoice: { id: "i1", appointmentId: "a1", status: "paid", balanceMinor: 0 },
    payments: [{ id: "p1", status: "recorded", amountMinor: 5954 }] };

  it("draws Take Payment as the lead primary when money is owed and the role can check out", () => {
    const markup = load(["checkout.perform"]).markup(voided);
    expect(markup).toMatch(/<div class="surface-foot-actions surface-foot-lead"><button type="button" class="primary compact" data-testid="invoice-take-payment">Take Payment<\/button><\/div>$/u);
    // The not-built controls are in the utility group, never the dominant slot.
    expect(markup).toContain('<div class="surface-foot-actions surface-foot-utility" data-testid="invoice-document-actions">');
  });
  it("draws no Take Payment on a settled invoice or for a role without checkout.perform", () => {
    expect(load(["checkout.perform"]).markup(settled)).not.toContain("invoice-take-payment");
    expect(load([]).markup(voided)).not.toContain("invoice-take-payment");
  });
  it("says 'Print the Receipt' only when there is a Receipt to print", () => {
    const actions = load([]);
    expect(actions.reason(settled)).toContain("Print the Receipt");
    expect(actions.reason(voided)).not.toContain("Receipt and hand");
  });
  it("re-reads the invoice when Check Out pops back onto it", () => {
    expect(slice("function showInvoiceDocument(", "\n/**")).toContain("level.reload=async()=>{");
  });
});

describe("D9 · Book Again carries the services and groomer without linking a reschedule", () => {
  const carry = build<(item: unknown, options?: unknown) => { appointmentId: string | null; services: unknown[]; employeeId: string }>(
    `${fn("function rescheduleCarryOver(")}\nreturn rescheduleCarryOver;`, {});
  const item = { id: "a1", employeeId: "e1", employeeName: "Grace", services: [{ serviceId: "s1", name: "Bath" }] };

  it("Reschedule links, Book Again does not", () => {
    expect(carry(item).appointmentId).toBe("a1");
    const again = carry(item, { link: false });
    expect(again.appointmentId).toBeNull();
    expect(again.services).toEqual([{ serviceId: "s1", name: "Bath" }]);
    expect(again.employeeId).toBe("e1");
  });
  it("only a linked carry sends rescheduledFromAppointmentId or retitles the dialog", () => {
    expect(source).toContain("...(state.booking.reschedule?.appointmentId?{rescheduledFromAppointmentId:state.booking.reschedule.appointmentId}:{})");
    expect(source).toContain('textContent=reschedule?.appointmentId?"Reschedule Appointment":"Create Appointment"');
    expect(slice('on("appointment-book-again"', "}));")).toContain("rescheduleCarryOver(surface.item,{link:false})");
  });
});

describe("D3 · Add service shows what the assigned groomer is not set up for", () => {
  const services = [
    { id: "s1", name: "Bath", category: "DOG_BASE", active: true, basePriceMinor: 5500, baseDurationMinutes: 60 },
    { id: "s2", name: "Full Groom", category: "DOG_BASE", active: true, basePriceMinor: 9000, baseDurationMinutes: 90 }
  ];
  const picker = build<(selected: string[], options?: unknown) => string>(
    `${fn("function bookingServiceCheckboxes(")}\nreturn bookingServiceCheckboxes;`,
    { escape, money: (minor: number) => `$${(minor / 100).toFixed(2)}`, state: { services },
      serviceCategoryOrder: ["DOG_BASE"], serviceSectionOpen: () => true });

  it("disables a service outside the groomer's set, with the reason, and leaves the rest pressable", () => {
    const markup = picker([], { groomer: { displayName: "Grace Groomer", serviceIds: ["s1"] } });
    expect(markup).toMatch(/value="s2"[^>]*disabled/u);
    expect(markup).toContain("Grace Groomer is not set up for this service");
    expect(markup).not.toMatch(/value="s1"[^>]*disabled/u);
  });
  it("keeps a service already on the visit pressable so it can be removed", () => {
    expect(picker(["s2"], { groomer: { displayName: "Grace", serviceIds: ["s1"] } })).not.toMatch(/value="s2"[^>]*disabled/u);
  });
  it("restricts nothing for a groomer with no service list, or with no groomer at all", () => {
    expect(picker([], { groomer: { displayName: "Grace", serviceIds: [] } })).not.toContain("disabled");
    expect(picker([])).not.toContain("disabled");
  });
});

describe("UX-06 · the lifecycle strip never shows '…' after its read has failed", () => {
  const strip = build<(activity: unknown, item: unknown) => string>(
    [fn("function appointmentLifecycleValues("), fn("function appointmentLifecycleTimes("), fn("function appointmentLifecycleMarkup("),
      "return appointmentLifecycleMarkup;"].join("\n"),
    { escape, activityStamp: (value: string) => `@${value}`, lifecycleDurationLabel: (minutes: number | null) => minutes === null ? "not recorded" : `${minutes} min` });

  it("uses the stored columns, and 'unavailable' for what only the history could supply", () => {
    const markup = strip({ items: null, failed: true }, { status: "checked_in", checkedInAt: "2026-10-02T17:00:00Z" });
    expect(markup).toContain("@2026-10-02T17:00:00Z");
    expect(markup).toContain("unavailable");
    expect(markup).not.toContain("…");
  });
  it("shows '…' only while the read is in flight", () => {
    expect(strip({ items: null }, { status: "checked_in", checkedInAt: "x" })).toContain("…");
  });
  it("still says 'not recorded' on a visit past check-in whose times are missing", () => {
    // Hidden only while the visit never started; a started visit with gaps says so.
    for (const status of ["checked_in", "in_service", "completed"]) {
      const markup = strip({ items: [] }, { status, checkedInAt: null, checkedOutAt: null });
      expect(markup, status).toContain('data-testid="lifecycle-in"');
      expect(markup, status).toContain("not recorded");
    }
    // A cancelled visit that WAS checked in keeps its strip too.
    expect(strip({ items: [] }, { status: "cancelled", checkedInAt: "2026-10-02T17:00:00Z" })).toContain("lifecycle-in");
  });
  it("is empty on a visit nobody has checked in", () => {
    expect(strip({ items: [] }, { status: "scheduled", checkedInAt: null })).toBe("");
    expect(styles).toContain(".appointment-lifecycle:empty{display:none}");
  });
});

describe("UX-07 · Check Out says when it fell back to the built-in methods", () => {
  it("marks the fallback choices and the method group names it", () => {
    expect(fn("function checkoutMethodChoices(")).toContain("settlementType:value,fallback:true");
    expect(source).toContain("const fallbackNotice=co.choices.some(choice=>choice.fallback)");
    expect(source).toContain('data-testid="checkout-methods-fallback"');
  });
  it("does not pin the fallback for the session after a transient failure", () => {
    expect(fn("async function ensureCheckoutPaymentOptions(")).toContain("catch(error){if(error?.status===403)checkoutOptions.unavailable=true;}");
  });
});

describe("UX-08 · the repeated-time question appears only for a repeated time", () => {
  const scope = build<{ ambiguous(value: string, zone: string): boolean; field(value: string, start: string): string }>(
    [fn("function zoneOffsetMinutes("), fn("function localStartAmbiguous("), fn("function disambiguationField("),
      "return {ambiguous:localStartAmbiguous,field:disambiguationField};"].join("\n"),
    { schedulingZone: () => "America/Los_Angeles" });

  it("detects the fall-back hour in the business's zone and nothing else", () => {
    expect(scope.ambiguous("2026-11-01T01:30", "America/Los_Angeles")).toBe(true);
    expect(scope.ambiguous("2026-11-01T02:00", "America/Los_Angeles")).toBe(false);
    expect(scope.ambiguous("2026-03-08T02:30", "America/Los_Angeles")).toBe(false);
    expect(scope.ambiguous("2026-10-28T10:00", "America/Los_Angeles")).toBe(false);
    expect(scope.ambiguous("2026-10-25T02:30", "Europe/Berlin")).toBe(true);
  });
  it("renders the field hidden unless the start is ambiguous or a choice is saved", () => {
    expect(scope.field("", "2026-10-28T10:00")).toContain("data-disambiguation hidden");
    expect(scope.field("", "2026-11-01T01:30")).not.toContain(" hidden");
    expect(scope.field("later", "2026-10-28T10:00")).not.toContain(" hidden");
  });
});

describe("F10 · Move offers only the staff this caller may assign", () => {
  const options = build<(ids: string[], o?: unknown) => unknown[]>(
    [fn("function groomerServiceGap("), fn("function groomerPickerOptions("), "return groomerPickerOptions;"].join("\n"),
    { state: { employees: [{ id: "g", displayName: "Grace", active: true }, { id: "b", displayName: "Gabriel", active: true }], services: [] } });
  it("filters to the allowed ids when asked, and to nobody else", () => {
    expect(options([], { only: ["g"] }).map((row) => (row as string[])[0])).toEqual(["g"]);
    expect(options([]).length).toBe(2);
    expect(source).toContain('{only:allowed("appointments.edit_all_staff")?null:[myEmployeeId(),...assigned].filter(Boolean)}');
  });
});

describe("UX-09 · phone dialogs collapse their context to one line with a Details disclosure", () => {
  it("collapses the booking client panel and the pet context at <=580px, never the safety alert", () => {
    const block = media("max-width:580px").join("\n");
    expect(block).toContain(".booking-client:not(.is-expanded) .booking-client-more{display:none}");
    expect(block).toContain(".modal-pet-context:not(.is-expanded) .care-note:not(.care-alarm){display:none}");
    expect(block).not.toContain(".care-alarm{display:none}");
    expect(styles).toContain(".phone-details-toggle{display:none}");
    expect(source).toContain('data-phone-details aria-expanded="false">Details</button>');
  });
});

describe("F3 · the Block Time schedule is one column in a phone's drawer", () => {
  it("restates the <=420px single column after the rule that used to outrank it", () => {
    const override = styles.lastIndexOf(".blocked-time-schedule{grid-template-columns:minmax(0,1.1fr)");
    const phone = styles.lastIndexOf("@media(max-width:420px){\n  .blocked-time-schedule{grid-template-columns:minmax(0,1fr)}");
    expect(override).toBeGreaterThan(0);
    expect(phone).toBeGreaterThan(override);
  });
});

describe("D22 · the client profile's appointment table fits and lines up", () => {
  it("keeps the status cell a table cell and drops the repeated 'Services:' prefix", () => {
    expect(styles).toContain(".history-table td.history-status{display:table-cell;min-width:0}");
    expect(styles).not.toContain(".history-status{display:flex");
    expect(fn("function historyRowMarkup(")).not.toContain("Services: ");
  });
});

describe("F13 · a save from a previous dialog cannot close the one open now", () => {
  it("scopes completions to the dialog session that started them", () => {
    const modal = fn("function openModal(");
    expect(modal).toContain("const session=++modalSession;");
    expect(modal).toContain('if(current())$("#modal").close();');
    expect(modal).toContain("if(current())$(\"#modal-error\").textContent = error.message;");
    expect(modal).toContain("finally{if(current()){button.disabled=false;");
  });
});

describe("W · a save that landed is not reported as failed when the re-read after it fails", () => {
  it("catches the refresh on its own, closes the dialog and says both things", () => {
    const modal = fn("function openModal(");
    expect(modal).toContain("if(state.me)await refresh().catch(failure=>{stale=failure;});");
    expect(modal).toContain("The screen could not refresh");
    expect(modal).not.toContain("if(state.me)await refresh();");
  });
});

describe("D19 · opening Reschedule asks for one price, not three", () => {
  it("shares an identical in-flight request and asks afresh for a different body", async () => {
    const calls: string[] = [];
    const resolve = build<(petId: string, ids: string[]) => Promise<unknown>>(
      `let bookingPriceRequest=null;\n${fn("function resolveBookingPrices(")}\nreturn resolveBookingPrices;`,
      { api: (_path: string, init: { body: string }) => { calls.push(init.body); return Promise.resolve([]); } });
    await Promise.all([resolve("p1", ["s1"]), resolve("p1", ["s1"]), resolve("p1", ["s1"])]);
    expect(calls).toHaveLength(1);
    await resolve("p1", ["s1", "s2"]);
    expect(calls).toHaveLength(2);
  });
});

describe("D15 / D17 · discount wording", () => {
  const carries = build<(name: string, bp: number) => boolean>(
    [fn("function taxPayPercent("), fn("function discountNameCarriesRate("), "return discountNameCarriesRate;"].join("\n"), {});
  it("does not repeat a rate the name already states", () => {
    expect(carries("Welcome 15%", 1500)).toBe(true);
    expect(carries("Welcome 15 %", 1500)).toBe(true);
    expect(carries("Welcome 115%", 1500)).toBe(false);
    expect(carries("Senior", 1500)).toBe(false);
  });
  it("offers only a coupon to a role the server withholds discounts from", () => {
    expect(source).toContain('options===null?"+ Apply coupon":"+ Apply coupon or discount"');
  });
});

describe("F9 / D11 / F12 · the Ticket and the client profile", () => {
  it("reads a groomer's client notes through the appointment-scoped payload", async () => {
    const notes = build<(item: unknown) => Promise<{ items: unknown[] }>>(
      `${fn("function appointmentClientNotes(")}\nreturn appointmentClientNotes;`,
      { state: { clientProfile: { appointmentId: "a1", notes: { items: [{ body: "Text first" }], failed: false } } },
        allowed: () => true, api: () => Promise.reject(new Error("should not be read")), permissionRefusalSentence: () => "" });
    expect((await notes({ id: "a1" })).items).toEqual([{ body: "Text first" }]);
  });
  it("puts the visit's time range on the Ticket", () => {
    expect(fn("function ticketVisitMarkup(")).toContain('data-testid="ticket-time"');
  });
  it("names the client in the title on a phone", () => {
    expect(source).toContain('<span class="page-title-subject">${escape(clientName(customer))}</span>');
    expect(media("max-width:640px").join("\n")).toContain(".page-title-generic{display:none}");
  });
});
