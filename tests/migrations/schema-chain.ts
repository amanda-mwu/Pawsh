import { readFile, readdir } from "node:fs/promises";

/**
 * The migration directory as an ordered chain, plus the one question a text assertion about a
 * schema usually means to ask: is this object part of the schema a fresh database ends up with?
 *
 * WHY THIS FILE EXISTS. `expect(await readMigration("0001_initial.sql")).toContain("x")` asserts
 * that a historical file once mentioned `x`. That is not the same claim as "the database has
 * `x`", and the two came apart in exactly the way you would expect: 0001 adds
 * `employee_appointment_no_overlap` and 0002 drops it, so the assertion passed for years against
 * a schema in which the constraint does not exist. A migration is an edit, and an edit that is
 * later reverted leaves a passing assertion behind it.
 *
 * WHAT THIS IS AND IS NOT. It replays the chain in apply order and records, per named object,
 * whether each statement that mentions it creates it or removes it; the final state is the last
 * event. That is a text model, not a catalogue query - the authoritative check is the database
 * suite running against a freshly migrated database - but it is the check that belongs in the
 * unit project, it needs no server, and it catches the whole class of assertion above.
 */

/** Line endings are normalised for the reason the syntax suite normalises them: Git checks this
 * repository out with CRLF on Windows, so an assertion that spans a line break would match on
 * Linux and fail on a Windows runner. */
export interface MigrationFile {
  file: string;
  version: string;
  number: number;
  /** The file as written, prose and all. */
  source: string;
  /** The same file with `--` comments removed. */
  sql: string;
}

export const migrationFilePattern = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * Drops `--` comments so an assertion can be about the SQL rather than about the essay above it.
 *
 * These migrations explain themselves at length, and several of them explain a shape they are
 * deliberately NOT using: 0051's comment quotes the reversed check constraint it rejects, and a
 * `not.toContain` over the raw file therefore fails on the very paragraph that documents why the
 * forbidden shape is forbidden. A negative assertion has to be able to tell a rule from a
 * description of a rule.
 */
export function stripComments(source: string): string {
  return source.replace(/(^|\s)--[^\n]*/g, "$1");
}

export async function readMigrationChain(directory = "migrations"): Promise<MigrationFile[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async (file) => {
    const source = (await readFile(`${directory}/${file}`, "utf8")).replaceAll("\r\n", "\n");
    return {
      file,
      version: file.replace(/\.sql$/, ""),
      number: Number(file.slice(0, 4)),
      source,
      sql: stripComments(source)
    };
  }));
}

/**
 * Every number claimed by more than one file, as `0046: a.sql, b.sql`.
 *
 * The 0046/0047 collision reached the repository because nothing looked at the filenames as a
 * set. `applyMigrations` keys `schema_migrations` on the whole version string, so two files
 * sharing a number are two independent versions whose apply order is settled by their prose -
 * and renumbering one after it has been applied somewhere makes it run a second time.
 */
export function duplicateNumbers(chain: MigrationFile[]): string[] {
  const byNumber = new Map<number, string[]>();
  for (const migration of chain) {
    byNumber.set(migration.number, [...(byNumber.get(migration.number) ?? []), migration.file]);
  }
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .sort((left, right) => left[0] - right[0])
    .map(([number, files]) => `${String(number).padStart(4, "0")}: ${files.sort().join(", ")}`);
}

/** Every number between 1 and the highest that no file claims. */
export function numberingGaps(chain: MigrationFile[]): number[] {
  if (!chain.length) return [];
  const present = new Set(chain.map((migration) => migration.number));
  const gaps: number[] = [];
  for (let number = 1; number <= Math.max(...present); number += 1) {
    if (!present.has(number)) gaps.push(number);
  }
  return gaps;
}

export interface SchemaEvent {
  version: string;
  kind: "create" | "drop";
}

const removals = [
  String.raw`drop\s+constraint\s+(?:if\s+exists\s+)?NAME\b`,
  String.raw`drop\s+index\s+(?:if\s+exists\s+)?(?:concurrently\s+)?NAME\b`,
  String.raw`drop\s+trigger\s+(?:if\s+exists\s+)?NAME\b`,
  String.raw`drop\s+policy\s+(?:if\s+exists\s+)?NAME\b`,
  String.raw`drop\s+function\s+(?:if\s+exists\s+)?NAME\b`,
  String.raw`drop\s+table\s+(?:if\s+exists\s+)?NAME\b`,
  String.raw`drop\s+column\s+(?:if\s+exists\s+)?NAME\b`
];

const additions = [
  String.raw`add\s+constraint\s+NAME\b`,
  String.raw`constraint\s+NAME\s`,
  String.raw`create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?NAME\b`,
  String.raw`create\s+(?:or\s+replace\s+)?trigger\s+NAME\b`,
  String.raw`create\s+policy\s+NAME\b`,
  String.raw`create\s+(?:or\s+replace\s+)?function\s+NAME\b`,
  String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?NAME\b`,
  String.raw`add\s+column\s+(?:if\s+not\s+exists\s+)?NAME\b`
];

function compile(patterns: string[], name: string): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern.replaceAll("NAME", name), "i"));
}

/**
 * Every point in the chain at which a named object is created or removed, in apply order.
 *
 * Split on statement boundaries rather than lines, because a `create table` that declares an
 * inline `constraint x check (...)` and an `alter table ... drop constraint x` are both single
 * statements spanning several lines, and a drop must never be read as a create because the two
 * words happened to fall in the same paragraph.
 *
 * The removal arm is tested first, and that ordering is load-bearing: `constraint NAME` appears
 * inside `drop constraint NAME` as well as inside a table declaration, so reading a statement as
 * a creation before ruling out a removal would record every drop as a create. 0039 replaces two
 * constraints by dropping and re-adding them in separate statements, which this records as
 * `drop -> create` and resolves, correctly, to present.
 */
export function objectLifecycle(chain: MigrationFile[], name: string): SchemaEvent[] {
  const drops = compile(removals, name);
  const creates = compile(additions, name);
  const events: SchemaEvent[] = [];
  for (const migration of chain) {
    // `sql`, not `source`: a paragraph explaining why 0049 no longer relies on 0001's exclusion
    // constraint is prose about an object, not an edit to it.
    for (const statement of migration.sql.split(/;\s*\n/)) {
      if (drops.some((pattern) => pattern.test(statement))) {
        events.push({ version: migration.version, kind: "drop" });
      } else if (creates.some((pattern) => pattern.test(statement))) {
        events.push({ version: migration.version, kind: "create" });
      }
    }
  }
  return events;
}

/** Whether a fresh database, migrated to the head of the chain, ends up holding this object. */
export function existsInFinalSchema(chain: MigrationFile[], name: string): boolean {
  return objectLifecycle(chain, name).at(-1)?.kind === "create";
}

/** A readable trace for an assertion message: `create@0001 -> drop@0002`. */
export function describeLifecycle(chain: MigrationFile[], name: string): string {
  const events = objectLifecycle(chain, name);
  if (!events.length) return `${name}: never created or dropped anywhere in the chain`;
  return `${name}: ${events.map((event) => `${event.kind}@${event.version.slice(0, 4)}`).join(" -> ")}`;
}
