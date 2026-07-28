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
