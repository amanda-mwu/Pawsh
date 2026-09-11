import { describe, expect, it } from "vitest";
import { evaluate, slice } from "./support/stacked-dialog.js";

/**
 * THE PRINTED TICKET IS A NARROWER DOCUMENT THAN THE TICKET ON SCREEN, AND THIS FILE IS THE LINE.
 *
 * The Ticket is the salon's own work sheet, so for a long time the sheet on screen and the sheet on
 * paper were the same markup with nothing withheld: `ticketDocumentMarkup`, one function, two
 * hosts. Three notes on screen, the same three on paper.
 *
 * They are no longer the same document. A SCREEN IS READ BY WHOEVER IS SIGNED IN, AT A DESK, FOR
 * AS LONG AS THE DIALOG IS OPEN. A printed sheet is clipped to a run, carried around the salon,
 * set down on a bench, taken out to a van and eventually thrown away, and nothing about that life
 * is controlled by a permission. So the printed projection now carries the APPOINTMENT note - the
 * one of the three that is a fact about this visit - and withholds the pet's and the client's note
 * threads, which are the salon's standing record of an animal and a household.
 *
 * ─── WHAT THIS FILE IS REALLY FOR ────────────────────────────────────────────────────────────
 *
 * Not "the rows were removed" - a single deleted line would satisfy that and would go on
 * satisfying it while somebody quietly piped a safety alert into the services table next month.
 * What is asserted here is the BOUNDARY: the fixture carries EVERY note-shaped field Pawsh has -
 * appointment note, service note, pet note thread, client note thread, the five pet-care fields,
 * and a pinned ("popup") flag - each with its own sentinel string, and the printed markup is
 * asserted NOT to contain any of them BY NAME as well as by value. A leak through a `data-`
 * attribute, a `title`, an `aria-label` or an accessible name fails these assertions exactly as a
 * visible table cell does, because the assertion is against the markup string and not against a
 * rendered view of it.
 *
 * The on-screen projection is asserted in the same breath, from the same fixture, because "the
 * printed sheet lost the threads" and "the surface kept them" are one change and either one
 * without the other is the wrong change.
 *
 * ─── WHAT A MUTATION HAS TO BREAK ────────────────────────────────────────────────────────────
 *
 *   `{printed:true}` → `{printed:false}` in `printTicket`
 *       the printed sheet carries the pet and client threads again. "the printed sheet carries the
 *       appointment note and NEITHER thread" fails, and so does every by-name assertion about the
 *       two thread sentinels.
 *
 *   `const threads=printed?""` → `const threads=` (the rows drawn unconditionally) in
 *   `ticketNotesMarkup`
 *       the flag becomes furniture: the separation is gone while the parameter is still passed.
 *       The same printed assertions fail.
 *
 *   `printed` dropped from `ticketDocumentMarkup`'s call to `ticketNotesMarkup`
 *       the projection is decided nowhere. `{printed}` arrives as `undefined`, the threads are
 *       drawn, and the printed assertions fail while the surface ones still pass.
 *
 *   `ticketServicesMarkup` given a sixth column reading `model.warning`
 *       the five pet-care fields reach paper through the services table instead of the notes
 *       table. "no pet-care field reaches the printed markup, by name or by value" fails.
 *
 * ─── AND ONE THING THIS FILE HOLDS FOR ANOTHER CHANGE ────────────────────────────────────────
 *
 * The print preview's chrome used to be headed `Print preview: Ticket #: 4f2c1a90`, and the stated
 * reason was that the Ticket's body carried no title of its own, so its preview would otherwise
 * name nothing. The chrome carries no document label any more, so that claim has to be wrong for
 * the label to be safe to remove - and it is: `ticketDocumentMarkup` OPENS on the appointment
 * reference and the salon's name. "the printed sheet says what it is, first" is that precondition,
 * asserted here rather than asserted nowhere. `tests/ui/print-preview.test.ts` holds the chrome's
 * half.
 */

