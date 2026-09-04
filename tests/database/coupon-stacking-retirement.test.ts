import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { tokenHash } from "../../src/http/context.js";
import { roleFor } from "../support/roles.js";

/**
 * ONE STACKING AUTHORITY, and it is the one that moves money.
 *
 * Two columns carried the same three-valued rule. `businesses.discount_stacking_mode` (0048) is
 * read by every discount calculation in the product. `businesses.coupon_stacking` (0047) had no
 * money consumer at all: `PUT /api/business/settings` wrote it and read it back only to name it in
 * an audit entry, and the Business Settings control that fed it sat under copy promising the
 * choice would take effect when coupons shipped. Coupons shipped, against the other column.
 *
 * `single` and `one_per_appointment` were the same rule spelled twice; `amount_first` and
 * `percentage_first` were spelled identically. They were never separate concepts.
 *
 * WHAT THIS SUITE HOLDS. That the retired column and its named constraint are gone from a database
 * migrated from empty; that the drop is safe to run against a database that still has them and
 * takes nothing else with it; that no route can change stacking except the one attached to the
 * money; that the permission is `settings.discounts` and that `settings.manage` alone will not do;
 * and that a real bill follows the surviving value.
 *
 * NO VALUE WAS COPIED INTO THE FINANCIAL AUTHORITY. That is the safety property of the whole
 * change and it is asserted below rather than assumed: on the database this was written against,
 * one workspace held `coupon_stacking = 'percentage_first'` while billing under
 * `discount_stacking_mode = 'one_per_appointment'`. Copying would have moved that workspace's
 * bills. Existing effective billing behaviour wins over an obsolete inert setting.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "coupon-stacking-retirement-secret-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

/** Thrown to roll a transaction back once its assertions have been gathered. */
class Rollback extends Error {}

