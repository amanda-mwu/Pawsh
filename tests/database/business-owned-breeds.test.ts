import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import type { Config } from "../../src/config.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "business-owned-breeds-test-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
function cookie(response: { headers: Record<string, unknown> }) {
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

interface CatalogBreed {
  id: string; name: string; search: string;
  defaultPricingClass: string; active: boolean; customized: boolean; businessOwned: boolean;
}

/**
 * A business may add breeds of its own. It may never rename or delete a shared Pawsh breed,
 * because
 * breed identity is the one thing every tenant shares and every pet's price resolves through.
 */
describeDatabase("business-owned breeds", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  let ownerCookie: string; let otherCookie: string;
  let businessId: string; let otherBusinessId: string;
  let customerId: string; let dogTypeId: string; let catTypeId: string;
  let groomId: string;
  const suffix = crypto.randomUUID();

  /** Every pet's EFFECTIVE pricing class, resolved exactly the way the pricing resolver does. */
  async function petPricingDistribution(): Promise<Record<string, number>> {
    const rows = await db<{ pricingClass: string; count: number }[]>`
      select coalesce(
               case when coalesce(override.active,breed.active)
                    then coalesce(override.pricing_class,breed.default_pricing_class) end,
               'STANDARD') as pricing_class,
             count(*)::int as count
      from pets pet
      left join breeds breed on breed.id=pet.breed_id
      left join business_breed_settings override
        on override.business_id=pet.business_id and override.breed_id=breed.id
      group by 1
    `;
    return Object.fromEntries(rows.map((row) => [row.pricingClass, row.count]));
  }

  /** The shared taxonomy's own class counts. Nothing a tenant does may move these. */
  async function sharedTaxonomySnapshot(): Promise<Record<string, number>> {
    const rows = await db<{ defaultPricingClass: string; count: number }[]>`
      select default_pricing_class,count(*)::int as count
      from breeds where business_id is null group by 1
    `;
    return Object.fromEntries(rows.map((row) => [row.defaultPricingClass, row.count]));
  }

  async function dogBreeds(withCookie: string): Promise<CatalogBreed[]> {
    return (await app.inject({
      method: "GET", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: withCookie }
    })).json();
  }

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: `salon-breeds-${suffix}@example.test`, password: "correct horse salon breeds", businessName: "Salon Breeds" }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;
    const other = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: `rival-breeds-${suffix}@example.test`, password: "correct horse rival breeds", businessName: "Rival Breeds" }
    });
    otherCookie = cookie(other);
    otherBusinessId = other.json().businessId;
    const customer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: ownerCookie },
      payload: { firstName: "Breed", lastName: "Owner" }
    });
    customerId = customer.json().id;
    const types = (await app.inject({ method: "GET", url: "/api/pet-types", headers: { cookie: ownerCookie } })).json();
    dogTypeId = types.find((type: { search: string }) => type.search === "dog").id;
    catTypeId = types.find((type: { search: string }) => type.search === "cat").id;
    const services = (await app.inject({ method: "GET", url: "/api/services", headers: { cookie: ownerCookie } })).json();
    groomId = services.find((service: { seedKey: string }) => service.seedKey === "dog-groom-style").id;
  });

  afterAll(async () => { await app.close(); await db.end(); });

  // The whole point of the schema choice: a business breed is an ordinary breed id, so it flows
  // through pet selection and the pricing resolver with no second code path.
  it("creates a business breed that behaves like any other breed", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Cavapoochon", pricingClass: "EXTRA_FLOOF" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "Cavapoochon", search: "cavapoochon",
      defaultPricingClass: "EXTRA_FLOOF", active: true, businessOwned: true
    });
    const breedId = created.json().id;

    // It appears in the catalog beside the shared rows, and it is the only business-owned one.
    const catalog = await dogBreeds(ownerCookie);
    expect(catalog.filter((breed) => breed.businessOwned).map((breed) => breed.name)).toEqual(["Cavapoochon"]);
    expect(catalog.find((breed) => breed.name === "Poodle")).toMatchObject({ businessOwned: false });

    // A pet may be recorded against it, and prices through its class.
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Cava", species: "dog", petTypeId: dogTypeId, breedId, weightOunces: 300 }
    });
    expect(pet.statusCode).toBe(201);
    expect(pet.json()).toMatchObject({ breedId, breed: "Cavapoochon" });
    const priced = await app.inject({
      method: "POST", url: "/api/pricing/resolve", headers: { cookie: ownerCookie },
      payload: { petId: pet.json().id, serviceIds: [groomId] }
    });
    expect(priced.json()[0].pricingClass).toBe("EXTRA_FLOOF");

    // The database proves the composite key still holds: a cat cannot be a Cavapoochon.
    await expect(db`
      update pets set pet_type_id=${catTypeId} where id=${pet.json().id} and business_id=${businessId}
    `).rejects.toThrow();

    await db`update pets set breed_id=null where id=${pet.json().id}`;
    await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
  });

  it("renames and deletes a breed the business owns", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Housse Terrier" }
    });
    const breedId = created.json().id;
    expect(created.json()).toMatchObject({ defaultPricingClass: "STANDARD", businessOwned: true });

    const renamed = await app.inject({
      method: "PATCH", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie },
      payload: { name: "House Terrier" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: breedId, name: "House Terrier", search: "house terrier", businessOwned: true });

    // Identity survived the rename: the id did not move, so nothing repriced.
    const [stored] = await db<{ id: string; normalizedName: string; defaultPricingClass: string }[]>`
      select id,normalized_name,default_pricing_class from breeds where id=${breedId}`;
    expect(stored).toMatchObject({ normalizedName: "house terrier", defaultPricingClass: "STANDARD" });

    const deleted = await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
    expect(deleted.statusCode).toBe(204);
    expect((await dogBreeds(ownerCookie)).find((breed) => breed.id === breedId)).toBeUndefined();
  });

  // A rename is a display correction, not a repricing: the pet keeps the same breed_id and the
  // denormalized display text follows the new name.
  it("carries a rename onto the display text of pets already on the breed", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Sproodle", pricingClass: "EXTRA_FLOOF" }
    });
    const breedId = created.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Sprout", species: "dog", petTypeId: dogTypeId, breedId, weightOunces: 300 }
    });
    const before = (await app.inject({
      method: "POST", url: "/api/pricing/resolve", headers: { cookie: ownerCookie },
      payload: { petId: pet.json().id, serviceIds: [groomId] }
    })).json()[0];

    await app.inject({
      method: "PATCH", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie },
      payload: { name: "Springerdoodle" }
    });
    const [petRow] = await db<{ breed: string; breedId: string }[]>`
      select breed,breed_id from pets where id=${pet.json().id}`;
    expect(petRow).toMatchObject({ breed: "Springerdoodle", breedId });

    const after = (await app.inject({
      method: "POST", url: "/api/pricing/resolve", headers: { cookie: ownerCookie },
      payload: { petId: pet.json().id, serviceIds: [groomId] }
    })).json()[0];
    expect(after.pricingClass).toBe(before.pricingClass);
    expect(after.priceMinor).toBe(before.priceMinor);

    await db`update pets set breed_id=null where id=${pet.json().id}`;
    await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
  });

  // Renaming a shared breed would change identity for every tenant at once. Deleting one would
  // remove a row other tenants' pets reference. Both are refused with a code the client can key
  // on so it can hide the pencil and the trash rather than discovering this by failing.
  it("refuses to rename or delete a shared Pawsh breed", async () => {
    const poodle = (await dogBreeds(ownerCookie)).find((breed) => breed.name === "Poodle")!;
    expect(poodle.businessOwned).toBe(false);

    const renamed = await app.inject({
      method: "PATCH", url: `/api/breeds/${poodle.id}`, headers: { cookie: ownerCookie },
      payload: { name: "House Poodle" }
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().code).toBe("BREED_NOT_BUSINESS_OWNED");

    const deleted = await app.inject({
      method: "DELETE", url: `/api/breeds/${poodle.id}`, headers: { cookie: ownerCookie }
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().code).toBe("BREED_NOT_BUSINESS_OWNED");

    // Untouched, for this tenant and for everyone else.
    const [canonical] = await db<{ name: string; businessId: string | null }[]>`
      select name,business_id from breeds where id=${poodle.id}`;
    expect(canonical).toMatchObject({ name: "Poodle", businessId: null });
    expect((await dogBreeds(otherCookie)).find((breed) => breed.id === poodle.id)?.name).toBe("Poodle");

    // The controls a business DOES have over a shared breed still work.
    const configured = await app.inject({
      method: "PUT", url: `/api/breeds/${poodle.id}/settings`, headers: { cookie: ownerCookie },
      payload: { pricingClass: "SMOOTH_SINGLE" }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ defaultPricingClass: "SMOOTH_SINGLE", customized: true, businessOwned: false });
    await app.inject({
      method: "PUT", url: `/api/breeds/${poodle.id}/settings`, headers: { cookie: ownerCookie },
      payload: { pricingClass: null, active: null }
    });
  });

  // A business "Poodle" would shadow the canonical Poodle in the picker and make name-based text
  // resolution ambiguous, so it is refused rather than created.
  it("refuses a name that collides with the shared taxonomy or with an alias", async () => {
    const shared = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "poodle" }
    });
    expect(shared.statusCode).toBe(409);
    expect(shared.json().code).toBe("BREED_NAME_TAKEN");

    // Normalisation, not string equality: punctuation and case must not smuggle a duplicate in.
    const punctuated = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Shih-Tzu" }
    });
    expect(punctuated.statusCode).toBe(409);

    // An alias is a spelling of an existing breed. Claiming it would make "Yorkie" ambiguous.
    const alias = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Yorkie" }
    });
    expect(alias.statusCode).toBe(409);
    expect(alias.json().code).toBe("BREED_NAME_TAKEN");

    // The same name is fine under a different pet type - uniqueness is scoped to the type.
    const asCat = await app.inject({
      method: "POST", url: `/api/pet-types/${catTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Yorkie" }
    });
    expect(asCat.statusCode).toBe(201);
    await app.inject({ method: "DELETE", url: `/api/breeds/${asCat.json().id}`, headers: { cookie: ownerCookie } });

    // And a business cannot add the same name twice.
    const first = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Borderdoodle" }
    });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "borderdoodle" }
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("BREED_NAME_TAKEN");

    // Renaming onto a taken name is refused the same way, and leaves the row as it was.
    const other = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Aussiedoodle Cross" }
    });
    const clash = await app.inject({
      method: "PATCH", url: `/api/breeds/${other.json().id}`, headers: { cookie: ownerCookie },
      payload: { name: "Borderdoodle" }
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe("BREED_NAME_TAKEN");
    const [unchanged] = await db<{ name: string }[]>`select name from breeds where id=${other.json().id}`;
    expect(unchanged!.name).toBe("Aussiedoodle Cross");

    // Renaming a breed to the name it already has is not a collision with itself.
    const noop = await app.inject({
      method: "PATCH", url: `/api/breeds/${other.json().id}`, headers: { cookie: ownerCookie },
      payload: { name: "Aussiedoodle Cross" }
    });
    expect(noop.statusCode).toBe(200);

    for (const id of [first.json().id, other.json().id]) {
      await app.inject({ method: "DELETE", url: `/api/breeds/${id}`, headers: { cookie: ownerCookie } });
    }

    // The database refuses the shared collision even when the API is bypassed entirely.
    await expect(db`
      insert into breeds (business_id,pet_type_id,name,normalized_name)
      values (${businessId},${dogTypeId},'Poodle','poodle')
    `).rejects.toThrow(/already exists in the shared Pawsh taxonomy/);
  });

  // Two businesses naming the same breed are two independent rows. Neither collides, and neither
  // can see the other's.
  it("lets two businesses add the same breed name independently", async () => {
    const mine = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Village Doodle", pricingClass: "EXTRA_FLOOF" }
    });
    const theirs = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: otherCookie },
      payload: { name: "Village Doodle", pricingClass: "SMOOTH_SINGLE" }
    });
    expect(mine.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    expect(mine.json().id).not.toBe(theirs.json().id);
    // Independent rows carry independent classes; neither account's choice reaches the other.
    expect(mine.json().defaultPricingClass).toBe("EXTRA_FLOOF");
    expect(theirs.json().defaultPricingClass).toBe("SMOOTH_SINGLE");

    const mineNames = (await dogBreeds(ownerCookie)).filter((breed) => breed.name === "Village Doodle");
    expect(mineNames).toHaveLength(1);
    expect(mineNames[0]!.id).toBe(mine.json().id);

    for (const [id, withCookie] of [[mine.json().id, ownerCookie], [theirs.json().id, otherCookie]] as const) {
      await app.inject({ method: "DELETE", url: `/api/breeds/${id}`, headers: { cookie: withCookie } });
    }
  });

  it("keeps one business's breed invisible and untouchable to another", async () => {
    const mine = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Private Doodle" }
    });
    const breedId = mine.json().id;

    expect((await dogBreeds(otherCookie)).some((breed) => breed.id === breedId)).toBe(false);
    expect((await app.inject({
      method: "GET", url: "/api/dog-breeds", headers: { cookie: otherCookie }
    })).json().some((breed: CatalogBreed) => breed.id === breedId)).toBe(false);

    // Every write path answers "not found" rather than leaking that the row exists.
    for (const request of [
      { method: "PATCH" as const, url: `/api/breeds/${breedId}`, payload: { name: "Stolen Doodle" } },
      { method: "PUT" as const, url: `/api/breeds/${breedId}/settings`, payload: { pricingClass: "EXTRA_FLOOF" } },
      { method: "DELETE" as const, url: `/api/breeds/${breedId}` }
    ]) {
      const response = await app.inject({ ...request, headers: { cookie: otherCookie } });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }

    // And it cannot be attached to the other business's pet.
    const theirCustomer = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: otherCookie },
      payload: { firstName: "Rival", lastName: "Client" }
    });
    const refused = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: otherCookie },
      payload: { customerId: theirCustomer.json().id, name: "Rival Pet", species: "dog", petTypeId: dogTypeId, breedId }
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("BREED_NOT_IN_CATALOG");

    // The API is not the only thing standing in the way: the database refuses it too.
    await expect(db`
      insert into pets (business_id,customer_id,name,species,pet_type_id,breed_id)
      values (${otherBusinessId},${theirCustomer.json().id},'Direct Pet','dog',${dogTypeId},${breedId})
    `).rejects.toThrow(/breed owned by another business/);

    const [survived] = await db<{ name: string }[]>`select name from breeds where id=${breedId}`;
    expect(survived!.name).toBe("Private Doodle");
    await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
  });

  // Nulling breed_id and keeping the display text - the way legacy pets are grandfathered -
  // would silently drop these pets to STANDARD. The delete is refused instead.
  it("refuses to delete a breed pets are still recorded against", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Used Doodle", pricingClass: "EXTRA_FLOOF" }
    });
    const breedId = created.json().id;
    const pet = await app.inject({
      method: "POST", url: "/api/pets", headers: { cookie: ownerCookie },
      payload: { customerId, name: "Used", species: "dog", petTypeId: dogTypeId, breedId, weightOunces: 300 }
    });
    const petId = pet.json().id;

    const refused = await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "BREED_IN_USE", petCount: 1 });

    // The breed and the pet's pricing class both survive the refusal.
    const priced = await app.inject({
      method: "POST", url: "/api/pricing/resolve", headers: { cookie: ownerCookie },
      payload: { petId, serviceIds: [groomId] }
    });
    expect(priced.json()[0].pricingClass).toBe("EXTRA_FLOOF");

    // Archiving is not release: the row still holds the foreign key, so the delete still refuses.
    await db`update pets set archived_at=now() where id=${petId}`;
    const stillRefused = await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
    expect(stillRefused.statusCode).toBe(409);
    expect(stillRefused.json()).toMatchObject({ code: "BREED_IN_USE", petCount: 1 });

    // Once nothing references it, the delete goes through - and takes the account's own override
    // of its own breed with it.
    await app.inject({
      method: "PUT", url: `/api/breeds/${breedId}/settings`, headers: { cookie: ownerCookie },
      payload: { pricingClass: "SMOOTH_SINGLE" }
    });
    await db`update pets set breed_id=null where id=${petId}`;
    const deleted = await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
    expect(deleted.statusCode).toBe(204);
    const [orphans] = await db<{ count: number }[]>`
      select count(*)::int as count from business_breed_settings where breed_id=${breedId}`;
    expect(orphans!.count).toBe(0);
  });

  // The 0001 tenant_isolation loop is a one-time do-block and never saw this table, so `breeds`
  // carries its own policies. They are asserted under a NON-OWNER role, because the application
  // role owns these tables and would bypass row-level security silently.
  it("isolates business breeds under row-level security for a non-owner role", async () => {
    const policies = await db<{ policyname: string }[]>`
      select policyname from pg_policies where tablename='breeds' order by policyname`;
    expect(policies.map((policy) => policy.policyname)).toEqual(["shared_taxonomy_read", "tenant_isolation"]);

    const mine = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Policy Doodle" }
    });
    const theirs = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: otherCookie },
      payload: { name: "Rival Policy Doodle" }
    });
    await db.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname='pawsh_rls_test') then
          create role pawsh_rls_test nologin nosuperuser nobypassrls;
        end if;
      end $$;
      grant usage on schema public to pawsh_rls_test;
      grant select,insert,update,delete on breeds to pawsh_rls_test;
    `);
    await db.begin(async (tx) => {
      await tx`set local role pawsh_rls_test`;
      await tx`select set_config('app.business_id',${businessId},true)`;
      const visible = await tx<{ id: string; name: string }[]>`
        select id,name from breeds where business_id is not null`;
      expect(visible.map((breed) => breed.name)).toEqual(["Policy Doodle"]);
      // The shared taxonomy stays readable without owning any of it.
      const [sharedCount] = await tx<{ count: number }[]>`
        select count(*)::int as count from breeds where business_id is null`;
      expect(sharedCount!.count).toBeGreaterThan(200);
      // A shared row admits no write policy at all.
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`update breeds set name='Hijacked' where normalized_name='poodle' and business_id is null`;
        const [changed] = await savepoint<{ count: number }[]>`
          select count(*)::int as count from breeds where name='Hijacked'`;
        if (changed!.count === 0) throw new Error("row-level security withheld the shared row");
      })).rejects.toThrow("row-level security withheld the shared row");
      // Another tenant's row is neither readable nor writable.
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`
          insert into breeds (business_id,pet_type_id,name,normalized_name)
          values (${otherBusinessId},${dogTypeId},'Cross Tenant','cross tenant')
        `;
      })).rejects.toThrow();
    });

    await app.inject({ method: "DELETE", url: `/api/breeds/${mine.json().id}`, headers: { cookie: ownerCookie } });
    await app.inject({ method: "DELETE", url: `/api/breeds/${theirs.json().id}`, headers: { cookie: otherCookie } });
  });

  // Business breeds are additive. They must not move the shared taxonomy, and they must not move
  // the pricing class any existing pet already resolves to.
  /**
   * Ownership is the BUSINESS - the customer account - not a salon location. `locations` carries
   * `business_id`, so one account operates many; `breeds` carries `business_id` and no
   * `location_id`, so there is nothing for two locations of one account to disagree about.
   *
   * This is the distinction the product decision turns on, so it is asserted rather than assumed.
   */
  it("serves a business-added breed at every location the account operates", async () => {
    // A second location under the SAME account. No endpoint creates one today, so the row goes
    // in directly - which is how a real account gets its second salon at present.
    const [second] = await db<{ id: string }[]>`
      insert into locations (business_id,name,timezone)
      values (${businessId},${`Second Salon ${suffix}`},'America/Los_Angeles')
      returning id
    `;
    const [first] = await db<{ id: string }[]>`
      select id from locations where business_id=${businessId} and id<>${second!.id} order by id limit 1
    `;

    const created = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Crosslocation Doodle" }
    });
    expect(created.statusCode).toBe(201);
    const breedId = created.json().id;

    // The same row - same id - is served at both, not a per-location copy of it.
    for (const locationId of [second!.id, first!.id]) {
      const switched = await app.inject({
        method: "POST", url: "/api/me/location", headers: { cookie: ownerCookie }, payload: { locationId }
      });
      expect(switched.statusCode).toBe(200);
      expect((await dogBreeds(ownerCookie)).find((breed) => breed.name === "Crosslocation Doodle"),
        `at location ${locationId}`).toMatchObject({ id: breedId, businessOwned: true });
    }

    // A pricing class set while working at one location is in force at the other: the override
    // is stored per business, so switching salons cannot change what a groom costs.
    await app.inject({
      method: "PUT", url: `/api/breeds/${breedId}/settings`, headers: { cookie: ownerCookie },
      payload: { pricingClass: "EXTRA_FLOOF" }
    });
    await app.inject({
      method: "POST", url: "/api/me/location", headers: { cookie: ownerCookie },
      payload: { locationId: second!.id }
    });
    expect((await dogBreeds(ownerCookie)).find((breed) => breed.name === "Crosslocation Doodle"))
      .toMatchObject({ defaultPricingClass: "EXTRA_FLOOF", customized: true });

    // An unrelated account still never sees it.
    expect((await dogBreeds(otherCookie)).some((breed) => breed.name === "Crosslocation Doodle")).toBe(false);

    // Guards the model itself: a location column here would reintroduce per-salon breeds.
    const [scoped] = await db<{ count: number }[]>`
      select count(*)::int as count from information_schema.columns
      where table_name='breeds' and column_name='location_id'
    `;
    expect(scoped!.count).toBe(0);

    await app.inject({ method: "DELETE", url: `/api/breeds/${breedId}`, headers: { cookie: ownerCookie } });
    await app.inject({
      method: "POST", url: "/api/me/location", headers: { cookie: ownerCookie },
      payload: { locationId: first!.id }
    });
    await db`delete from locations where id=${second!.id}`;
  });

  /**
   * A shared Pawsh breed is one row read by every tenant, so the only safe place for an opinion
   * about it is the sparse per-business override. Two accounts must be able to hold opposite
   * opinions about the same Beagle without either seeing the other's.
   */
  it("keeps one account's opinion of a shared breed away from another's", async () => {
    const beagle = (await dogBreeds(ownerCookie)).find((breed) => breed.name === "Beagle");
    expect(beagle, "Beagle is part of the shared taxonomy").toBeTruthy();
    expect(beagle!.businessOwned).toBe(false);
    // Both accounts see the same shared row, by the same id.
    expect((await dogBreeds(otherCookie)).find((breed) => breed.name === "Beagle")?.id).toBe(beagle!.id);

    // This account prices it differently and stops offering it.
    await app.inject({
      method: "PUT", url: `/api/breeds/${beagle!.id}/settings`, headers: { cookie: ownerCookie },
      payload: { pricingClass: "EXTRA_FLOOF", active: false }
    });

    const mine = (await dogBreeds(ownerCookie)).find((breed) => breed.id === beagle!.id);
    expect(mine).toMatchObject({ defaultPricingClass: "EXTRA_FLOOF", active: false, customized: true });

    // The other account is entirely unaffected, and still follows the Pawsh default.
    const theirs = (await dogBreeds(otherCookie)).find((breed) => breed.id === beagle!.id);
    expect(theirs).toMatchObject({
      defaultPricingClass: beagle!.defaultPricingClass, active: true, customized: false
    });

    // Neither may rename or delete it, however strongly they disagree about its price.
    for (const withCookie of [ownerCookie, otherCookie]) {
      const renamed = await app.inject({
        method: "PATCH", url: `/api/breeds/${beagle!.id}`, headers: { cookie: withCookie },
        payload: { name: "Beagle Deluxe" }
      });
      expect(renamed.statusCode).toBe(409);
      expect(renamed.json().code).toBe("BREED_NOT_BUSINESS_OWNED");
      const deleted = await app.inject({
        method: "DELETE", url: `/api/breeds/${beagle!.id}`, headers: { cookie: withCookie }
      });
      expect(deleted.statusCode).toBe(409);
    }

    // The shared row itself never moved.
    const [row] = await db<{ name: string; businessId: string | null }[]>`
      select name,business_id from breeds where id=${beagle!.id}
    `;
    expect(row).toMatchObject({ name: "Beagle", businessId: null });

    // Clearing both fields removes the override row rather than freezing today's value.
    await app.inject({
      method: "PUT", url: `/api/breeds/${beagle!.id}/settings`, headers: { cookie: ownerCookie },
      payload: { pricingClass: null, active: null }
    });
    expect((await dogBreeds(ownerCookie)).find((breed) => breed.id === beagle!.id))
      .toMatchObject({ customized: false, active: true });
  });

  it("leaves the shared taxonomy and the pet pricing distribution unchanged", async () => {
    const sharedBefore = await sharedTaxonomySnapshot();
    const petsBefore = await petPricingDistribution();
    const [sharedTotal] = await db<{ count: number }[]>`
      select count(*)::int as count from breeds where business_id is null`;

    const created = await app.inject({
      method: "POST", url: `/api/pet-types/${dogTypeId}/breeds`, headers: { cookie: ownerCookie },
      payload: { name: "Distribution Doodle", pricingClass: "EXTRA_FLOOF" }
    });
    await app.inject({
      method: "PATCH", url: `/api/breeds/${created.json().id}`, headers: { cookie: ownerCookie },
      payload: { name: "Distribution Doodle II" }
    });
    await app.inject({
      method: "PUT", url: `/api/breeds/${created.json().id}/settings`, headers: { cookie: ownerCookie },
      payload: { pricingClass: "SMOOTH_SINGLE" }
    });
    await app.inject({ method: "DELETE", url: `/api/breeds/${created.json().id}`, headers: { cookie: ownerCookie } });

    expect(await sharedTaxonomySnapshot()).toEqual(sharedBefore);
    expect(await petPricingDistribution()).toEqual(petsBefore);
    const [sharedAfter] = await db<{ count: number }[]>`
      select count(*)::int as count from breeds where business_id is null`;
    expect(sharedAfter!.count).toBe(sharedTotal!.count);
    // The shared taxonomy is exactly the curated list: 244 dog + 29 cat.
    expect(sharedTotal!.count).toBe(273);
  });
});
