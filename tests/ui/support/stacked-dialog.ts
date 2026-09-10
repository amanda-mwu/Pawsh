import { readFileSync } from "node:fs";

/**
 * A FAKE `#stacked-dialog`, GOOD ENOUGH TO RUN THE REAL ONE AGAINST.
 *
 * Two defects were fixed by taking work off the BROWSER'S own dialogs — `prompt`, `confirm` and
 * the print dialog — and giving it to Pawsh's `#stacked-dialog`. Neither fix can be tested by
 * looking at `public/app.js`: what matters is whether a request is sent, whether a document
 * reaches paper, and which press does it. So `openStackedDialog` itself is EXECUTED here, against
 * a dialog that records rather than renders.
 *
 * `public/app.js` is served as a plain module with no bundler and has top-level side effects that
 * need a real document, so the regions under test are sliced out by their own declarations and
 * evaluated with `new Function` — the harness `tests/ui/payment-receipt.test.ts` and
 * `tests/ui/business-settings.test.ts` already use. The stubs are handed in as PARAMETERS rather
 * than written into the evaluated source, so they stay ordinary typed objects a test can read.
 *
 * THE ONE DISCIPLINE THIS FAKE KEEPS. `querySelector` on the dialog body answers for a hook ONLY
 * when the markup the dialog was handed actually contains it, and returns null otherwise — which
 * is what makes "the field is still in the body" and "the warning is still in the body" real
 * assertions instead of assertions about a stub. A selector the fake does not model throws, so a
 * client that starts reaching for something new is reported rather than silently given null.
 */
const source = readFileSync("public/app.js", "utf8");

/** One region of the client, by the declarations that bound it. */
export function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** A control inside the dialog body. Only the properties the client actually touches. */
export interface StubField {
  value: string;
  checked: boolean;
  textContent: string;
}

/** One `.print-root` the client appended to the body. */
export interface PrintedRoot {
  className: string;
  innerHTML: string;
}

/** What a dialog looked like at the moment it was shown. */
export interface DialogRecord {
  title: string;
  body: string;
  confirmLabel: string;
  confirmHidden: boolean;
  dismissLabel: string;
  /** The accessible name of the head X, or null when the dialog did not ask for one. */
  headCloseLabel: string | null;
}

export interface DialogHarness {
  /** Every dialog shown, in order, as it stood when `showModal()` ran. */
  opens: DialogRecord[];
  /** The one currently on screen, or null. */
  current(): DialogRecord | null;
  /** Whether a dialog is on screen at all. */
  isOpen(): boolean;
  /** A control inside the open dialog's body — null when the markup does not render it. */
  field(selector: string): StubField | null;
  /** Press the confirm button. */
  confirm(): Promise<void>;
  /** Press the dismiss button. */
  dismiss(): Promise<void>;
  /** Press the head X. Throws when the dialog did not draw one. */
  headClose(): Promise<void>;
  /** Escape, or any other native dismissal the browser performs on the element itself. */
  escape(): void;
  /** Every `.print-root` appended to the body, in order. */
  printed: PrintedRoot[];
  /** How many times the client asked the browser to print. */
  prints: { count: number };
  /** Everything said in a toast. */
  toasts: string[];
  /** Deferred work the client queued with `setTimeout`, un-run until `runTimers()`. */
  timers: (() => void)[];
  /** Runs, and clears, whatever the client deferred. */
  runTimers(): void;
  /** The stubs, by the parameter names the evaluated source expects. */
  stubs: Record<string, unknown>;
}

interface StubElement {
  type: string;
  className: string;
  innerHTML: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  onclick: (() => void) | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/** Does the markup the dialog was handed actually render this hook? */
function bodyRenders(markup: string, selector: string): boolean {
  const named = /^\[name="([^"]+)"\]$/u.exec(selector);
  if (named) return markup.includes(`name="${named[1]}"`);
  const testid = /^\[data-testid="([^"]+)"\]$/u.exec(selector);
  if (testid) return markup.includes(`data-testid="${testid[1]}"`);
  const className = /^\.([a-z-]+)$/u.exec(selector);
  if (className) return new RegExp(`class="[^"]*\\b${className[1]}\\b`, "u").test(markup);
  throw new Error(`the fake dialog body was asked for ${selector}, which it does not model`);
}

