import { describe, expect, it } from "vitest";
import { businessSettingsSchema, workingHoursSchema } from "../../src/http/schemas.js";
import {
  currenciesWithoutMinorUnitDisplay, formatMinor, isSupportedCurrency, supportedCurrencies
} from "@pawsh/domain";

/**
 * The absent-versus-null distinction, tested at the layer that has to preserve it.
 *
 * The nulling defect was half a schema problem and half a handler problem: `nullish()` collapsed
 * the two cases in the reader's mind while zod had in fact kept them apart, and the handler's
 * `?? null` then threw the distinction away. The database tier proves the column survives a save;
 * these prove the parsed value still carries the difference for the handler to act on, which is
 * the part that can be checked without a database.
 */
const base = {
  name: "Pawsh Salon",
  timezone: "America/Los_Angeles",
  taxRateBasisPoints: 825,
  reminderLeadMinutes: 1440,
  locationVersion: 3
};

describe("businessSettingsSchema", () => {
  it("leaves an omitted contact field undefined rather than null", () => {
    const parsed = businessSettingsSchema.parse({ ...base });
    // `undefined` is the handler's signal to leave the stored column alone. If either of these
    // came back null the save would clear a column the caller never mentioned, which is exactly
    // the defect: no client has ever sent phone or email, so every save wiped both.
    expect(parsed.phone).toBeUndefined();
    expect(parsed.email).toBeUndefined();
    expect(parsed.address).toBeUndefined();
    expect(parsed.currency).toBeUndefined();
  });

  it("treats an explicit null and a blank string as a deliberate clear", () => {
    const cleared = businessSettingsSchema.parse({ ...base, phone: null, email: "", address: "   " });
    expect(cleared.phone).toBeNull();
    // A blank string is a cleared field, not a validation error, matching `customerSchema.phone`
    // and `staffPhoneField`. One phone-and-email convention across the codebase.
    expect(cleared.email).toBeNull();
    expect(cleared.address).toBeNull();
  });

  it("keeps a sent contact field, trimmed", () => {
    const parsed = businessSettingsSchema.parse({
      ...base, phone: " (267) 320-4180 ", email: " hello@pawsh.test ",
      address: " 12 Chestnut Street, Philadelphia, PA "
    });
    expect(parsed.phone).toBe("(267) 320-4180");
    expect(parsed.email).toBe("hello@pawsh.test");
    expect(parsed.address).toBe("12 Chestnut Street, Philadelphia, PA");
  });

  it("refuses a malformed email rather than storing it", () => {
    expect(businessSettingsSchema.safeParse({ ...base, email: "not-an-address" }).success).toBe(false);
  });

  it("bounds the address at the 500 characters the column allows", () => {
    expect(businessSettingsSchema.safeParse({ ...base, address: "x".repeat(500) }).success).toBe(true);
    expect(businessSettingsSchema.safeParse({ ...base, address: "x".repeat(501) }).success).toBe(false);
  });

  it("accepts a supported currency in any case and refuses an unsupported one", () => {
    expect(businessSettingsSchema.parse({ ...base, currency: "cad" }).currency).toBe("CAD");
    // Well-formed, real ISO 4217, and still refused: JPY has no minor unit, so every price in the
    // product - which divides by one hundred unconditionally - would read a hundredfold low.
    expect(businessSettingsSchema.safeParse({ ...base, currency: "JPY" }).success).toBe(false);
    expect(businessSettingsSchema.safeParse({ ...base, currency: "ZZZ" }).success).toBe(false);
    expect(businessSettingsSchema.safeParse({ ...base, currency: "US" }).success).toBe(false);
  });

  it("still requires the fields the save has always required", () => {
    for (const missing of ["name", "timezone", "taxRateBasisPoints", "reminderLeadMinutes", "locationVersion"]) {
      const payload: Record<string, unknown> = { ...base };
      delete payload[missing];
      expect(businessSettingsSchema.safeParse(payload).success, missing).toBe(false);
    }
  });
});

