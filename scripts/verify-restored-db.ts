import postgres from "postgres";

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const restoredUrl = process.env.DATABASE_URL;

if (!sourceUrl || !restoredUrl) {
  throw new Error("SOURCE_DATABASE_URL and DATABASE_URL are required");
}
if (sourceUrl === restoredUrl) {
  throw new Error("Restore verification requires distinct source and restored databases");
}

const source = postgres(sourceUrl, { max: 1 });
const restored = postgres(restoredUrl, { max: 1 });

type TableRow = { table_name: string };

try {
  const sourceTables = await source<TableRow[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `;
  const restoredTables = await restored<TableRow[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `;

  const sourceNames = sourceTables.map((row) => row.table_name);
  const restoredNames = restoredTables.map((row) => row.table_name);
  if (JSON.stringify(sourceNames) !== JSON.stringify(restoredNames)) {
    throw new Error("Restored database table inventory does not match the source");
  }

  for (const table of sourceNames) {
    const [sourceCount] = await source<{ count: string }[]>`
      select count(*)::text as count from ${source(table)}
    `;
    const [restoredCount] = await restored<{ count: string }[]>`
      select count(*)::text as count from ${restored(table)}
    `;
    if (sourceCount?.count !== restoredCount?.count) {
      throw new Error(
        `Restored row count mismatch for ${table}: source=${sourceCount?.count}, restored=${restoredCount?.count}`
      );
    }
  }

  console.log(`Restore verified: ${sourceNames.length} public tables and all row counts match.`);
} finally {
  await Promise.all([source.end(), restored.end()]);
}
