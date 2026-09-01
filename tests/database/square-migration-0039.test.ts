import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0039 tightens two unique indexes, and a migration that tightens one cannot assume the data
 * already satisfies it.
 *
 * `square_checkout_identifier` and `payment_refund_identifier` make a Square checkout id and a
 * Square refund id unique across the WHOLE table rather than within a business, because the two
 * webhook lookups that use them have no business id to filter by - resolving the business is what
 * they are for. If two rows in different salons already hold one Square id, that is a real
 * ambiguity about whose ledger a payment belongs in, and no automatic choice between them is
 * defensible: picking one would write down permanently the same arbitrary answer the broken lookup
 * was already giving. So the migration must refuse to run and name the offending ids, exactly as
 * 0032 refuses rather than silently repricing a salon's book.
 *
 * This runs against its own throwaway database rather than the shared test one, because it has to
 * apply migrations to a schema deliberately left at 0038 and then observe 0039 failing - neither
 * of which a suite sharing a migrated database can do.
 *
 * THE FOREIGN KEYS ARE DROPPED BEFORE THE DUPLICATES ARE PLANTED, AND ONLY FOR THAT. A checkout
 * row references an invoice, which references an appointment and a customer, which reference a
 * location, a pet and an employee. None of that graph has anything to do with the property under
 * test, and building two complete copies of it would be a hundred lines of setup whose failure
 * modes would be its own. What is being tested is whether 0039 notices two rows sharing a Square
 * id, so the rows are planted directly in the shape the guard reads.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const scratchDatabase = "pawsh_migration_0039_vitest";
const lastMigrationBefore = "0038_payment_refunds";
const migrationUnderTest = "0039_square_recovery_and_dead_letters";

