import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";
import { tokenHash } from "../../src/http/context.js";
import { roleFor } from "../support/roles.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "discounts-and-coupons-test-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

interface DiscountSettings {
  currency: string;
  stackingMode: string;
  discounts: {
    id: string; name: string; kind: string; amountMinor: number | null;
    rateBasisPoints: number | null; applyScope: string; active: boolean;
  }[];
  coupons: {
    id: string; code: string; name: string | null; kind: string;
    amountMinor: number | null; rateBasisPoints: number | null; applyScope: string;
    startsOn: string | null; endsOn: string | null; weekdays: number[] | null;
    newClientsOnly: boolean; maxRedemptions: number | null;
    maxRedemptionsPerClient: number | null; redeemedCount: number; active: boolean;
  }[];
  stackingModes: { value: string; label: string }[];
  discountKinds: { value: string; label: string }[];
  applyScopes: { value: string; label: string }[];
  perPetMultiplier: { supported: boolean; petCountPerAppointment: number; reason: string };
}

/**
 * Settings -> Coupon & Discount, and what it does to a bill.
 *
 * The rules worth holding are that the SERVER decides every configured amount, that discounts
 * COMPOUND off what the previous ones left, that the coupon rules are evaluated against the
 * APPOINTMENT'S OWN LOCAL DATE rather than against checkout time, that a redemption cap is a cap
 * under real concurrency rather than a check two racing checkouts can both pass, and that none of
 * it is visible or reachable across a tenant boundary.
 */
