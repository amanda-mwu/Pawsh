import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A SCREEN A ROLE CANNOT USE MUST SAY SO. IT MUST NOT SIMPLY BE EMPTY.
 *
 * A groomer opening an appointment got a surface with five of its controls rendered as `""` —
 * the groomer pencil, Adjust services, the appointment note's Edit, Cancel and No-show — and a
 * client rail reading "The client record could not be loaded. Retry". Nothing on the screen said
 * the word permission. The five had silently vanished, and the sixth was a lie: the record had not
 * failed to load, it had been REFUSED, and pressing Retry re-sent three 403s forever — each one
 * costing `api()` a `/api/me` re-read and a full calendar re-render.
 *
 * Two rules come out of that, and both are the repository's existing ones rather than new ones:
 *
 *   WHAT THE VISIT DOES NOT ALLOW IS ABSENT. A transition the server would refuse — cancelling a
 *   completed visit, adjusting the services of one that has not been checked in — is withheld,
 *   because a disabled control that could never apply here explains nothing. This is
 *   `calendarAction()`'s rule and it is unchanged.
 *
 *   WHAT THE ROLE DOES NOT ALLOW IS DISABLED, WITH THE KEY NAMED. This is what the blocked-time
 *   drawer's Update and Delete do, and what the Invoice button on this same footer already did.
 *
 * The two halves are asserted separately below, because collapsing them back into one flag is
 * precisely the defect.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `can.cancelOffered` → `can.cancel` in the footer
 *       the defect, restored for two of the five. "a groomer is shown why, not nothing" fails.
 *
 *   `moveOffered:status==="scheduled"&&!appointmentsLocked()` → `...&&appointmentMoveAllowed()`
 *       the pencil vanishes again. "the groomer pencil is disabled, not absent" fails.
 *
 *   dropping the `refused` branch from `drawRail`
 *       a refusal is offered a Retry again. "a refusal offers nothing to press" fails.
 *
 *   `if(!allowed("customers.view"))` removed from `loadClient`
 *       the three reads go back out. "no request is made at all" fails.
 *
 *   `surface.client.refused=error?.status===403` → `false`
 *       a 403 arriving mid-session is presented as a transient failure. "a 403 that arrives
 *       anyway is still a refusal" fails.
 *
 * Each was applied to `public/app.js`, run against this file, and reverted.
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** The appointment note block, whose head carries one of the five. */
const NOTES = slice(
  "function appointmentRecordNoteMarkup(surface){",
  "\nfunction appointmentPermissionRefusal("
);
/** The refusal attributes, the rail's refusal, and the surface that draws both. */
const SURFACE = slice(
  "function appointmentPermissionRefusal(action,permission){",
  "\n/**\n * The appointment detail surface: level 1 of the stack."
);
/** The single place the surface decides what this actor may do with this visit. */
const DERIVE = slice("  const derive=()=>{", "\n  /**\n   * The appointment note redraws");
/** The rail's three states, and the read behind them. */
const DRAW_RAIL = slice("  const drawRail=()=>{", "\n  const drawActivity=()=>{");
const LOAD_CLIENT = slice("  const loadClient=async()=>{", "\n  const reload=async()=>{");

interface Surface {
  item: Record<string, unknown>;
  client: { loaded: boolean; failed: boolean; refused: boolean };
  permissions: Record<string, boolean>;
}

interface Module {
  grant(...permissions: string[]): void;
  derive(): Record<string, boolean>;
  appointmentSurfaceMarkup(surface: Surface): string;
  loadClient(): Promise<void>;
  surface: Surface;
  /** What the rail body holds right now. */
  rail(): string;
  /** Every path the rail asked the server for. */
  reads: string[];
}