describeDatabase("migration 0039", () => {
  let admin: postgres.Sql;
  let scratchUrl: string;

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const url = new URL(databaseUrl!);
    url.pathname = `/${scratchDatabase}`;
    scratchUrl = url.toString();
  }, 30_000);

  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`).catch(() => {});
    await admin.end();
  });

  /** A database at exactly 0038, with nothing of 0039 applied. */
  async function databaseAt0038(): Promise<postgres.Sql> {
    await admin.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
    await admin.unsafe(`create database ${scratchDatabase}`);
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    await sql`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`;
    for (const file of (await readdir("migrations")).filter((n) => n.endsWith(".sql")).sort()) {
      const version = file.replace(/\.sql$/, "");
      if (version > lastMigrationBefore) break;
      await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
      await sql`
        insert into schema_migrations (version) values (${version}) on conflict do nothing
      `;
    }
    return sql;
  }

  /**
   * Applies 0039, and leaves the connection usable if it refused.
   *
   * The migration is one `begin; ... commit;`, so a `raise exception` inside it aborts the
   * transaction and never reaches the commit - which leaves the session sitting in a failed
   * transaction where every later statement answers "current transaction is aborted". Rolling back
   * is what lets a test assert on the schema AFTER observing the refusal, which is the half that
   * actually matters: a migration that refuses must also have changed nothing.
   */
  async function apply0039(sql: postgres.Sql): Promise<void> {
    try {
      await sql.unsafe(await readFile(resolve("migrations", `${migrationUnderTest}.sql`), "utf8"));
    } catch (error) {
      await sql.unsafe("rollback").catch(() => {});
      throw error;
    }
  }

  /** See the file header: the object graph is irrelevant to the property under test. */
  async function dropForeignKeys(sql: postgres.Sql, table: string): Promise<void> {
    await sql.unsafe(`
      do $$
      declare fk record;
      begin
        for fk in
          select conname from pg_constraint
          where conrelid = '${table}'::regclass and contype = 'f'
        loop
          execute format('alter table ${table} drop constraint %I', fk.conname);
        end loop;
      end $$;
    `);
  }

  it("applies to a database already at 0038", async () => {
    const sql = await databaseAt0038();
    try {
      const before = await sql<{ version: string }[]>`
        select version from schema_migrations order by version desc limit 1
      `;
      expect(before[0]!.version).toBe(lastMigrationBefore);

      await apply0039(sql);

      const after = await sql<{ version: string }[]>`
        select version from schema_migrations order by version desc limit 1
      `;
      expect(after[0]!.version).toBe(migrationUnderTest);

      // The tightened indexes exist and the weaker ones they replace are gone, rather than both
      // being left in place with the redundant one still suggesting per-business uniqueness.
      const indexes = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes where schemaname='public'
      `;
      const names = indexes.map((row) => row.indexname);
      expect(names).toContain("square_checkout_identifier");
      expect(names).toContain("payment_refund_identifier");
      expect(names).not.toContain("square_checkout_identifier_per_business");
      expect(names).not.toContain("payment_refund_provider_reference");
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("refuses a Square id claimed by a second salon once it is applied", async () => {
    const sql = await databaseAt0038();
    try {
      await dropForeignKeys(sql, "square_terminal_checkouts");
      await dropForeignKeys(sql, "payment_refunds");
      await apply0039(sql);

      // Two DIFFERENT businesses, one Square checkout id. This is what the old per-business index
      // permitted and what the webhook lookup could not survive.
      await sql`
        insert into square_terminal_checkouts
          (business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
           amount_minor, currency, status, created_by)
        values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'CHECKOUT_ONE_OWNER',
          'key-a', 1000, 'USD', 'in_progress', gen_random_uuid())
      `;
      await expect(sql`
        insert into square_terminal_checkouts
          (business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
           amount_minor, currency, status, created_by)
        values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'CHECKOUT_ONE_OWNER',
          'key-b', 1000, 'USD', 'in_progress', gen_random_uuid())
      `).rejects.toMatchObject({ code: "23505" });

      await sql`
        insert into payment_refunds
          (business_id, payment_id, invoice_id, amount_minor, currency, provider,
           provider_refund_id, idempotency_key, status, requested_by, settled_at)
        values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1000, 'USD', 'square',
          'REFUND_ONE_OWNER', 'rkey-a', 'completed', gen_random_uuid(), now())
      `;
      await expect(sql`
        insert into payment_refunds
          (business_id, payment_id, invoice_id, amount_minor, currency, provider,
           provider_refund_id, idempotency_key, status, requested_by, settled_at)
        values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1000, 'USD', 'square',
          'REFUND_ONE_OWNER', 'rkey-b', 'completed', gen_random_uuid(), now())
      `).rejects.toMatchObject({ code: "23505" });

      // A refund that has not been given a reference yet is still free to exist many times over -
      // the index is partial for exactly that reason, and pending rows must not collide.
      for (const key of ["rkey-c", "rkey-d"]) {
        await sql`
          insert into payment_refunds
            (business_id, payment_id, invoice_id, amount_minor, currency, provider,
             idempotency_key, status, requested_by)
          values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1000, 'USD', 'square',
            ${key}, 'pending', gen_random_uuid())
        `;
      }
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("refuses to run when two salons already hold one Square checkout id", async () => {
    const sql = await databaseAt0038();
    try {
      await dropForeignKeys(sql, "square_terminal_checkouts");
      const shared = "SQUARE_CHECKOUT_SHARED_BY_TWO";
      for (let row = 0; row < 2; row += 1) {
        await sql`
          insert into square_terminal_checkouts
            (business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
             amount_minor, currency, status, created_by)
          values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${shared},
            ${`key-${row}`}, 1000, 'USD', 'in_progress', gen_random_uuid())
        `;
      }

      // The whole migration is one transaction, so a refusal leaves the schema untouched rather
      // than half-applied.
      await expect(apply0039(sql)).rejects.toThrow(/more than one Pawsh checkout row/i);

      const version = await sql<{ version: string }[]>`
        select version from schema_migrations order by version desc limit 1
      `;
      expect(version[0]!.version).toBe(lastMigrationBefore);
      const indexes = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes where schemaname='public'
      `;
      // Nothing was dropped and nothing was created: the operator resolves the duplicates and runs
      // it again, rather than finding a schema in a state no migration describes.
      expect(indexes.map((row) => row.indexname))
        .toContain("square_checkout_identifier_per_business");
      expect(indexes.map((row) => row.indexname)).not.toContain("square_checkout_identifier");
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("refuses to run when two salons already hold one Square refund id", async () => {
    const sql = await databaseAt0038();
    try {
      await dropForeignKeys(sql, "payment_refunds");
      const shared = "SQUARE_REFUND_SHARED_BY_TWO";
      for (let row = 0; row < 2; row += 1) {
        await sql`
          insert into payment_refunds
            (business_id, payment_id, invoice_id, amount_minor, currency, provider,
             provider_refund_id, idempotency_key, status, requested_by, settled_at)
          values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1000, 'USD', 'square',
            ${shared}, ${`key-${row}`}, 'completed', gen_random_uuid(), now())
        `;
      }

      await expect(apply0039(sql)).rejects.toThrow(/more than one Pawsh refund row/i);
      const version = await sql<{ version: string }[]>`
        select version from schema_migrations order by version desc limit 1
      `;
      expect(version[0]!.version).toBe(lastMigrationBefore);
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("names the ids an operator has to go and resolve", async () => {
    const sql = await databaseAt0038();
    try {
      await dropForeignKeys(sql, "square_terminal_checkouts");
      for (const shared of ["CHECKOUT_AAA", "CHECKOUT_BBB"]) {
        for (let row = 0; row < 2; row += 1) {
          await sql`
            insert into square_terminal_checkouts
              (business_id, invoice_id, device_id, square_checkout_id, idempotency_key,
               amount_minor, currency, status, created_by)
            values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${shared},
              ${`${shared}-${row}`}, 1000, 'USD', 'in_progress', gen_random_uuid())
          `;
        }
      }

      // A refusal that does not say WHICH rows is a refusal nobody can act on.
      await expect(apply0039(sql)).rejects.toThrow(/CHECKOUT_AAA, CHECKOUT_BBB/);
    } finally {
      await sql.end();
    }
  }, 60_000);
});
