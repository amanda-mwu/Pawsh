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
