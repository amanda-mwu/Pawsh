import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * QA ROUND 2, AS BEHAVIOUR.
 *
 * Each block slices the client's own function out of `public/app.js` by name and RUNS it against
 * the smallest fake it needs. Nothing here asserts on source text or on stylesheet substrings:
 * what only a rendered page can answer - computed status text, layout, the stacked dialog over a
 * surface, a failed second tender redrawn against its invoice - is measured by
 * `tests/e2e/qa-round2.spec.ts`.
 */
const source = readFileSync("public/app.js", "utf8");

/** One top-level function's text, by name, measured by its braces. */
function fn(name: string): string {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`, "u"));
  if (start < 0) throw new Error(`public/app.js no longer defines ${name}`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} never closes`);
}

function build<T>(names: string[], scope: Record<string, unknown>, result: string): T {
  const keys = Object.keys(scope);
  const body = `${names.map(fn).join("\n")}\nreturn ${result};`;
  return (new Function(...keys, body) as (...args: unknown[]) => T)(...keys.map((key) => scope[key]));
}

const money = (minor: number) => `$${(Number(minor || 0) / 100).toFixed(2)}`;
const escape = (value: unknown = "") =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (value: unknown = "") => escape(value).replaceAll('"', "&quot;");
const text = (html: string) => html.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
const form = (values: Record<string, string>) => ({ get: (key: string) => values[key] ?? null });

// ─── C · client credit, then a second tender that failed ────────────────────────────────────

describe("C: the progress line after credit and a failed second tender", () => {
  const progress = build<(co: unknown) => string>(
    ["receiptHasPayment", "settledComponents", "settledComponentsMinor", "checkoutMode", "checkoutSettlementProgressMarkup"],
    { money },
    "checkoutSettlementProgressMarkup"
  );
  const receipt = (payments: Array<{ method: string; amountMinor: number; status?: string }>, balanceMinor: number) => ({
    receipt: { invoice: { balanceMinor }, payments: payments.map((payment) => ({ status: "recorded", ...payment })) }
  });

  it("names the credit and the exact remaining amount due", () => {
    expect(text(progress(receipt([{ method: "client_credit", amountMinor: 4000 }], 5201))))
      .toBe("Settlement in progress · Client credit of $40.00 applied · $52.01 remaining amount due");
  });

  it("states other recorded money beside the credit, and ignores a voided component", () => {
    expect(text(progress(receipt([
      { method: "client_credit", amountMinor: 4000 },
      { method: "external_card", amountMinor: 2000 },
      { method: "cash", amountMinor: 999, status: "voided" }
    ], 3201)))).toBe("Settlement in progress · Client credit of $40.00 applied · $20.00 recorded · $32.01 remaining amount due");
  });

  it("leaves a settlement without credit worded as before", () => {
    expect(text(progress(receipt([{ method: "cash", amountMinor: 4000 }], 5201))))
      .toBe("Settlement in progress · $40.00 recorded · $52.01 still to settle");
  });

  it("every separator belongs to the phrase before it, so a wrap cannot orphan it", () => {
    const html = progress(receipt([{ method: "client_credit", amountMinor: 4000 }], 5201));
    const phrases = [...html.matchAll(/<(?:span|strong) class="progress-part">([^<]*)</gu)].map((match) => match[1]);
    expect(phrases).toEqual(["Settlement in progress ·", "Client credit of $40.00 applied ·", "$52.01 remaining amount due"]);
  });
});

// ─── D and P1-1 · Check In and Start service from the card menu ────────────────────────────

