import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

// Node 22.0 supports loadEnvFile(), while --env-file-if-exists was not added
// until 22.9. Keep the optional .env behavior compatible with the full major.
if (existsSync(".env")) loadEnvFile(".env");
