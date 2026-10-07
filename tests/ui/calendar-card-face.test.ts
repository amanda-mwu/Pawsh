import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * QA-CAL-08 · THE CALENDAR CARD READS LIKE THE BOOK.
 *
 * Human QA found the day view at 1280 crowded and the short second card of an overlap nearly
 * empty. The card face is now: a strip (time, notes icon, status code chip, safety flags), then the
 * pet, the breed on its own line and every service - no client and no care notes, which the hover
 * card and the visit carry. Height decides how much shows: a short visit is its strip. The hover card
 * reads Status, the day and start, Client, Pet & Services, Groom by and Created at.
 *
 * `appointmentCard` and `appointmentHoverDetails` run here as written - sliced out of
 * `public/app.js` - against the smallest fakes they need. What only a browser can answer (the
 * wrap, the clip, the chip surviving a 60px lane) is measured in the calendar e2e specs.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ───────────────────────────────────────────────────────────
 *
 *   the client name back on the card face                  "the face is pet, breed and services"
 *   the add-on limit / "+N more" back                       "every service is listed"
 *   an add-on visit forced to an empty strip at any height "every visit gets the full face"
 *   the accessible name losing the client or the status    "the face is pet, breed and services"
 *   the hover out of the book's order, or a phone in it     "the hover reads in the book's order"
 */
const source = readFileSync("public/app.js", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

const PRESENTATION = slice("const ADD_ON_SERVICE_CATEGORIES=", "\n/**\n * THE CARD'S OVERFLOW MENU");
const CARD = slice("function appointmentCard(item,", "\n// == Blocked time on the grid");

const escape = (value: unknown = "") =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const clock = (value: Date) => value.toISOString().slice(11, 16);

interface Service { id: string; category: string }
interface Module {
  appointmentCard(item: Record<string, unknown>, options?: Record<string, unknown>): string;
  appointmentHoverDetails(model: unknown, badges: unknown): string;
  appointmentBadges(item: Record<string, unknown>): unknown;
  appointmentPresentation(item: Record<string, unknown>): unknown;
}

function load(services: Service[]): Module {
  const scope: Record<string, unknown> = {
    state: { services, employees: [] },
    escape,
    petName: (record: { petName?: string }) => record.petName || "Unnamed pet",
    clientName: (record: { customerName?: string }) => record.customerName,
    formatPrefTime: clock,
    formatPrefWeekdayLongMonthDay: () => "Tuesday, October 6",
    formatPrefDateAndTime: (value: Date) => `10/06/2026 ${clock(value)}`,
    compactTimeRange: (start: Date, end: Date) => `${clock(start)}–${clock(end)}`,
    appointmentLocalValue: (item: { startAt: string }) => item.startAt.slice(0, 16),
    schedulingZone: () => "UTC",
    money: (minor: number) => `$${(minor / 100).toFixed(2)}`,
    calendarDragAvailable: () => false,
    scopeAllows: () => true,
    groomerColorSlot: () => 0,
    safetyContext: () => "",
    calendarAction: () => ""
  };
  const names = Object.keys(scope);
  const body = `${PRESENTATION}\n${CARD}\nreturn { appointmentCard, appointmentHoverDetails, appointmentPresentation, appointmentBadges };`;
  return (new Function(...names, body) as (...args: unknown[]) => Module)(...names.map((name) => scope[name]));
}

const SERVICES: Service[] = [
  { id: "bath", category: "DOG_BASE" },
  { id: "nails", category: "A_LA_CARTE" },
  { id: "teeth", category: "DOG_ADDON" },
  { id: "ears", category: "A_LA_CARTE" }
];

function visit(services: Array<[string, string]>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "visit-1", status: "scheduled", startAt: "2026-10-06T14:00:00.000Z", endAt: "2026-10-06T15:00:00.000Z",
    createdAt: "2026-10-01T09:15:00.000Z", petName: "Mochi", breed: "Shih Tzu", customerName: "Sophia Chen",
    groomers: [{ displayName: "Gabriel Groomer" }],
    services: services.map(([serviceId, name]) => ({ serviceId, name, durationMinutes: 15, priceMinor: 1000 })),
    behaviorNotes: "Nervous around dryers", coatNotes: "Matted ears",
    ...extra
  };
}

