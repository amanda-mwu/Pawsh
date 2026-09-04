import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Settings → Business, exercised as markup and payload rather than through a browser.
 *
 * The Playwright suite in `tests/e2e/business.spec.ts` drives the real screen; this file exists
 * because the two defects this workspace replaces are both expressible without one, and both are
 * silent when they happen:
 *
 *   - the retired hours dialog rendered a fabricated Mon-Fri 09:00-17:00 without reading anything,
 *     and its PUT is a whole-location delete-then-insert, so Save destroyed the real week;
 *   - `PUT /api/business/settings` is a MERGE, so a payload that names `phone`, `email` or
 *     `address` when the operator did not touch them can clear columns that nothing on screen was
 *     about - `businesses.email` is a workspace-administrator identity for access requests.
 *
 * `public/app.js` is served as a plain module with no bundler and has top-level side effects that
 * need a document, so the Business block is sliced out by its own two boundaries and evaluated
 * against stubs. Both anchors are declarations this file would have to be rewritten for anyway.
 */
const source = readFileSync("public/app.js", "utf8");
/**
 * `public/money.js` verbatim, with its `export` keywords dropped so it can be prepended to the
 * block the way an import would have supplied it.
 *
 * NOT A STUB. `businessCurrencySample` is a promise about how this workspace's prices will read,
 * and the promise is only true because it is made by the same formatter that will read them - so
 * the harness runs the real one. A hand-written two-decimal stand-in here would pass while the
 * browser rounded COP to whole units, which is the divergence
 * `tests/domain/web-money-parity.test.mjs` exists to prevent.
 */
const moneySource = readFileSync("public/money.js", "utf8").replaceAll("\nexport function", "\nfunction");
const blockStart = source.indexOf("const BUSINESS_TABS=[");
const blockEnd = source.indexOf("\nfunction renderSettingsCategory(");

interface BusinessModule {
  businessState: {
    tab: string;
    draft: Record<string, string> | null;
    fieldErrors: Record<string, string>;
    hours: unknown[] | null;
    hoursDraft: Record<number, { open: boolean; start: string; end: string; multi: boolean; touched: boolean; periods: { start: string; end: string }[] }> | null;
    hoursBaseline: unknown;
    hoursSubmitted: boolean;
    hoursError: unknown;
    filters: Record<string, string>;
  };
  businessTabsMarkup(): string;
  businessUnavailableMarkup(tab: string): string;
  businessInfoMarkup(): string;
  businessHoursMarkup(): string;
  businessHoursDraftFrom(hours: unknown[]): Record<number, unknown>;
  businessHoursPayload(): { hours: { weekday: number; startTime: string; endTime: string }[] };
  businessHoursRowError(day: number): string | null;
  businessHoursInvalidDays(): number[];
  businessSettingsPayload(): Record<string, unknown>;
  businessValidateInfo(): Record<string, string>;
  businessDraft(): Record<string, string>;
  businessPickerMatches(key: string, query: string): { options: string[]; total: number; filtered: boolean };
  businessPickerOptionsMarkup(key: string, options: string[], selected: string): string;
  businessPickerCountText(key: string, result: { options: string[]; total: number; filtered: boolean }): string;
  businessUrlError(value: string): string | null;
  state: { me: Record<string, unknown>; businessHours: unknown[] };
}

/**
 * A saved workspace: contact details recorded, a Saturday-inclusive week, a legacy-free currency.
 *
 * Every preference is set to something OTHER than its column default, so a control that renders
 * the default instead of the stored value fails rather than passing by coincidence. `hourFormat`
 * is the string "24" because the column is text and the schema compares it as text.
 */
function businessFixture() {
  return {
    name: "Riverside Grooming",
    phone: "626-555-0101",
    website: "https://riverside.example",
    email: "hello@riverside.example",
    address: "18 Mill Lane, Riverside",
    businessType: "hybrid",
    timezone: "America/Los_Angeles",
    currency: "USD",
    dateFormat: "DD/MM/YYYY",
    hourFormat: "24",
    weightUnit: "kg",
    appointmentLock: "enabled",
    upcomingAppointmentCount: 5 as number | null,
    defaultServiceFrequencyWeeks: 6 as number | null,
    socialFacebook: "https://facebook.com/riverside",
    socialGoogle: "https://g.page/riverside",
    socialYelp: "https://yelp.com/biz/riverside",
    taxRateBasisPoints: 825,
    reminderLeadMinutes: 1440,
    locationVersion: 7,
    locationName: "Riverside"
  };
}

