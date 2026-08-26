import { configDefaults, defineConfig } from "vitest/config";
import { resolveDatabaseTestMode } from "./tests/support/test-database.js";

// Resolved in the main process so every database worker inherits the same isolated target.
const databaseMode = resolveDatabaseTestMode();

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: configDefaults.include,
          exclude: [...configDefaults.exclude, "tests/e2e/**", "tests/database/**"],
          globalSetup: ["tests/support/global-unit-setup.ts"]
        }
      },
      {
        test: {
          name: "database",
          include: ["tests/database/**/*.test.ts"],
          exclude: configDefaults.exclude,
          globalSetup: ["tests/support/global-database-setup.ts"],
          // Every database file shares ONE PostgreSQL instance, so running them in
          // parallel makes them contend rather than progress. Against a cold cache
          // that contention pushed per-file beforeAll hooks past the 10s ceiling,
          // failing suites and skipping their tests. Serial file execution measures
          // the same wall time (~21s) because the bottleneck is the database, not
          // the CPU, and it removes the cold-start flake.
          fileParallelism: false,
          // An explicit opt-out must actually withhold the database, otherwise an ambient
          // DATABASE_URL would let suites run while the run reports them as excluded.
          env: databaseMode.state === "executed"
            ? { DATABASE_URL: databaseMode.url }
            : { DATABASE_URL: "" }
        }
      }
    ]
  }
});
