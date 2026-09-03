import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, uniqueViolations } from "../../src/app.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import type { Config } from "../../src/config.js";
import { tokenHash } from "../../src/http/context.js";
import { hashPassword } from "../../src/security/passwords.js";
import { roleFor } from "../support/roles.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "tax-payment-settings-test-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
function cookie(response: { headers: Record<string, unknown> }) {
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

interface PaymentMethod {
  id: string; name: string; settlementType: string; enabled: boolean; sortOrder: number;
  processorLabel: string | null; builtIn: boolean;
}
interface TaxRate { id: string; name: string; rateBasisPoints: number; isDefault: boolean }
interface CardProcessor {
  id: string; provider: string; isDefault: boolean; locationLabel: string | null;
  tipPercents: number[];
  fees: { id: string; processorId: string; name: string; rateBasisPoints: number; centAmountMinor: number }[];
  terminals: { id: string; processorId: string; name: string; locationLabel: string | null; deviceCode: string | null }[];
}
interface TaxPaymentSettings {
  currency: string;
  taxRateBasisPoints: number;
  taxRates: TaxRate[];
  paymentMethods: PaymentMethod[];
  cardProcessors: CardProcessor[];
  cardProcessing: {
    connectable: boolean; reason: string;
    connectableProviders: string[]; connectRoute: string;
  };
  settlementTypes: { value: string; label: string }[];
  cardProcessorProviders: { value: string; label: string }[];
}

/**
 * Settings -> Tax & Payment.
 *
 * The screen configures what a salon charges and how it takes money, and it is honest about the
 * one thing it cannot do: connect a card processor. The rules worth holding are that the rate a
 * salon marks as in force is the rate its invoices will actually snapshot, that the four
 * settlement types the ledger records can never be deleted out from under recorded payments,
 * and that none of it is visible across a tenant boundary.
 */
describeDatabase("tax and payment settings", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string; let rivalCookie: string; let cashierCookie: string;
  let businessId: string;
  const suffix = crypto.randomUUID();

  async function settings(withCookie = ownerCookie): Promise<TaxPaymentSettings> {
    const response = await app.inject({
      method: "GET", url: "/api/settings/tax-payments", headers: { cookie: withCookie }
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  /** What `businesses.tax_rate_basis_points` says - the column every invoice snapshots. */
  async function businessTaxRateBasisPoints(): Promise<number> {
    const [row] = await db<{ taxRateBasisPoints: number }[]>`
      select tax_rate_basis_points from businesses where id=${businessId}
    `;
    return row!.taxRateBasisPoints;
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `salon-tax-${suffix}@example.test`,
        password: "correct horse salon taxes", businessName: "Salon Taxes"
      }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;
    const rival = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `rival-tax-${suffix}@example.test`,
        password: "correct horse rival taxes", businessName: "Rival Taxes"
      }
    });
    rivalCookie = cookie(rival);

    // Somebody who takes money and configures nothing - the audience the checkout read exists
    // for, and the one the settings read must keep refusing.
    const cashierToken = crypto.randomUUID();
    const [cashier] = await db<{ userId: string }[]>`
      with account as (
        insert into users(email,normalized_email,password_hash)
        values (${`cashier-tax-${suffix}@example.test`},${`cashier-tax-${suffix}@example.test`},
          ${await hashPassword("correct horse salon cashier")})
        returning id
      )
      insert into business_memberships(business_id,user_id,role_id)
      select ${businessId},id,${await roleFor(db, businessId, ['checkout.perform','payments.view'])} from account
      returning user_id
    `;
    await db`
      insert into sessions(user_id,token_hash,expires_at)
      values (${cashier!.userId},${tokenHash(cashierToken)},now()+interval '1 day')
    `;
    cashierCookie = `pawsh_session=${cashierToken}`;
  });

  afterAll(async () => { await app.close(); await db.end(); });

  // A salon opening this screen for the first time sees what it has been charging and taking,
  // not a blank slate implying neither was ever set.
  it("serves the whole screen, and reports which processor can be connected", async () => {
    const payload = await settings();

    expect(payload.currency).toBe("USD");
    expect(payload.taxRateBasisPoints).toBe(await businessTaxRateBasisPoints());

    // The four settlement types the ledger can tell apart, in order, all built in.
    expect(payload.paymentMethods.map((method) => method.name)).toEqual(["Cash", "Card", "Check", "Other"]);
    expect(payload.paymentMethods.map((method) => method.settlementType))
      .toEqual(["cash", "external_card", "check", "other"]);
    expect(payload.paymentMethods.every((method) => method.builtIn && method.enabled)).toBe(true);
    expect(payload.paymentMethods[0]).toMatchObject({ processorLabel: null });
    expect(typeof payload.paymentMethods[0]!.sortOrder).toBe("number");

    // Exactly one rate, and it is the rate the business row already carried.
    expect(payload.taxRates).toHaveLength(1);
    expect(payload.taxRates[0]).toMatchObject({
      name: "No tax", rateBasisPoints: 0, isDefault: true
    });

    expect(payload.cardProcessors).toEqual([]);

    // The honest part, and it has to stay honest. This asserted "does not connect" for as long as
    // that was true; Square Terminal made it false, and an assertion that pins a stale claim is
    // worse than no assertion because it actively defends the wrong answer. What the server owes
    // the client is which providers can actually be connected and where, so that is what is
    // pinned - including the negative, which is the part an owner most needs: exactly one
    // provider is connectable and the rest of this screen is configuration.
    expect(payload.cardProcessing.connectable).toBe(true);
    expect(payload.cardProcessing.connectableProviders).toEqual(["square"]);
    expect(payload.cardProcessing.connectRoute).toBe("/settings/integrations");
    expect(payload.cardProcessing.reason).toMatch(/connects to Square/i);
    // Recording a processor is still not connecting to one, for every provider and for Square on
    // any screen but Integrations.
    expect(payload.cardProcessing.reason).toMatch(/No other processor can be connected/i);
    for (const provider of payload.cardProcessorProviders.map((entry) => entry.value)) {
      if (provider === "square") continue;
      expect(payload.cardProcessing.connectableProviders).not.toContain(provider);
    }

    // The two closed sets, named by the server so the client keeps no copy of a check constraint.
    expect(payload.settlementTypes.map((type) => type.value))
      .toEqual(["cash", "external_card", "check", "other"]);
    expect(payload.settlementTypes.find((type) => type.value === "external_card")?.label).toBe("Card");
    expect(payload.cardProcessorProviders.map((provider) => provider.value))
      .toEqual(["square", "stripe", "clover_cardpointe", "authorize_net"]);
  });

  it("refuses to sign anyone in without the settings permission", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/settings/tax-payments" });
    expect(anonymous.statusCode).toBe(401);
  });

  // A built-in method IS one of the four settlement types, and recorded payments of that type
  // display through it. It can be turned off; it can never be removed or relabelled.
  it("refuses to delete, rename or retype a built-in payment method", async () => {
    const before = await settings();
    const cash = before.paymentMethods.find((method) => method.name === "Cash")!;

    const deleted = await app.inject({
      method: "DELETE", url: `/api/settings/payment-methods/${cash.id}`,
      headers: { cookie: ownerCookie }
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().code).toBe("PAYMENT_METHOD_BUILT_IN");

    const renamed = await app.inject({
      method: "PATCH", url: `/api/settings/payment-methods/${cash.id}`,
      headers: { cookie: ownerCookie }, payload: { name: "Folding money" }
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().code).toBe("PAYMENT_METHOD_BUILT_IN");

    const retyped = await app.inject({
      method: "PATCH", url: `/api/settings/payment-methods/${cash.id}`,
      headers: { cookie: ownerCookie }, payload: { settlementType: "other" }
    });
    expect(retyped.statusCode).toBe(409);
    expect(retyped.json().code).toBe("PAYMENT_METHOD_BUILT_IN");

    // Disabling it is allowed, and is what the refusals point the salon at.
    const disabled = await app.inject({
      method: "PATCH", url: `/api/settings/payment-methods/${cash.id}`,
      headers: { cookie: ownerCookie }, payload: { enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().paymentMethods.find((method: PaymentMethod) => method.id === cash.id))
      .toMatchObject({ name: "Cash", settlementType: "cash", enabled: false, builtIn: true });

    await app.inject({
      method: "PATCH", url: `/api/settings/payment-methods/${cash.id}`,
      headers: { cookie: ownerCookie }, payload: { enabled: true }
    });
  });

  it("adds, renames, reorders and removes a salon's own payment method", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/settings/payment-methods", headers: { cookie: ownerCookie },
      payload: { name: "Zelle", settlementType: "other", processorLabel: "Zelle" }
    });
    expect(created.statusCode).toBe(201);
    const zelleId = created.json().createdId;
    expect(created.json().paymentMethods.find((method: PaymentMethod) => method.id === zelleId))
      .toMatchObject({ name: "Zelle", settlementType: "other", builtIn: false, enabled: true, processorLabel: "Zelle" });

    // A name already in use is refused, case- and whitespace-insensitively, matching the index.
    const duplicate = await app.inject({
      method: "POST", url: "/api/settings/payment-methods", headers: { cookie: ownerCookie },
      payload: { name: "  zelle ", settlementType: "other" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("PAYMENT_METHOD_NAME_TAKEN");

    // Renaming onto a built-in's name is the same refusal.
    const collide = await app.inject({
      method: "PATCH", url: `/api/settings/payment-methods/${zelleId}`,
      headers: { cookie: ownerCookie }, payload: { name: "Cash" }
    });
    expect(collide.statusCode).toBe(409);
    expect(collide.json().code).toBe("PAYMENT_METHOD_NAME_TAKEN");

    // A custom method may be renamed and retyped; only built-ins are fixed.
    const renamed = await app.inject({
      method: "PATCH", url: `/api/settings/payment-methods/${zelleId}`,
      headers: { cookie: ownerCookie },
      payload: { name: "Zelle transfer", settlementType: "external_card", processorLabel: null }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().paymentMethods.find((method: PaymentMethod) => method.id === zelleId))
      .toMatchObject({ name: "Zelle transfer", settlementType: "external_card", processorLabel: null });

    // A partial order is refused: renumbering a list you cannot see all of is how two methods
    // end up sharing a position.
    const partial = await app.inject({
      method: "PUT", url: "/api/settings/payment-methods/order",
      headers: { cookie: ownerCookie }, payload: { ids: [zelleId] }
    });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().code).toBe("PAYMENT_METHOD_ORDER_INCOMPLETE");

    // So is one that names a method twice to make the count come out right.
    const current = await settings();
    const doubled = await app.inject({
      method: "PUT", url: "/api/settings/payment-methods/order", headers: { cookie: ownerCookie },
      payload: { ids: current.paymentMethods.map(() => zelleId) }
    });
    expect(doubled.statusCode).toBe(400);
    expect(doubled.json().code).toBe("PAYMENT_METHOD_ORDER_INCOMPLETE");

    // The whole list, reversed, is applied - built-ins included.
    const reversed = [...current.paymentMethods].reverse().map((method) => method.id);
    const ordered = await app.inject({
      method: "PUT", url: "/api/settings/payment-methods/order", headers: { cookie: ownerCookie },
      payload: { ids: reversed }
    });
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().paymentMethods.map((method: PaymentMethod) => method.id)).toEqual(reversed);
    expect((await settings()).paymentMethods.map((method) => method.id)).toEqual(reversed);

    const removed = await app.inject({
      method: "DELETE", url: `/api/settings/payment-methods/${zelleId}`,
      headers: { cookie: ownerCookie }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().paymentMethods.some((method: PaymentMethod) => method.id === zelleId)).toBe(false);
  });

  /**
   * The rule the whole table exists for: the rate a salon marks as in force is the rate the
   * business row carries, because that column is what invoice creation snapshots. If these two
   * could drift, the settings screen would be a second, disagreeing answer to "what tax do we
   * charge".
   */
  it("mirrors the rate in force onto the column invoices snapshot", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/settings/tax-rates", headers: { cookie: ownerCookie },
      payload: { name: "City sales tax", rateBasisPoints: 875, isDefault: true }
    });
    expect(created.statusCode).toBe(201);
    const cityId = created.json().createdId;
    expect(await businessTaxRateBasisPoints()).toBe(875);

    // The rate that stood down did so in the same write, so exactly one is in force.
    const afterCreate: TaxPaymentSettings = created.json();
    expect(afterCreate.taxRates.filter((rate) => rate.isDefault).map((rate) => rate.id)).toEqual([cityId]);
    expect(afterCreate.taxRateBasisPoints).toBe(875);

    // Editing the rate in force moves the mirrored column with it.
    const edited = await app.inject({
      method: "PATCH", url: `/api/settings/tax-rates/${cityId}`, headers: { cookie: ownerCookie },
      payload: { rateBasisPoints: 900 }
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().taxRateBasisPoints).toBe(900);
    expect(await businessTaxRateBasisPoints()).toBe(900);

    // A second rate that is not in force changes nothing about what invoices charge.
    const county = await app.inject({
      method: "POST", url: "/api/settings/tax-rates", headers: { cookie: ownerCookie },
      payload: { name: "County sales tax", rateBasisPoints: 650 }
    });
    expect(county.statusCode).toBe(201);
    const countyId = county.json().createdId;
    expect(county.json().taxRates.find((rate: TaxRate) => rate.id === countyId).isDefault).toBe(false);
    expect(await businessTaxRateBasisPoints()).toBe(900);

    // Switching the default is the only way the number moves.
    const switched = await app.inject({
      method: "PATCH", url: `/api/settings/tax-rates/${countyId}`, headers: { cookie: ownerCookie },
      payload: { isDefault: true }
    });
    expect(switched.statusCode).toBe(200);
    const afterSwitch: TaxPaymentSettings = switched.json();
    expect(afterSwitch.taxRates.filter((rate) => rate.isDefault).map((rate) => rate.id)).toEqual([countyId]);
    expect(afterSwitch.taxRateBasisPoints).toBe(650);
    expect(await businessTaxRateBasisPoints()).toBe(650);

    // The database backs the "exactly one" claim, not just the projection.
    const [defaults] = await db<{ count: number }[]>`
      select count(*)::int as count from tax_rates where business_id=${businessId} and is_default
    `;
    expect(defaults!.count).toBe(1);
  });

  it("refuses to delete or un-default the rate in force", async () => {
    const current = await settings();
    const inForce = current.taxRates.find((rate) => rate.isDefault)!;
    const spare = current.taxRates.find((rate) => !rate.isDefault)!;

    const deleted = await app.inject({
      method: "DELETE", url: `/api/settings/tax-rates/${inForce.id}`, headers: { cookie: ownerCookie }
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().code).toBe("TAX_RATE_IN_FORCE");

    // Clearing the flag would leave the screen showing no rate in force while every invoice
    // still carried one, so it is refused rather than quietly applied.
    const cleared = await app.inject({
      method: "PATCH", url: `/api/settings/tax-rates/${inForce.id}`, headers: { cookie: ownerCookie },
      payload: { isDefault: false }
    });
    expect(cleared.statusCode).toBe(409);
    expect(cleared.json().code).toBe("TAX_RATE_DEFAULT_REQUIRED");

    // Nothing moved.
    expect(await businessTaxRateBasisPoints()).toBe(inForce.rateBasisPoints);

    // A rate that is not in force deletes cleanly.
    const removed = await app.inject({
      method: "DELETE", url: `/api/settings/tax-rates/${spare.id}`, headers: { cookie: ownerCookie }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().taxRates.some((rate: TaxRate) => rate.id === spare.id)).toBe(false);
    expect(await businessTaxRateBasisPoints()).toBe(inForce.rateBasisPoints);
  });

  it("refuses a duplicate tax rate name", async () => {
    const inForce = (await settings()).taxRates.find((rate) => rate.isDefault)!;
    const duplicate = await app.inject({
      method: "POST", url: "/api/settings/tax-rates", headers: { cookie: ownerCookie },
      payload: { name: inForce.name.toUpperCase(), rateBasisPoints: 100 }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("TAX_RATE_NAME_TAKEN");
  });

  // The business settings form writes `businesses.tax_rate_basis_points` directly. Either screen
  // may set the rate; neither may leave the other showing a different number.
  it("carries a business settings tax change onto the rate in force", async () => {
    const [location] = await db<{ version: number }[]>`
      select version from locations where business_id=${businessId} order by name,id limit 1
    `;
    const saved = await app.inject({
      method: "PUT", url: "/api/business/settings", headers: { cookie: ownerCookie },
      payload: {
        name: "Salon Taxes", phone: null, email: null, timezone: "America/Los_Angeles",
        currency: "USD", taxRateBasisPoints: 1025, reminderLeadMinutes: 1440,
        locationVersion: location!.version
      }
    });
    expect(saved.statusCode).toBe(200);

    const payload = await settings();
    expect(payload.taxRateBasisPoints).toBe(1025);
    expect(payload.taxRates.find((rate) => rate.isDefault)?.rateBasisPoints).toBe(1025);
    expect(payload.taxRates.filter((rate) => rate.isDefault)).toHaveLength(1);
  });

  /**
   * A processor row is configuration a salon keeps for its own reference, and a terminal row is
   * an inventory record of a device on the counter. Creating either connects and pairs nothing,
   * which is why nothing in these requests carries a credential.
   */
  it("configures a card processor with its fees and terminals", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/settings/card-processors", headers: { cookie: ownerCookie },
      payload: { provider: "square", locationLabel: "Front counter" }
    });
    expect(created.statusCode).toBe(201);
    const processorId = created.json().createdId;
    // The first processor is the default whether or not anybody said so, and the tip presets
    // come back from the server rather than being assumed by the client.
    expect(created.json().cardProcessors[0]).toMatchObject({
      id: processorId, provider: "square", isDefault: true, locationLabel: "Front counter",
      tipPercents: [15, 18, 20], fees: [], terminals: []
    });

    // The same provider twice is refused: it is the row's identity within a business.
    const again = await app.inject({
      method: "POST", url: "/api/settings/card-processors", headers: { cookie: ownerCookie },
      payload: { provider: "square" }
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("CARD_PROCESSOR_EXISTS");

    const tipped = await app.inject({
      method: "PATCH", url: `/api/settings/card-processors/${processorId}`,
      headers: { cookie: ownerCookie }, payload: { tipPercents: [10, 15, 20], locationLabel: null }
    });
    expect(tipped.statusCode).toBe(200);
    expect(tipped.json().cardProcessors[0]).toMatchObject({
      tipPercents: [10, 15, 20], locationLabel: null
    });

    // "2.6% + 10c" is one fee, not two.
    const fee = await app.inject({
      method: "POST", url: `/api/settings/card-processors/${processorId}/fees`,
      headers: { cookie: ownerCookie },
      payload: { name: "Card present", rateBasisPoints: 260, centAmountMinor: 10 }
    });
    expect(fee.statusCode).toBe(201);
    const feeId = fee.json().createdId;
    expect(fee.json().cardProcessors[0].fees).toEqual([
      expect.objectContaining({ id: feeId, processorId, name: "Card present", rateBasisPoints: 260, centAmountMinor: 10 })
    ]);

    const terminal = await app.inject({
      method: "POST", url: `/api/settings/card-processors/${processorId}/terminals`,
      headers: { cookie: ownerCookie },
      payload: { name: "Counter reader", locationLabel: "Front counter", deviceCode: "SQ-1188" }
    });
    expect(terminal.statusCode).toBe(201);
    const terminalId = terminal.json().createdId;
    expect(terminal.json().cardProcessors[0].terminals).toEqual([
      expect.objectContaining({
        id: terminalId, processorId, name: "Counter reader",
        locationLabel: "Front counter", deviceCode: "SQ-1188"
      })
    ]);

    // A second processor takes over as the default only when it says so, and exactly one holds
    // the flag afterwards.
    const stripe = await app.inject({
      method: "POST", url: "/api/settings/card-processors", headers: { cookie: ownerCookie },
      payload: { provider: "stripe", isDefault: true }
    });
    expect(stripe.statusCode).toBe(201);
    const stripeId = stripe.json().createdId;
    expect(stripe.json().cardProcessors.filter((processor: CardProcessor) => processor.isDefault)
      .map((processor: CardProcessor) => processor.id)).toEqual([stripeId]);

    // Clearing the last default is refused; the salon names a successor instead.
    const cleared = await app.inject({
      method: "PATCH", url: `/api/settings/card-processors/${stripeId}`,
      headers: { cookie: ownerCookie }, payload: { isDefault: false }
    });
    expect(cleared.statusCode).toBe(409);
    expect(cleared.json().code).toBe("CARD_PROCESSOR_DEFAULT_REQUIRED");

    // Deleting the default promotes the survivor rather than leaving no answer to "which one
    // do we use?".
    const removedDefault = await app.inject({
      method: "DELETE", url: `/api/settings/card-processors/${stripeId}`,
      headers: { cookie: ownerCookie }
    });
    expect(removedDefault.statusCode).toBe(200);
    expect(removedDefault.json().cardProcessors.map((processor: CardProcessor) => processor.id)).toEqual([processorId]);
    expect(removedDefault.json().cardProcessors[0].isDefault).toBe(true);

    // A fee deletes on its own; deleting the processor takes the rest with it.
    const feeRemoved = await app.inject({
      method: "DELETE", url: `/api/settings/card-processors/${processorId}/fees/${feeId}`,
      headers: { cookie: ownerCookie }
    });
    expect(feeRemoved.statusCode).toBe(200);
    expect(feeRemoved.json().cardProcessors[0].fees).toEqual([]);

    const processorRemoved = await app.inject({
      method: "DELETE", url: `/api/settings/card-processors/${processorId}`,
      headers: { cookie: ownerCookie }
    });
    expect(processorRemoved.statusCode).toBe(200);
    expect(processorRemoved.json().cardProcessors).toEqual([]);
    const [orphans] = await db<{ count: number }[]>`
      select count(*)::int as count from card_processor_terminals where id=${terminalId}
    `;
    expect(orphans!.count).toBe(0);
  });

  /**
   * Tenant isolation, on the nested resources as well as the top-level ones. Another salon's id
   * is not a permission error to be probed - it is a 404, and it acts on nothing.
   */
  it("treats another salon's processor, terminal and rate as absent", async () => {
    const mine = await app.inject({
      method: "POST", url: "/api/settings/card-processors", headers: { cookie: ownerCookie },
      payload: { provider: "clover_cardpointe", locationLabel: "Mine" }
    });
    const processorId = mine.json().createdId;
    const terminal = await app.inject({
      method: "POST", url: `/api/settings/card-processors/${processorId}/terminals`,
      headers: { cookie: ownerCookie }, payload: { name: "Mine only" }
    });
    const terminalId = terminal.json().createdId;
    const rate = (await settings()).taxRates.find((entry) => entry.isDefault)!;

    // The rival cannot hang a terminal off a processor it does not own,
    const attached = await app.inject({
      method: "POST", url: `/api/settings/card-processors/${processorId}/terminals`,
      headers: { cookie: rivalCookie }, payload: { name: "Theirs" }
    });
    expect(attached.statusCode).toBe(404);

    // cannot delete the one that is there,
    const deletedTerminal = await app.inject({
      method: "DELETE", url: `/api/settings/card-processors/${processorId}/terminals/${terminalId}`,
      headers: { cookie: rivalCookie }
    });
    expect(deletedTerminal.statusCode).toBe(404);

    // cannot price it,
    const fee = await app.inject({
      method: "POST", url: `/api/settings/card-processors/${processorId}/fees`,
      headers: { cookie: rivalCookie }, payload: { name: "Theirs", rateBasisPoints: 100 }
    });
    expect(fee.statusCode).toBe(404);

    // cannot edit or delete the processor itself,
    const patched = await app.inject({
      method: "PATCH", url: `/api/settings/card-processors/${processorId}`,
      headers: { cookie: rivalCookie }, payload: { locationLabel: "Theirs" }
    });
    expect(patched.statusCode).toBe(404);
    const deletedProcessor = await app.inject({
      method: "DELETE", url: `/api/settings/card-processors/${processorId}`,
      headers: { cookie: rivalCookie }
    });
    expect(deletedProcessor.statusCode).toBe(404);

    // and cannot touch the rate this salon is charging.
    const deletedRate = await app.inject({
      method: "DELETE", url: `/api/settings/tax-rates/${rate.id}`, headers: { cookie: rivalCookie }
    });
    expect(deletedRate.statusCode).toBe(404);

    // None of the refusals were partial: everything is exactly where it was, and the rival's
    // own screen never contained any of it.
    const after = await settings();
    expect(after.cardProcessors.find((processor) => processor.id === processorId))
      .toMatchObject({ locationLabel: "Mine", terminals: [expect.objectContaining({ id: terminalId })] });
    expect(after.taxRates.some((entry) => entry.id === rate.id)).toBe(true);
    const rivalSettings = await settings(rivalCookie);
    expect(rivalSettings.cardProcessors).toEqual([]);
    expect(rivalSettings.taxRates.some((entry) => entry.id === rate.id)).toBe(false);

    await app.inject({
      method: "DELETE", url: `/api/settings/card-processors/${processorId}`,
      headers: { cookie: ownerCookie }
    });
  });

  /**
   * A duplicate name is something a person walks into, not an edge case: someone adds a second
   * "Cash". Both the checked path and the raced path have to come back as a rendered sentence.
   */
  it("answers a duplicate name with presentable text, however it is reached", async () => {
    const refused = await app.inject({
      method: "POST", url: "/api/settings/payment-methods", headers: { cookie: ownerCookie },
      payload: { name: "Cash", settlementType: "cash" }
    });
    expect(refused.statusCode).toBe(409);
    const body = refused.json();
    expect(body.code).toBe("PAYMENT_METHOD_NAME_TAKEN");
    // Renderable as-is: a sentence, not a constraint name, a stack or a driver message.
    expect(body.error).toBe("A payment method with that name already exists.");
    expect(body.error).not.toMatch(/duplicate key|constraint|pg_|relation|\bERROR\b/i);
    expect(refused.headers["content-type"]).toMatch(/application\/json/);

    // Two writers going for the same name at once. Whichever way they interleave - one losing
    // the pre-check, or one losing the index - exactly one wins and the other is told the same
    // thing in the same words.
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST", url: "/api/settings/payment-methods", headers: { cookie: ownerCookie },
        payload: { name: "Tap to pay", settlementType: "external_card" }
      }),
      app.inject({
        method: "POST", url: "/api/settings/payment-methods", headers: { cookie: ownerCookie },
        payload: { name: "tap to pay", settlementType: "external_card" }
      })
    ]);
    const statuses = [first!.statusCode, second!.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first!.statusCode === 409 ? first! : second!;
    expect(loser.json()).toMatchObject({
      code: "PAYMENT_METHOD_NAME_TAKEN",
      error: "A payment method with that name already exists."
    });
    const winner = first!.statusCode === 201 ? first! : second!;
    await app.inject({
      method: "DELETE", url: `/api/settings/payment-methods/${winner.json().createdId}`,
      headers: { cookie: ownerCookie }
    });
  });

  /**
   * The raced path, forced rather than hoped for.
   *
   * An uncommitted row with the same name is invisible to the route's pre-check, so the route
   * gets past it and blocks on `payment_method_name_per_business` instead - which is exactly the
   * interleaving two salon staff can produce. What comes back must still be the sentence, never
   * "duplicate key value violates unique constraint".
   */
  it("turns a lost race on the unique index into the same sentence", async () => {
    const name = `Split second ${suffix.slice(0, 8)}`;
    const addMethod = () => app.inject({
      method: "POST", url: "/api/settings/payment-methods", headers: { cookie: ownerCookie },
      payload: { name, settlementType: "other" }
    });
    let pending: ReturnType<typeof addMethod> | undefined;
    await db.begin(async (tx) => {
      await tx`select set_config('app.business_id',${businessId},true)`;
      await tx`
        insert into payment_methods (business_id,name,settlement_type,sort_order)
        values (${businessId},${name},'other',900)
      `;
      pending = addMethod();
      // Long enough for the request to reach its insert and block there. If it does not, the
      // committed row makes the pre-check refuse instead - the same code, the same sentence.
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const raced = await pending!;
    expect(raced.statusCode).toBe(409);
    expect(raced.json()).toEqual({
      code: "PAYMENT_METHOD_NAME_TAKEN",
      error: "A payment method with that name already exists."
    });

    await db`delete from payment_methods where business_id=${businessId} and name=${name}`;
  });

  // The translation table is keyed by the name PostgreSQL reports. A renamed or dropped index
  // would silently fall back to "violates a data integrity rule", which explains nothing.
  it("names indexes that actually exist for every uniqueness message", async () => {
    const known = await db<{ name: string }[]>`
      select indexname as name from pg_indexes where schemaname='public'
      union select conname as name from pg_constraint
    `;
    const names = new Set(known.map((row) => row.name));
    for (const constraint of Object.keys(uniqueViolations)) {
      expect(names.has(constraint), constraint).toBe(true);
    }
  });

  /**
   * The whole feature is decorative unless the people who take money can see it. Checkout is
   * gated on `checkout.perform`; the settings screen on `settings.manage`. Most staff have the
   * first and not the second, so they read the configuration through a narrower door.
   */
  it("serves the checkout modal's payment options to a member who can only take payments", async () => {
    // The door that stays shut: no settings access, so no settings payload.
    const refused = await app.inject({
      method: "GET", url: "/api/settings/tax-payments", headers: { cookie: cashierCookie }
    });
    expect(refused.statusCode).toBe(403);

    // The door that opens.
    const response = await app.inject({
      method: "GET", url: "/api/checkout/payment-options", headers: { cookie: cashierCookie }
    });
    expect(response.statusCode).toBe(200);
    const options = response.json();

    // Exactly the fields checkout needs, and no others on any method.
    expect(options.paymentMethods.length).toBeGreaterThan(0);
    for (const method of options.paymentMethods) {
      expect(Object.keys(method).sort()).toEqual(["id", "name", "settlementType"]);
    }

    // Same order the settings screen shows, so a groomer and an owner are looking at one list.
    const owner = await settings();
    expect(options.paymentMethods.map((method: { id: string }) => method.id))
      .toEqual(owner.paymentMethods.filter((method) => method.enabled).map((method) => method.id));

    // No processor recorded yet: null, not an empty array, so the client can tell "no presets
    // configured" from "these are the presets".
    expect(options.tipPercents).toBeNull();

    // This cashier holds `checkout.perform` and `payments.view` and NOT `discounts.apply`, so the
    // configured discounts are withheld - as null, which is not the empty array a salon with none
    // would get. The stacking rule is not withheld: it is a policy enum, not configuration.
    expect(options.discounts).toBeNull();
    expect(options.stackingMode).toBe("one_per_appointment");

    // NULL, because this request named no client. `creditAvailableMinor` answers "what has THIS
    // customer got on account", so a request that mentions nobody has no answer to give - and
    // null rather than zero, because a client with an empty balance is a different thing from a
    // question that was never asked.
    expect(options.creditAvailableMinor).toBeNull();

    // Nothing about tax, fees, terminals, providers or disabled methods rides along. Exhaustive
    // on purpose: a field added to this endpoint has to be argued for here before it ships.
    //
    // `creditAvailableMinor` IS THE ARGUMENT FOR ONE ADDITION, and it is a deliberate narrow
    // exposure rather than an oversight. Applying existing credit at checkout needs only
    // `checkout.perform` - the same rule that lets this cashier redeem a coupon they cannot
    // create - so an operator who may spend a balance has to be told what the balance is or they
    // cannot spend it. It is ONE figure, about the client at the till. Everything else in the
    // ledger - who granted it, when, why, what it was spent on - stays behind `payments.view` on
    // the customer routes, and this cashier reaches none of it here.
    expect(Object.keys(options).sort())
      .toEqual([
        "creditAvailableMinor", "discounts", "paymentMethods", "stackingMode", "tipPercents"
      ]);
    const serialized = response.body;
    for (const leaked of ["taxRate", "currency", "fees", "terminals", "provider", "locationLabel",
      "builtIn", "enabled", "sortOrder", "cardProcessing", "processorLabel"]) {
      expect(serialized, leaked).not.toContain(leaked);
    }
  });

  it("hides disabled methods from checkout while the settings screen still lists them", async () => {
    const before = await settings();
    const check = before.paymentMethods.find((method) => method.name === "Check")!;
    await app.inject({
      method: "PATCH", url: `/api/settings/payment-methods/${check.id}`,
      headers: { cookie: ownerCookie }, payload: { enabled: false }
    });

    const options = (await app.inject({
      method: "GET", url: "/api/checkout/payment-options", headers: { cookie: cashierCookie }
    })).json();
    // Gone from checkout - a groomer cannot take a payment through a method the salon turned off.
    expect(options.paymentMethods.some((method: { id: string }) => method.id === check.id)).toBe(false);
    // Still on the settings screen, because that is where it gets turned back on.
    expect((await settings()).paymentMethods.find((method) => method.id === check.id))
      .toMatchObject({ enabled: false });

    // The tip presets come from the default processor, and only those three numbers do.
    const processor = await app.inject({
      method: "POST", url: "/api/settings/card-processors", headers: { cookie: ownerCookie },
      payload: { provider: "authorize_net", locationLabel: "Back office", tipPercents: [12, 18, 25] }
    });
    const processorId = processor.json().createdId;
    await app.inject({
      method: "POST", url: `/api/settings/card-processors/${processorId}/fees`,
      headers: { cookie: ownerCookie },
      payload: { name: "Keyed entry", rateBasisPoints: 350, centAmountMinor: 30 }
    });
    await app.inject({
      method: "POST", url: `/api/settings/card-processors/${processorId}/terminals`,
      headers: { cookie: ownerCookie }, payload: { name: "Back office reader", deviceCode: "AN-77" }
    });

    const withProcessor = await app.inject({
      method: "GET", url: "/api/checkout/payment-options", headers: { cookie: cashierCookie }
    });
    expect(withProcessor.json().tipPercents).toEqual([12, 18, 25]);
    // What the salon pays its processor, where the machine sits and what it is called are the
    // owner's business, not the cashier's.
    for (const leaked of ["Keyed entry", "Back office", "AN-77", "authorize_net", "rateBasisPoints"]) {
      expect(withProcessor.body, leaked).not.toContain(leaked);
    }

    // A salon may disable everything; that is an empty list, not a failure.
    for (const method of (await settings()).paymentMethods) {
      await app.inject({
        method: "PATCH", url: `/api/settings/payment-methods/${method.id}`,
        headers: { cookie: ownerCookie }, payload: { enabled: false }
      });
    }
    const emptied = await app.inject({
      method: "GET", url: "/api/checkout/payment-options", headers: { cookie: cashierCookie }
    });
    expect(emptied.statusCode).toBe(200);
    expect(emptied.json().paymentMethods).toEqual([]);

    // Another salon's cashier sees its own list, never this one's.
    const rivalOptions = await app.inject({
      method: "GET", url: "/api/checkout/payment-options", headers: { cookie: rivalCookie }
    });
    expect(rivalOptions.json().paymentMethods.length).toBe(4);
    expect(rivalOptions.json().tipPercents).toBeNull();

    for (const method of (await settings()).paymentMethods) {
      await app.inject({
        method: "PATCH", url: `/api/settings/payment-methods/${method.id}`,
        headers: { cookie: ownerCookie }, payload: { enabled: true }
      });
    }
    await app.inject({
      method: "DELETE", url: `/api/settings/card-processors/${processorId}`,
      headers: { cookie: ownerCookie }
    });
  });

  // A new business arrives configured, the way migration 0034 left every business that already
  // existed. An empty screen would imply this salon charges no tax and takes no payments.
  it("provisions a newly created business with the same starting configuration", async () => {
    const fresh = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `fresh-tax-${suffix}@example.test`,
        password: "correct horse fresh taxes", businessName: "Fresh Taxes"
      }
    });
    expect(fresh.statusCode).toBe(201);
    const payload = await settings(cookie(fresh));
    expect(payload.paymentMethods.map((method) => method.settlementType))
      .toEqual(["cash", "external_card", "check", "other"]);
    expect(payload.paymentMethods.every((method) => method.builtIn)).toBe(true);
    expect(payload.taxRates).toHaveLength(1);
    expect(payload.taxRates[0]).toMatchObject({ isDefault: true, rateBasisPoints: 0 });
    expect(payload.taxRateBasisPoints).toBe(0);
  });
});