function loadBusinessModule(business = businessFixture(), permissions = ["settings.manage"]): BusinessModule {
  const state = {
    me: { business, permissions, isOwner: false, supportedCurrencies: ["USD", "CAD", "EUR", "GBP"] },
    businessHours: [] as unknown[]
  };
  // `escape` in the browser serialises a text node; the entity set that matters for these
  // assertions is the same one, restated here because there is no document.
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") => escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const prelude = `
    "use strict";
    const $ = () => null;
    const api = async () => { throw new Error("no network in this harness"); };
    const toast = () => {};
    const runDetached = () => {};
    const openStackedDialog = () => {};
    const renderAccountIdentity = () => {};
    const allowed = (permission) => state.permissionsHeld.includes(permission);
    const availabilityLocationName = () => state.me.business.locationName || "this location";
    const taxPayPercent = (points) => (Number(points || 0) / 100).toFixed(2).replace(/\\.?0+$/, "") || "0";
    // The timezone hint is the only thing in this block that reaches the date formatter, and it is
    // not what these assertions are about; the formatters have their own suite below.
    const formatPrefTime = (instant, zone) =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(instant);
  `;
  const exported = `
    return { businessState, businessTabsMarkup, businessUnavailableMarkup, businessInfoMarkup,
      businessHoursMarkup, businessHoursDraftFrom, businessHoursPayload, businessHoursRowError,
      businessHoursInvalidDays, businessSettingsPayload, businessValidateInfo, businessDraft,
      businessPickerMatches, businessPickerOptionsMarkup, businessPickerCountText,
      businessUrlError, state };
  `;
  const factory = new Function(
    "state", "escape", "escapeAttr", "document",
    prelude + moneySource + source.slice(blockStart, blockEnd) + exported
  ) as (
    state: unknown, escape: unknown, escapeAttr: unknown, document: unknown
  ) => BusinessModule;
  return factory({ ...state, permissionsHeld: permissions }, escape, escapeAttr, undefined);
}

describe("Settings → Business", () => {
  it("slices a real block out of the client", () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
  });

  describe("tab bar", () => {
    it("keeps Amanda's tab order and one Tab stop", () => {
      const business = loadBusinessModule();
      const markup = business.businessTabsMarkup();
      const labels = [...markup.matchAll(/data-business-tab="([a-z]+)"/g)].map((match) => match[1]);
      expect(labels).toEqual(["info", "number", "domain", "hours", "billing"]);
      // Roving tabindex: the selected tab is the bar's only Tab stop.
      expect([...markup.matchAll(/tabindex="(-?\d)"/g)].map((match) => match[1]))
        .toEqual(["0", "-1", "-1", "-1", "-1"]);
      expect([...markup.matchAll(/aria-selected="(\w+)"/g)].map((match) => match[1]))
        .toEqual(["true", "false", "false", "false", "false"]);
      expect(markup).toContain('role="tablist"');
      expect(markup).toContain('aria-label="Business"');
      expect(markup.match(/aria-controls="business-panel"/g)).toHaveLength(5);
    });

    it("moves aria-selected and the Tab stop with the selection", () => {
      const business = loadBusinessModule();
      business.businessState.tab = "hours";
      const markup = business.businessTabsMarkup();
      expect(markup).toContain('id="business-tab-hours" class="settings-tab active"');
      expect(markup).toMatch(/data-business-tab="hours"[^>]*aria-selected="true"[^>]*tabindex="0"/);
      expect(markup).toMatch(/data-business-tab="info"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    });

    it("never disables or badges the three unavailable tabs", () => {
      const markup = loadBusinessModule().businessTabsMarkup();
      expect(markup).not.toContain("disabled");
      expect(markup).not.toContain("aria-disabled");
      expect(markup).not.toContain("badge");
    });
  });

  describe("the three unavailable tabs", () => {
    const unavailable: [string, string][] = [["number", "Pawsh Number"], ["domain", "Domain"], ["billing", "Business Billing"]];
    for (const [tab, heading] of unavailable) {
      it(`${heading} states its own absence and offers nothing to configure`, () => {
        const markup = loadBusinessModule().businessUnavailableMarkup(tab);
        expect(markup).toContain("<p class=\"eyebrow\">Not available</p>");
        // `Coming soon` is a delivery promise; these are standing deferrals.
        expect(markup).not.toContain("Coming soon");
        expect(markup).toContain(`<h3>${heading}</h3>`);
        // Each of these would assert the capability exists and is merely pending.
        expect(markup).not.toMatch(/<(input|select|textarea|fieldset|table)\b/);
        expect(markup).not.toContain("disabled");
        expect(markup).not.toContain("skeleton");
        expect(markup).not.toMatch(/Notify me|Contact sales|Upgrade/);
      });
    }

    it("says what Pawsh Number is not, and where the real adjacent thing is", () => {
      const markup = loadBusinessModule().businessUnavailableMarkup("number");
      expect(markup).toContain("Pawsh does not provide phone numbers.");
      expect(markup).toContain("no inbox for two-way SMS");
      expect(markup).toContain('data-settings-goto="automated-messages"');
    });

    it("says Domain has nothing to point at, and invents no pointer", () => {
      const markup = loadBusinessModule().businessUnavailableMarkup("domain");
      expect(markup).toContain("Pawsh has no public client surface");
      expect(markup).not.toContain("data-settings-goto");
    });

    it("separates billing Pawsh from taking payment from clients", () => {
      const markup = loadBusinessModule().businessUnavailableMarkup("billing");
      expect(markup).toContain("Pawsh does not charge for itself from inside the product.");
      expect(markup).toContain('data-settings-goto="tax-payments"');
    });
  });

  describe("Info", () => {
    it("renders the stored record, including the address the API now returns", () => {
      const markup = loadBusinessModule().businessInfoMarkup();
      expect(markup).toContain('value="Riverside Grooming"');
      expect(markup).toContain('value="626-555-0101"');
      expect(markup).toContain('value="hello@riverside.example"');
      expect(markup).toContain("18 Mill Lane, Riverside</textarea>");
      // The rate is a mirrored value, not a control: `readonly` reads as disabled and is skipped.
      expect(markup).toContain('data-testid="business-tax-rate">8.25%');
      expect(markup).not.toMatch(/name="taxRate"/);
      // Clean form, so nothing to save yet.
      expect(markup).toMatch(/data-testid="business-save" disabled/);
    });

    it("offers exactly the currencies the server reported, plus the stored one", () => {
      // Scoped to the one select: the timezone picker beside it renders 418 options of its own,
      // and a whole-document regex would be asserting about whichever of them ICU happens to ship.
      const codes = (markup: string) => {
        const select = markup.slice(markup.indexOf('id="business-currency-select"'));
        return [...select.slice(0, select.indexOf("</select>")).matchAll(/<option value="([A-Z]{3})"/g)]
          .map((match) => match[1]);
      };
      expect(codes(loadBusinessModule().businessInfoMarkup())).toEqual(["USD", "CAD", "EUR", "GBP"]);
      // A workspace holding a code from before the supported list existed still sees what it is
      // set to rather than having it silently rewritten by the next save.
      const legacy = loadBusinessModule({ ...businessFixture(), currency: "JPY" }).businessInfoMarkup();
      expect(codes(legacy)).toEqual(["USD", "CAD", "EUR", "GBP", "JPY"]);
      expect(legacy).toContain('value="JPY" selected');
    });

    it("marks the optional fields rather than the required ones", () => {
      const markup = loadBusinessModule().businessInfoMarkup();
      // Phone, website, email, address, default service frequency, and the three social links.
      expect(markup.match(/class="staff-optional">Optional</g)).toHaveLength(8);
      expect(markup).toContain('data-testid="business-name" required');
      expect(markup).not.toContain("*");
    });

    describe("the full preference set", () => {
      /** Every new control, with the fixture's value - none of which is the column's default. */
      const controls: [string, string][] = [
        ["business-website", 'value="https://riverside.example"'],
        ["business-type", '<option value="hybrid" selected>Hybrid (mobile + salon)</option>'],
        ["business-date-format", '<option value="DD/MM/YYYY" selected>DD/MM/YYYY</option>'],
        ["business-hour-format", '<option value="24" selected>24 Hours</option>'],
        ["business-weight-unit", '<option value="kg" selected>Kg</option>'],
        ["business-appointment-lock", '<option value="enabled" selected>Enable Lock</option>'],
        ["business-upcoming-count", '<option value="5" selected>5 appointments</option>'],
        ["business-service-frequency", 'value="6"'],
        ["business-social-facebook", 'value="https://facebook.com/riverside"'],
        ["business-social-google", 'value="https://g.page/riverside"'],
        ["business-social-yelp", 'value="https://yelp.com/biz/riverside"']
      ];
      for (const [testId, expected] of controls) {
        it(`renders ${testId} from the stored record`, () => {
          const markup = loadBusinessModule().businessInfoMarkup();
          expect(markup).toContain(`data-testid="${testId}"`);
          expect(markup).toContain(expected);
        });
      }

      it("offers All as a literal and 1 through 20, because null is the value All", () => {
        const markup = loadBusinessModule().businessInfoMarkup();
        expect(markup).toContain('<option value="All"');
        expect(markup).toContain('<option value="1">1 appointment</option>');
        expect(markup).toContain("20 appointments");
        expect(markup).not.toContain("21 appointments");
        // An unset count is All, not blank - `null` is a value here, not an absence.
        const unset = loadBusinessModule({ ...businessFixture(), upcomingAppointmentCount: null });
        expect(unset.businessInfoMarkup()).toContain('<option value="All" selected>All</option>');
      });

      it("makes business type required and non-emptyable", () => {
        const business = loadBusinessModule();
        const markup = business.businessInfoMarkup();
        expect(markup).toMatch(/data-testid="business-type" required/);
        // No blank option: the column is `not null`, so there is no state in which the operator is
        // choosing "none", and offering one would invent it.
        expect(markup).not.toMatch(/data-testid="business-type"[^>]*>\s*<option value=""/);
        business.businessDraft().businessType = "";
        expect(business.businessValidateInfo().businessType)
          .toBe("Choose whether this salon is mobile, fixed, or both.");
      });

      it("falls back to the tuple's first value rather than selecting nothing", () => {
        // The columns are `not null` behind check constraints, so this is unreachable through the
        // API. A select with no option selected would silently post whatever the browser picked.
        const rogue = loadBusinessModule({ ...businessFixture(), weightUnit: "stone", hourFormat: "36" });
        const markup = rogue.businessInfoMarkup();
        expect(markup).toContain('<option value="lb" selected>Lb</option>');
        expect(markup).toContain('<option value="12" selected>12 Hours</option>');
      });

      it("says what the one stored-but-inert setting does not do, without promising a date", () => {
        const markup = loadBusinessModule().businessInfoMarkup();
        expect(markup).toContain("Pawsh has no send-out link");
        expect(markup).toContain("The count is stored now and takes effect when there is one.");
        // The coupon-stacking control and its note are gone. The note said the choice would take
        // effect when coupons shipped; coupons shipped, and it still reached nothing that
        // calculates a bill, because `coupon_stacking` has no money consumers. The rule that does
        // decide money is `discount_stacking_mode`, and its one control is on Coupons & discounts.
        expect(markup).not.toContain("multiple coupons");
        expect(markup).not.toContain("business-coupon-stacking");
        // Exactly one. The appointment lock is enforced, so it carries an ordinary hint and must
        // not be grouped with the setting that is stored and inert.
        expect(markup.match(/class="field-hint business-pending-note"/g)).toHaveLength(1);
        expect(markup).not.toContain("business-note-appointment-lock");
        // The voice of the three unavailable tabs: no delivery promise anywhere on this form.
        expect(markup).not.toContain("Coming soon");
        expect(markup).not.toMatch(/coming soon|Notify me|shortly|in a future release/i);
      });

      it("describes what enabling the appointment lock actually does", () => {
        const markup = loadBusinessModule().businessInfoMarkup();
        const hint = "Enable Lock stops appointments being moved: nobody can change when one starts"
          + " or who is assigned to it, and drag-to-reschedule leaves the calendar. Everything else"
          + " stays editable, new appointments can still be booked, and the lock applies to owners too.";
        expect(markup).toContain(hint);
        // The three things the ruling settled, and the three the hint would be wrong to imply.
        expect(markup).not.toContain("has not been decided");
        expect(markup).not.toMatch(/lock[^<]*invoice|lock[^<]*edits to/i);
      });

      it("carries the reference's row captions in the field-hint idiom", () => {
        const markup = loadBusinessModule().businessInfoMarkup();
        expect(markup).toContain("How many appointments are shown in the sent-out upcoming link.");
        expect(markup).toContain("The default service frequency for all clients.");
        // One hint placement across the whole form, rather than a second style for two rows.
        expect(markup).not.toContain("business-field-lead");
      });

      it("keeps the three social links on their own card and the email off it", () => {
        const markup = loadBusinessModule().businessInfoMarkup();
        const social = markup.slice(markup.indexOf("<h3>Social media</h3>"));
        expect(social).toContain('data-testid="business-social-facebook"');
        expect(social).toContain('data-testid="business-social-google"');
        expect(social).toContain('data-testid="business-social-yelp"');
        // Email is a salon correspondence address, not a listing, and stays on Business info.
        expect(social).not.toContain('data-testid="business-email"');
        expect(markup.indexOf('data-testid="business-email"'))
          .toBeLessThan(markup.indexOf("<h3>Social media</h3>"));
      });

      it("uses the number-and-unit idiom for the service frequency", () => {
        const markup = loadBusinessModule().businessInfoMarkup();
        expect(markup).toMatch(/<span class="pref-frequency">[\s\S]*?data-testid="business-service-frequency"/);
        expect(markup).toContain('<span class="pref-unit">Weeks</span>');
      });
    });

    describe("the searchable pickers", () => {
      it("filters the currency list and keeps the count audible", () => {
        const business = loadBusinessModule();
        expect(business.businessPickerMatches("currency", "").options)
          .toEqual(["USD", "CAD", "EUR", "GBP"]);
        const filtered = business.businessPickerMatches("currency", "u");
        expect(filtered.options).toEqual(["USD", "EUR"]);
        expect(business.businessPickerCountText("currency", filtered))
          .toBe("2 of 4 currencies shown.");
        expect(business.businessPickerCountText("currency", business.businessPickerMatches("currency", "")))
          .toBe("4 currencies.");
      });

      it("never lets a filter hide the value the operator has selected", () => {
        const business = loadBusinessModule();
        // "CAD" matches nothing here, so without the guard the select would silently report USD -
        // and the next save would store it.
        const filtered = business.businessPickerMatches("currency", "zzz");
        expect(filtered.options).toEqual(["USD"]);
        const markup = business.businessPickerOptionsMarkup("currency", filtered.options, "USD");
        expect(markup).toContain('<option value="USD" selected>USD</option>');
      });

      it("keeps a stored code the server no longer lists selectable, filtered or not", () => {
        const legacy = loadBusinessModule({ ...businessFixture(), currency: "JPY" });
        expect(legacy.businessPickerMatches("currency", "").options).toContain("JPY");
        expect(legacy.businessPickerMatches("currency", "jp").options).toEqual(["JPY"]);
        expect(legacy.businessInfoMarkup()).toContain('value="JPY" selected');
      });

      it("filters timezones and groups them by region", () => {
        const business = loadBusinessModule();
        const all = business.businessPickerMatches("timezone", "");
        expect(all.total).toBeGreaterThan(100);
        const filtered = business.businessPickerMatches("timezone", "los_ang");
        expect(filtered.options).toEqual(["America/Los_Angeles"]);
        expect(business.businessPickerCountText("timezone", filtered))
          .toBe(`1 of ${all.total} timezones shown.`);
        const markup = business.businessPickerOptionsMarkup("timezone", filtered.options, "America/Los_Angeles");
        expect(markup).toContain('<optgroup label="America">');
        expect(markup).toContain('<option value="America/Los_Angeles" selected>');
      });

      it("keeps a zone this runtime does not list rather than rewriting it on save", () => {
        const legacy = loadBusinessModule({ ...businessFixture(), timezone: "Mars/Olympus_Mons" });
        expect(legacy.businessPickerMatches("timezone", "").options).toContain("Mars/Olympus_Mons");
        expect(legacy.businessInfoMarkup()).toContain('<option value="Mars/Olympus_Mons" selected>');
      });

      it("gives both pickers a labelled filter wired to their select", () => {
        const markup = loadBusinessModule().businessInfoMarkup();
        expect(markup).toContain('data-testid="business-currency-filter"');
        expect(markup).toContain('aria-controls="business-currency-select"');
        expect(markup).toContain('aria-label="Filter currencies"');
        expect(markup).toContain('data-testid="business-timezone-filter"');
        expect(markup).toContain('aria-controls="business-timezone-select"');
        // The count is announced, not merely drawn.
        expect(markup).toMatch(/data-testid="business-currency-count"/);
        expect(markup).toMatch(/class="field-hint business-picker-count" role="status"/);
      });

      it("does not treat a filter keystroke as an unsaved change", () => {
        const business = loadBusinessModule();
        business.businessState.filters.currency = "eur";
        expect(business.businessInfoMarkup()).toMatch(/data-testid="business-save" disabled/);
      });
    });

    describe("the payload against a MERGE schema", () => {
      let business: BusinessModule;
      beforeEach(() => { business = loadBusinessModule(); });

      it("preserves phone, email and address when the save was about something else", () => {
        business.businessDraft().name = "Riverside Pet Spa";
        const payload = business.businessSettingsPayload();
        expect(payload).toEqual({
          name: "Riverside Pet Spa",
          timezone: "America/Los_Angeles",
          taxRateBasisPoints: 825,
          reminderLeadMinutes: 1440,
          locationVersion: 7
        });
        // Named explicitly: an omitted key is what preserves the column, and `phone: null` is
        // what the previous handler wrote on every single save of this screen.
        expect(Object.keys(payload)).not.toContain("phone");
        expect(Object.keys(payload)).not.toContain("email");
        expect(Object.keys(payload)).not.toContain("address");
        expect(Object.keys(payload)).not.toContain("currency");
      });

      it("sends null only for a field the operator actually emptied", () => {
        business.businessDraft().phone = "   ";
        business.businessDraft().address = "";
        const payload = business.businessSettingsPayload();
        expect(payload.phone).toBeNull();
        expect(payload.address).toBeNull();
        expect(Object.keys(payload)).not.toContain("email");
      });

      it("sends a changed contact field, trimmed", () => {
        business.businessDraft().email = "  desk@riverside.example  ";
        expect(business.businessSettingsPayload().email).toBe("desk@riverside.example");
      });

      it("holds an untouched currency picker out of the payload entirely", () => {
        const legacy = loadBusinessModule({ ...businessFixture(), currency: "JPY" });
        legacy.businessDraft().name = "Riverside Pet Spa";
        // `currencyCode` would refuse JPY. Omitting it is what lets this workspace rename itself.
        expect(Object.keys(legacy.businessSettingsPayload())).not.toContain("currency");
        legacy.businessDraft().currency = "USD";
        expect(legacy.businessSettingsPayload().currency).toBe("USD");
      });

      it("round-trips the tax rate so the Tax & payments mirror is not disturbed", () => {
        business.businessDraft().name = "Riverside Pet Spa";
        expect(business.businessSettingsPayload().taxRateBasisPoints).toBe(825);
      });

      it("still omits every untouched field now that there are twenty of them", () => {
        business.businessDraft().name = "Riverside Pet Spa";
        // The merge rule has not changed just because the form grew: the five required fields and
        // nothing else. Every key added below is a column this save was never about.
        expect(business.businessSettingsPayload()).toEqual({
          name: "Riverside Pet Spa",
          timezone: "America/Los_Angeles",
          taxRateBasisPoints: 825,
          reminderLeadMinutes: 1440,
          locationVersion: 7
        });
      });

      it("sends an enum only when it moved, and never sends one as null", () => {
        // Five now, not six. `couponStacking` was retired with its control: it wrote a column no
        // bill calculation reads, and the rule that does decide money is `discount_stacking_mode`
        // on the Coupons & discounts screen.
        const enums = ["businessType", "dateFormat", "hourFormat", "weightUnit", "appointmentLock"];
        business.businessDraft().name = "Riverside Pet Spa";
        for (const key of enums) expect(Object.keys(business.businessSettingsPayload())).not.toContain(key);
        // Sending null for any of the five is a 400 - they have no null - so an emptied draft value
        // must still not reach the payload as one.
        business.businessDraft().dateFormat = "MM/DD/YYYY";
        business.businessDraft().weightUnit = "lb";
        const payload = business.businessSettingsPayload();
        expect(payload.dateFormat).toBe("MM/DD/YYYY");
        expect(payload.weightUnit).toBe("lb");
        expect(Object.values(payload)).not.toContain(null);
      });

      it("coerces the appointment count to a number, because the schema refuses a numeric string", () => {
        business.businessDraft().upcomingAppointmentCount = "12";
        expect(business.businessSettingsPayload().upcomingAppointmentCount).toBe(12);
        expect(typeof business.businessSettingsPayload().upcomingAppointmentCount).toBe("number");
      });

      it("posts All as the literal the server takes and returns as null", () => {
        business.businessDraft().upcomingAppointmentCount = "All";
        expect(business.businessSettingsPayload().upcomingAppointmentCount).toBe("All");
        // Omitted preserves; this is the one field where null IS a value, so an untouched All
        // must not be posted either.
        const allAlready = loadBusinessModule({ ...businessFixture(), upcomingAppointmentCount: null });
        allAlready.businessDraft().name = "Riverside Pet Spa";
        expect(Object.keys(allAlready.businessSettingsPayload()))
          .not.toContain("upcomingAppointmentCount");
      });

      it("clears the service frequency with null and sets it with a number", () => {
        business.businessDraft().defaultServiceFrequencyWeeks = "";
        expect(business.businessSettingsPayload().defaultServiceFrequencyWeeks).toBeNull();
        business.businessDraft().defaultServiceFrequencyWeeks = "8";
        expect(business.businessSettingsPayload().defaultServiceFrequencyWeeks).toBe(8);
      });

      it("sends the website and the three social links only when they moved", () => {
        business.businessDraft().name = "Riverside Pet Spa";
        for (const key of ["website", "socialFacebook", "socialGoogle", "socialYelp"]) {
          expect(Object.keys(business.businessSettingsPayload())).not.toContain(key);
        }
        // A bare host is sent as typed: the server prefixes https:// and returns what it stored.
        business.businessDraft().socialYelp = "  www.yelp.com/biz/pawsh  ";
        business.businessDraft().website = "";
        const payload = business.businessSettingsPayload();
        expect(payload.socialYelp).toBe("www.yelp.com/biz/pawsh");
        expect(payload.website).toBeNull();
        expect(Object.keys(payload)).not.toContain("socialFacebook");
      });

      it("round-trips every preference unchanged through a save about the name alone", () => {
        // The regression this guards: a payload built from the whole draft rather than the diff
        // would post twenty fields on every save, and the merge schema would happily write them.
        business.businessDraft().name = "Riverside Pet Spa";
        expect(Object.keys(business.businessSettingsPayload()).sort()).toEqual([
          "locationVersion", "name", "reminderLeadMinutes", "taxRateBasisPoints", "timezone"
        ]);
      });
      it("round-trips minute-precision reminder lead when the hours field was not touched", () => {
        const odd = loadBusinessModule({ ...businessFixture(), reminderLeadMinutes: 90 });
        odd.businessDraft().name = "Riverside Pet Spa";
        expect(odd.businessSettingsPayload().reminderLeadMinutes).toBe(90);
        expect(odd.businessValidateInfo()).toEqual({});
        odd.businessDraft().reminderHours = "2";
        expect(odd.businessSettingsPayload().reminderLeadMinutes).toBe(120);
      });
    });

    describe("validation", () => {
      it("refuses a name Pawsh could not put on an invoice", () => {
        const business = loadBusinessModule();
        business.businessDraft().name = "R";
        expect(business.businessValidateInfo().name)
          .toBe("A salon name is needed — it is what appears on every invoice.");
      });

      it("refuses an email Pawsh cannot send to, and accepts an empty one", () => {
        const business = loadBusinessModule();
        business.businessDraft().email = "desk@";
        expect(business.businessValidateInfo().email)
          .toBe("That is not an email address Pawsh can send to.");
        business.businessDraft().email = "";
        expect(business.businessValidateInfo()).toEqual({});
      });

      it("refuses a link scheme the server treats as a stored-XSS bound", () => {
        const business = loadBusinessModule();
        // These four fields are rendered as links. The schema 400s on anything but http/https, and
        // the client refuses the same set rather than a looser one.
        for (const hostile of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd"]) {
          expect(business.businessUrlError(hostile))
            .toBe("Pawsh stores web addresses only. Start it with https:// or leave the scheme off entirely.");
        }
        // A bare host is not a scheme and is left alone: the server prefixes https:// itself.
        expect(business.businessUrlError("www.yelp.com/biz/pawsh")).toBeNull();
        expect(business.businessUrlError("https://facebook.com/riverside")).toBeNull();
        expect(business.businessUrlError("HTTP://example.test")).toBeNull();
        expect(business.businessUrlError("")).toBeNull();
        expect(business.businessUrlError(`https://x.test/${"a".repeat(500)}`))
          .toBe("That address is longer than the 500 characters Pawsh stores.");
      });

      it("marks the offending link field rather than the foot", () => {
        const business = loadBusinessModule();
        business.businessDraft().socialGoogle = "javascript:alert(1)";
        expect(Object.keys(business.businessValidateInfo())).toEqual(["socialGoogle"]);
        const errors = business.businessValidateInfo();
        business.businessState.fieldErrors = errors;
        const markup = business.businessInfoMarkup();
        expect(markup).toContain('data-testid="business-social-google"');
        expect(markup).toMatch(/data-testid="business-social-google"[^>]*aria-invalid="true"/);
        expect(markup).toContain('id="business-error-socialGoogle"');
        // The foot stays quiet so there is exactly one message per problem.
        expect(markup).toContain('data-testid="business-status"></p>');
      });

      it("refuses a service frequency outside the schema's 1 to 104 weeks", () => {
        const business = loadBusinessModule();
        for (const value of ["0", "105", "2.5", "-1"]) {
          business.businessDraft().defaultServiceFrequencyWeeks = value;
          expect(business.businessValidateInfo().defaultServiceFrequencyWeeks)
            .toBe("Enter a whole number of weeks, from 1 to 104.");
        }
        // Empty is "no default set", which the column allows and the payload clears with null.
        business.businessDraft().defaultServiceFrequencyWeeks = "";
        expect(business.businessValidateInfo()).toEqual({});
        business.businessDraft().defaultServiceFrequencyWeeks = "104";
        expect(business.businessValidateInfo()).toEqual({});
      });
      it("refuses a reminder lead that is not a whole number of hours in range", () => {
        const business = loadBusinessModule();
        for (const value of ["", "1.5", "-1", "721", "abc"]) {
          business.businessDraft().reminderHours = value;
          expect(business.businessValidateInfo().reminderHours)
            .toBe("Enter a whole number of hours, from 0 to 720.");
        }
        business.businessDraft().reminderHours = "0";
        expect(business.businessValidateInfo()).toEqual({});
      });
    });
  });

  describe("Business Hours", () => {
    const savedWeek = [
      { weekday: 2, startTime: "10:30", endTime: "18:45" },
      { weekday: 6, startTime: "08:15", endTime: "13:00" }
    ];

    /** One weekday's draft row, asserted present so the assertions below read as assertions. */
    function hoursRow(business: BusinessModule, day: number) {
      const row = business.businessState.hoursDraft?.[day];
      if (!row) throw new Error(`no draft row for weekday ${day}`);
      return row;
    }

    function withHours(hours: unknown[], business = loadBusinessModule()) {
      business.businessState.tab = "hours";
      business.businessState.hours = hours;
      business.businessState.hoursDraft = business.businessHoursDraftFrom(hours) as never;
      business.businessState.hoursBaseline = business.businessHoursDraftFrom(hours);
      return business;
    }

    it("renders nothing at all before the read resolves", () => {
      const business = loadBusinessModule();
      business.businessState.tab = "hours";
      const markup = business.businessHoursMarkup();
      expect(markup).toContain('aria-busy="true"');
      expect(markup).toContain('data-testid="business-hours-loading"');
      // The single most important assertion in this file. The retired dialog drew this week
      // instantly and its Save wrote it over whatever was really stored.
      expect(markup).not.toContain("09:00");
      expect(markup).not.toContain("17:00");
      expect(markup).not.toContain("checked");
      expect(markup).not.toContain("input type=\"time\"");
    });

    it("renders the hours that are stored, never a default week", () => {
      const markup = withHours(savedWeek).businessHoursMarkup();
      expect(markup).toContain('id="business-hours-start-2" data-business-start="2" data-testid="business-hours-start-2" value="10:30"');
      expect(markup).toContain('data-testid="business-hours-end-2" value="18:45"');
      expect(markup).toContain('data-testid="business-hours-start-6" value="08:15"');
      expect(markup).not.toContain("09:00");
      expect(markup).not.toContain("17:00");
      // Monday is not stored, so it is closed - and says so in a word rather than resting on the
      // switch's position or a greyed-out input.
      expect(markup).toContain('data-testid="business-hours-state-1">Closed');
      expect(markup).toMatch(/data-testid="business-hours-open-2"[^>]* checked/);
      expect(markup).not.toMatch(/data-testid="business-hours-open-1"[^>]* checked/);
      expect(markup).toContain("These are the hours saved for <strong>Riverside</strong>");
    });

    it("says an unconfigured week is open, not closed", () => {
      const markup = withHours([]).businessHoursMarkup();
      // Seven off switches with no sentence would tell the operator the exact opposite of how the
      // calendar behaves: `!periods.length && !state.businessHours.length` means open at all times.
      expect(markup).toContain("No business hours are saved for <strong>Riverside</strong>");
      expect(markup).toContain("the calendar treats every slot on every day as open");
      expect(markup).not.toContain("These are the hours saved for");
      expect(markup.match(/data-testid="business-hours-state-\d">Closed/g)).toHaveLength(7);
      expect(markup).not.toMatch(/data-business-day="\d"[^>]* checked/);
      // Nothing is dirty yet, so nothing can be written over the "open at all times" behaviour by
      // an operator who only came to look.
      expect(markup).toMatch(/data-testid="business-hours-save" disabled/);
    });

    it("renders no editable grid at all when the read failed", () => {
      const business = loadBusinessModule();
      business.businessState.tab = "hours";
      business.businessState.hoursError = { status: 500, message: "Boom" };
      const markup = business.businessHoursMarkup();
      expect(markup).toContain("so it is not showing any. Nothing has changed.");
      expect(markup).not.toContain("input type=\"time\"");
      expect(markup).not.toContain("business-hours-save");
      business.businessState.hoursError = { status: 403, message: "Forbidden" };
      expect(business.businessHoursMarkup()).toContain("You do not have permission to view this.");
    });

    it("passes a multi-period weekday through read-only rather than deleting half of it", () => {
      const split = [
        { weekday: 6, startTime: "09:00", endTime: "12:00" },
        { weekday: 6, startTime: "13:00", endTime: "17:00" },
        { weekday: 2, startTime: "10:30", endTime: "18:45" }
      ];
      const business = withHours(split);
      const markup = business.businessHoursMarkup();
      expect(markup).toContain('data-testid="business-hours-multi-6"');
      expect(markup).toContain("09:00–12:00, 13:00–17:00");
      expect(markup).toContain("Two periods — editing here would remove one.");
      // No switch and no inputs on that row: a control it cannot redraw would offer to destroy a
      // period the editor has no way to express.
      expect(markup).not.toContain('data-business-day="6"');
      expect(markup).not.toContain('data-business-start="6"');
      // And the save carries both periods untouched.
      expect(business.businessHoursPayload().hours).toEqual([
        { weekday: 2, startTime: "10:30", endTime: "18:45" },
        { weekday: 6, startTime: "09:00", endTime: "12:00" },
        { weekday: 6, startTime: "13:00", endTime: "17:00" }
      ]);
    });

    it("sends all seven days' state, because the PUT replaces the whole location", () => {
      const business = withHours(savedWeek);
      Object.assign(hoursRow(business, 1), { open: true, start: "08:00", end: "16:00" });
      // Tuesday untouched, Monday added, everything else closed - and the untouched day still has
      // to be in the payload or the delete-then-insert would drop it.
      expect(business.businessHoursPayload().hours).toEqual([
        { weekday: 1, startTime: "08:00", endTime: "16:00" },
        { weekday: 2, startTime: "10:30", endTime: "18:45" },
        { weekday: 6, startTime: "08:15", endTime: "13:00" }
      ]);
    });

    it("refuses a range that ends when or before it starts", () => {
      const business = withHours(savedWeek);
      hoursRow(business, 2).end = "10:30";
      expect(business.businessHoursRowError(2))
        .toBe("Tuesday must close after it opens. Hours cannot run past midnight.");
      hoursRow(business, 2).end = "09:00";
      expect(business.businessHoursInvalidDays()).toEqual([2]);
      hoursRow(business, 2).end = "18:45";
      expect(business.businessHoursInvalidDays()).toEqual([]);
    });

    it("refuses an open day with a missing time", () => {
      const business = withHours(savedWeek);
      hoursRow(business, 2).end = "";
      expect(business.businessHoursRowError(2))
        .toBe("Tuesday is open, so it needs an opening and a closing time.");
    });

    it("marks a broken row and names the count in the foot on submit", () => {
      const business = withHours(savedWeek);
      hoursRow(business, 2).end = "09:00";
      business.businessState.hoursSubmitted = true;
      const markup = business.businessHoursMarkup();
      expect(markup).toContain("is-invalid");
      expect(markup).toContain('data-testid="business-hours-row-error-2"');
      expect(markup).toContain("Fix 1 day before saving.");
      expect(markup).toContain('aria-invalid="true"');
    });

    it("keeps a closed day out of the payload without disabling its controls", () => {
      const business = withHours(savedWeek);
      hoursRow(business, 2).open = false;
      const markup = business.businessHoursMarkup();
      expect(markup).toContain('data-testid="business-hours-state-2">Closed');
      expect(markup).not.toContain('data-business-start="2"');
      expect(markup).not.toContain("disabled aria-disabled");
      expect(business.businessHoursPayload().hours).toEqual([
        { weekday: 6, startTime: "08:15", endTime: "13:00" }
      ]);
    });

    it("shows times as words and refuses the editor without the Settings permission", () => {
      const business = withHours(savedWeek, loadBusinessModule(businessFixture(), ["calendar.view"]));
      const markup = business.businessHoursMarkup();
      expect(markup).toContain("Changing business hours needs the Settings permission.");
      // `.availability-note.is-quiet` uses `--placeholder`, which fails AA for body text.
      expect(markup).not.toContain("availability-note is-quiet");
      expect(markup).toContain('data-testid="business-hours-state-2">10:30–18:45');
      expect(markup).not.toContain("input type=\"time\"");
      expect(markup).not.toContain("business-hours-save");
    });

    it("labels every control without relying on the row's day name", () => {
      const markup = withHours(savedWeek).businessHoursMarkup();
      expect(markup).toContain('aria-label="Open on Tuesday"');
      expect(markup).toContain('role="switch"');
      expect(markup).toContain('<label class="visually-hidden" for="business-hours-start-2">Tuesday opens at</label>');
      expect(markup).toContain('<label class="visually-hidden" for="business-hours-end-2">Tuesday closes at</label>');
      // `step="900"` would refuse a stored 09:05 that already exists in the database.
      expect(markup).not.toContain("step=");
    });
  });
});