export function dialogHarness(): DialogHarness {
  const opens: DialogRecord[] = [];
  const printed: PrintedRoot[] = [];
  const prints = { count: 0 };
  const toasts: string[] = [];
  const timers: (() => void)[] = [];

  let title = "";
  let body = "";
  let open = false;
  let headCloseLabel: string | null = null;
  let headClosePress: (() => void) | null = null;
  let fields = new Map<string, StubField>();

  const confirmButton = { hidden: false, textContent: "", disabled: false,
    onclick: null as null | (() => Promise<void> | void) };
  const dismissButton = { textContent: "", onclick: null as null | (() => void) };

  const element = (tag: string): StubElement => ({
    type: tag,
    className: "",
    innerHTML: "",
    dataset: {},
    attributes: {},
    onclick: null,
    setAttribute(name, value) { this.attributes[name] = value; },
    // `appendPrintRoot` tears its root down a second later. A real timer here would outlive the
    // run, so the teardown is recorded in `timers` and the removal itself is a no-op.
    remove() { /* the recorded roots are the assertion; nothing is torn down here */ }
  });

  const titleNode = {
    // Assigning the heading's text is also what clears the previous dialog's head X. The fake
    // reproduces that, because "the X cannot outlive the dialog that asked for it" is asserted.
    set textContent(value: string) { title = value; headCloseLabel = null; headClosePress = null; },
    get textContent() { return title; },
    append(node: StubElement) {
      if (node.dataset.testid !== "stacked-dialog-close") {
        throw new Error(`the fake dialog head was handed ${node.dataset.testid ?? "an unnamed node"}`);
      }
      headCloseLabel = node.attributes["aria-label"] ?? null;
      headClosePress = node.onclick;
    }
  };

  const bodyNode = {
    set innerHTML(value: string) { body = value; fields = new Map(); },
    get innerHTML() { return body; },
    querySelector(selector: string): StubField | null {
      if (!bodyRenders(body, selector)) return null;
      let node = fields.get(selector);
      if (!node) { node = { value: "", checked: false, textContent: "" }; fields.set(selector, node); }
      return node;
    }
  };

  const dialogNode = {
    showModal() {
      open = true;
      opens.push({ title, body, confirmLabel: confirmButton.textContent,
        confirmHidden: confirmButton.hidden, dismissLabel: dismissButton.textContent,
        headCloseLabel });
    },
    close() { open = false; }
  };

  const $ = (selector: string): unknown => {
    if (selector === "#stacked-dialog") return dialogNode;
    if (selector === "#stacked-dialog-title") return titleNode;
    if (selector === "#stacked-dialog-body") return bodyNode;
    if (selector === '[data-testid="stacked-dialog-confirm"]') return confirmButton;
    if (selector === '[data-testid="stacked-dialog-dismiss"]') return dismissButton;
    throw new Error(`the fake document was asked for ${selector}, which it does not model`);
  };

  const documentStub = {
    createElement: (tag: string) => element(tag),
    body: { append(node: StubElement) { printed.push(node); } }
  };

  return {
    opens,
    current: () => (open ? opens.at(-1) ?? null : null),
    isOpen: () => open,
    field: (selector) => bodyNode.querySelector(selector),
    confirm: async () => { await confirmButton.onclick?.(); },
    dismiss: async () => { dismissButton.onclick?.(); },
    headClose: async () => {
      if (!headClosePress) throw new Error("this dialog drew no head close control");
      headClosePress();
    },
    // The browser closes the element itself on Escape; nothing the client wrote runs.
    escape: () => { dialogNode.close(); },
    printed,
    prints,
    toasts,
    timers,
    runTimers: () => { const queued = timers.splice(0); for (const task of queued) task(); },
    stubs: {
      $,
      document: documentStub,
      globalThis: { print() { prints.count += 1; } },
      setTimeout: (task: () => void) => { timers.push(task); return 0; },
      toast: (message: string) => { toasts.push(message); }
    }
  };
}

/**
 * Evaluates sliced client source against the harness's stubs plus whatever else the region needs.
 *
 * The stub names are parameters of the generated function, so the sliced source sees them as
 * ordinary bindings and the test still holds the objects.
 */
export function evaluate<T>(regions: string[], scope: Record<string, unknown>, exported: string): T {
  const names = Object.keys(scope);
  const factory = new Function(...names, [...regions, exported].join("\n")) as (
    ...args: unknown[]
  ) => T;
  return factory(...names.map((name) => scope[name]));
}