/** The text a sighted reader gets from a fragment: tags dropped, entities decoded. */
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replaceAll("&amp;", "&").replace(/\s+/gu, " ").trim();
const button = (html: string) => /<button type="button" class="calendar-open"[^>]*>([\s\S]*?)<\/button>/u.exec(html)![1]!;

describe("the card face", () => {
  const app = load(SERVICES);

  it("the face is pet, breed and services; the client and the care notes are not on it", () => {
    const card = app.appointmentCard(visit([["bath", "Bath"], ["nails", "Nail Trim"]]));
    const face = button(card);
    expect(text(face)).toBe("Mochi Shih Tzu Bath Nail Trim");
    expect(face).not.toContain("Sophia Chen");
    expect(card).not.toContain("appointment-client");
    expect(card).not.toContain("Nervous around dryers");
    // The accessible name still says the client and the status.
    expect(card).toContain('aria-label="14:00–15:00, Mochi, Shih Tzu, Sophia Chen, Bath, Nail Trim, scheduled"');
  });

  it("every service is listed, the card's height decides how many read", () => {
    const card = app.appointmentCard(visit([["bath", "Bath"], ["nails", "Nail Trim"], ["teeth", "Teeth Brushing"], ["ears", "Ear Cleaning"]], {
      endAt: "2026-10-06T14:20:00.000Z"
    }));
    expect(text(button(card))).toBe("Mochi Shih Tzu Bath Nail Trim Teeth Brushing Ear Cleaning");
    expect(card).not.toMatch(/more<\/small>/u);
  });

  it("every card carries its status code chip, a 15-minute one too", () => {
    const card = app.appointmentCard(visit([["bath", "Bath"]], { endAt: "2026-10-06T14:15:00.000Z" }));
    expect(card).toContain("density-brief");
    expect(card).toMatch(/<span class="appointment-badge badge-scheduled" role="img" aria-label="Scheduled">.*<span class="badge-code">SCH<\/span>/u);
  });

  it("every visit gets the full face, add-ons alone included; height alone decides how much shows", () => {
    const addOns = app.appointmentCard(visit([["ears", "Ear Cleaning"], ["nails", "Nail Trim"]]));
    expect(addOns).toContain('class="appointment-pet"');
    expect(addOns).toContain("Ear Cleaning");
    expect(addOns).toContain('aria-label="14:00–15:00, Mochi, Shih Tzu, Sophia Chen, Ear Cleaning, Nail Trim, scheduled"');
  });
});

describe("the hover card", () => {
  const app = load(SERVICES);
  // The same pair `showCalendarHover` hands it: the presentation and the card's own chip.
  const hoverOf = (item: Record<string, unknown>) => app.appointmentHoverDetails(app.appointmentPresentation(item), app.appointmentBadges(item));

  it("reads in the book's order: status, day and start, client, pet & services, groomer, created", () => {
    const hover = hoverOf(visit([["bath", "Bath"], ["nails", "Nail Trim"]]));
    expect(text(hover)).toBe(
      "Status: SCH Scheduled Tuesday, October 6 · 14:00 Client: Sophia Chen Pet & Services: Mochi : Bath, Nail Trim "
      + "Groom by Gabriel Groomer Created at 10/06/2026 09:15"
    );
    expect(hover).toContain('<span class="appointment-badge badge-scheduled">SCH</span>');
  });

  it("an invoiced visit shows the payment chip, and no contact detail ever reaches the hover", () => {
    const hover = hoverOf(visit([["bath", "Bath"]], {
      status: "completed", invoiceStatus: "paid", customerPhone: "555-0100", customerEmail: "client@example.test"
    }));
    expect(text(hover)).toMatch(/^Status: PAI Paid /u);
    expect(hover).not.toContain("555-0100");
    expect(hover).not.toContain("client@example.test");
  });

  it("a visit without a created stamp prints no Created line rather than an empty one", () => {
    const hover = hoverOf(visit([["bath", "Bath"]], { createdAt: undefined }));
    expect(hover).not.toContain("Created at");
  });
});