/**
 * The two client-side consumers Settings -> Business now drives.
 *
 * Both are sliced out of `public/app.js` the same way the Business block is, because both are the
 * point of the settings rather than decoration on it: a `Date format` that changes nothing on
 * screen, or a `Weight unit` that converts pet weights while leaving the price-band captions in
 * pounds, would each be a preference the operator has been told a lie about.
 */
interface FormatModule {
  state: { me: Record<string, unknown> };
  formatPrefDate(instant: Date, zone?: string): string;
  formatPrefTime(instant: Date, zone?: string): string;
  formatPrefClock(hour: number, minute: number): string;
  formatPrefDateTime(instant: Date, zone?: string): string;
  formatPrefDateAndTime(instant: Date, zone?: string): string;
  formatPrefWeekdayTime(instant: Date, zone?: string): string;
  formatPrefLocalDate(localDate: string): string;
  formatPrefLocalWeekdayDate(localDate: string): string;
}
interface WeightModule {
  state: { me: Record<string, unknown> };
  workspaceWeightUnit(): string;
  weightTierList(): { code: string; label: string }[];
  formatPetWeight(ounces: number | null): string | null;
  ouncesFromWeight(value: string | number | null): number | null;
  weightInputValue(ounces: number | null): string;
  weightFieldLabel(): string;
  weightInputAttrs(): string;
}

