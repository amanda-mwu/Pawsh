import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "business-settings-secret-at-least-thirty-two",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

/**
 * Settings -> Business, at the tier where the defect actually lived.
 *
 * `businessSettingsSchema` had always kept "absent" and "null" apart - zod does that on its own -
 * so nothing at the schema tier could have caught this. The handler collapsed them with
 * `input.phone ?? null` when it wrote, and only a real save against a real row shows that. Hence
 * a database suite: read the columns back after a save that never mentioned them.
 */
describeDatabase("business settings", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string, businessId: string;

  const me = async () => (await app.inject({
    method: "GET", url: "/api/me", headers: { cookie: ownerCookie }
  })).json();

  const save = async (payload: Record<string, unknown>) => {
    const current = await me();
    return app.inject({
      method: "PUT", url: "/api/business/settings",
      headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
      payload: {
        name: current.business.name, timezone: current.business.timezone,
        taxRateBasisPoints: current.business.taxRateBasisPoints,
        reminderLeadMinutes: current.business.reminderLeadMinutes,
        locationVersion: current.business.locationVersion,
        ...payload
      }
    });
  };

  const stored = async () => (await db<{ phone: string | null; email: string | null; currency: string }[]>`
    select phone,email,currency from businesses where id=${businessId}
  `)[0]!;

  const putHours = (hours: unknown) => app.inject({
    method: "PUT", url: "/api/business/working-hours",
    headers: { cookie: ownerCookie, origin: config.APP_ORIGIN }, payload: { hours }
  });

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `settings-${crypto.randomUUID()}@example.test`,
      password: "correct horse business settings", businessName: "Settings Salon"
    }});
    ownerCookie = cookie(signup);
    ({ businessId } = signup.json());
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe("contact details", () => {
    it("keeps phone and email through a save that only changes the name", async () => {
      const set = await save({ phone: "(267) 320-4180", email: "hello@settings.test" });
      expect(set.statusCode, set.body).toBe(200);
      expect(await stored()).toMatchObject({ phone: "(267) 320-4180", email: "hello@settings.test" });

      // THE REGRESSION. This is the payload every existing client sends: no phone, no email.
      // Before the fix it wrote null over both, so renaming the salon erased its contact details
      // and, with the email, one of the two identities a workspace access request matches an
      // administrator on.
      const renamed = await save({ name: "Settings Salon Renamed" });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(await stored()).toMatchObject({ phone: "(267) 320-4180", email: "hello@settings.test" });
      expect((await me()).business.name).toBe("Settings Salon Renamed");
    });

    it("still clears a field the operator explicitly emptied", async () => {
      // The other half of the distinction. Preserving an omitted field must not cost the ability
      // to clear one on purpose - a blank input and an explicit null both mean "remove it".
      expect((await save({ phone: "" })).statusCode).toBe(200);
      expect((await stored()).phone).toBeNull();
      expect((await save({ email: null })).statusCode).toBe(200);
      expect((await stored()).email).toBeNull();
    });

    it("refuses a malformed email without touching the stored one", async () => {
      await save({ email: "keep@settings.test" });
      const rejected = await save({ email: "not-an-address" });
      expect(rejected.statusCode).toBe(400);
      expect((await stored()).email).toBe("keep@settings.test");
    });
  });

  describe("the address line", () => {
    it("round-trips through the settings surface", async () => {
      const set = await save({ address: " 12 Chestnut Street, Philadelphia, PA " });
      expect(set.statusCode, set.body).toBe(200);
      // Trimmed by the schema, so the column never holds the operator's stray spaces.
      expect((await me()).business.address).toBe("12 Chestnut Street, Philadelphia, PA");
      const [location] = await db<{ address: string | null }[]>`
        select address from locations where business_id=${businessId} and active
      `;
      expect(location?.address).toBe("12 Chestnut Street, Philadelphia, PA");
    });

    it("survives a save that does not mention it, and clears when emptied", async () => {
      await save({ name: "Settings Salon Renamed" });
      expect((await me()).business.address).toBe("12 Chestnut Street, Philadelphia, PA");
      expect((await save({ address: "" })).statusCode).toBe(200);
      expect((await me()).business.address).toBeNull();
    });

    it("enforces the 500-character bound at the schema and at the column", async () => {
      expect((await save({ address: "x".repeat(500) })).statusCode).toBe(200);
      expect((await save({ address: "x".repeat(501) })).statusCode).toBe(400);
      // 0046 is the durable half of that bound. A write that goes round the schema still fails.
      const [location] = await db<{ id: string }[]>`
        select id from locations where business_id=${businessId} and active
      `;
      await expect(
        db`update locations set address=${"x".repeat(501)} where id=${location!.id}`
      ).rejects.toThrow(/location_address_bounded/);
      // A blank string is refused by the same constraint, so null is the only way to say "none".
      await expect(
        db`update locations set address=${"   "} where id=${location!.id}`
      ).rejects.toThrow(/location_address_bounded/);
      await save({ address: null });
    });
  });

  describe("currency", () => {
    it("accepts a supported code and preserves the stored one when omitted", async () => {
      expect((await save({ currency: "cad" })).statusCode).toBe(200);
      expect((await stored()).currency).toBe("CAD");
      await save({ name: "Settings Salon Renamed" });
      expect((await stored()).currency).toBe("CAD");
      await save({ currency: "USD" });
    });

    it("refuses a currency Pawsh cannot represent, leaving the stored one alone", async () => {
      // Real ISO 4217 and still refused: JPY has no minor unit and every Pawsh amount divides by
      // one hundred, so accepting it would misstate every invoice by a factor of a hundred.
      expect((await save({ currency: "JPY" })).statusCode).toBe(400);
      expect((await save({ currency: "ZZZ" })).statusCode).toBe(400);
      expect((await stored()).currency).toBe("USD");
    });

    it("reports the currencies a picker may offer", async () => {
      const currencies = (await me()).supportedCurrencies;
      expect(currencies).toContain("USD");
      expect(currencies).not.toContain("JPY");
    });
  });

  describe("optimistic concurrency and the timezone", () => {
    it("refuses a stale locationVersion with the unchanged 409", async () => {
      const current = await me();
      const rejected = await app.inject({
        method: "PUT", url: "/api/business/settings",
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
        payload: {
          name: "Stale Save", timezone: current.business.timezone,
          phone: "(215) 555-0100",
          taxRateBasisPoints: current.business.taxRateBasisPoints,
          reminderLeadMinutes: current.business.reminderLeadMinutes,
          locationVersion: current.business.locationVersion - 1
        }
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().code).toBe("STALE_LOCATION_SETTINGS");
      // Refused before anything was written, contact field included.
      expect((await me()).business.name).not.toBe("Stale Save");
      expect((await stored()).phone).toBeNull();
    });

    it("moves the timezone and the version together, and refuses an invalid zone", async () => {
      const before = await me();
      const saved = await save({ timezone: "America/Chicago" });
      expect(saved.statusCode, saved.body).toBe(200);
      const after = await me();
      expect(after.business.timezone).toBe("America/Chicago");
      // Every save bumps the version, which is what makes the caller's next save prove it read
      // this one. Scheduling reads the same token.
      expect(after.business.locationVersion).toBe(before.business.locationVersion + 1);
      expect((await save({ timezone: "Mars/Olympus_Mons" })).statusCode).toBe(400);
      expect((await me()).business.timezone).toBe("America/Chicago");
    });
  });

  describe("the working-hours grid", () => {
    it("saves a well-formed week and bumps the location version", async () => {
      const before = await me();
      const saved = await putHours([
        { weekday: 1, startTime: "09:00", endTime: "17:00" },
        { weekday: 2, startTime: "09:00", endTime: "17:00" }
      ]);
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await me()).business.locationVersion).toBe(before.business.locationVersion + 1);
      const read = (await app.inject({
        method: "GET", url: "/api/business/working-hours", headers: { cookie: ownerCookie }
      })).json();
      expect(read).toHaveLength(2);
    });

    it("refuses a day that ends before it starts, naming the day", async () => {
      const rejected = await putHours([{ weekday: 2, startTime: "17:00", endTime: "09:00" }]);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe("INVALID_WORKING_HOURS");
      expect(rejected.json().error).toContain("Tuesday");
    });

    it("refuses a zero-length day", async () => {
      // Not a shorter day - a closed one, and the way to say closed is to leave the day out.
      const rejected = await putHours([{ weekday: 3, startTime: "09:00", endTime: "09:00" }]);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe("INVALID_WORKING_HOURS");
    });

    it("refuses the same weekday twice instead of failing on the unique index", async () => {
      const rejected = await putHours([
        { weekday: 4, startTime: "09:00", endTime: "12:00" },
        { weekday: 4, startTime: "13:00", endTime: "17:00" }
      ]);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe("DUPLICATE_WORKING_HOURS_DAY");
    });

    it("leaves the stored grid and the version untouched when it refuses", async () => {
      // The write is a delete-and-reinsert, so a refusal that arrived after the delete would
      // empty the week. It is checked before the transaction opens.
      const before = await me();
      const stored = (await app.inject({
        method: "GET", url: "/api/business/working-hours", headers: { cookie: ownerCookie }
      })).json();
      expect(await putHours([{ weekday: 2, startTime: "17:00", endTime: "09:00" }])).toMatchObject({ statusCode: 400 });
      const after = (await app.inject({
        method: "GET", url: "/api/business/working-hours", headers: { cookie: ownerCookie }
      })).json();
      expect(after).toEqual(stored);
      expect((await me()).business.locationVersion).toBe(before.business.locationVersion);
    });

    it("applies the same refusal to a groomer's grid", async () => {
      const employeeId = (await app.inject({
        method: "POST", url: "/api/employees",
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
        payload: { displayName: "Ines Duarte" }
      })).json().id;
      const rejected = await app.inject({
        method: "PUT", url: `/api/employees/${employeeId}/working-hours`,
        headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
        payload: { hours: [{ weekday: 5, startTime: "17:00", endTime: "09:00" }] }
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe("INVALID_WORKING_HOURS");
    });
  });

  describe("permission gating", () => {
    it("keeps the save behind settings.manage and the read behind calendar.view", async () => {
      expect((await app.inject({
        method: "PUT", url: "/api/business/settings", payload: { name: "No Session" }
      })).statusCode).toBe(401);
      expect((await app.inject({
        method: "PUT", url: "/api/business/working-hours", payload: { hours: [] }
      })).statusCode).toBe(401);
      expect((await app.inject({
        method: "GET", url: "/api/business/working-hours"
      })).statusCode).toBe(401);
    });

    it("refuses a save aimed at another tenant's business", async () => {
      const foreign = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
        email: `settings-foreign-${crypto.randomUUID()}@example.test`,
        password: "correct horse foreign settings", businessName: "Foreign Settings"
      }});
      const foreignCookie = cookie(foreign);
      const current = await me();
      // The handler resolves the location from the SESSION, never from the payload, so a foreign
      // caller sending this business's version simply misses their own location's version.
      const rejected = await app.inject({
        method: "PUT", url: "/api/business/settings",
        headers: { cookie: foreignCookie, origin: config.APP_ORIGIN },
        payload: {
          name: "Crossed Over", timezone: "America/Chicago", taxRateBasisPoints: 0,
          reminderLeadMinutes: 1440, locationVersion: current.business.locationVersion + 50
        }
      });
      expect(rejected.statusCode).toBe(409);
      expect((await me()).business.name).not.toBe("Crossed Over");
    });
  });

  /**
   * The preference set from 0047, at the tier where storage, the merge and the consumers meet.
   *
   * The schema suite proves the parsed value keeps absent, null and a value apart. These prove the
   * handler acts on that distinction against a real row, that the check constraints are the
   * durable backstop under it, and - for the three preferences that are supposed to CHANGE
   * BEHAVIOUR - that something downstream actually moved.
   */
  describe("preferences", () => {
    const preferences = async () => (await db<Record<string, unknown>[]>`
      select business_type,date_format,hour_format,weight_unit,appointment_lock,
        upcoming_appointment_count,default_service_frequency_weeks,website,
        social_facebook,social_google,social_yelp
      from businesses where id=${businessId}
    `)[0]!;

    it("gives a workspace that predates the columns the behaviour it already had", async () => {
      // Every default is chosen to be TRUE of an existing workspace rather than aspirational. A
      // salon that upgrades and never opens the screen reads the same dates, the same weights and
      // the same prices tomorrow as today.
      expect(await preferences()).toMatchObject({
        businessType: "salon", dateFormat: "MM/DD/YYYY", hourFormat: "12", weightUnit: "lb",
        appointmentLock: "disabled",
        upcomingAppointmentCount: null, defaultServiceFrequencyWeeks: null, website: null
      });
    });

    it("returns every preference on the payload the screen is drawn from", async () => {
      // `/api/me` is where Settings -> Business reads its every other field, so a second endpoint
      // would be a second thing to keep in step with the version bump.
      const business = (await me()).business;
      for (const field of [
        "businessType", "dateFormat", "hourFormat", "weightUnit", "appointmentLock",
        "upcomingAppointmentCount", "defaultServiceFrequencyWeeks",
        "website", "socialFacebook", "socialGoogle", "socialYelp"
      ]) {
        expect(business, field).toHaveProperty(field);
      }
      // And `couponStacking` is NOT here any more. `/api/me` selects `businesses.*`, so dropping
      // the column in 0053 removed the field from this payload; the assertion is kept rather than
      // deleted because its disappearance is the wire change, not an accident of the query.
      expect(business).not.toHaveProperty("couponStacking");
    });

    it("round-trips every preference and preserves it through an unrelated save", async () => {
      const set = await save({
        businessType: "hybrid", dateFormat: "DD/MM/YYYY", hourFormat: "24", weightUnit: "kg",
        appointmentLock: "enabled",
        upcomingAppointmentCount: 7, defaultServiceFrequencyWeeks: 6,
        website: "pawsh.test", socialFacebook: "https://facebook.com/pawsh",
        socialGoogle: "https://g.page/pawsh", socialYelp: "https://yelp.com/biz/pawsh"
      });
      expect(set.statusCode, set.body).toBe(200);
      expect(await preferences()).toMatchObject({
        businessType: "hybrid", dateFormat: "DD/MM/YYYY", hourFormat: "24", weightUnit: "kg",
        appointmentLock: "enabled",
        upcomingAppointmentCount: 7, defaultServiceFrequencyWeeks: 6,
        website: "https://pawsh.test", socialFacebook: "https://facebook.com/pawsh"
      });

      // THE MERGE. The payload every existing client sends mentions none of these, and must leave
      // all twelve exactly as they are - the same rule that already protects phone and email.
      expect((await save({ name: "Preference Salon" })).statusCode).toBe(200);
      expect(await preferences()).toMatchObject({
        businessType: "hybrid", dateFormat: "DD/MM/YYYY", weightUnit: "kg",
        upcomingAppointmentCount: 7, website: "https://pawsh.test"
      });
    });

    it("keeps All, a number and absence apart for the upcoming count", async () => {
      // Null is the VALUE "All" here, not a clear, so this is the one field where an explicit null
      // and an omission must reach the column differently.
      await save({ upcomingAppointmentCount: 12 });
      expect((await preferences()).upcomingAppointmentCount).toBe(12);
      await save({ name: "Preference Salon" });
      expect((await preferences()).upcomingAppointmentCount).toBe(12);
      await save({ upcomingAppointmentCount: null });
      expect((await preferences()).upcomingAppointmentCount).toBeNull();
      await save({ upcomingAppointmentCount: 3 });
      await save({ upcomingAppointmentCount: "All" });
      expect((await preferences()).upcomingAppointmentCount).toBeNull();
    });

    it("clears a link on purpose but never by omission", async () => {
      await save({ website: "https://pawsh.test", socialYelp: "https://yelp.com/biz/pawsh" });
      await save({ name: "Preference Salon" });
      expect((await preferences()).website).toBe("https://pawsh.test");
      await save({ website: "" });
      expect((await preferences()).website).toBeNull();
      expect((await preferences()).socialYelp).toBe("https://yelp.com/biz/pawsh");
    });

    it("refuses a link whose scheme would execute rather than navigate", async () => {
      await save({ socialFacebook: "https://facebook.com/pawsh" });
      const rejected = await save({ socialFacebook: "javascript:alert(document.cookie)" });
      expect(rejected.statusCode).toBe(400);
      // Refused without disturbing the stored one, so a hostile save is not also a destructive one.
      expect((await preferences()).socialFacebook).toBe("https://facebook.com/pawsh");
    });

    it("refuses a value outside an enum without touching the row", async () => {
      await save({ weightUnit: "kg", businessType: "mobile" });
      for (const payload of [
        { weightUnit: "stone" }, { businessType: "franchise" }, { dateFormat: "YYYY-MM-DD" },
        { hourFormat: "36" }, { appointmentLock: "maybe" }
      ]) {
        expect((await save(payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      // `couponStacking` is no longer one of them, and the difference is deliberate rather than an
      // omission: the field left the schema with the column in 0053, and the schema is not
      // `.strict()`, so a client still sending it is IGNORED rather than refused. A 400 here would
      // break every such client on a deploy that removed a setting they cannot see anyway.
      expect((await save({ couponStacking: "both" })).statusCode).toBe(200);
      expect(await preferences()).toMatchObject({ weightUnit: "kg", businessType: "mobile" });
    });

    it("holds every enum at the column as well as at the schema", async () => {
      // 0047 is the durable half. A write that goes round the API still fails, which is what makes
      // these columns safe to read without re-validating.
      for (const [column, value, constraint] of [
        ["business_type", "franchise", "business_type_supported"],
        ["date_format", "YYYY-MM-DD", "business_date_format_supported"],
        ["hour_format", "36", "business_hour_format_supported"],
        ["weight_unit", "stone", "business_weight_unit_supported"],
        ["appointment_lock", "maybe", "business_appointment_lock_supported"]
      ] as const) {
        await expect(
          db.unsafe(`update businesses set ${column}=$1 where id=$2`, [value, businessId]),
          column
        ).rejects.toThrow(new RegExp(constraint));
      }
      for (const [column, value, constraint] of [
        ["upcoming_appointment_count", 21, "business_upcoming_appointment_count_range"],
        ["default_service_frequency_weeks", 105, "business_default_service_frequency_range"]
      ] as const) {
        await expect(
          db.unsafe(`update businesses set ${column}=$1 where id=$2`, [value, businessId]),
          column
        ).rejects.toThrow(new RegExp(constraint));
      }
      // Blank is refused the same way `locations.address` refuses it, so null is the one way to
      // say "not recorded".
      await expect(
        db.unsafe("update businesses set website=$1 where id=$2", ["   ", businessId])
      ).rejects.toThrow(/business_website_bounded/);
    });

    it("records only the preferences that actually moved", async () => {
      // Both fields are put in a known state first, so what follows asserts the handler's
      // did-it-move rule rather than whatever an earlier test in this file happened to leave.
      await save({ weightUnit: "lb", currency: "USD", appointmentLock: "disabled" });
      const before = (await db<{ count: number }[]>`
        select count(*)::int from audit_events
        where business_id=${businessId} and action='business.settings.update'
      `)[0]!.count;

      // A save that changes nothing but the name writes no `changed` block at all, rather than a
      // dozen unchanged nulls.
      await save({ name: "Preference Salon" });
      const [rename] = await db<{ afterData: Record<string, unknown> }[]>`
        select after_data from audit_events where business_id=${businessId}
          and action='business.settings.update' order by created_at desc limit 1
      `;
      expect(rename!.afterData).not.toHaveProperty("changed");

      await save({ weightUnit: "kg", appointmentLock: "enabled" });
      const [changed] = await db<{ afterData: { changed?: Record<string, unknown> } }[]>`
        select after_data from audit_events where business_id=${businessId}
          and action='business.settings.update' order by created_at desc limit 1
      `;
      // Both are worth a trail for different reasons: `weightUnit` changes how every price band
      // and pet weight READS without changing a stored number, which later looks like corruption
      // to whoever did not make the edit.
      expect(changed!.afterData.changed).toMatchObject({
        weightUnit: { before: "lb", after: "kg" },
        appointmentLock: { before: "disabled", after: "enabled" }
      });
      // And nothing the caller did not send is claimed to have changed.
      expect(Object.keys(changed!.afterData.changed!).sort()).toEqual(["appointmentLock", "weightUnit"]);
      expect((await db<{ count: number }[]>`
        select count(*)::int from audit_events
        where business_id=${businessId} and action='business.settings.update'
      `)[0]!.count).toBe(before + 2);
    });

    /**
     * The consumer that would be easiest to fake and worst to fake.
     *
     * `pets.weight_ounces` stays canonical, so switching the unit must change what an operator
     * READS and nothing an invoice is computed from. The trap is converting a pet's weight without
     * converting the price-tier band captions, which are themselves defined in pounds - that puts
     * a kilogram weight under a pound-captioned column and makes the screen unreadable.
     */
    describe("the weight unit", () => {
      it("converts the tier captions along with the unit", async () => {
        await save({ weightUnit: "lb" });
        const pounds = await me();
        expect(pounds.weightUnit).toBe("lb");
        expect(pounds.weightTiers.map((tier: { label: string }) => tier.label)).toEqual([
          "1–20 lb", "21–40 lb", "41–60 lb", "61–80 lb", "81–100 lb", "100+ lb"
        ]);

        const saved = await save({ weightUnit: "kg" });
        expect(saved.statusCode, saved.body).toBe(200);
        // Returned with the save as well as on `/api/me`, so a workspace that switches does not
        // show converted weights against pound captions until its next refetch.
        expect(saved.json().weightTiers.map((tier: { label: string }) => tier.label)).toEqual([
          "0.1–9.1 kg", "9.2–18.1 kg", "18.2–27.2 kg", "27.3–36.3 kg", "36.4–45.4 kg", "45.4+ kg"
        ]);
        const kilograms = await me();
        expect(kilograms.weightUnit).toBe("kg");
        expect(kilograms.weightTiers[0].label).toBe("0.1–9.1 kg");
        // The bounds themselves are published unconverted, because ounces are what the pricing
        // comparison uses and a client should not have to reconstruct them from a caption.
        expect(kilograms.weightTiers[0]).toMatchObject({
          code: "TIER_1", minExclusiveOunces: 0, maxOunces: 320
        });
      });

      it("does not move a price or a tier when it changes", async () => {
        // The property that makes this safe to be a presentation setting at all.
        const post = (url: string, payload: Record<string, unknown>) =>
          app.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
        const serviceId = (await post("/api/services", {
          name: `Tiered Groom ${crypto.randomUUID().slice(0, 8)}`,
          baseDurationMinutes: 60, basePriceMinor: 8000, pricingMode: "WEIGHT_TIER"
        })).json().id;
        const customerId = (await post("/api/customers", { firstName: "Wendy", lastName: "Weight" }))
          .json().id;
        // 672 ounces is 42 lb, which is 19.05 kg: tier 3 either way.
        const petId = (await post("/api/pets", {
          customerId, name: "Kilo", species: "dog", weightOunces: 672
        })).json().id;
        const priced = await app.inject({
          method: "PUT", url: `/api/services/${serviceId}/pricing`,
          headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
          payload: { prices: [{ pricingClass: "STANDARD", weightTierCode: "TIER_3", priceMinor: 9500 }] }
        });
        expect(priced.statusCode, priced.body).toBe(200);
        const quote = async () => (await app.inject({
          method: "POST", url: "/api/pricing/resolve",
          headers: { cookie: ownerCookie, origin: config.APP_ORIGIN },
          payload: { petId, serviceIds: [serviceId] }
        })).json();

        await save({ weightUnit: "lb" });
        const pounds = await quote();
        await save({ weightUnit: "kg" });
        const kilograms = await quote();

        expect(pounds[0].priceMinor).toBe(9500);
        expect(kilograms[0].priceMinor).toBe(pounds[0].priceMinor);
        expect(kilograms[0].weightTierCode).toBe(pounds[0].weightTierCode);
        // The one thing that moves is the caption, and it captions the tier the pet resolved into.
        expect(pounds[0].weightTierLabel).toBe("41–60 lb");
        expect(kilograms[0].weightTierLabel).toBe("18.2–27.2 kg");
        await save({ weightUnit: "lb" });
      });
    });

    it("seeds a new client's booking cadence from the salon's default", async () => {
      // What `defaultServiceFrequencyWeeks` MEANS, wired so it is not a number nobody reads.
      await save({ defaultServiceFrequencyWeeks: 6 });
      const seeded = await app.inject({
        method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
        payload: { firstName: "Freda", lastName: "Frequency" }
      });
      expect(seeded.statusCode).toBe(201);
      expect(seeded.json().bookingFrequencyWeeks).toBe(6);

      // EXISTING CLIENTS ARE NOT TOUCHED. A cadence already set for a specific dog is not a
      // default and must not be overwritten when the default moves.
      await save({ defaultServiceFrequencyWeeks: 10 });
      const [unchanged] = await db<{ bookingFrequencyWeeks: number | null }[]>`
        select booking_frequency_weeks from customers where id=${seeded.json().id}
      `;
      expect(unchanged!.bookingFrequencyWeeks).toBe(6);

      // And a workspace that has set no default still seeds null, exactly as before.
      await save({ defaultServiceFrequencyWeeks: null });
      const unseeded = await app.inject({
        method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
        payload: { firstName: "Nora", lastName: "None" }
      });
      expect(unseeded.json().bookingFrequencyWeeks).toBeNull();
    });

    it("keeps one workspace's preferences out of another's", async () => {
      const foreign = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
        email: `settings-prefs-${crypto.randomUUID()}@example.test`,
        password: "correct horse other preferences", businessName: "Other Preferences"
      }});
      const foreignCookie = cookie(foreign);
      await save({ weightUnit: "kg", dateFormat: "DD/MM/YYYY", businessType: "mobile" });

      // The neighbour keeps the defaults, and its own save does not reach across.
      const theirs = (await app.inject({
        method: "GET", url: "/api/me", headers: { cookie: foreignCookie }
      })).json();
      expect(theirs.business.weightUnit).toBe("lb");
      expect(theirs.business.dateFormat).toBe("MM/DD/YYYY");
      expect(theirs.weightTiers[0].label).toBe("1–20 lb");

      await app.inject({
        method: "PUT", url: "/api/business/settings",
        headers: { cookie: foreignCookie, origin: config.APP_ORIGIN },
        payload: {
          name: theirs.business.name, timezone: theirs.business.timezone,
          taxRateBasisPoints: 0, reminderLeadMinutes: 1440,
          locationVersion: theirs.business.locationVersion,
          weightUnit: "lb", businessType: "hybrid"
        }
      });
      expect(await preferences()).toMatchObject({ weightUnit: "kg", businessType: "mobile" });
      await save({ weightUnit: "lb", dateFormat: "MM/DD/YYYY" });
    });

    it("keeps the preference save behind settings.manage", async () => {
      // The same gate the rest of this screen is behind; asserted because the payload grew.
      expect((await app.inject({
        method: "PUT", url: "/api/business/settings",
        payload: { name: "No Session", weightUnit: "kg" }
      })).statusCode).toBe(401);
    });
  });
});
