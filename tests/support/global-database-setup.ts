import {
  prerequisiteFailureMessage,
  provisionTestDatabase,
  resolveDatabaseTestMode
} from "./test-database.js";

/**
 * Runs once before the database project. Turns the previous silent-skip behaviour into an
 * explicit, reported outcome so a green run can never mean "the database suites did nothing".
 */
export default async function setup(): Promise<void> {
  const mode = resolveDatabaseTestMode();
  if (mode.state === "unavailable") {
    throw new Error(prerequisiteFailureMessage(mode.reason));
  }
  if (mode.state === "excluded") {
    console.warn(`[pawsh] DATABASE TESTS INTENTIONALLY EXCLUDED (${mode.reason}). No database coverage in this run.`);
    return;
  }
  const { applied } = await provisionTestDatabase(mode);
  console.info(
    `[pawsh] DATABASE TESTS EXECUTED against isolated database "${mode.database}" via ${mode.source}` +
    `${applied.length ? ` (applied ${applied.length} migration(s): ${applied.join(", ")})` : " (schema already current)"}`
  );
}