function sliceModule<T>(startAnchor: string, endAnchor: string, exports: string, business: Record<string, unknown>): T {
  const from = source.indexOf(startAnchor);
  const to = source.indexOf(endAnchor);
  if (from < 0 || to <= from) throw new Error(`could not slice ${startAnchor}`);
  const factory = new Function("state", `
    "use strict";
    const schedulingZone = () => state.me?.business?.timezone || "UTC";
    const dateAt = (value) => new Date(\`\${value}T12:00:00Z\`);
    ${source.slice(from, to)}
    return { ${exports}, state };
  `) as (state: unknown) => T;
  return factory({ me: business });
}

function loadFormatModule(business: Record<string, unknown>): FormatModule {
  return sliceModule<FormatModule>("const PREF_WEEKDAYS=[", "function wallParts(",
    "formatPrefDate, formatPrefTime, formatPrefClock, formatPrefDateTime, formatPrefDateAndTime,"
    + " formatPrefWeekdayTime, formatPrefLocalDate, formatPrefLocalWeekdayDate", business);
}
function loadWeightModule(me: Record<string, unknown>): WeightModule {
  return sliceModule<WeightModule>("const WEIGHT_OUNCES_PER=", "function petTypeIdFor(",
    "workspaceWeightUnit, weightTierList, formatPetWeight, ouncesFromWeight, weightInputValue,"
    + " weightFieldLabel, weightInputAttrs", me);
}