describe("the card menu's Check In and Start service", () => {
  type Call = { path: string; init: { method: string; body: string } };
  function harness(appointment: Record<string, unknown>, { future = false, confirmAnswer = true } = {}) {
    const calls: Call[] = [];
    const order: string[] = [];
    let modal: { title: string; fields: string; submit: (form: unknown) => Promise<void> } | null = null;
    const advance = build<(id: string, status: string) => Promise<unknown>>(
      ["advanceAppointment"],
      {
        runOnce: (_key: string, work: () => unknown) => work(),
        checkout: () => undefined,
        calendarAppointmentById: () => appointment,
        toast: () => undefined,
        closeCalendarMenus: () => { order.push("menus closed"); },
        confirmFutureCheckIn: async () => { order.push("asked"); return future ? confirmAnswer : true; },
        openModal: (title: string, fields: string, submit: (form: unknown) => Promise<void>) => {
          order.push("modal");
          modal = { title, fields, submit };
        },
        petContextMarkup: () => "",
        field: (name: string, _label: string, _type: string, extra = "") => `<input name="${name}" ${extra}>`,
        escapeAttr,
        api: async (path: string, init: { method: string; body: string }) => {
          calls.push({ path, init });
          return { version: 8 };
        },
        confirm: () => true,
        refresh: async () => undefined
      },
      "advanceAppointment"
    );
    return { advance, calls, order, modal: () => modal! };
  }

  it("closes the menu before asking, and Cancel on a future visit opens nothing", async () => {
    const { advance, order, calls } = harness({ id: "a1", version: 3 }, { future: true, confirmAnswer: false });
    await advance("a1", "scheduled");
    expect(order).toEqual(["menus closed", "asked"]);
    expect(calls).toHaveLength(0);
  });

  it("Confirm on a future visit opens the existing Check in form", async () => {
    const { advance, order, modal } = harness({ id: "a1", version: 3 }, { future: true });
    await advance("a1", "scheduled");
    expect(order).toEqual(["menus closed", "asked", "modal"]);
    expect(modal().title).toBe("Check in appointment");
  });

  it("Start service shows the note written before check-in, and leaves it alone when unchanged", async () => {
    const { advance, calls, modal } = harness({ id: "a1", version: 3, operationalNotes: "Nervous about the dryer." });
    await advance("a1", "checked_in");
    expect(modal().fields).toContain('value="Nervous about the dryer."');
    await modal().submit(form({ operationalNotes: "Nervous about the dryer." }));
    expect(calls.map((call) => call.path)).toEqual(["/api/appointments/a1/transition"]);
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ status: "in_service", version: 3 });
  });

  it("Start service writes the note only when it was changed, and moves on the new version", async () => {
    const { advance, calls, modal } = harness({ id: "a1", version: 3, operationalNotes: "Nervous about the dryer." });
    await advance("a1", "checked_in");
    await modal().submit(form({ operationalNotes: "  Nervous about the dryer; used the quiet one.  " }));
    expect(calls.map((call) => call.path)).toEqual(["/api/appointments/a1/operations", "/api/appointments/a1/transition"]);
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ operationalNotes: "Nervous about the dryer; used the quiet one.", version: 3 });
    expect(JSON.parse(calls[1]!.init.body)).toEqual({ status: "in_service", version: 8 });
  });

  it("an empty box on a visit with no note sends no note write", async () => {
    const { advance, calls, modal } = harness({ id: "a1", version: 3, operationalNotes: null });
    await advance("a1", "checked_in");
    await modal().submit(form({ operationalNotes: "" }));
    expect(calls.map((call) => call.path)).toEqual(["/api/appointments/a1/transition"]);
  });
});

