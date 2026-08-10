import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadConfig } from "../src/config.js";
import { provisionBusinessCatalog } from "../src/domain/catalog-seed.js";

const config = loadConfig();
const sql = postgres(config.DATABASE_URL, { max: 1 });
const directory = resolve("migrations");

try {
  await sql`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`;
  const applied = new Set(
    (await sql<{ version: string }[]>`select version from schema_migrations`).map((row) => row.version)
  );
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const migration = await readFile(resolve(directory, file), "utf8");
    await sql.unsafe(migration);
    // Older migrations are inconsistent about recording themselves. Keep the
    // runner authoritative so every successfully applied file is skipped on
    // subsequent startup, while remaining compatible with self-recording SQL.
    await sql`
      insert into schema_migrations (version) values (${version})
      on conflict (version) do nothing
    `;
    console.log(`Applied ${version}`);
  }
  const businesses=await sql<{id:string}[]>`select id from businesses`;
  for(const business of businesses)await sql.begin(async(tx)=>{
    await tx`select set_config('app.business_id',${business.id},true)`;
    await provisionBusinessCatalog(tx,business.id);
  });
} finally {
  await sql.end();
}