/** Client and pet name resolution, the real functions, because the rows are labelled by them. */
const NAMES = slice(
  "function clientName(record, fallback = \"Not set\") {",
  "\n// The currency this workspace bills in"
);
/** The salon block at the head of the sheet. */
const SALON = slice("function salonIdentityOf({", "\n/**\n * WHICH PET A SERVICE LINE WAS FOR");
/**
 * The appointment view model, REAL rather than stubbed, because it is where the five pet-care
 * fields are folded into `model.warning`. A stub that did not compute `warning` would make "the
 * printed sheet never reads it" an assertion about the stub.
 */
const PRESENTATION = slice(
  "function appointmentPresentation(item){", "\nfunction appointmentAccessibleName("
);
/** The sheet: the salon block, the visit, the services, the notes, both hosts, and the print path. */
const TICKET = slice("function salonIdentity(){", "\n/**\n * Opens the Ticket.");

/**
 * EVERY NOTE-SHAPED FIELD PAWSH HAS, each with a sentinel nothing else in the markup could
 * produce. The keys are the wire names, so `expect(markup).not.toContain(key)` is an assertion
 * about the FIELD and not only about this fixture's value of it.
 */
const INTERNAL_FIELDS = {
  safetyAlerts: "SENTINEL-safety muzzle required for nail work",
  behaviorNotes: "SENTINEL-behaviour bites at strangers",
  medicalNotes: "SENTINEL-medical seizure medication twice daily",
  groomingPreferences: "SENTINEL-grooming never clipper the face",
  coatNotes: "SENTINEL-coat matted behind both ears",
  operationalNotes: "SENTINEL-service-note finished the bath early"
} as const;
/** The newest entry in the pet's note thread, and a pinned one behind it. */
const PET_THREAD = "SENTINEL-pet-thread one inch reverse, round head";
const PET_THREAD_PINNED = "SENTINEL-pet-thread-pinned lift the back legs slowly";
/** The newest entry in the client's thread, and a pinned "popup" note behind it. */
const CLIENT_THREAD = "SENTINEL-client-thread text before the dog is ready";
const CLIENT_THREAD_PINNED = "SENTINEL-client-thread-popup card on file has expired";
/** The one note the printed sheet is meant to carry. */
const APPOINTMENT_NOTE = "Owner collecting at 4pm sharp.";

const SALON_NAME = "Pawsh Grooming Room";

interface Client {
  ticketDocumentMarkup(item: unknown, notes: unknown, options?: { printed?: boolean }): string;
  ticketSurfaceMarkup(item: unknown, notes: unknown): string;
  ticketLatestNote(settled: unknown): { failed: boolean; body: string };
  printTicket(item: unknown, notes: unknown): void;
  ticketReference(item: { id: string }): string;
}

interface Loaded {
  client: Client;
  /** What `printTicket` handed the preview: the class, and the markup itself. */
  previews: { className: string; html: string }[];
}

function loadClient(): Loaded {
  const previews: Loaded["previews"] = [];
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const client = evaluate<Client>(
    [NAMES, SALON, PRESENTATION, TICKET],
    {
      escape,
      escapeAttr: (value = "") =>
        escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;"),
      // The session's business, which is where the sheet's own header comes from.
      state: {
        me: {
          business: {
            name: SALON_NAME, phone: "555 0100", email: "room@pawsh.test",
            address: "12 High Street", timezone: "UTC"
          }
        }
      },
      schedulingZone: () => "UTC",
      formatPrefDate: () => "Friday 6 March 2026",
      formatPrefWeekdayLongMonthDay: () => "Friday, March 6",
      formatPrefTime: () => "2:00 PM",
      compactTimeRange: () => "2–3:30",
      appointmentLocalValue: () => "2026-03-06T14:00",
      previewPrintRoot: (className: string, html: string) => { previews.push({ className, html }); }
    },
    "return {ticketDocumentMarkup, ticketSurfaceMarkup, ticketLatestNote, printTicket,"
      + " ticketReference};"
  );
  return { client, previews };
}

function appointmentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "4f2c1a90-0000-4000-8000-000000000001",
    startAt: "2026-03-06T14:00:00.000Z",
    endAt: "2026-03-06T15:30:00.000Z",
    schedulingTimezone: "UTC",
    status: "completed",
    petId: "pet-1",
    customerId: "customer-1",
    petName: "Charlie",
    breed: "Golden Retriever",
    firstName: "Emma",
    lastName: "Johnson",
    employeeName: "Grace Groomer",
    groomers: [{ displayName: "Grace Groomer" }],
    services: [
      { serviceId: "svc-1", name: "Full Groom", durationMinutes: 90, priceMinor: 7500 },
      { serviceId: "svc-2", name: "Nail Trim", durationMinutes: 30, priceMinor: 1500 }
    ],
    notes: APPOINTMENT_NOTE,
    ...INTERNAL_FIELDS,
    ...overrides
  };
}

