import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { registerRoutes } from "./http/routes.js";
import { deliverNotifications, LogEmailProvider, processOutbox } from "./engagement/worker.js";

const config = loadConfig();
const db = createDatabase(config);
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    redact: ["req.headers.authorization", "req.headers.cookie", "password"]
  },
  genReqId: () => crypto.randomUUID()
});

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, { origin: config.APP_ORIGIN, credentials: true });
await app.register(cookie, { secret: config.SESSION_SECRET });
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
await app.register(staticFiles, { root: resolve("public"), prefix: "/" });

app.get("/health", async () => {
  await db`select 1`;
  return { status: "ok" };
});

registerRoutes(app, db, config);

const worker = setInterval(async () => {
  try {
    await processOutbox(db);
    await deliverNotifications(db, new LogEmailProvider());
  } catch (error) {
    app.log.error({ err: error }, "background processing failed");
  }
}, 15_000);
worker.unref();

app.setErrorHandler<Error>((error, request, reply) => {
  request.log.error({ err: error }, "request failed");
  if (error.name === "ZodError") return reply.code(400).send({ error: "Invalid request", details: error });
  if ((error as { code?: string }).code === "23P01") {
    return reply.code(409).send({ error: "The employee already has an overlapping appointment" });
  }
  if ((error as { code?: string }).code?.startsWith("23")) {
    return reply.code(409).send({ error: "The requested change violates a data integrity rule" });
  }
  return reply.code(400).send({ error: error.message });
});

app.addHook("onClose", async () => {
  clearInterval(worker);
  await db.end();
});

await app.listen({ host: "0.0.0.0", port: config.PORT });