describeDatabase("discounts and coupons", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie = "", rivalCookie = "", viewerCookie = "", managerCookie = "";
  let cashierCookie = "", granterCookie = "";
  let businessId = "", locationId = "", employeeId = "", serviceId = "", customerId = "", petId = "";
  const suffix = crypto.randomUUID();
  const key = (): string => crypto.randomUUID();

  async function settings(withCookie = ownerCookie): Promise<DiscountSettings> {
    const response = await app.inject({
      method: "GET", url: "/api/settings/discounts", headers: { cookie: withCookie }
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function setStacking(mode: string, withCookie = ownerCookie) {
    return app.inject({
      method: "PUT", url: "/api/settings/discount-stacking",
      headers: { cookie: withCookie }, payload: { stackingMode: mode }
    });
  }

  async function createDiscount(payload: Record<string, unknown>, withCookie = ownerCookie) {
    return app.inject({
      method: "POST", url: "/api/settings/discounts", headers: { cookie: withCookie }, payload
    });
  }

  async function createCoupon(payload: Record<string, unknown>, withCookie = ownerCookie) {
    return app.inject({
      method: "POST", url: "/api/settings/coupons", headers: { cookie: withCookie }, payload
    });
  }

  /** A completed appointment, priced at `priceMinor`, on a named local day in a named timezone. */
  async function createCompleted(input: {
    localStart: string; timezone: string; utcOffsetMinutes: number; startAtUtc: string;
    priceMinor?: number; client?: { customerId: string; petId: string };
  }): Promise<string> {
    const endAtUtc = new Date(new Date(input.startAtUtc).getTime() + 3_600_000).toISOString();
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${input.client?.customerId ?? customerId},
        ${input.client?.petId ?? petId},${employeeId},
        ${input.startAtUtc}::timestamptz,${endAtUtc}::timestamptz,${input.timezone},
        ${input.localStart},${input.utcOffsetMinutes},'completed',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner returning id
    `;
    await db`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${serviceId},'Discount Groom',60,${input.priceMinor ?? 10_000})
    `;
    return appointment!.id;
  }

  /** A completed appointment on an ordinary Tuesday in 2034, for tests that do not care when. */
  let ordinaryDay = 1;
  async function ordinaryAppointment(
    priceMinor = 10_000, client?: { customerId: string; petId: string }
  ): Promise<string> {
    // 2034-04-04 is a Tuesday. Each call takes the next day so appointments never collide.
    const day = String(3 + (ordinaryDay += 1) % 20).padStart(2, "0");
    return createCompleted({
      localStart: `2034-04-${day}T09:00`, timezone: "America/Los_Angeles",
      utcOffsetMinutes: -420, startAtUtc: `2034-04-${day}T16:00:00.000Z`,
      priceMinor, ...(client ? { client } : {})
    });
  }

  /**
   * A client with a pet of their own.
   *
   * `appointments` carries a composite (business_id, customer_id, pet_id) foreign key, so a pet
   * belongs to exactly one client and a fixture cannot borrow somebody else's.
   */
  async function newClient(firstName: string, lastName: string) {
    const customer = (await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName, lastName, preferredContactMethod: "none" }
    })).json().id as string;
    const pet = (await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId: customer, name: `${firstName} Pet`, species: "dog" }
    })).json().id as string;
    return { customerId: customer, petId: pet };
  }

  async function checkout(
    appointmentId: string, payload: Record<string, unknown> = {},
    session = ownerCookie, requestKey = key()
  ) {
    return app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: session, "idempotency-key": requestKey }, payload
    });
  }

  async function seatMember(label: string, permissions: readonly string[]): Promise<string> {
    const token = crypto.randomUUID();
    const email = `${label}-${suffix}@example.test`;
    const [member] = await db<{ userId: string }[]>`
      with account as (
        insert into users(email,normalized_email,password_hash)
        values (${email},${email},${await hashPassword("correct horse discount member")})
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
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `salon-discount-${suffix}@example.test`,
        password: "correct horse salon discounts", businessName: "Discount Salon"
      }
    });
    ownerCookie = cookie(signup);
    ({ businessId, locationId } = signup.json());
    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `rival-discount-${suffix}@example.test`,
        password: "correct horse rival discounts", businessName: "Rival Discounts"
      }
    });
    rivalCookie = cookie(rival);

    // No tax, so every assertion below is about the discount and not about the rounding of a rate.
    await app.inject({
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
      payload: {
        name: "Discount Salon", timezone: "America/Los_Angeles", currency: "USD",
        taxRateBasisPoints: 0, reminderLeadMinutes: 1440, locationVersion: 1
      }
    });
    const service = await app.inject({
      method: "POST", url: "/api/services", headers: { cookie: ownerCookie },
      payload: { name: "Discount Groom", baseDurationMinutes: 60, basePriceMinor: 10_000 }
    });
    serviceId = service.json().id;
    const employee = await app.inject({
      method: "POST", url: "/api/employees", headers: { cookie: ownerCookie },
      payload: { displayName: "Discount Groomer", serviceIds: [serviceId] }
    });
    employeeId = employee.json().id;
    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Dee", lastName: "Count", preferredContactMethod: "none" }
    });
    customerId = customer.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Discount Pet", species: "dog" }
    });
    petId = pet.json().id;

    // Sago needs the read to work for somebody who can look and not change, so a viewer holds this
    // key and nothing else. The manager holds `settings.manage` and NOT `settings.discounts`,
    // which is the whole point of graduating a child out of the master.
    viewerCookie = await seatMember("discount-viewer", ["settings.discounts"]);
    managerCookie = await seatMember("discount-manager", ["settings.manage", "team.manage"]);
    cashierCookie = await seatMember("discount-cashier", ["checkout.perform", "payments.view"]);
    granterCookie = await seatMember("discount-granter",
      ["checkout.perform", "payments.view", "discounts.apply"]);
  });

  afterAll(async () => { await app.close(); await db.end(); });

  // -------------------------------------------------------------------------------------------
  // The screen.
  // -------------------------------------------------------------------------------------------

  it("serves the whole screen, and says what the Per Pet control is actually worth", async () => {
    const payload = await settings();
    expect(payload.currency).toBe("USD");
    // The truthful description of what checkout did before this feature existed.
    expect(payload.stackingMode).toBe("one_per_appointment");
    expect(payload.discounts).toEqual([]);
    expect(payload.coupons).toEqual([]);

    // The three closed sets, named by the server so the client keeps no copy of a check constraint.
    expect(payload.stackingModes.map((mode) => mode.value))
      .toEqual(["one_per_appointment", "amount_first", "percentage_first"]);
    expect(payload.discountKinds.map((kind) => kind.value)).toEqual(["amount", "percentage"]);
    expect(payload.applyScopes.map((scope) => scope.value)).toEqual(["per_appointment", "per_pet"]);

    // The honest part. An appointment covers one pet, so Per Pet is a stored intention and not a
    // multiplier, and the server says so rather than letting the screen imply arithmetic it does
    // not do. If Pawsh ever books more than one pet on a visit, this assertion is the reminder.
    expect(payload.perPetMultiplier).toMatchObject({ supported: false, petCountPerAppointment: 1 });
  });

  it("gates every route on settings.discounts alone, not on settings.manage", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings/discounts" })).statusCode).toBe(401);

    // A viewer holding only this key can READ the screen. That is what makes a read-only visitor
    // expressible at all, and gating the GET on `settings.manage` would have made it impossible.
    const viewer = await settings(viewerCookie);
    expect(viewer.stackingMode).toBe("one_per_appointment");

    // `settings.manage` is a group MASTER WITH INDEPENDENT CHILDREN. Holding the master does not
    // reach a child that has graduated, which is the whole shape of the taxonomy.
    const manager = await app.inject({
      method: "GET", url: "/api/settings/discounts", headers: { cookie: managerCookie }
    });
    expect(manager.statusCode).toBe(403);
    expect((await createDiscount({ name: "Manager reach", kind: "amount", amountMinor: 100 },
      managerCookie)).statusCode).toBe(403);
    expect((await setStacking("amount_first", managerCookie)).statusCode).toBe(403);

    // And somebody who only takes money never reaches the configuration.
    expect((await app.inject({
      method: "GET", url: "/api/settings/discounts", headers: { cookie: cashierCookie }
    })).statusCode).toBe(403);
  });

  it("refuses a value that disagrees with its kind, and a coupon range that runs backwards", async () => {
    expect((await createDiscount({ name: "No value", kind: "amount" })).statusCode).toBe(400);
    expect((await createDiscount({
      name: "Both", kind: "amount", amountMinor: 500, rateBasisPoints: 1_000
    })).statusCode).toBe(400);
    expect((await createDiscount({
      name: "Too much", kind: "percentage", rateBasisPoints: 10_001
    })).statusCode).toBe(400);
    expect((await createCoupon({
      code: "BACKWARDS", kind: "amount", amountMinor: 500,
      startsOn: "2034-05-01", endsOn: "2034-04-01"
    })).statusCode).toBe(400);
    // A coupon good on no day at all is a mistake, not a setting. Null is how you say "any day".
    expect((await createCoupon({
      code: "NODAYS", kind: "amount", amountMinor: 500, weekdays: []
    })).statusCode).toBe(400);
    // A code a customer would mistype.
    expect((await createCoupon({
      code: "SPRING 25", kind: "amount", amountMinor: 500
    })).statusCode).toBe(400);
  });

  it("answers every write with the whole screen, and serves redeemedCount as a count", async () => {
    const created = await createDiscount({
      name: "Loyalty", kind: "percentage", rateBasisPoints: 1_000, applyScope: "per_appointment"
    });
    expect(created.statusCode).toBe(201);
    const afterCreate: DiscountSettings & { createdId: string } = created.json();
    // The whole read, not the row - the same contract the Tax & Payment screen uses.
    expect(afterCreate.createdId).toBeTruthy();
    expect(afterCreate.discounts.map((discount) => discount.name)).toContain("Loyalty");
    expect(afterCreate.stackingMode).toBe("one_per_appointment");

    const coupon = await createCoupon({
      code: "welcome10", name: "Welcome", kind: "percentage", rateBasisPoints: 1_000
    });
    expect(coupon.statusCode).toBe(201);
    const stored = (coupon.json() as DiscountSettings).coupons.find((row) => row.code === "welcome10")!;
    // Not denormalized. A coupon nobody has redeemed reports zero because `count(*)` says zero.
    expect(stored.redeemedCount).toBe(0);
    expect(stored.newClientsOnly).toBe(false);
    // Every unset limitation is NULL, not a stand-in value.
    expect(stored).toMatchObject({
      startsOn: null, endsOn: null, weekdays: null,
      maxRedemptions: null, maxRedemptionsPerClient: null
    });

    // Case-insensitive and business-scoped.
    const clash = await createCoupon({ code: "WELCOME10", kind: "amount", amountMinor: 500 });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe("COUPON_CODE_TAKEN");
    // The rival may hold the same code, because the index is scoped to a business.
    expect((await createCoupon({ code: "WELCOME10", kind: "amount", amountMinor: 500 }, rivalCookie))
      .statusCode).toBe(201);
  });

  it("retires a row instead of deleting it, and keeps a handed-out code claimed", async () => {
    const discount = (await createDiscount({ name: "Seasonal", kind: "amount", amountMinor: 1_000 }))
      .json().createdId;
    const coupon = (await createCoupon({ code: "ONCEONLY", kind: "amount", amountMinor: 1_000 }))
      .json().createdId;

    const removedDiscount = await app.inject({
      method: "DELETE", url: `/api/settings/discounts/${discount}`, headers: { cookie: ownerCookie }
    });
    // 204, and the same thing `DELETE /api/services/:id` already means.
    expect(removedDiscount.statusCode).toBe(204);
    const [discountRow] = await db<{ active: boolean }[]>`
      select active from discounts where business_id=${businessId} and id=${discount}
    `;
    expect(discountRow!.active).toBe(false);
    expect((await settings()).discounts.map((row) => row.id)).not.toContain(discount);
    // A second delete finds nothing ACTIVE, rather than reporting success twice.
    expect((await app.inject({
      method: "DELETE", url: `/api/settings/discounts/${discount}`, headers: { cookie: ownerCookie }
    })).statusCode).toBe(404);

    // The discount NAME is released - only staff ever saw it - so it can be used again.
    expect((await createDiscount({ name: "Seasonal", kind: "amount", amountMinor: 2_000 }))
      .statusCode).toBe(201);

    expect((await app.inject({
      method: "DELETE", url: `/api/settings/coupons/${coupon}`, headers: { cookie: ownerCookie }
    })).statusCode).toBe(204);
    // THE CODE IS NOT RELEASED. A customer holding a printed ONCEONLY must never be handed
    // somebody else's meaning of it, so the refusal is a distinct one that says why.
    const reissue = await createCoupon({ code: "ONCEONLY", kind: "amount", amountMinor: 2_000 });
    expect(reissue.statusCode).toBe(409);
    expect(reissue.json().code).toBe("COUPON_CODE_RETIRED");
  });

  it("keeps configuration invisible and unreachable across a tenant boundary", async () => {
    const mine = (await createDiscount({ name: "Mine only", kind: "amount", amountMinor: 750 }))
      .json().createdId;
    const myCoupon = (await createCoupon({ code: "MINEONLY", kind: "amount", amountMinor: 750 }))
      .json().createdId;

    const theirs = await settings(rivalCookie);
    expect(theirs.discounts.map((row) => row.id)).not.toContain(mine);
    expect(theirs.coupons.map((row) => row.id)).not.toContain(myCoupon);

    // Naming the id directly is a 404, not a 403: the rival is told nothing about whether it exists.
    const stolen = { name: "Stolen", code: "STOLEN", kind: "amount", amountMinor: 1 };
    for (const [method, url] of [
      ["PUT", `/api/settings/discounts/${mine}`], ["DELETE", `/api/settings/discounts/${mine}`],
      ["PUT", `/api/settings/coupons/${myCoupon}`], ["DELETE", `/api/settings/coupons/${myCoupon}`]
    ] as const) {
      const response = method === "PUT"
        ? await app.inject({ method, url, headers: { cookie: rivalCookie }, payload: stolen })
        : await app.inject({ method, url, headers: { cookie: rivalCookie } });
      const where = `${method} ${url}`;
      expect([404, 400], where).toContain(response.statusCode);
      expect(response.statusCode, where).not.toBe(204);
      expect(response.statusCode, where).not.toBe(200);
    }
    const [untouched] = await db<{ name: string; active: boolean }[]>`
      select name,active from discounts where business_id=${businessId} and id=${mine}
    `;
    expect(untouched).toMatchObject({ name: "Mine only", active: true });
  });

  it("carries a tenant_isolation policy on all four new tables", async () => {
    // 0034 shipped five tables without one and 0035 existed solely to repair that. These are
    // declared in 0046 itself so no follow-up is needed.
    const rows = await db<{ tablename: string; rowsecurity: boolean; policies: number }[]>`
      select c.relname as tablename, c.relrowsecurity as rowsecurity,
        (select count(*)::int from pg_policies p
         where p.tablename=c.relname and p.policyname='tenant_isolation') as policies
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relname in ('discounts','coupons','coupon_redemptions','invoice_discounts')
      order by c.relname
    `;
    expect(rows.map((row) => row.tablename))
      .toEqual(["coupon_redemptions", "coupons", "discounts", "invoice_discounts"]);
    for (const row of rows) {
      expect(row.rowsecurity, row.tablename).toBe(true);
      expect(row.policies, row.tablename).toBe(1);
    }
  });

  // -------------------------------------------------------------------------------------------
  // The picker's door.
  //
  // `GET /api/checkout/payment-options` is the ONLY way the people who take money can learn what
  // discounts exist: the settings read above is gated on `settings.discounts`, which the test
  // directly above proves a cashier does not hold. A picker built against the settings read would
  // have worked for an owner and answered every cashier with a 403 on every checkout.
  // -------------------------------------------------------------------------------------------

  interface CheckoutOptions {
    paymentMethods: { id: string }[];
    tipPercents: number[] | null;
    stackingMode: string;
    discounts: {
      id: string; name: string; kind: string; amountMinor: number | null;
      rateBasisPoints: number | null; applyScope: string;
    }[] | null;
  }

  async function checkoutOptions(withCookie: string) {
    const response = await app.inject({
      method: "GET", url: "/api/checkout/payment-options", headers: { cookie: withCookie }
    });
    return { statusCode: response.statusCode, body: response.body,
      payload: response.json() as CheckoutOptions };
  }

  it("serves the checkout picker the same active discounts the settings screen shows", async () => {
    // Created out of alphabetical order on purpose: the two screens must agree on the ORDER as
    // well as the membership, or an operator and an owner are reading two different lists.
    const zed = (await createDiscount({
      name: "Zed regular client", kind: "percentage", rateBasisPoints: 500
    })).json().createdId;
    const anniversary = (await createDiscount({
      name: "Anniversary five", kind: "amount", amountMinor: 500, applyScope: "per_pet"
    })).json().createdId;
    const retired = (await createDiscount({
      name: "Retired already", kind: "amount", amountMinor: 100
    })).json().createdId;
    expect((await app.inject({
      method: "DELETE", url: `/api/settings/discounts/${retired}`, headers: { cookie: ownerCookie }
    })).statusCode).toBe(204);

    // Somebody who can take money and grant a discount, and who cannot open the settings screen.
    const options = await checkoutOptions(granterCookie);
    expect(options.statusCode).toBe(200);
    expect((await app.inject({
      method: "GET", url: "/api/settings/discounts", headers: { cookie: granterCookie }
    })).statusCode).toBe(403);

    // The same rows in the same order as the screen that configures them.
    const owner = await settings();
    expect(options.payload.discounts?.map((row) => row.id)).toEqual(owner.discounts.map((row) => row.id));
    expect(options.payload.discounts?.map((row) => row.id)).toContain(zed);
    expect(options.payload.discounts?.map((row) => row.id)).toContain(anniversary);
    // Alphabetical by name, not by insertion.
    const names = options.payload.discounts!.map((row) => row.name);
    expect(names.indexOf("Anniversary five")).toBeLessThan(names.indexOf("Zed regular client"));

    // A retired row is not offered. `active = false` is what a delete means here, and a picker
    // listing one would offer the operator something the checkout write refuses.
    expect(options.payload.discounts?.map((row) => row.id)).not.toContain(retired);
    expect(options.body).not.toContain("Retired already");

    // Exactly what the picker needs to SHOW a row, and nothing else - no `active`, which is true
    // of every row here by construction, and no timestamps.
    for (const row of options.payload.discounts!) {
      expect(Object.keys(row).sort())
        .toEqual(["amountMinor", "applyScope", "id", "kind", "name", "rateBasisPoints"]);
    }
    expect(options.payload.discounts!.find((row) => row.id === anniversary))
      .toMatchObject({ kind: "amount", amountMinor: 500, rateBasisPoints: null, applyScope: "per_pet" });

    // The stacking rule travels with the list, so the picker can stop the operator at one
    // selection rather than letting them build a bill the server answers with 409 at submit.
    expect(options.payload.stackingMode).toBe("one_per_appointment");
    expect((await setStacking("amount_first")).statusCode).toBe(200);
    expect((await checkoutOptions(granterCookie)).payload.stackingMode).toBe("amount_first");
    // Restored: the checkout tests below start from the default.
    expect((await setStacking("one_per_appointment")).statusCode).toBe(200);

    // Another salon's till sees its own configuration and never this one's.
    const rival = await checkoutOptions(rivalCookie);
    expect(rival.statusCode).toBe(200);
    expect(rival.payload.discounts).toEqual([]);
    expect(rival.body).not.toContain("Zed regular client");
  });

  it("withholds the list from a cashier who cannot apply one, as null and not an empty array",
    async () => {
      // The distinction that matters. This cashier holds `checkout.perform` and NOT
      // `discounts.apply`, so the checkout write would answer any `appliedDiscountIds` with a 403
      // - a picker rendered from this payload would be decorative. `null` says "not yours to
      // apply"; `[]` would say "this salon has configured none", which is false and is what the
      // modal would then tell them.
      const cashier = await checkoutOptions(cashierCookie);
      expect(cashier.statusCode).toBe(200);
      expect(cashier.payload.discounts).toBeNull();
      expect(cashier.body).not.toContain("Zed regular client");
      expect(cashier.body).not.toContain("Anniversary five");

      // Not a closed door: the endpoint still serves them the payment methods they came for. The
      // permission omits a field, it does not refuse the request.
      expect(cashier.payload.paymentMethods.length).toBeGreaterThan(0);
      expect(cashier.payload.stackingMode).toBe("one_per_appointment");

      // The same key, tested the same way the checkout write tests it, so the picker and the
      // write cannot disagree about who may use it.
      expect((await checkoutOptions(granterCookie)).payload.discounts).not.toBeNull();
      // An owner's authority is `is_owner` and not a stored permission list.
      expect((await checkoutOptions(ownerCookie)).payload.discounts).not.toBeNull();

      // And the door itself is `checkout.perform`. Holding the settings key instead does not open
      // it, which is the mirror of a cashier not reaching the settings screen.
      expect((await app.inject({
        method: "GET", url: "/api/checkout/payment-options", headers: { cookie: viewerCookie }
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "GET", url: "/api/checkout/payment-options"
      })).statusCode).toBe(401);
    });

  // -------------------------------------------------------------------------------------------
  // What it does to a bill.
  // -------------------------------------------------------------------------------------------

  it("refuses a second discount under one_per_appointment, and compounds under the others", async () => {
    const twentyOff = (await createDiscount({
      name: "Twenty off", kind: "amount", amountMinor: 2_000
    })).json().createdId;
    const tenPercent = (await createDiscount({
      name: "Ten percent", kind: "percentage", rateBasisPoints: 1_000
    })).json().createdId;

    // The default, and a HARD SERVER CONSTRAINT rather than a client convention.
    expect((await settings()).stackingMode).toBe("one_per_appointment");
    const refused = await checkout(await ordinaryAppointment(), {
      appliedDiscountIds: [twentyOff, tenPercent]
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("MULTIPLE_DISCOUNTS_NOT_ALLOWED");
    // A manual amount counts as one of them: it is money off the same bill.
    const refusedManual = await checkout(await ordinaryAppointment(), {
      discountMinor: 500, discountType: "courtesy", appliedDiscountIds: [tenPercent]
    });
    expect(refusedManual.statusCode).toBe(409);
    expect(refusedManual.json().code).toBe("MULTIPLE_DISCOUNTS_NOT_ALLOWED");
    // One is still fine, and the server computes what it is worth.
    const single = await checkout(await ordinaryAppointment(), { appliedDiscountIds: [tenPercent] });
    expect(single.statusCode).toBe(201);
    expect(single.json()).toMatchObject({ subtotalMinor: 10_000, discountMinor: 1_000, totalMinor: 9_000 });

    // $100, $20 off, then 10% off. The percentage takes 10% of the 8000 that REMAINED.
    expect((await setStacking("amount_first")).statusCode).toBe(200);
    const amountFirst = await checkout(await ordinaryAppointment(), {
      appliedDiscountIds: [tenPercent, twentyOff]
    });
    expect(amountFirst.statusCode).toBe(201);
    expect(amountFirst.json()).toMatchObject({
      subtotalMinor: 10_000, discountMinor: 2_800, totalMinor: 7_200
    });

    // The same two discounts, the same bill, the other order. $70 rather than $72 - which is
    // exactly why this is a setting and not a constant.
    expect((await setStacking("percentage_first")).statusCode).toBe(200);
    const percentageFirst = await checkout(await ordinaryAppointment(), {
      appliedDiscountIds: [twentyOff, tenPercent]
    });
    expect(percentageFirst.json()).toMatchObject({
      subtotalMinor: 10_000, discountMinor: 3_000, totalMinor: 7_000
    });

    // And the breakdown on each receipt sums to the aggregate the invoice carries.
    for (const invoice of [amountFirst.json(), percentageFirst.json()]) {
      const rows = await db<{ appliedMinor: number; source: string; nameSnapshot: string | null }[]>`
        select applied_minor,source,name_snapshot from invoice_discounts
        where business_id=${businessId} and invoice_id=${invoice.id} order by line_position
      `;
      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum, row) => sum + row.appliedMinor, 0)).toBe(invoice.discountMinor);
      expect(rows.every((row) => row.source === "discount")).toBe(true);
    }
    await setStacking("amount_first");
  });

  it("never trusts a client-sent amount for a configured discount", async () => {
    const fiver = (await createDiscount({ name: "Five off", kind: "amount", amountMinor: 500 }))
      .json().createdId;
    // The client may name WHICH discount. It may not name what it is worth, and there is no field
    // through which it could: `appliedDiscountIds` is a list of ids and nothing else.
    const response = await checkout(await ordinaryAppointment(), {
      appliedDiscountIds: [fiver], discountMinor: 0
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().discountMinor).toBe(500);

    // Editing the discount afterwards does not rewrite the receipt: the breakdown is a snapshot.
    await app.inject({
      method: "PUT", url: `/api/settings/discounts/${fiver}`, headers: { cookie: ownerCookie },
      payload: { name: "Five off", kind: "amount", amountMinor: 9_000 }
    });
    const [snapshot] = await db<{ amountMinorSnapshot: number; appliedMinor: number }[]>`
      select amount_minor_snapshot,applied_minor from invoice_discounts
      where business_id=${businessId} and invoice_id=${response.json().id}
    `;
    expect(snapshot).toMatchObject({ amountMinorSnapshot: 500, appliedMinor: 500 });
  });

  it("gates a configured discount on discounts.apply and a coupon on nothing but checkout", async () => {
    const staffPick = (await createDiscount({
      name: "Staff pick", kind: "amount", amountMinor: 1_000
    })).json().createdId;
    await createCoupon({ code: "CUSTOMERHELD", kind: "amount", amountMinor: 1_000 });

    // GRANTING money off needs the grant permission, whether it was typed or chosen.
    const deniedConfigured = await checkout(await ordinaryAppointment(),
      { appliedDiscountIds: [staffPick] }, cashierCookie);
    expect(deniedConfigured.statusCode).toBe(403);
    const deniedManual = await checkout(await ordinaryAppointment(),
      { discountMinor: 500, discountType: "courtesy" }, cashierCookie);
    expect(deniedManual.statusCode).toBe(403);
    expect((await checkout(await ordinaryAppointment(), { appliedDiscountIds: [staffPick] },
      granterCookie)).statusCode).toBe(201);

    // A COUPON IS DIFFERENT. It was earned somewhere else and the operator is keying in a code,
    // not deciding anything - so a receptionist who takes money can honour one.
    const honoured = await checkout(await ordinaryAppointment(), { couponCode: "CUSTOMERHELD" },
      cashierCookie);
    expect(honoured.statusCode).toBe(201);
    expect(honoured.json().discountMinor).toBe(1_000);
  });

  it("evaluates a coupon against the appointment's local date, not against checkout time", async () => {
    // 2034-11-04 is a SATURDAY in Los Angeles and its 18:00 local start is 2034-11-05T01:00Z -
    // a SUNDAY in UTC. 2034-11-05 is the Sunday US daylight saving ends, so the next day's 18:00
    // local start is an hour further from UTC (-480 rather than -420) and lands on a Monday in UTC.
    //
    // Both appointments therefore have a local date that DISAGREES with their UTC date, across a
    // DST boundary, which is exactly where a rule that quietly used the instant would break.
    const saturday = await createCompleted({
      localStart: "2034-11-04T18:00", timezone: "America/Los_Angeles",
      utcOffsetMinutes: -420, startAtUtc: "2034-11-05T01:00:00.000Z"
    });
    const sunday = await createCompleted({
      localStart: "2034-11-05T18:00", timezone: "America/Los_Angeles",
      utcOffsetMinutes: -480, startAtUtc: "2034-11-06T02:00:00.000Z"
    });
    await createCoupon({ code: "SATONLY", kind: "amount", amountMinor: 1_500, weekdays: [6] });

    // The Saturday groom qualifies even though the instant it happened at was a Sunday in UTC.
    const accepted = await checkout(saturday, { couponCode: "SATONLY" });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().discountMinor).toBe(1_500);
    // And the Sunday one does not, even though the instant it happened at was a Monday in UTC.
    const rejected = await checkout(sunday, { couponCode: "SATONLY" });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("COUPON_WRONG_WEEKDAY");

    // THE CHECKED-OUT-NEXT-MORNING CASE, taken to its limit: these appointments are in 2034 and
    // this checkout is running today. A coupon whose window covers the APPOINTMENT and expired
    // long before this test ran is still honoured, because checkout time is not the question.
    await createCoupon({
      code: "NOV2034", kind: "amount", amountMinor: 2_000,
      startsOn: "2034-11-01", endsOn: "2034-11-30"
    });
    const windowed = await checkout(await createCompleted({
      localStart: "2034-11-07T09:00", timezone: "America/Los_Angeles",
      utcOffsetMinutes: -480, startAtUtc: "2034-11-07T17:00:00.000Z"
    }), { couponCode: "NOV2034" });
    expect(windowed.statusCode).toBe(201);
    expect(windowed.json().discountMinor).toBe(2_000);

    // A window that misses the appointment is refused with the side it missed on.
    await createCoupon({
      code: "DEC2034", kind: "amount", amountMinor: 2_000, startsOn: "2034-12-01"
    });
    const early = await checkout(await createCompleted({
      localStart: "2034-11-08T09:00", timezone: "America/Los_Angeles",
      utcOffsetMinutes: -480, startAtUtc: "2034-11-08T17:00:00.000Z"
    }), { couponCode: "DEC2034" });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe("COUPON_NOT_STARTED");
  });

  it("reads new client as no prior non-void invoice, so a cancelled-only history still counts", async () => {
    await createCoupon({ code: "FIRSTVISIT", kind: "percentage", rateBasisPoints: 2_000,
      newClientsOnly: true });

    // Somebody whose only history is a CANCELLED appointment. They were never invoiced, so they
    // are new - the predicate is about invoices, not about whether the salon has heard of them.
    const { customerId: fresh, petId: freshPet } = await newClient("Never", "Invoiced");
    await db`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${businessId},${locationId},${fresh},${freshPet},${employeeId},
        '2034-03-01T16:00:00.000Z'::timestamptz,'2034-03-01T17:00:00.000Z'::timestamptz,
        'America/Los_Angeles','2034-03-01T08:00',-480,'cancelled',user_id,user_id
      from business_memberships where business_id=${businessId} and is_owner
    `;
    const [history] = await db<{ appointments: number; invoices: number }[]>`
      select
        (select count(*)::int from appointments where business_id=${businessId} and customer_id=${fresh}) appointments,
        (select count(*)::int from invoices where business_id=${businessId} and customer_id=${fresh}) invoices
    `;
    expect(history).toEqual({ appointments: 1, invoices: 0 });

    const firstVisit = await checkout(
      await ordinaryAppointment(10_000, { customerId: fresh, petId: freshPet }),
      { couponCode: "FIRSTVISIT" });
    expect(firstVisit.statusCode).toBe(201);
    expect(firstVisit.json().discountMinor).toBe(2_000);

    // And now they are not new, because they have been invoiced once.
    const secondVisit = await checkout(
      await ordinaryAppointment(10_000, { customerId: fresh, petId: freshPet }),
      { couponCode: "FIRSTVISIT" });
    expect(secondVisit.statusCode).toBe(409);
    expect(secondVisit.json().code).toBe("COUPON_NEW_CLIENTS_ONLY");
  });

  it("lets exactly one of two concurrent checkouts take a coupon's last redemption", async () => {
    await createCoupon({
      code: "LASTONE", kind: "amount", amountMinor: 1_000, maxRedemptions: 1
    });
    const [first, second] = await Promise.all([
      checkout(await ordinaryAppointment(), { couponCode: "LASTONE" }),
      checkout(await ordinaryAppointment(), { couponCode: "LASTONE" })
    ]);
    // A REAL ROW LOCK, not an advisory one and not an optimistic check: the second transaction
    // blocks on the coupon row, then reads the redemption the first one committed.
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().code).toBe("COUPON_FULLY_REDEEMED");

    const [count] = await db<{ redemptions: number }[]>`
      select count(*)::int redemptions from coupon_redemptions r
      join coupons c on c.business_id=r.business_id and c.id=r.coupon_id
      where r.business_id=${businessId} and upper(btrim(c.code))='LASTONE'
    `;
    expect(count!.redemptions).toBe(1);
    // The screen reports it as a count, not from a stored column.
    expect((await settings()).coupons.find((row) => row.code === "LASTONE")!.redeemedCount).toBe(1);
    // A third attempt, unraced, is refused the same way.
    const third = await checkout(await ordinaryAppointment(), { couponCode: "LASTONE" });
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe("COUPON_FULLY_REDEEMED");
  });

  it("holds the per-client cap under concurrency while another client is unaffected", async () => {
    await createCoupon({
      code: "ONEEACH", kind: "amount", amountMinor: 1_000, maxRedemptionsPerClient: 1
    });
    const [first, second] = await Promise.all([
      checkout(await ordinaryAppointment(), { couponCode: "ONEEACH" }),
      checkout(await ordinaryAppointment(), { couponCode: "ONEEACH" })
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().code).toBe("COUPON_CLIENT_LIMIT_REACHED");

    // The cap is PER CLIENT, so a different client is untouched by the first one exhausting theirs.
    const other = await newClient("Other", "Client");
    const theirs = await checkout(await ordinaryAppointment(10_000, other), { couponCode: "ONEEACH" });
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().discountMinor).toBe(1_000);
  });

  it("refuses an unrecognised or retired coupon without saying which rows exist", async () => {
    const retired = (await createCoupon({ code: "RETIREDNOW", kind: "amount", amountMinor: 500 }))
      .json().createdId;
    await app.inject({
      method: "DELETE", url: `/api/settings/coupons/${retired}`, headers: { cookie: ownerCookie }
    });
    const gone = await checkout(await ordinaryAppointment(), { couponCode: "RETIREDNOW" });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().code).toBe("COUPON_INACTIVE");

    const unknown = await checkout(await ordinaryAppointment(), { couponCode: "NEVEREXISTED" });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().code).toBe("COUPON_NOT_FOUND");

    // A rival's code is not a code here, even though the row exists in the same table.
    await createCoupon({ code: "RIVALONLY", kind: "amount", amountMinor: 500 }, rivalCookie);
    const crossTenant = await checkout(await ordinaryAppointment(), { couponCode: "RIVALONLY" });
    expect(crossTenant.statusCode).toBe(409);
    expect(crossTenant.json().code).toBe("COUPON_NOT_FOUND");
  });

  it("settles a fully discounted bill with no payment, and clamps rather than erroring", async () => {
    // Atlas verified this already worked for a manual discount; it has to go on working when the
    // discount comes from the catalog and takes the whole bill.
    await createDiscount({ name: "On the house", kind: "percentage", rateBasisPoints: 10_000 });
    const free = (await settings()).discounts.find((row) => row.name === "On the house")!.id;
    const settled = await checkout(await ordinaryAppointment(), { appliedDiscountIds: [free] });
    expect(settled.statusCode).toBe(201);
    expect(settled.json()).toMatchObject({
      subtotalMinor: 10_000, discountMinor: 10_000, totalMinor: 0, balanceMinor: 0, status: "paid"
    });
    const [payments] = await db<{ count: number }[]>`
      select count(*)::int count from payments
      where business_id=${businessId} and invoice_id=${settled.json().id}
    `;
    expect(payments!.count).toBe(0);

    // A FIXED AMOUNT LARGER THAN THE BILL CLAMPS. Before this it reached
    // `calculateInvoice`'s bare "Discount cannot exceed subtotal" throw, which had no stable error
    // code for a client to act on. The clamp makes that throw unreachable from checkout.
    await createDiscount({ name: "Fifty off", kind: "amount", amountMinor: 5_000 });
    const fifty = (await settings()).discounts.find((row) => row.name === "Fifty off")!.id;
    const overshoot = await checkout(await ordinaryAppointment(3_000), { appliedDiscountIds: [fifty] });
    expect(overshoot.statusCode).toBe(201);
    expect(overshoot.json()).toMatchObject({
      subtotalMinor: 3_000, discountMinor: 3_000, totalMinor: 0, status: "paid"
    });
    const [clamped] = await db<{ amountMinorSnapshot: number; appliedMinor: number }[]>`
      select amount_minor_snapshot,applied_minor from invoice_discounts
      where business_id=${businessId} and invoice_id=${overshoot.json().id}
    `;
    // The row still says what the discount was worth; `applied_minor` says what it took.
    expect(clamped).toMatchObject({ amountMinorSnapshot: 5_000, appliedMinor: 3_000 });
  });

  it("puts both new fields in the client hash and in the intent fingerprint", async () => {
    const tenner = (await createDiscount({ name: "Ten off", kind: "amount", amountMinor: 1_000 }))
      .json().createdId;
    await createCoupon({ code: "FINGERPRINT", kind: "amount", amountMinor: 2_000 });
    const appointment = await ordinaryAppointment();

    // THE CLIENT HASH. The same idempotency key with different discounts is a DIFFERENT request,
    // and must be refused rather than answered with the first request's invoice.
    const requestKey = key();
    const first = await checkout(appointment, { appliedDiscountIds: [tenner] }, ownerCookie, requestKey);
    expect(first.statusCode).toBe(201);
    expect(first.json().discountMinor).toBe(1_000);
    const replay = await checkout(appointment, { appliedDiscountIds: [tenner] }, ownerCookie, requestKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    const differentDiscounts = await checkout(appointment, { appliedDiscountIds: [] },
      ownerCookie, requestKey);
    expect(differentDiscounts.statusCode).toBe(409);
    expect(differentDiscounts.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    const differentCoupon = await checkout(appointment,
      { appliedDiscountIds: [tenner], couponCode: "FINGERPRINT" }, ownerCookie, requestKey);
    expect(differentCoupon.statusCode).toBe(409);
    expect(differentCoupon.json().code).toBe("IDEMPOTENCY_KEY_REUSED");

    // THE INTENT FINGERPRINT. A fresh key carrying different discounts must not be judged
    // compatible with the invoice already on this appointment and slip through as a 200.
    const compatible = await checkout(appointment, { appliedDiscountIds: [tenner] });
    expect(compatible.statusCode).toBe(200);
    expect(compatible.json().id).toBe(first.json().id);
    const incompatibleDiscount = await checkout(appointment, { appliedDiscountIds: [] });
    expect(incompatibleDiscount.statusCode).toBe(409);
    expect(incompatibleDiscount.json().code).toBe("INVOICE_ALREADY_EXISTS");
    const incompatibleCoupon = await checkout(appointment,
      { appliedDiscountIds: [tenner], couponCode: "FINGERPRINT" });
    expect(incompatibleCoupon.statusCode).toBe(409);
    expect(incompatibleCoupon.json().code).toBe("INVOICE_ALREADY_EXISTS");
    // And nothing was consumed by the attempts that were refused.
    const [redemptions] = await db<{ count: number }[]>`
      select count(*)::int count from coupon_redemptions r
      join coupons c on c.business_id=r.business_id and c.id=r.coupon_id
      where r.business_id=${businessId} and upper(btrim(c.code))='FINGERPRINT'
    `;
    expect(redemptions!.count).toBe(0);
  });

  it("refuses a discount that was retired between the screen loading and the checkout", async () => {
    const doomed = (await createDiscount({ name: "About to go", kind: "amount", amountMinor: 500 }))
      .json().createdId;
    await app.inject({
      method: "DELETE", url: `/api/settings/discounts/${doomed}`, headers: { cookie: ownerCookie }
    });
    const stale = await checkout(await ordinaryAppointment(), { appliedDiscountIds: [doomed] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("DISCOUNT_NOT_AVAILABLE");

    // A rival's discount is not reachable by id either.
    const rivalDiscount = (await createDiscount({ name: "Not yours", kind: "amount", amountMinor: 500 },
      rivalCookie)).json().createdId;
    const crossTenant = await checkout(await ordinaryAppointment(), { appliedDiscountIds: [rivalDiscount] });
    expect(crossTenant.statusCode).toBe(409);
    expect(crossTenant.json().code).toBe("DISCOUNT_NOT_AVAILABLE");
  });

  it("keeps the manual path exactly as it was, and gives it a receipt row", async () => {
    await setStacking("one_per_appointment");
    const manual = await checkout(await ordinaryAppointment(), {
      discountMinor: 500, discountType: "courtesy", tipMinor: 1_500
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json()).toMatchObject({
      subtotalMinor: 10_000, discountMinor: 500, tipMinor: 1_500, totalMinor: 11_000,
      discountType: "courtesy"
    });
    // `discount_type` is written exactly as before - nothing reads it, and changing what it says
    // would be a silent rewrite of a column with six years of history in it.
    const [row] = await db<{
      source: string; nameSnapshot: string | null; kindSnapshot: string;
      appliedMinor: number; discountId: string | null; couponId: string | null;
    }[]>`
      select source,name_snapshot,kind_snapshot,applied_minor,discount_id,coupon_id
      from invoice_discounts where business_id=${businessId} and invoice_id=${manual.json().id}
    `;
    // The same shape the 0046 backfill gave every historical manual discount.
    expect(row).toMatchObject({
      source: "manual", nameSnapshot: "courtesy", kindSnapshot: "amount",
      appliedMinor: 500, discountId: null, couponId: null
    });

    // A checkout with no discount at all writes no breakdown row and no coupon redemption.
    const plain = await checkout(await ordinaryAppointment(), { tipMinor: 0 });
    expect(plain.statusCode).toBe(201);
    expect(plain.json()).toMatchObject({ discountMinor: 0, totalMinor: 10_000 });
    const [none] = await db<{ count: number }[]>`
      select count(*)::int count from invoice_discounts
      where business_id=${businessId} and invoice_id=${plain.json().id}
    `;
    expect(none!.count).toBe(0);
  });

  it("keeps every invoice's breakdown summing to its discount, backfilled ones included", async () => {
    // THE TOTAL INVARIANT, checked across the ENTIRE database rather than across this suite's own
    // rows: every invoice any suite has ever created here, plus every row the 0046 backfill
    // wrote, must agree. An invariant with an exception is not an invariant.
    const [mismatched] = await db<{ count: number }[]>`
      select count(*)::int count from invoices i
      where i.discount_minor <> coalesce(
        (select sum(d.applied_minor) from invoice_discounts d
         where d.business_id=i.business_id and d.invoice_id=i.id), 0)
    `;
    expect(mismatched!.count).toBe(0);

    // And no breakdown row can outlive or precede its invoice's totals: a discount that took
    // nothing is still a row, but nothing takes more than the bill.
    const [overspent] = await db<{ count: number }[]>`
      select count(*)::int count from invoices i
      where i.discount_minor > i.subtotal_minor
    `;
    expect(overspent!.count).toBe(0);
  });

  it("shows the breakdown on the receipt, in applied order", async () => {
    await setStacking("amount_first");
    const flat = (await createDiscount({ name: "Flat fifteen", kind: "amount", amountMinor: 1_500 }))
      .json().createdId;
    await createCoupon({ code: "RECEIPT20", name: "Twenty percent", kind: "percentage",
      rateBasisPoints: 2_000 });
    const invoice = (await checkout(await ordinaryAppointment(), {
      appliedDiscountIds: [flat], couponCode: "RECEIPT20"
    })).json();
    // $100, $15 off, then 20% of the $85 that remained.
    expect(invoice).toMatchObject({ discountMinor: 3_200, totalMinor: 6_800 });

    const receipt = await app.inject({
      method: "GET", url: `/api/invoices/${invoice.id}/receipt`, headers: { cookie: ownerCookie }
    });
    expect(receipt.statusCode).toBe(200);
    const discounts = receipt.json().discounts as {
      linePosition: number; source: string; nameSnapshot: string | null; appliedMinor: number;
    }[];
    expect(discounts.map((row) => [row.linePosition, row.source, row.nameSnapshot, row.appliedMinor]))
      .toEqual([[1, "discount", "Flat fifteen", 1_500], [2, "coupon", "Twenty percent", 1_700]]);
    expect(discounts.reduce((sum, row) => sum + row.appliedMinor, 0)).toBe(invoice.discountMinor);
    await setStacking("one_per_appointment");
  });
});
