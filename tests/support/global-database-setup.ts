import {
  prerequisiteFailureMessage,
  provisionTestDatabase,
  resolveDatabaseTestMode
} from "./test-database.js";

/**
 * Runs once before the database project. Turns the previous silent-skip behaviour into an
 * explicit, reported outcome so a green run can never mean "the database suites did nothing".
 *
 * It now also reports WHAT THE RUN STARTED FROM, on the same principle. A run against a database
 * still holding earlier runs' rows is not the run these suites are written against, and the line
 * below is the only place that difference is visible from the outside.
 */
export default async function setup(): Promise<(() => Promise<void>) | void> {
  const mode = resolveDatabaseTestMode();
  if (mode.state === "unavailable") {
    throw new Error(prerequisiteFailureMessage(mode.reason));
  }
  if (mode.state === "excluded") {
    console.warn(`[pawsh] DATABASE TESTS INTENTIONALLY EXCLUDED (${mode.reason}). No database coverage in this run.`);
    return;
  }
  const { start, reason, applied, release } = await provisionTestDatabase(mode);
  const schema = applied.length
    ? ` (applied ${applied.length} migration(s): ${applied.join(", ")})`
    : " (schema already current)";
  if (start === "reused") {
    console.warn(
      `[pawsh] DATABASE TESTS EXECUTED against a REUSED database "${mode.database}" via ${mode.source}` +
      `${schema}. Rows from earlier runs are still present, so any assertion that counts or claims` +
      ` rows globally may be measuring them. Reason: ${reason}.`
    );
  } else {
    console.info(
      `[pawsh] DATABASE TESTS EXECUTED against a freshly reset isolated database "${mode.database}"` +
      ` via ${mode.source}${schema}`
    );
  }
  // The run's exclusive claim is held until every suite has finished, not just until the schema
  // is in place - see `TestDatabaseProvisioning.release`.
  return release;
}