describe("D: the early-check-in question", () => {
  type Dialog = { listeners: Record<string, () => void>; addEventListener(type: string, listener: () => void): void };
  function harness(localDate: string) {
    const opened: Array<Record<string, unknown>> = [];
    let dialog: Dialog | null = null;
    const confirmFutureCheckIn = build<(item: unknown) => Promise<boolean>>(
      ["appointmentDatedAfterToday", "confirmFutureCheckIn"],
      {
        appointmentLocalValue: () => `${localDate}T10:00`,
        businessDate: () => "2026-10-02",
        appointmentPresentation: () => ({ dateLabel: "Friday, October 9" }),
        schedulingTime: () => "10:00 AM",
        escape,
        openStackedDialog: (options: Record<string, unknown>) => {
          opened.push(options);
          dialog = { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
          return dialog;
        }
      },
      "confirmFutureCheckIn"
    );
    return { confirmFutureCheckIn, opened, close: () => (dialog as Dialog | null)?.listeners.close?.() };
  }

  it("today asks nothing", async () => {
    const { confirmFutureCheckIn, opened } = harness("2026-10-02");
    await expect(confirmFutureCheckIn({ startAt: "x" })).resolves.toBe(true);
    expect(opened).toHaveLength(0);
  });

  it("a later date names the visit's date and time, offers Check In, and Cancel changes nothing", async () => {
    const { confirmFutureCheckIn, opened, close } = harness("2026-10-09");
    const answer = confirmFutureCheckIn({ startAt: "x" });
    expect(opened[0]!.title).toBe("Check in early?");
    expect(text(String(opened[0]!.body))).toContain("Friday, October 9 at 10:00 AM");
    expect(opened[0]!.confirmLabel).toBe("Check In");
    close();
    await expect(answer).resolves.toBe(false);
  });

  it("Confirm resolves true", async () => {
    const { confirmFutureCheckIn, opened, close } = harness("2026-10-09");
    const answer = confirmFutureCheckIn({ startAt: "x" });
    (opened[0]!.onConfirm as () => void)();
    close();
    await expect(answer).resolves.toBe(true);
  });
});

// ─── A · who writes the service note ───────────────────────────────────────────────────────

describe("A: either key writes the service note", () => {
  const writer = (permissions: string[]) => build<() => boolean>(
    ["serviceNoteWriter"], { allowed: (key: string) => permissions.includes(key) }, "serviceNoteWriter"
  )();
  it("the groomer's key, the desk's key, and neither", () => {
    expect(writer(["operations.perform_service"])).toBe(true);
    expect(writer(["appointments.edit"])).toBe(true);
    expect(writer(["appointments.view"])).toBe(false);
  });
});

// ─── B · customers.contact_info ─────────────────────────────────────────────────────────────

describe("B: the client editor without customers.contact_info", () => {
  const field = (name: string) => `<label data-field="${name}"></label>`;
  const basic = (permissions: string[], customer: Record<string, unknown>) => build<(record: unknown) => string>(
    ["contactInfoAllowed", "contactInfoVisible", "clientBasicSectionMarkup"],
    { allowed: (key: string) => permissions.includes(key), field, escape },
    "clientBasicSectionMarkup"
  )(customer);

  it("draws email and phone with the key on a record that was not withheld", () => {
    const html = basic(["customers.contact_info"], { firstName: "Emma", email: "e@x.example", phone: "626", contactWithheld: false });
    expect(html).toContain('data-field="email"');
    expect(html).toContain('data-field="phone"');
  });

  it("draws neither without the key or on a withheld record, so the PUT never carries them", () => {
    for (const html of [
      basic([], { firstName: "Emma", email: null, phone: null, contactWithheld: true }),
      basic(["customers.contact_info"], { firstName: "Emma", email: null, phone: null, contactWithheld: true })
    ]) {
      expect(html).not.toContain('data-field="email"');
      expect(html).not.toContain('data-field="phone"');
      expect(html).toContain('data-field="firstName"');
    }
  });
});

// ─── Visual round · status labels, Move ─────────────────────────────────────────────────────

describe("one status label", () => {
  it("reads the sentence-case label from the one map, and degrades to the words", () => {
    const label = build<(status: string) => string>(["appointmentStatusLabel"], {
      APPOINTMENT_BADGES: { checked_in: ["CHK", "Checked in"], in_service: ["SVC", "In service"], no_show: ["NOS", "No show"] }
    }, "appointmentStatusLabel");
    expect(label("checked_in")).toBe("Checked in");
    expect(label("in_service")).toBe("In service");
    expect(label("no_show")).toBe("No show");
    expect(label("mystery_state")).toBe("mystery state");
  });
});

describe("Move with nothing changed sends nothing", () => {
  const unchanged = build<(form: unknown, appointment: unknown, current: string) => boolean>(["moveUnchanged"], {}, "moveUnchanged");
  const appointment = { employeeId: "e1", scheduledDisambiguation: null };
  it("same start, groomer and occurrence is unchanged", () => {
    expect(unchanged(form({ startAt: "2026-10-09T10:00", employeeId: "e1" }), appointment, "2026-10-09T10:00")).toBe(true);
  });
  it("a new time, a new groomer or a chosen occurrence is a move", () => {
    expect(unchanged(form({ startAt: "2026-10-09T10:30", employeeId: "e1" }), appointment, "2026-10-09T10:00")).toBe(false);
    expect(unchanged(form({ startAt: "2026-10-09T10:00", employeeId: "e2" }), appointment, "2026-10-09T10:00")).toBe(false);
    expect(unchanged(form({ startAt: "2026-10-09T10:00", employeeId: "e1", disambiguation: "later" }), appointment, "2026-10-09T10:00")).toBe(false);
  });
});

// ─── The full-screen Receipt ───────────────────────────────────────────────────────────────

describe("the Receipt opens full screen, closes back, and prints only its paper", () => {
  function harness() {
    const printed: Array<{ className: string; innerHTML: string }> = [];
    const prints = { count: 0 };
    const nodes: Record<string, { textContent?: string; innerHTML?: string }> = {
      "#receipt-document-title": { textContent: "" },
      "#receipt-document-paper": { innerHTML: "" }
    };
    const buttons: Record<string, { onclick: null | (() => void) }> = {};
    const state = { open: false, focused: "" };
    const listeners: Array<() => void> = [];
    const dialog = {
      querySelector(selector: string) {
        const id = /data-testid="([^"]+)"/u.exec(selector)![1]!;
        return buttons[id] ?? (buttons[id] = { onclick: null });
      },
      addEventListener(_type: string, listener: () => void) { listeners.push(listener); },
      showModal() { state.open = true; },
      close() { state.open = false; listeners.splice(0).forEach((listener) => listener()); }
    };
    const source = { isConnected: true, focus() { state.focused = "Print Receipt"; } };
    const open = build<(receipt: unknown) => void>(
      ["appendPrintRoot", "openReceiptDocument"],
      {
        $: (selector: string) => (selector === "#receipt-document" ? dialog : nodes[selector]),
        document: {
          activeElement: source,
          createElement: () => ({ className: "", innerHTML: "", remove() {} }),
          body: { append(node: { className: string; innerHTML: string }) { printed.push(node); } }
        },
        globalThis: { print() { prints.count += 1; } },
        setTimeout: () => 0,
        paymentReceiptTitle: () => "Receipt #INV-1042",
        paymentReceiptMarkup: () => '<div class="wide payment-receipt" data-testid="payment-receipt">«paper»</div>'
      },
      "openReceiptDocument"
    );
    return { open, printed, prints, nodes, buttons, state };
  }

  it("opens over the screen it was pressed from, titled by the receipt, with the paper on it", () => {
    const h = harness();
    h.open({});
    expect(h.state.open).toBe(true);
    expect(h.nodes["#receipt-document-title"]!.textContent).toBe("Receipt #INV-1042");
    expect(h.nodes["#receipt-document-paper"]!.innerHTML).toContain("«paper»");
    expect(h.printed).toHaveLength(0);
  });

  it("× closes it back to the control it was opened from, printing nothing", () => {
    const h = harness();
    h.open({});
    h.buttons["receipt-document-close"]!.onclick!();
    expect(h.state.open).toBe(false);
    expect(h.state.focused).toBe("Print Receipt");
    expect(h.prints.count).toBe(0);
  });

  it("Print hands exactly the paper to the browser's print, as the Receipt's print root", () => {
    const h = harness();
    h.open({});
    h.buttons["receipt-document-print"]!.onclick!();
    expect(h.prints.count).toBe(1);
    expect(h.printed).toEqual([expect.objectContaining({
      className: "print-root print-payment-receipt",
      innerHTML: '<div class="wide payment-receipt" data-testid="payment-receipt">«paper»</div>'
    })]);
  });
});