/**
 * The two note threads as the Ticket actually holds them: through the REAL `ticketLatestNote`, off
 * a settled fetch, with a pinned entry in each. Handing `{body}` objects straight in would skip the
 * one function that has ever touched `pinned`, and "no pinned flag reaches paper" would then be an
 * assertion about the fixture.
 */
function threadsFrom(client: Client): { pet: unknown; client: unknown } {
  const settled = (items: Record<string, unknown>[]) =>
    ({ status: "fulfilled", value: { items } });
  return {
    pet: client.ticketLatestNote(settled([
      { body: PET_THREAD_PINNED, pinned: true, createdAt: "2026-01-02T09:00:00.000Z" },
      { body: PET_THREAD, pinned: false, createdAt: "2026-03-01T09:00:00.000Z" }
    ])),
    client: client.ticketLatestNote(settled([
      { body: CLIENT_THREAD_PINNED, pinned: true, createdAt: "2026-01-03T09:00:00.000Z" },
      { body: CLIENT_THREAD, pinned: false, createdAt: "2026-03-02T09:00:00.000Z" }
    ]))
  };
}

/** The markup `printTicket` put on its way to paper. */
function printedMarkup(loaded: Loaded, item: unknown, notes: unknown): string {
  loaded.client.printTicket(item, notes);
  const preview = loaded.previews.at(-1);
  expect(preview, "printTicket reached the preview").toBeDefined();
  // The class that says WHICH document this is travels with the markup, unchanged.
  expect(preview!.className).toBe("print-root print-ticket");
  return preview!.html;
}

/** The rows of the notes table, as `<tr>` test ids, in order. */
function noteRows(markup: string): string[] {
  const table = markup.slice(markup.indexOf('data-testid="ticket-notes"'));
  return [...table.matchAll(/<tr data-testid="(ticket-note-[a-z]+)"/gu)].map((match) => match[1]!);
}

describe("the printed Ticket carries the appointment note and neither note thread", () => {
  it("prints one note row, and it is the appointment's own", () => {
    const loaded = loadClient();
    const item = appointmentFixture();
    const markup = printedMarkup(loaded, item, threadsFrom(loaded.client));

    expect(noteRows(markup)).toEqual(["ticket-note-appointment"]);
    expect(markup).toContain("Appointment note");
    expect(markup).toContain(APPOINTMENT_NOTE);
    // WITHHELD, NOT EMPTIED. A dashed row would still tell the reader of the sheet that a pet note
    // exists to be asked about; the row is absent from the printed document entirely.
    expect(markup).not.toContain('data-testid="ticket-note-pet"');
    expect(markup).not.toContain('data-testid="ticket-note-client"');
    expect(markup).not.toContain(PET_THREAD);
    expect(markup).not.toContain(CLIENT_THREAD);
    // And the sheet is otherwise the same sheet: the services table is untouched by this change.
    expect([...markup.matchAll(/data-testid="ticket-service-row"/gu)]).toHaveLength(2);
    expect(markup).toContain("Full Groom");
    expect(markup).toContain("Nail Trim");
  });

  it("still prints the Notes section, so an absent appointment note is a blank and not a gap", () => {
    // The row is drawn even with nothing in it, which is the rule the three-row table always had
    // and the one the single-row table keeps: "nobody wrote a note" is a fact, and a sheet that
    // drops the row leaves the groomer unable to tell it from a sheet that never had one.
    const loaded = loadClient();
    const markup = printedMarkup(
      loaded, appointmentFixture({ notes: null }), threadsFrom(loaded.client)
    );

    expect(noteRows(markup)).toEqual(["ticket-note-appointment"]);
    expect(markup).toContain("<h3>Notes</h3>");
    expect(markup).toContain("<td>Appointment note</td><td>-</td>");
  });

  it("withholds the threads even while they are still loading, and even when they failed", () => {
    // `ticketNoteCell` has two non-note states - `…` in flight and `unavailable` after a refused
    // read - and both are facts about a thread the printed sheet is not carrying. Neither may
    // reach paper as a row of its own.
    const loaded = loadClient();
    const pending = printedMarkup(
      loaded, appointmentFixture(), { pet: null, client: null }
    );
    expect(noteRows(pending)).toEqual(["ticket-note-appointment"]);
    expect(pending).not.toContain("unavailable");
    expect(pending).not.toContain("…");

    const refused = printedMarkup(loaded, appointmentFixture(), {
      pet: loaded.client.ticketLatestNote({ status: "rejected" }),
      client: loaded.client.ticketLatestNote({ status: "rejected" })
    });
    expect(noteRows(refused)).toEqual(["ticket-note-appointment"]);
    expect(refused).not.toContain("unavailable");
  });
});

