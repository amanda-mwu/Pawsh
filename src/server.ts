import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase, type Database } from "./db/client.js";
import { formatBoundAddress, lifecycleLoggingEnabled, startupFailureMessage, writeLifecycleLog } from "./startup.js";

async function main(): Promise<void> {
  const startedAt = performance.now();
  let lifecycleLogs = process.env.NODE_ENV !== "test";
  let db: Database | undefined;
  let app: FastifyInstance | undefined;
  let waitingDiagnostic: NodeJS.Timeout | undefined;

  try {
    writeLifecycleLog(lifecycleLogs, "BOOT", "Loading configuration");
    const config = loadConfig();
    lifecycleLogs = lifecycleLoggingEnabled(config.NODE_ENV);
    writeLifecycleLog(lifecycleLogs, "BOOT", "Configuration loaded", { environment: config.NODE_ENV });

    db = createDatabase(config);
    writeLifecycleLog(lifecycleLogs, "BOOT", "Waiting for PostgreSQL");
    waitingDiagnostic = setTimeout(() => {
      writeLifecycleLog(lifecycleLogs, "BOOT", "Still waiting for PostgreSQL");
    }, 3_000);
    waitingDiagnostic.unref();
    await db`select 1`;
    clearTimeout(waitingDiagnostic);
    waitingDiagnostic = undefined;
    writeLifecycleLog(lifecycleLogs, "BOOT", "PostgreSQL ready");

    writeLifecycleLog(lifecycleLogs, "BOOT", "Registering application services");
    app = await createApp(config, db);
    app.addHook("onClose", async () => {
      await db!.end();
    });

    writeLifecycleLog(lifecycleLogs, "BOOT", "Starting HTTP server");
    await app.listen({ host: "0.0.0.0", port: config.PORT });
    writeLifecycleLog(lifecycleLogs, "READY", "Pawsh listening", {
      environment: config.NODE_ENV,
      appOrigin: config.APP_ORIGIN,
      boundAddress: formatBoundAddress(app.server.address()),
      startupMs: Math.round(performance.now() - startedAt)
    });

    let shuttingDown = false;
    async function shutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      writeLifecycleLog(lifecycleLogs, "STOP", "Stopping HTTP server and workers", { signal });
      try {
        await app!.close();
        writeLifecycleLog(lifecycleLogs, "STOP", "Database pool closed");
        writeLifecycleLog(lifecycleLogs, "STOP", "Shutdown complete");
        process.exitCode = 0;
      } catch (error) {
        writeLifecycleLog(lifecycleLogs, "ERROR", "Shutdown failed");
        app!.log.error({ err: error, signal }, "shutdown failed");
        process.exitCode = 1;
      }
    }

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    if (waitingDiagnostic) clearTimeout(waitingDiagnostic);
    writeLifecycleLog(lifecycleLogs, "ERROR", startupFailureMessage(error));
    if (app) {
      try {
        await app.close();
      } catch {
        await db?.end().catch(() => undefined);
      }
    } else if (db) await db.end().catch(() => undefined);
    process.exitCode = 1;
  }
}

await main();