describeDatabase("the retirement of coupon_stacking", () => {
  let db: Database, app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie = "", managerCookie = "", discounterCookie = "";
  let businessId = "", locationId = "", employeeId = "", serviceId = "";
  let customerId = "", petId = "";
  const suffix = crypto.randomUUID().slice(0, 8);

  const stackingMode = async () => {
    const [row] = await db<{ discountStackingMode: string }[]>`
      select discount_stacking_mode from businesses where id=${businessId}
    `;
    return row!.discountStackingMode;
  };

  const setStacking = (mode: string, session = ownerCookie) => app.inject({
    method: "PUT", url: "/api/settings/discount-stacking",
    headers: { cookie: session }, payload: { stackingMode: mode }
  });

  const saveBusinessSettings = async (payload: Record<string, unknown>, session = ownerCookie) => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: session } });
    return app.inject({
      method: "PUT", url: "/api/business/settings",
      headers: { cookie: session, origin: config.APP_ORIGIN },
      payload: {
        name: `Stacking Salon ${suffix}`, timezone: "America/Los_Angeles",
        taxRateBasisPoints: 0, reminderLeadMinutes: 1440,
        locationVersion: me.json().business.locationVersion, ...payload
      }
    });
  };

  const seatMember = async (label: string, permissions: readonly string[]) => {
    const token = crypto.randomUUID();
    const email = `${label}-${suffix}@example.test`;
    const [member] = await db<{ userId: string }[]>`
      with account as (
        insert into users(email,normalized_email,password_hash)
        values (${email},${email},${await hashPassword("correct horse stacking member")})
        returning id
      )
      insert into business_memberships(business_id,user_id,role_id)
      select ${businessId},id,${await roleFor(db, businessId, permissions)} from account
      returning user_id
    `;
    await db`
      insert into sessions(user_id,token_hash,expires_at)
      values (${member!.userId},${tokenHash(token)},now()+interval '1 day')
    `;
    return `pawsh_session=${token}`;
  };

  /** A completed $100 appointment, ready to be checked out. */
  let day = 3;
  const completedAppointment = async () => {
    const date = `2034-05-${String((day += 1)).padStart(2, "0")}`;
    const startAtUtc = `${date}T16:00:00.000Z`;
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${customerId},${petId},${employeeId},
        ${startAtUtc}::timestamptz,${startAtUtc}::timestamptz + interval '1 hour','America/Los_Angeles',
        ${startAtUtc}::timestamptz at time zone 'America/Los_Angeles',-420,'completed',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Stacking Groom',60,10000)
    `;
    return appointment!.id;
  };

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      email: `stacking-owner-${suffix}@example.test`,
      password: "correct horse stacking owner", businessName: `Stacking Salon ${suffix}`
    }});
    expect(signup.statusCode, signup.body).toBe(201);
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    // Zero tax so the assertions below are about the discount arithmetic and nothing else.
    await db`update businesses set tax_rate_basis_points=0 where id=${businessId}`;

    serviceId = (await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: `Stacking Groom ${suffix}`, baseDurationMinutes: 60, basePriceMinor: 10000 }
    })).json().id;
    employeeId = (await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: `Stacking Groomer ${suffix}`, serviceIds: [serviceId] }
    })).json().id;
    customerId = (await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Stack", lastName: "Client", preferredContactMethod: "none", emailAllowed: false }
    })).json().id;
    petId = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Stack Pet", species: "dog" }
    })).json().id;

    // The two permissions the retirement moves stacking BETWEEN, seated separately so neither can
    // borrow the other's authority.
    managerCookie = await seatMember("stacking-manager", ["settings.manage", "settings.view"]);
    discounterCookie = await seatMember("stacking-discounter",
      ["settings.discounts", "settings.view", "checkout.perform", "payments.view", "discounts.apply"]);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe("a database migrated from empty", () => {
    it("has no coupon_stacking column and no constraint named for it", async () => {
      const [column] = await db<{ count: number }[]>`
        select count(*)::int as count from information_schema.columns
        where table_name='businesses' and column_name='coupon_stacking'
      `;
      const [constraint] = await db<{ count: number }[]>`
        select count(*)::int as count from pg_constraint
        where conname='business_coupon_stacking_supported'
      `;
      expect({ column: column!.count, constraint: constraint!.count }).toEqual({ column: 0, constraint: 0 });
    });

    it("keeps the surviving authority, its default and its own check constraint", async () => {
      // The point of the drop is that ONE of the two survives intact. A migration that took the
      // wrong column, or took the right column's constraint with it, would still leave zero rows
      // above and has to be caught here.
      const [column] = await db<{ dataType: string; columnDefault: string; isNullable: string }[]>`
        select data_type,column_default,is_nullable from information_schema.columns
        where table_name='businesses' and column_name='discount_stacking_mode'
      `;
      expect(column).toMatchObject({ dataType: "text", isNullable: "NO" });
      expect(column!.columnDefault).toContain("one_per_appointment");
      await expect(db`
        update businesses set discount_stacking_mode='single' where id=${businessId}
      `).rejects.toThrow(/discount_stacking_mode/);
      // 'single' was `coupon_stacking`'s spelling of this rule and is not this column's, which is
      // the clearest possible statement that the two vocabularies did not merge.
      expect(await stackingMode()).toBe("one_per_appointment");
    });
  });

  describe("upgrading a database that still has the column", () => {
    /**
     * The real migration file, run against a `businesses` table put back the way 0047 left it,
     * inside a transaction that is rolled back so the suite's own schema is untouched.
     *
     * `begin;` and `commit;` are stripped because the statements run INSIDE an open transaction
     * here; leaving them would commit the outer one and defeat the rollback. Everything between
     * them is the file verbatim.
     */
    it("drops the column and its constraint and moves no billing value", async () => {
      const file = await readFile(resolve("migrations/0053_retire_coupon_stacking.sql"), "utf8");
      const statements = file.replace(/^\s*begin;/i, "").replace(/commit;\s*$/i, "");
      expect(statements).toContain("drop column if exists coupon_stacking");

      let observed: Record<string, unknown> = {};
      await db.begin(async (tx) => {
        await tx.unsafe(`
          alter table businesses
            add column coupon_stacking text not null default 'single',
            add constraint business_coupon_stacking_supported
              check (coupon_stacking in ('single', 'amount_first', 'percentage_first'))
        `);
        // THE DIVERGENCE THAT MAKES THIS WORTH TESTING. This workspace's inert setting says
        // percentage_first while its bills are calculated one_per_appointment - the exact shape
        // found in real data. A migration that "helpfully" copied the value across would change
        // what this business charges.
        await tx`
          update businesses set coupon_stacking='percentage_first',
            discount_stacking_mode='one_per_appointment' where id=${businessId}
        `;
        await tx.unsafe(statements);
        const [after] = await tx<{ stacking: string; columns: number; constraints: number }[]>`
          select b.discount_stacking_mode as stacking,
            (select count(*)::int from information_schema.columns
             where table_name='businesses' and column_name='coupon_stacking') as columns,
            (select count(*)::int from pg_constraint
             where conname='business_coupon_stacking_supported') as constraints
          from businesses b where b.id=${businessId}
        `;
        observed = { ...after! };
        throw new Rollback();
      }).catch((error: unknown) => { if (!(error instanceof Rollback)) throw error; });

      expect(observed).toEqual({ stacking: "one_per_appointment", columns: 0, constraints: 0 });
    });

    it("is idempotent, so a re-run or a fresh database takes the same path", async () => {
      const file = await readFile(resolve("migrations/0053_retire_coupon_stacking.sql"), "utf8");
      const statements = file.replace(/^\s*begin;/i, "").replace(/commit;\s*$/i, "");
      // Against THIS database the column is already gone, so both statements are no-ops. That is
      // the case a fresh database and a second run both land in, and it must not raise.
      await db.begin(async (tx) => {
        await tx.unsafe(statements);
        await tx.unsafe(statements);
        throw new Rollback();
      }).catch((error: unknown) => { if (!(error instanceof Rollback)) throw error; });
      expect(await stackingMode()).toBe("one_per_appointment");
    });
  });

  describe("exactly one route can change stacking", () => {
    it("ignores the retired field on the Business Settings save and leaves billing alone", async () => {
      expect((await setStacking("amount_first")).statusCode).toBe(200);
      // A client that has not been redeployed still sends `couponStacking`. The schema is not
      // `.strict()`, so this is accepted and the field is dropped - it must not 400, and it must
      // certainly not reach the column that decides the bill.
      const saved = await saveBusinessSettings({ couponStacking: "percentage_first" });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).not.toHaveProperty("couponStacking");
      expect(await stackingMode()).toBe("amount_first");
    });

    it("stops recording a couponStacking change in the settings audit entry", async () => {
      // The field's only consumer was this entry, which is why "it has no consumer" read as true
      // for as long as it did.
      const [entry] = await db<{ after: Record<string, unknown> }[]>`
        select after_data as after from audit_events
        where business_id=${businessId} and action='business.settings.update'
        order by created_at desc limit 1
      `;
      const changed = (entry?.after?.changed ?? {}) as Record<string, unknown>;
      expect(changed).not.toHaveProperty("couponStacking");
    });

    it("requires settings.discounts, and settings.manage alone will not do", async () => {
      const refused = await setStacking("percentage_first", managerCookie);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toMatch(/settings\.discounts/);
      // Unmoved: a refusal that had already written would be worse than one that had not.
      expect(await stackingMode()).toBe("amount_first");

      const allowed = await setStacking("percentage_first", discounterCookie);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(await stackingMode()).toBe("percentage_first");
    });

    it("leaves settings.manage no other door to the value", async () => {
      // The manager can still save the Business screen; what they cannot do is change stacking
      // through it, by the retired name or by the surviving one.
      const saved = await saveBusinessSettings(
        { couponStacking: "amount_first", discountStackingMode: "amount_first" }, managerCookie
      );
      expect(saved.statusCode, saved.body).toBe(200);
      expect(await stackingMode()).toBe("percentage_first");
    });
  });

  describe("a real bill follows the surviving value", () => {
    /**
     * $100, a $20 fixed discount and a 10% one. The two orders give different money, which is what
     * makes this a MONEY setting rather than a preference:
     *
     *   amount_first      $100 - $20 = $80, then 10% of $80 = $8   -> $28 off, $72 to pay
     *   percentage_first  10% of $100 = $10, then $20              -> $30 off, $70 to pay
     */
    let twentyOff = "", tenPercent = "";

    beforeAll(async () => {
      // The write returns the whole settings payload with the new row's id under `createdId`,
      // rather than the row - one read for the screen, not two.
      const createDiscount = async (payload: Record<string, unknown>) => {
        const response = await app.inject({
          method: "POST", url: "/api/settings/discounts",
          headers: { cookie: ownerCookie }, payload
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json().createdId as string;
      };
      twentyOff = await createDiscount({
        name: `Stacking twenty off ${suffix}`, kind: "amount", amountMinor: 2000
      });
      tenPercent = await createDiscount({
        name: `Stacking ten percent ${suffix}`, kind: "percentage", rateBasisPoints: 1000
      });
    });

    const billUnder = async (mode: string) => {
      expect((await setStacking(mode)).statusCode).toBe(200);
      const appointmentId = await completedAppointment();
      const response = await app.inject({
        method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: { appliedDiscountIds: [tenPercent, twentyOff] }
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };

    it("charges $72 under amount_first and $70 under percentage_first", async () => {
      expect(await billUnder("amount_first")).toMatchObject({
        subtotalMinor: 10000, discountMinor: 2800, totalMinor: 7200
      });
      expect(await billUnder("percentage_first")).toMatchObject({
        subtotalMinor: 10000, discountMinor: 3000, totalMinor: 7000
      });
    });

    it("refuses a second discount outright under one_per_appointment", async () => {
      // The rule `coupon_stacking` called `single`, under the only spelling that survives. It does
      // not quietly drop the second discount - it refuses the checkout with its own code, so a
      // cashier is told rather than handed a bill that is not the one they built.
      expect((await setStacking("one_per_appointment")).statusCode).toBe(200);
      const both = await app.inject({
        method: "POST", url: `/api/appointments/${await completedAppointment()}/checkout`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: { appliedDiscountIds: [tenPercent, twentyOff] }
      });
      expect(both.statusCode, both.body).toBe(409);
      expect(both.json().code).toBe("MULTIPLE_DISCOUNTS_NOT_ALLOWED");

      // One discount is still honoured, so the mode restricts stacking rather than discounting.
      const single = await app.inject({
        method: "POST", url: `/api/appointments/${await completedAppointment()}/checkout`,
        headers: { cookie: ownerCookie, "idempotency-key": crypto.randomUUID() },
        payload: { appliedDiscountIds: [twentyOff] }
      });
      expect(single.statusCode, single.body).toBe(201);
      expect(single.json()).toMatchObject({ discountMinor: 2000, totalMinor: 8000 });
    });
  });
});