describe("the Ticket ON SCREEN is unchanged: this is a print projection and nothing else", () => {
  it("keeps all three note rows, the threads among them", () => {
    const loaded = loadClient();
    const item = appointmentFixture();
    const notes = threadsFrom(loaded.client);
    const surface = loaded.client.ticketSurfaceMarkup(item, notes);

    expect(noteRows(surface))
      .toEqual(["ticket-note-pet", "ticket-note-client", "ticket-note-appointment"]);
    expect(surface).toContain(PET_THREAD);
    expect(surface).toContain(CLIENT_THREAD);
    expect(surface).toContain(APPOINTMENT_NOTE);
    // Labelled by the pet and the client, as they always were.
    expect(surface).toContain("<td>Charlie (Pet)</td>");
    expect(surface).toContain("<td>Emma Johnson (Client)</td>");
  });

  it("defaults to the screen's projection, so only an explicit flag narrows a document", () => {
    // `ticketDocumentMarkup(item,notes)` with no options is the SURFACE. A new caller that forgets
    // the flag gets the fuller internal document rather than silently getting the paper one - the
    // safe default for a reader, and the loud one for a leak.
    const loaded = loadClient();
    const notes = threadsFrom(loaded.client);
    const defaulted = loaded.client.ticketDocumentMarkup(appointmentFixture(), notes);

    expect(noteRows(defaulted))
      .toEqual(["ticket-note-pet", "ticket-note-client", "ticket-note-appointment"]);
    expect(defaulted)
      .toBe(loaded.client.ticketDocumentMarkup(appointmentFixture(), notes, { printed: false }));
  });

  it("draws the print root from the SAME renderer, one flag apart", () => {
    // The separation is a flag on one function, not a second renderer. Everything outside the
    // notes table is identical between the two hosts, character for character - which is what
    // stops the printed sheet drifting from the sheet the groomer read.
    const loaded = loadClient();
    const item = appointmentFixture();
    const notes = threadsFrom(loaded.client);
    const screen = loaded.client.ticketDocumentMarkup(item, notes);
    const paper = printedMarkup(loaded, item, notes);
    const head = (markup: string) => markup.slice(0, markup.indexOf("<h3>Notes</h3>"));

    expect(head(paper)).toBe(head(screen));
    expect(paper.length).toBeLessThan(screen.length);
  });
});

