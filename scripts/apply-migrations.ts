import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type postgres from "postgres";
import { provisionBusinessCatalog } from "../src/domain/catalog-seed.js";

type Sql = ReturnType<typeof postgres>;

export async function migrationVersions(directory = resolve("migrations")): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => name.replace(/\.sql$/, ""));
}

/**
 * Applies every pending migration in order and returns the versions applied by this call.
 * Shared by the CLI migration runner and the database test harness so both paths can never
 * drift into applying different schemas.
 */
export async function applyMigrations(
  sql: Sql,
  options: { directory?: string; log?: (message: string) => void } = {}
): Promise<string[]> {
  const directory = options.directory ?? resolve("migrations");
  await sql`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`;
  const applied = new Set(
    (await sql<{ version: string }[]>`select version from schema_migrations`).map((row) => row.version)
  );
  const freshlyApplied: string[] = [];
  for (const version of await migrationVersions(directory)) {
    if (applied.has(version)) continue;
    const migration = await readFile(resolve(directory, `${version}.sql`), "utf8");
    await sql.unsafe(migration);
    // Older migrations are inconsistent about recording themselves. Keep the
    // runner authoritative so every successfully applied file is skipped on
    // subsequent startup, while remaining compatible with self-recording SQL.
    await sql`
      insert into schema_migrations (version) values (${version})
      on conflict (version) do nothing
    `;
    freshlyApplied.push(version);
    options.log?.(`Applied ${version}`);
  }
  return freshlyApplied;
}

export async function seedBusinessCatalogs(sql: Sql): Promise<void> {
  const businesses = await sql<{ id: string }[]>`select id from businesses`;
  for (const business of businesses) {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.business_id',${business.id},true)`;
      await provisionBusinessCatalog(tx, business.id);
    });
  }
}