describe("client formatting driven by the workspace's preferences", () => {
  // 2026-09-02T15:30Z, a Wednesday, read in UTC so the assertions are about layout and nothing else.
  const instant = new Date("2026-09-02T15:30:00Z");
  const workspace = (dateFormat: string, hourFormat: string) =>
    loadFormatModule({ business: { dateFormat, hourFormat, timezone: "UTC" } });

  it("lays out the date in the order the operator chose, zero-padded and four-digit", () => {
    expect(workspace("MM/DD/YYYY", "12").formatPrefDate(instant)).toBe("09/02/2026");
    expect(workspace("DD/MM/YYYY", "12").formatPrefDate(instant)).toBe("02/09/2026");
  });

  it("lays out the clock in the convention the operator chose", () => {
    expect(workspace("MM/DD/YYYY", "12").formatPrefTime(instant)).toBe("3:30 PM");
    expect(workspace("MM/DD/YYYY", "24").formatPrefTime(instant)).toBe("15:30");
  });

  it("keeps the two settings independent", () => {
    // DD/MM/YYYY with a 12-hour clock is a valid combination and must render as one.
    expect(workspace("DD/MM/YYYY", "12").formatPrefDateTime(instant))
      .toBe("Wednesday, 02/09/2026 at 3:30 PM");
    expect(workspace("MM/DD/YYYY", "24").formatPrefDateTime(instant))
      .toBe("Wednesday, 09/02/2026 at 15:30");
  });

  it("matches the line `formatPreferredDateTime` puts in the mail Pawsh sends", () => {
    // One workspace must read the same on screen as it does in its own appointment emails.
    expect(workspace("DD/MM/YYYY", "24").formatPrefDateTime(instant))
      .toBe("Wednesday, 02/09/2026 at 15:30");
  });

  it("distinguishes midnight from noon in both conventions", () => {
    const midnight = new Date("2026-09-02T00:00:00Z");
    const noon = new Date("2026-09-02T12:00:00Z");
    expect(workspace("MM/DD/YYYY", "12").formatPrefTime(midnight)).toBe("12:00 AM");
    expect(workspace("MM/DD/YYYY", "12").formatPrefTime(noon)).toBe("12:00 PM");
    expect(workspace("MM/DD/YYYY", "24").formatPrefTime(midnight)).toBe("00:00");
    expect(workspace("MM/DD/YYYY", "24").formatPrefTime(noon)).toBe("12:00");
  });

  it("resolves the instant in the zone it is given, not the browser's", () => {
    const zoned = workspace("MM/DD/YYYY", "24");
    expect(zoned.formatPrefTime(instant, "America/Los_Angeles")).toBe("08:30");
    expect(zoned.formatPrefDate(instant, "Asia/Tokyo")).toBe("09/03/2026");
  });

  it("reorders a calendar date without going near a time zone", () => {
    // `vaccination_expires_on` is a date, not an instant. Anchoring it at noon UTC to survive
    // being formatted is the workaround this replaces.
    expect(workspace("DD/MM/YYYY", "12").formatPrefLocalDate("2026-09-02")).toBe("02/09/2026");
    expect(workspace("MM/DD/YYYY", "12").formatPrefLocalDate("2026-09-02T00:00:00Z")).toBe("09/02/2026");
    // Anything that is not a calendar date comes back untouched rather than as "Invalid Date".
    expect(workspace("MM/DD/YYYY", "12").formatPrefLocalDate("")).toBe("");
  });

  it("keeps the weekday in English beside the numeric date", () => {
    expect(workspace("DD/MM/YYYY", "12").formatPrefLocalWeekdayDate("2026-09-02"))
      .toBe("Wednesday, 02/09/2026");
    expect(workspace("MM/DD/YYYY", "24").formatPrefWeekdayTime(instant)).toBe("Wed 15:30");
  });

  it("formats the calendar's time axis from the same setting", () => {
    expect(workspace("MM/DD/YYYY", "12").formatPrefClock(13, 30)).toBe("1:30 PM");
    expect(workspace("MM/DD/YYYY", "24").formatPrefClock(13, 30)).toBe("13:30");
  });

  it("falls back to the pre-0047 shape when the record says nothing", () => {
    const bare = loadFormatModule({ business: {} });
    expect(bare.formatPrefDateTime(instant, "UTC")).toBe("Wednesday, 09/02/2026 at 3:30 PM");
  });
});

