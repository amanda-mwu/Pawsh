import { readdir } from "node:fs/promises";
import postgres from "postgres";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const LOCAL_DATABASES = new Set(["pawsh", "pawsh_dev"]);

export function inspectLocalDatabaseTarget(databaseUrl: string): { host: string; port: string; database: string } {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must use PostgreSQL");
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error("Local database commands require a loopback host");
  if (!LOCAL_DATABASES.has(database)) throw new Error("Local database commands require database pawsh or pawsh_dev");
  if (process.env.NODE_ENV === "production") throw new Error("Local database commands are disabled in production");
  return { host: url.hostname, port: url.port || "5432", database };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!["health", "verify", "reset"].includes(command ?? "")) {
    throw new Error("Usage: local-db.ts health|verify|reset");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const target = inspectLocalDatabaseTarget(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    if (command === "health") {
      const [row] = await sql<{ database: string; user: string; version: string; timezone: string }[]>`
        select current_database() database,current_user "user",
          current_setting('server_version') version,current_setting('TimeZone') timezone`;
      console.log(`PostgreSQL healthy: ${target.host}:${target.port}/${row!.database} user=${row!.user} version=${row!.version} timezone=${row!.timezone}`);
      return;
    }
    if (command === "verify") {
      const [settings] = await sql<
        { versionNumber: number; encoding: string; collation: string; ctype: string; timezone: string }[]
      >`
        select current_setting('server_version_num')::int "versionNumber",
          pg_encoding_to_char(encoding) encoding,datcollate collation,datctype ctype,
          current_setting('TimeZone') timezone from pg_database where datname=current_database()`;
      const extensions = await sql<{ name: string }[]>`select extname name from pg_extension order by extname`;
      const migrations = await sql<{ version: string }[]>`select version from schema_migrations order by version`;
      const expectedMigrations = (await readdir("migrations"))
        .filter((name) => name.endsWith(".sql"))
        .map((name) => name.replace(/\.sql$/, ""))
        .sort();
      const requiredExtensions = ["btree_gist", "pgcrypto"];
      if (Math.floor(settings!.versionNumber / 10_000) !== 17)
        throw new Error(`PostgreSQL 17 required; received ${settings!.versionNumber}`);
      if (settings!.encoding !== "UTF8") throw new Error(`UTF8 required; received ${settings!.encoding}`);
      if (settings!.timezone !== "UTC") throw new Error(`UTC database session required; received ${settings!.timezone}`);
      for (const name of requiredExtensions)
        if (!extensions.some((row) => row.name === name)) throw new Error(`Missing extension: ${name}`);
      const applied = new Set(migrations.map((row) => row.version));
      const missing = expectedMigrations.filter((version) => !applied.has(version));
      if (missing.length) throw new Error(`Missing migrations: ${missing.join(", ")}`);
      console.log(`Database contract verified: PostgreSQL 17, UTF8, ${settings!.collation}/${settings!.ctype}, UTC, ${migrations.length} migrations`);
      return;
    }
    console.log(`Resetting local database schema: ${target.host}:${target.port}/${target.database}`);
    await sql.begin(async (tx) => {
      await tx.unsafe("drop schema public cascade");
      await tx.unsafe("create schema public");
      await tx.unsafe(`grant all on schema public to ${quoteIdentifier(new URL(databaseUrl).username)}`);
      await tx.unsafe("grant usage on schema public to public");
    });
  } finally {
    await sql.end();
  }
}

function quoteIdentifier(value: string): string {
  if (!value) throw new Error("DATABASE_URL must include a database user");
  return `"${decodeURIComponent(value).replaceAll('"', '""')}"`;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/local-db.ts")) {
  await main();
}