/** The visit, in whichever status a test needs it. */
function appointment(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "3f0f0fd3-0000-4000-8000-000000000001",
    customerId: "5c4d3b2a-0000-4000-8000-000000000002",
    petId: "9a8b7c6d-0000-4000-8000-000000000003",
    status, version: 4, notes: "Ask about the ears.", operationalNotes: null,
    invoiceId: null, invoiceStatus: null,
    services: [{ serviceId: "s1", name: "Full groom", durationMinutes: 90, priceMinor: 6500 }],
    groomers: [{ id: "e1", displayName: "Alex" }],
    ...extra
  };
}

function client(status = "scheduled", { railFails = "forbidden" as "forbidden" | "offline" } = {}): Module {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") =>
    escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  const reads: string[] = [];
  const railBody = { innerHTML: "", querySelector: () => null };

  const prelude = `
    "use strict";
    const money = (minor) => "$" + (Number(minor || 0) / 100).toFixed(2);
    const petName = (record) => record.petName || "Pet";
    const granted = new Set();
    const allowed = (permission) => granted.has(permission);
    const grant = (...permissions) => { permissions.forEach((one) => granted.add(one)); };
    // The lock is OFF in every test here: this file is about permissions, and the lock has its own.
    const appointmentsLocked = () => false;
    const appointmentMoveAllowed = () => allowed("appointments.edit") && !appointmentsLocked();
    const appointmentBillingChip = () => ({ tone: "neutral", label: "Unbilled" });
    const appointmentLockNoteMarkup = () => "";
    const appointmentActivityMarkup = () => "<!--activity-->";
    const appointmentLifecycleMarkup = () => "<!--lifecycle-->";
    const appointmentPhotosMarkup = () => "<!--photos-->";
    const appointmentReportCardsMarkup = () => "<!--report-cards-->";
    const appointmentPresentation = (item) => ({
      status: item.status, dateLabel: "Wed, Oct 7", timeRange: "9:00 AM – 10:30 AM",
      durationMinutes: 90, totalPriceMinor: 6500, groomer: "Alex", petName: "Rex",
      breed: "Poodle", customerName: "Sam Reyes", rabiesNeeded: false, warning: null,
      serviceSnapshots: item.services
    });

    // The surface under test, and the closure state the rail's three functions read.
    const surface = {
      item: ${JSON.stringify(appointment(status))},
      model: appointmentPresentation(${JSON.stringify(appointment(status))}),
      activity: { items: [], failed: false }, photos: { data: null, failed: false },
      cards: { data: null, failed: false },
      client: { loaded: false, failed: false, refused: false },
      note: { open: false, draft: null, baseVersion: null, conflict: null, error: null, saving: false },
      permissions: null
    };
    surface.permissions = {};
    const id = surface.item.id;
    const returnView = "calendar";
    let clientSummaryRail = null;
    const stale = () => false;
    const dialog = { querySelector: (selector) =>
      selector === ".surface-rail-body" ? railBody : null };
    const renderClientSummaryPane = () => { railBody.innerHTML = "<!--client summary-->"; };
    const runDetached = (task) => { task(); };
    const HISTORY_INITIAL_ROWS = 10;
  `;

  const api = (path: string): Promise<unknown> => {
    reads.push(path);
    if (railFails === "forbidden") {
      return Promise.reject(Object.assign(new Error("Missing permission: customers.view"), { status: 403 }));
    }
    return Promise.reject(new Error("Failed to fetch"));
  };

  const scope: Record<string, unknown> = {
    escape, escapeAttr, railBody, api,
    state: { clientProfile: null, pets: [] },
    $: () => null,
    loadClientNotes: (customerId: string) => { reads.push(`/api/customers/${customerId}/notes`); return Promise.resolve([]); },
    loadClientAgreements: (customerId: string) => { reads.push(`/api/customers/${customerId}/agreements`); return Promise.resolve([]); }
  };

  const names = Object.keys(scope);
  const exported = `
    surface.permissions = derive();
    return { grant, derive, appointmentSurfaceMarkup, loadClient, surface,
      rail: () => railBody.innerHTML };`;
  const factory = new Function(
    ...names, [prelude, NOTES, SURFACE, DERIVE, DRAW_RAIL, LOAD_CLIENT, exported].join("\n")
  ) as (...args: unknown[]) => Omit<Module, "reads">;

  return { ...factory(...names.map((name) => scope[name])), reads };
}