describe("weights in the unit the workspace reads", () => {
  const servedKilograms = [
    { code: "TIER_1", label: "0.1–9.1 kg" }, { code: "TIER_2", label: "9.2–18.1 kg" },
    { code: "TIER_3", label: "18.2–27.2 kg" }, { code: "TIER_4", label: "27.3–36.3 kg" },
    { code: "TIER_5", label: "36.4–45.4 kg" }, { code: "TIER_6", label: "45.4+ kg" }
  ];

  it("captions the tiers from the served list rather than a hand-copied one", () => {
    const kilograms = loadWeightModule({ weightUnit: "kg", weightTiers: servedKilograms });
    expect(kilograms.weightTierList().map((tier) => tier.label))
      .toEqual(["0.1–9.1 kg", "9.2–18.1 kg", "18.2–27.2 kg", "27.3–36.3 kg", "36.4–45.4 kg", "45.4+ kg"]);
    // Matched on code, never on label text.
    expect(kilograms.weightTierList().map((tier) => tier.code))
      .toEqual(["TIER_1", "TIER_2", "TIER_3", "TIER_4", "TIER_5", "TIER_6"]);
  });

  it("captions six columns rather than blanking them when the payload predates the field", () => {
    const legacy = loadWeightModule({ business: {} });
    const labels = legacy.weightTierList().map((tier) => tier.label);
    expect(labels).toHaveLength(6);
    expect(labels[0]).toBe("1–20 lb");
    expect(labels[5]).toBe("100+ lb");
  });

  it("moves pet weights with the captions, never one without the other", () => {
    // The failure this guards: a 19.1 kg dog under a column headed "21-40 lb", where the operator
    // cannot tell whether the tier, the weight or the price is the thing that is wrong.
    const pounds = loadWeightModule({ weightUnit: "lb" });
    const kilograms = loadWeightModule({ weightUnit: "kg", weightTiers: servedKilograms });
    expect(pounds.formatPetWeight(672)).toBe("42 lb");
    expect(kilograms.formatPetWeight(672)).toBe("19.1 kg");
    expect(pounds.formatPetWeight(56)).toBe("3.5 lb");
    expect(pounds.formatPetWeight(null)).toBeNull();
  });

  it("reads a typed weight back in the same unit, to the ounce the column holds", () => {
    const kilograms = loadWeightModule({ weightUnit: "kg" });
    expect(kilograms.weightFieldLabel()).toBe("Weight (kg)");
    expect(kilograms.weightInputAttrs()).toBe('min="0.03" step="0.01"');
    // Round trip: the value the form shows must post back to the ounces it came from.
    const shown = kilograms.weightInputValue(672);
    expect(kilograms.ouncesFromWeight(shown)).toBe(672);
    expect(kilograms.ouncesFromWeight("")).toBeNull();
    expect(kilograms.ouncesFromWeight("-3")).toBeNull();
    const pounds = loadWeightModule({ weightUnit: "lb" });
    expect(pounds.weightFieldLabel()).toBe("Weight (lb)");
    expect(pounds.weightInputValue(672)).toBe("42");
    expect(pounds.ouncesFromWeight("42")).toBe(672);
  });

  it("treats an unrecognised unit as pounds rather than dividing by undefined", () => {
    expect(loadWeightModule({ weightUnit: "stone" }).workspaceWeightUnit()).toBe("lb");
    expect(loadWeightModule({ business: { weightUnit: "kg" } }).workspaceWeightUnit()).toBe("kg");
  });
});