describe("the internal note boundary, field by field", () => {
  /**
   * THE FIELDS, AND WHICH SIDE OF THE LINE EACH IS ON.
   *
   *   appointment note      `appointments.notes`. What the client asked for when the visit was
   *                         booked. Internal, and the ONE note kind the printed sheet carries -
   *                         it is a fact about this visit, it is what the groomer needs in front
   *                         of them, and the Ticket is the shop's own copy of the work.
   *   service note          `appointments.operational_notes`. Written while the dog is on the
   *                         table, under its own route and its own permission. Internal. Never on
   *                         the printed sheet - the Ticket has never drawn it, and it is asserted
   *                         here so that "never drawn" stops being an accident.
   *   pet note thread       `pet_notes`, behind `pets.view`. The salon's standing record of an
   *                         animal. Internal. On the surface; withheld from paper.
   *   client note thread    `customer_notes`, behind `customers.view`. The salon's standing record
   *                         of a household. Internal. On the surface; withheld from paper.
   *   pinned / "popup"      the `pinned` column on both threads. Internal, and a flag rather than
   *                         a note - with the threads withheld it cannot reach paper at all.
   *   safety alert          `pets.safety_alerts`, behind `pets.care.view`. Internal.
   *   behaviour notes       `pets.behavior_notes`, behind `pets.care.view`. Internal.
   *   medical notes         `pets.medical_notes`, behind `pets.care.view`. Internal.
   *   grooming preferences  `pets.grooming_preferences`. Internal.
   *   coat notes            `pets.coat_notes`. Internal.
   *
   * The last five arrive on the appointment payload and `appointmentPresentation` folds them into
   * `model.warning` for the calendar card's handling flag. The Ticket reads the model FIELD BY
   * NAME and never reads `warning`, which is why none of the five has ever reached the sheet; the
   * assertion below is what keeps a sixth column from being the change that alters that.
   *
   * EVERY ONE OF THESE IS INTERNAL. None of them is customer-facing, so the question the printed
   * Ticket answers is not "is this safe to show a client" - the Ticket is the shop's own document
   * and is never handed across a counter - but "does this belong to THIS VISIT". One field does.
   */
  it("lets no note field but the appointment note reach the printed markup, by name or by value",
    () => {
      const loaded = loadClient();
      const markup = printedMarkup(loaded, appointmentFixture(), threadsFrom(loaded.client));

      for (const [field, sentinel] of Object.entries(INTERNAL_FIELDS)) {
        expect(markup, `${field} value`).not.toContain(sentinel);
        // The wire name too: a leak through a `data-` attribute, a `title` or an `aria-label`
        // would carry the key as well as the value, and the markup string is what is searched.
        expect(markup, `${field} name`).not.toContain(field);
      }
      for (const thread of [PET_THREAD, PET_THREAD_PINNED, CLIENT_THREAD, CLIENT_THREAD_PINNED]) {
        expect(markup).not.toContain(thread);
      }
      expect(markup).not.toContain("pinned");
      expect(markup).not.toContain("popup");
      // `warning` is where the five pet-care fields are folded together, and the sheet never
      // reads it - by name or by the concatenation it produces.
      expect(markup).not.toContain("warning");
      expect(markup).not.toContain("SENTINEL-");

      // The one that IS carried, still carried.
      expect(markup).toContain(APPOINTMENT_NOTE);
    });

  it("carries no money either, which is the Ticket's older boundary and still holds", () => {
    const loaded = loadClient();
    const markup = printedMarkup(loaded, appointmentFixture(), threadsFrom(loaded.client));
    expect(markup).not.toContain("$");
    expect(markup).not.toContain("7500");
    expect(markup).not.toContain("priceMinor");
  });
});

describe("the printed Ticket says what it is, first", () => {
  /**
   * THE PRECONDITION FOR THE PREVIEW CHROME DROPPING THE DOCUMENT LABEL.
   *
   * The chrome was once `Print preview: Ticket #: 4f2c1a90`, and the stated reason was that this
   * body named nothing. If that were still true, removing the label would leave the Ticket's
   * preview anonymous - so the claim is asserted here rather than assumed: the document OPENS on
   * its own reference and the salon's name, before anything else on the sheet.
   */
  it("opens on the appointment reference and the salon's own name", () => {
    const loaded = loadClient();
    const item = appointmentFixture();
    const markup = printedMarkup(loaded, item, threadsFrom(loaded.client));
    const reference = loaded.client.ticketReference(item as { id: string });

    expect(markup).toContain(`Appointment #: ${reference}`);
    expect(markup).toContain(SALON_NAME);
    // FIRST, not merely somewhere: the reference line precedes the salon block, which precedes
    // the visit, so a reader who sees only the top of the sheet has already been told what it is.
    expect(markup.indexOf(`Appointment #: ${reference}`))
      .toBeLessThan(markup.indexOf(SALON_NAME));
    expect(markup.indexOf(SALON_NAME)).toBeLessThan(markup.indexOf("Client:"));
    // It is still not an <h1>: the financial documents are handed one because their bodies carry
    // no title, and this body is its own title.
    expect(markup).not.toContain("<h1>");
  });
});
