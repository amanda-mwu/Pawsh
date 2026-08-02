import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";

const config = loadConfig();
const db = createDatabase(config);
const app = await createApp(config, db);
app.addHook("onClose", async () => {
  await db.end();
});

await app.listen({ host: "0.0.0.0", port: config.PORT });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error, signal }, "shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