/**
 * The appointment move lock, on the client side of the gate.
 *
 * The setting governs whether an appointment can be MOVED - a change to when it starts or who is
 * assigned to it - and nothing else. Two failures are worth a test each: a drag affordance still
 * drawn under the lock, which sends a receptionist into a 409 they cannot act on; and an owner
 * exemption, which is the thing most likely to be reintroduced by somebody who reads the lock as a
 * permission rather than as a policy switch. The server has no owner bypass, so a client-side one
 * would draw the owner a drag that snaps back with no explanation.
 */
interface LockModule {
  appointmentsLocked(): boolean;
  appointmentMoveAllowed(): boolean;
  calendarDragAvailable(): boolean;
  appointmentLockNoteMarkup(testId: string): string;
  appointmentMoveRefused(error: { status?: number; data?: { code?: string } }): boolean;
}

function loadLockModule(
  { lock = "disabled", permissions = ["appointments.edit", "settings.manage"], isOwner = false, finePointer = true } = {}
): LockModule {
  const from = source.indexOf("function appointmentsLocked(){");
  const to = source.indexOf("function calendarDropSlot(");
  if (from < 0 || to <= from) throw new Error("could not slice the appointment-lock block");
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const factory = new Function("state", "escape", "globalThis", `
    "use strict";
    const allowed = (permission) => state.permissionsHeld.includes(permission);
    ${source.slice(from, to)}
    return { appointmentsLocked, appointmentMoveAllowed, calendarDragAvailable,
      appointmentLockNoteMarkup, appointmentMoveRefused };
  `) as (state: unknown, escape: unknown, globals: unknown) => LockModule;
  return factory(
    { me: { business: { appointmentLock: lock }, isOwner }, permissionsHeld: permissions },
    escape,
    { matchMedia: () => ({ matches: finePointer }) }
  );
}