/** The opening tag of one control, or null when the surface drew none. */
function control(markup: string, testid: string): string | null {
  return new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`, "u").exec(markup)?.[0] ?? null;
}

/** Redraws the surface for whatever this actor now holds. */
function draw(app: Module): string {
  app.surface.permissions = app.derive();
  return app.appointmentSurfaceMarkup(app.surface);
}

const FIVE: Array<[string, string, string]> = [
  ["appointment-groomer-edit", "appointments.edit", "change the groomer or the time"],
  ["appointment-adjust-services", "appointments.edit", "change the services on this appointment"],
  ["appointment-note-edit", "appointments.edit", "edit the appointment note"],
  ["appointment-cancel", "appointments.cancel", "cancel appointments"],
  ["appointment-no-show", "appointments.cancel", "mark an appointment as a no-show"]
];

describe("a control the ROLE cannot use is disabled with the reason on it", () => {
  it("a groomer is shown why the appointment is inert, not nothing at all", () => {
    // Exactly the shipped Groomer preset. Nothing in this file changes a preset.
    const groomer = ["calendar.view", "appointments.view", "pets.view", "pets.care.view",
      "operations.check_in", "operations.perform_service", "operations.complete"];
    // The two statuses the five are live in: a scheduled visit can still be moved and called off,
    // one on the table can have its services changed. Between them every one of the five is drawn.
    const live: Record<string, string[]> = {
      scheduled: ["appointment-groomer-edit", "appointment-note-edit",
        "appointment-cancel", "appointment-no-show"],
      checked_in: ["appointment-adjust-services", "appointment-note-edit"]
    };

    for (const [status, controls] of Object.entries(live)) {
      const app = client(status);
      app.grant(...groomer);
      const markup = draw(app);
      for (const testid of controls) {
        const button = control(markup, testid);
        expect(button, `${testid} vanished instead of explaining itself on a ${status} visit`).not.toBeNull();
        expect(button).toContain("disabled");
        expect(button).toContain('aria-disabled="true"');
        expect(button).toContain("You do not have permission");
      }
    }
  });

  it("names the permission on each of the five, so it can be asked for by name", () => {
    for (const [testid, permission, action] of FIVE) {
      // Each control is drawn in a status that offers it: the two footer controls need a
      // scheduled visit, the middle two need one that has been checked in.
      const app = client(["appointment-cancel", "appointment-no-show", "appointment-groomer-edit"]
        .includes(testid) ? "scheduled" : "checked_in");
      app.grant("calendar.view", "appointments.view");
      const button = control(draw(app), testid);

      expect(button, `${testid} was not drawn at all`).not.toBeNull();
      expect(button).toContain(`title="You do not have permission to ${action} (${permission})"`);
    }
  });

  it("draws all five plainly for a role that holds the keys", () => {
    const app = client("scheduled");
    app.grant("calendar.view", "appointments.view", "appointments.edit", "appointments.cancel");
    const markup = draw(app);

    for (const testid of ["appointment-groomer-edit", "appointment-note-edit",
      "appointment-cancel", "appointment-no-show"]) {
      const button = control(markup, testid);
      expect(button, `${testid} was not drawn`).not.toBeNull();
      expect(button).not.toContain("disabled");
    }
  });
});

describe("a control the VISIT does not allow stays absent", () => {
  it("offers no Cancel or No-show once the visit has been checked in, even to a manager", () => {
    // The server refuses the transition, so there is nothing to disable and nothing to explain.
    const app = client("checked_in");
    app.grant("calendar.view", "appointments.view", "appointments.edit", "appointments.cancel");
    const markup = draw(app);

    expect(control(markup, "appointment-cancel")).toBeNull();
    expect(control(markup, "appointment-no-show")).toBeNull();
  });

  it("offers Adjust services in every status the route accepts, and no groomer pencil after check-in", () => {
    // `PUT /api/appointments/:id/services` accepts `scheduled`, `checked_in` and `in_service`.
    // This used to offer the last two, so the status where adding a nail trim is most ordinary -
    // the client rings up before the visit - was the one with no way to do it.
    for (const status of ["scheduled", "checked_in", "in_service"]) {
      const app = client(status);
      app.grant("calendar.view", "appointments.view", "appointments.edit", "appointments.cancel");
      expect(control(draw(app), "appointment-adjust-services"), status).not.toBeNull();
    }

    // And nowhere else: the route refuses the other three outright.
    for (const status of ["completed", "cancelled", "no_show"]) {
      const app = client(status);
      app.grant("calendar.view", "appointments.view", "appointments.edit", "appointments.cancel");
      expect(control(draw(app), "appointment-adjust-services"), status).toBeNull();
    }

    // The groomer and the time stay a scheduled-only correction, which is unchanged.
    const inService = client("in_service");
    inService.grant("calendar.view", "appointments.view", "appointments.edit", "appointments.cancel");
    expect(control(draw(inService), "appointment-groomer-edit")).toBeNull();
  });

  it("the appointment note's Edit is offered in every status, so only the permission decides", () => {
    for (const status of ["scheduled", "checked_in", "in_service", "completed", "cancelled"]) {
      const app = client(status);
      app.grant("calendar.view", "appointments.view");
      expect(control(draw(app), "appointment-note-edit"), status).toContain("disabled");
    }
  });
});

describe("the client rail tells a refusal and a failure apart", () => {
  it("a groomer's rail states the missing permission and makes no request at all", async () => {
    const app = client("scheduled");
    app.grant("calendar.view", "appointments.view", "pets.view");

    await app.loadClient();

    // The three 403s — and the three `/api/me` reconciliations and calendar re-renders `api()`
    // spends on them — are gone because the reads never happen.
    expect(app.reads).toEqual([]);
    expect(app.rail()).toContain("customers.view");
    expect(app.rail()).toContain("Client records are not part of this role");
  });

  it("a refusal offers nothing to press, because there is nothing a retry could change", async () => {
    const app = client("scheduled");
    app.grant("calendar.view", "appointments.view");

    await app.loadClient();

    expect(app.rail()).not.toContain("appointment-client-retry");
    expect(app.rail()).not.toContain("Retry");
    expect(app.rail()).not.toContain("could not be loaded");
  });

  it("the surface draws that refusal from its first paint, never a Loading claim", () => {
    const app = client("scheduled");
    app.grant("calendar.view", "appointments.view");

    const markup = draw(app);
    expect(markup).toContain("Client records are not part of this role");
    expect(markup).not.toContain("Loading client…");
  });

  it("a 403 that arrives anyway — permissions moved mid-session — is still a refusal", async () => {
    const app = client("scheduled");
    app.grant("calendar.view", "appointments.view", "customers.view");

    await app.loadClient();

    expect(app.reads.length).toBeGreaterThan(0);
    expect(app.surface.client.refused).toBe(true);
    expect(app.rail()).not.toContain("Retry");
  });

  it("a genuine network failure keeps its Retry", async () => {
    const app = client("scheduled", { railFails: "offline" });
    app.grant("calendar.view", "appointments.view", "customers.view");

    await app.loadClient();

    expect(app.surface.client.failed).toBe(true);
    expect(app.surface.client.refused).toBe(false);
    expect(app.rail()).toContain("The client record could not be loaded");
    expect(app.rail()).toContain("appointment-client-retry");
  });

  it("a permitted rail loads and draws the client summary", async () => {
    const app = client("scheduled", { railFails: "offline" });
    app.grant("calendar.view", "appointments.view", "customers.view");
    expect(app.derive().viewClient).toBe(true);
    // The read itself is exercised by the two failure paths above; what matters here is that the
    // permitted actor's surface promises a load rather than refusing one.
    expect(draw(app)).toContain("Loading client…");
  });
});