/**
 * The preference set added in 0047, at the tier that decides what a save is allowed to say.
 *
 * The three cases every one of these fields has to keep apart are OMITTED, EXPLICIT NULL and a
 * VALUE, because the handler branches on exactly that distinction. A field that collapsed absent
 * into null would clear a column on every save that did not mention it - which is the defect the
 * suite above exists for, arriving through a new door.
 */
describe("businessSettingsSchema preferences", () => {
  const enumFields = {
    businessType: ["mobile", "salon", "hybrid"],
    dateFormat: ["MM/DD/YYYY", "DD/MM/YYYY"],
    hourFormat: ["12", "24"],
    weightUnit: ["lb", "kg"],
    appointmentLock: ["enabled", "disabled"],
    couponStacking: ["single", "amount_first", "percentage_first"]
  } as const;

  it("accepts every value of every enum, verbatim", () => {
    // Verbatim matters: these strings are the wire value, the parsed value AND the stored value,
    // with no mapping layer between them and the check constraints in 0047. A transformation here
    // would be a translation table that could disagree with the database.
    for (const [field, values] of Object.entries(enumFields)) {
      for (const value of values) {
        const parsed = businessSettingsSchema.parse({ ...base, [field]: value });
        expect(parsed[field as keyof typeof parsed], `${field}=${value}`).toBe(value);
      }
    }
  });

  it("refuses a value outside an enum instead of storing it", () => {
    for (const [field, values] of Object.entries(enumFields)) {
      expect(businessSettingsSchema.safeParse({ ...base, [field]: "nonsense" }).success, field)
        .toBe(false);
      // Case matters too - the column stores what arrives, and 'LB' would fail the check
      // constraint at the database rather than here, which is the wrong layer to find out.
      expect(
        businessSettingsSchema.safeParse({ ...base, [field]: values[0]!.toUpperCase() }).success,
        field
      ).toBe(values[0] === values[0]!.toUpperCase());
    }
  });

  it("leaves an omitted preference undefined so the stored value survives", () => {
    const parsed = businessSettingsSchema.parse({ ...base });
    for (const field of Object.keys(enumFields)) {
      expect(parsed[field as keyof typeof parsed], field).toBeUndefined();
    }
    expect(parsed.upcomingAppointmentCount).toBeUndefined();
    expect(parsed.defaultServiceFrequencyWeeks).toBeUndefined();
    expect(parsed.website).toBeUndefined();
    expect(parsed.socialFacebook).toBeUndefined();
  });

  it("refuses to clear a preference that has no null", () => {
    // There is no "no weight unit". These are `not null` columns over closed sets, so null is not
    // a value a caller may choose, and saying so here is better than a constraint violation the
    // error handler can only render as "violates a data integrity rule".
    for (const field of Object.keys(enumFields)) {
      expect(businessSettingsSchema.safeParse({ ...base, [field]: null }).success, field).toBe(false);
    }
  });

  describe("upcomingAppointmentCount", () => {
    it("keeps All, a number, and absence as three distinct answers", () => {
      // Null IS the value "All" here rather than a clear, which is what makes this field different
      // from every other nullable one on the schema. Absence still means "do not touch it".
      expect(businessSettingsSchema.parse({ ...base }).upcomingAppointmentCount).toBeUndefined();
      expect(businessSettingsSchema.parse({ ...base, upcomingAppointmentCount: null })
        .upcomingAppointmentCount).toBeNull();
      expect(businessSettingsSchema.parse({ ...base, upcomingAppointmentCount: 5 })
        .upcomingAppointmentCount).toBe(5);
    });

    it("accepts the literal All a picker holds, in any case", () => {
      for (const spelling of ["All", "all", "ALL", " All "]) {
        expect(
          businessSettingsSchema.parse({ ...base, upcomingAppointmentCount: spelling })
            .upcomingAppointmentCount, spelling
        ).toBeNull();
      }
    });

    it("bounds a number at the range the picker offers", () => {
      for (const value of [1, 20]) {
        expect(businessSettingsSchema.safeParse({ ...base, upcomingAppointmentCount: value }).success,
          String(value)).toBe(true);
      }
      for (const value of [0, 21, -1, 2.5, "seven"]) {
        expect(businessSettingsSchema.safeParse({ ...base, upcomingAppointmentCount: value }).success,
          String(value)).toBe(false);
      }
    });
  });

  describe("defaultServiceFrequencyWeeks", () => {
    it("takes exactly the range of the column it is the default for", () => {
      // `customers.booking_frequency_weeks` is bounded 1-104 by 0019. A business default outside
      // that range would save here and then fail on the row it seeds.
      for (const value of [1, 6, 104]) {
        expect(businessSettingsSchema.safeParse({ ...base, defaultServiceFrequencyWeeks: value })
          .success, String(value)).toBe(true);
      }
      for (const value of [0, 105, 1.5]) {
        expect(businessSettingsSchema.safeParse({ ...base, defaultServiceFrequencyWeeks: value })
          .success, String(value)).toBe(false);
      }
    });

    it("may be cleared back to no default", () => {
      expect(businessSettingsSchema.parse({ ...base, defaultServiceFrequencyWeeks: null })
        .defaultServiceFrequencyWeeks).toBeNull();
    });
  });

  describe("website and the social links", () => {
    const linkFields = ["website", "socialFacebook", "socialGoogle", "socialYelp"] as const;

    it("refuses a scheme that would execute rather than navigate", () => {
      // The security bound, and the reason these are not a bare `z.url()`. `javascript:alert(1)`
      // IS a well-formed URL and zod accepts it unrestricted. These four fields exist to be
      // rendered as links, so an unrestricted one is stored XSS with the settings screen as the
      // injection point. No downstream escaping saves an href whose scheme is the payload.
      for (const field of linkFields) {
        for (const hostile of [
          "javascript:alert(1)", "JavaScript:alert(document.cookie)",
          "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd"
        ]) {
          expect(businessSettingsSchema.safeParse({ ...base, [field]: hostile }).success,
            `${field}: ${hostile}`).toBe(false);
        }
      }
    });

    it("accepts an http or https link and keeps it verbatim", () => {
      const parsed = businessSettingsSchema.parse({
        ...base,
        website: "https://pawsh.test/book",
        socialFacebook: "http://facebook.com/pawsh"
      });
      expect(parsed.website).toBe("https://pawsh.test/book");
      expect(parsed.socialFacebook).toBe("http://facebook.com/pawsh");
    });

    it("prefixes a bare host rather than refusing it", () => {
      // Nobody types a scheme into a "Yelp page" box. Rejecting the absence of eight characters
      // teaches an operator the form is broken.
      expect(businessSettingsSchema.parse({ ...base, socialYelp: "www.yelp.com/biz/pawsh" })
        .socialYelp).toBe("https://www.yelp.com/biz/pawsh");
    });

    it("does not rescue a hostile scheme into a safe one by prefixing it", () => {
      // The prefix applies only when NO scheme is present. If it applied to anything unrecognised,
      // `javascript:alert(1)` would become `https://javascript:alert(1)` and pass.
      const parsed = businessSettingsSchema.safeParse({ ...base, website: "javascript:alert(1)" });
      expect(parsed.success).toBe(false);
    });

    it("treats blank as a deliberate clear and absence as leave-alone", () => {
      for (const field of linkFields) {
        expect(businessSettingsSchema.parse({ ...base, [field]: "" })[field]).toBeNull();
        expect(businessSettingsSchema.parse({ ...base, [field]: "   " })[field]).toBeNull();
        expect(businessSettingsSchema.parse({ ...base, [field]: null })[field]).toBeNull();
        expect(businessSettingsSchema.parse({ ...base })[field]).toBeUndefined();
      }
    });

    it("bounds a link at the 500 characters the column allows", () => {
      const long = `https://pawsh.test/${"x".repeat(500)}`;
      expect(businessSettingsSchema.safeParse({ ...base, website: long }).success).toBe(false);
    });
  });
});