describe("the appointment move lock", () => {
  it("stacks the setting and the permission as an AND", () => {
    // Both must hold. The permission answers who may move an appointment; the setting answers
    // whether anyone may right now.
    expect(loadLockModule().appointmentMoveAllowed()).toBe(true);
    expect(loadLockModule({ lock: "enabled" }).appointmentMoveAllowed()).toBe(false);
    expect(loadLockModule({ permissions: [] }).appointmentMoveAllowed()).toBe(false);
    expect(loadLockModule({ lock: "enabled", permissions: [] }).appointmentMoveAllowed()).toBe(false);
  });

  it("binds owners, because the lock is a policy switch and not a permission", () => {
    // There is no `isOwner` bypass on the server either. A client-side one would draw the person
    // most likely to be testing the lock a drag that snaps back with no explanation.
    const owner = loadLockModule({ lock: "enabled", isOwner: true, permissions: ["appointments.edit", "settings.manage"] });
    expect(owner.appointmentMoveAllowed()).toBe(false);
    expect(owner.calendarDragAvailable()).toBe(false);
  });

  it("takes the drag affordance away rather than letting it reach a 409", () => {
    expect(loadLockModule().calendarDragAvailable()).toBe(true);
    expect(loadLockModule({ lock: "enabled" }).calendarDragAvailable()).toBe(false);
    // The pre-existing coarse-pointer rule is unchanged and still independent of the lock.
    expect(loadLockModule({ finePointer: false }).calendarDragAvailable()).toBe(false);
  });

  it("treats a missing or unset lock as unlocked", () => {
    // `appointmentLock` is `not null` and always present, so this is only reachable through a
    // payload that predates 0047. Defaulting the other way would lock a workspace nobody locked.
    expect(loadLockModule({ lock: "" }).appointmentsLocked()).toBe(false);
    expect(loadLockModule({ lock: "disabled" }).appointmentsLocked()).toBe(false);
    expect(loadLockModule({ lock: "enabled" }).appointmentsLocked()).toBe(true);
  });

  describe("the sentence that replaces the affordance", () => {
    it("explains the lock and points at the fix for somebody who can reach it", () => {
      const markup = loadLockModule({ lock: "enabled" }).appointmentLockNoteMarkup("appointment-lock-note");
      expect(markup).toContain('data-testid="appointment-lock-note"');
      expect(markup).toContain("Appointments are locked from being moved.");
      // U+2192, matching the server's own message.
      expect(markup).toContain("Settings → Business");
      expect(markup).toContain("data-appointment-lock-settings");
    });

    it("drops the pointer for somebody who would be refused at it", () => {
      const staff = loadLockModule({ lock: "enabled", permissions: ["appointments.edit"] });
      const markup = staff.appointmentLockNoteMarkup("appointment-lock-note");
      expect(markup).toContain("Appointments are locked from being moved.");
      // They are being told to ask a manager, which the sentence already says. A link they cannot
      // follow is worse than no link.
      expect(markup).not.toContain("data-appointment-lock-settings");
    });

    it("says nothing to somebody who never had the affordance", () => {
      // Moving appointments is not a groomer's job. An explanation would be noise about a
      // capability they never held, and it is only drawn for the OTHER reason Move is missing.
      expect(loadLockModule({ lock: "enabled", permissions: ["calendar.view"] })
        .appointmentLockNoteMarkup("appointment-lock-note")).toBe("");
      // And nothing at all when there is no lock to explain.
      expect(loadLockModule().appointmentLockNoteMarkup("appointment-lock-note")).toBe("");
    });
  });

  it("recognises the refusal by code and not by its message", () => {
    const lock = loadLockModule();
    expect(lock.appointmentMoveRefused({ status: 409, data: { code: "APPOINTMENT_MOVE_LOCKED" } })).toBe(true);
    // The other refusals on the same endpoint share the status and the shape.
    expect(lock.appointmentMoveRefused({ status: 409, data: { code: "STALE_APPOINTMENT" } })).toBe(false);
    expect(lock.appointmentMoveRefused({ status: 409, data: { code: "SCHEDULING_CONFLICT" } })).toBe(false);
    expect(lock.appointmentMoveRefused({ status: 403, data: {} })).toBe(false);
    expect(lock.appointmentMoveRefused({ status: 500 })).toBe(false);
  });
});