describe("supported currencies", () => {
  /**
   * ICU's fraction digits for a code, which is CLDR's DISPLAY convention and not ISO's exponent.
   * The gap between the two is the whole subtlety of this suite.
   */
  const displayDigits = (currency: string) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits;

  it("offers only currencies Pawsh's two-decimal money model can represent", () => {
    // The membership rule, checked against the only oracle available offline. `Intl` reports the
    // number of decimals a place SHOWS, which for most currencies equals the ISO 4217 minor unit
    // and is therefore a real check: a zero-decimal code like JPY or a three-decimal one like KWD
    // slipping into the tuple fails here, and that is the class of mistake that puts a number off
    // by a factor of a hundred on an invoice.
    //
    // Fifteen members are known to disagree, and they are ENUMERATED rather than tolerated. Their
    // ISO minor unit is two - a hundred pul really is one afghani - while CLDR formats them with
    // no decimals because the subunit has been inflated out of use. Listing them by name is what
    // keeps this assertion honest: the check is not weakened to "0 or 2", which would let JPY in;
    // it is weakened for exactly fifteen named codes and no others.
    //
    // The count is not fixed by nature: CLDR changes, and a newer ICU printing a supported code
    // without its decimals fails this assertion by name. That is the intended signal, and the fix
    // is to decide whether the code belongs on the exception list or out of the tuple - never to
    // relax the comparison. `COP` arrived that way.
    for (const currency of supportedCurrencies) {
      const expected = (currenciesWithoutMinorUnitDisplay as readonly string[]).includes(currency)
        ? 0 : 2;
      expect(displayDigits(currency), currency).toBe(expected);
    }
  });

  it("names no exception that is not itself a supported currency", () => {
    // Guards the loophole in the test above: an exception list allowed to grow beyond the tuple
    // could be used to excuse a code that should never have been added at all.
    for (const currency of currenciesWithoutMinorUnitDisplay) {
      expect(supportedCurrencies as readonly string[], currency).toContain(currency);
    }
    expect(new Set(currenciesWithoutMinorUnitDisplay).size)
      .toBe(currenciesWithoutMinorUnitDisplay.length);
  });

  it("excludes every currency whose ISO minor unit is not two", () => {
    // Named individually because these are the codes an operator would most plausibly ask for and
    // that a future edit would most plausibly wave through. Each would be wrong by a factor of a
    // hundred (zero-decimal) or ten (three-decimal) on every invoice, payment and refund.
    for (const zeroDecimal of ["JPY", "KRW", "CLP", "ISK", "VND", "XAF", "XOF", "PYG", "RWF"]) {
      expect(isSupportedCurrency(zeroDecimal), zeroDecimal).toBe(false);
    }
    for (const threeDecimal of ["KWD", "BHD", "OMR", "JOD", "TND", "LYD", "IQD"]) {
      expect(isSupportedCurrency(threeDecimal), threeDecimal).toBe(false);
    }
    // Four decimals, and the non-currency codes: precious metals, IMF drawing rights, the test
    // and no-currency placeholders. All are real ISO 4217 codes and none is money a salon bills.
    for (const other of ["CLF", "UYW", "XAU", "XAG", "XDR", "XTS", "XXX"]) {
      expect(isSupportedCurrency(other), other).toBe(false);
    }
  });

  it("excludes fund and settlement codes even though their minor unit is two", () => {
    // The third clause of the membership rule. These pass the money-model test and are still not
    // currencies: they are accounting units for securities settlement and inflation indexing.
    for (const fund of ["USN", "BOV", "CHE", "CHW", "COU", "MXV"]) {
      expect(isSupportedCurrency(fund), fund).toBe(false);
    }
  });

  it("excludes codes ICU still carries that ISO 4217 has withdrawn", () => {
    // Each was replaced by something that IS here, or by the euro. A picker offering a currency
    // that no longer exists is a picker a salon can pick wrong from.
    for (const withdrawn of ["ANG", "HRK", "CUC", "SLL", "ZWL"]) {
      expect(isSupportedCurrency(withdrawn), withdrawn).toBe(false);
    }
    for (const successor of ["XCG", "EUR", "SLE", "ZWG"]) {
      expect(isSupportedCurrency(successor), successor).toBe(true);
    }
  });

  it("carries every code the settings screen was specified against", () => {
    for (const currency of ["AFN", "EUR", "ALL", "DZD", "USD", "AOA", "XCD", "ARS"]) {
      expect(isSupportedCurrency(currency), currency).toBe(true);
    }
  });

  it("keeps every currency the workspace could already be set to", () => {
    // The list this replaced. A workspace already storing one of these must not find its own
    // currency missing from the picker and be unable to save the screen.
    const previouslySupported = [
      "USD", "CAD", "EUR", "GBP", "AUD", "NZD", "MXN", "CHF", "SEK", "NOK", "DKK",
      "PLN", "CZK", "ZAR", "AED", "ILS", "INR", "SGD", "HKD", "PHP", "BRL"
    ];
    for (const currency of previouslySupported) {
      expect(isSupportedCurrency(currency), currency).toBe(true);
    }
  });

  it("is sorted, unique, and well-formed", () => {
    expect([...supportedCurrencies]).toEqual([...supportedCurrencies].sort());
    expect(new Set(supportedCurrencies).size).toBe(supportedCurrencies.length);
    for (const currency of supportedCurrencies) expect(currency).toMatch(/^[A-Z]{3}$/);
  });

  it("formats a whole minor-unit amount without rounding it away", () => {
    // The consequence of admitting the twelve CLDR-zero-decimal codes, and the reason `formatMinor`
    // pins its fraction digits. Unpinned, this printed "AFN 13" - the caller's exact integer
    // rounded off on a document a client pays against.
    expect(formatMinor(1250, "AFN")).toContain("12.50");
    expect(formatMinor(1250, "ALL")).toContain("12.50");
    // And the currencies that were always fine are untouched.
    expect(formatMinor(1250, "USD")).toBe("$12.50");
    expect(formatMinor(0, "EUR")).toContain("0.00");
  });

  it("derives its membership test from the tuple", () => {
    expect(supportedCurrencies.every(isSupportedCurrency)).toBe(true);
    expect(isSupportedCurrency("JPY")).toBe(false);
    // Uppercase only; the schema is what normalises case before this is consulted.
    expect(isSupportedCurrency("usd")).toBe(false);
  });
});

describe("workingHoursSchema", () => {
  it("no longer refuses an inverted period in the schema layer", () => {
    // Deliberate: the ordering check moved to `refuseInvalidWorkingHours` in the handlers so the
    // refusal can carry a code and name the day, the same reasoning `LIMIT_NOT_CONFIGURABLE`
    // already follows. The schema is left to decide shape. If this ever starts failing, the check
    // has been reintroduced here and the handlers' coded refusals have become unreachable.
    expect(workingHoursSchema.safeParse({ hours: [{ weekday: 2, startTime: "17:00", endTime: "09:00" }] }).success)
      .toBe(true);
  });

  it("still refuses a malformed time or weekday", () => {
    expect(workingHoursSchema.safeParse({ hours: [{ weekday: 7, startTime: "09:00", endTime: "17:00" }] }).success)
      .toBe(false);
    expect(workingHoursSchema.safeParse({ hours: [{ weekday: 1, startTime: "9:00", endTime: "17:00" }] }).success)
      .toBe(false);
    expect(workingHoursSchema.safeParse({ hours: [{ weekday: 1, startTime: "09:00", endTime: "24:00" }] }).success)
      .toBe(false);
  });
});
