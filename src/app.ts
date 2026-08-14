import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { deliverNotifications, LogEmailProvider, processOutbox, SmtpEmailProvider } from "./engagement/worker.js";
import { registerRoutes } from "./http/routes.js";
import type { DocumentHooks, FinancialHooks, LifecycleHooks, SchedulingHooks } from "./http/routes.js";
import { openSecret } from "./security/secrets.js";
import { createDocumentStorage, type DocumentStorage } from "./storage/documents.js";
import { WallTimeError } from "./domain/time.js";
import type { StartupDiagnostics } from "./startup.js";

export async function createApp(
  config: Config,
  db: Database,
  options: {
    runWorker?: boolean;
    serveStatic?: boolean;
    schedulingHooks?: SchedulingHooks;
    lifecycleHooks?: LifecycleHooks;
    documentStorage?: DocumentStorage;
    documentHooks?: DocumentHooks;
    financialHooks?: FinancialHooks;
    startupDiagnostics?: StartupDiagnostics;
  } = {}
): Promise<FastifyInstance> {
  const startup = options.startupDiagnostics;
  startup?.log("createApp begin");
  startup?.log("Creating Fastify instance");
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      redact: [
        "req.headers.authorization", "req.headers.cookie",
        "req.body.password", "req.body.token", "password", "token"
      ]
    },
    genReqId: () => crypto.randomUUID()
  });
  startup?.log("Fastify instance ready");

  await runStartupOperation(startup, "helmet", "Plugin registration", () =>
    app.register(helmet, { contentSecurityPolicy: false }));
  await runStartupOperation(startup, "cors", "Plugin registration", () =>
    app.register(cors, { origin: config.APP_ORIGIN, credentials: true }));
  await runStartupOperation(startup, "authentication cookie", "Plugin registration", () =>
    app.register(cookie, { secret: config.SESSION_SECRET }));
  await runStartupOperation(startup, "rate limiting", "Plugin registration", () =>
    app.register(rateLimit, { max: config.NODE_ENV === "test" ? 10_000 : 120, timeWindow: "1 minute" }));
  await runStartupOperation(startup, "multipart uploads", "Plugin registration", () =>
    app.register(multipart, { limits: { files: 1, fields: 12, parts: 13, fileSize: 10 * 1024 * 1024 } }));
  if (options.serveStatic !== false) {
    await runStartupOperation(startup, "static files", "Plugin registration", () =>
      app.register(staticFiles, { root: resolve("public"), prefix: "/" }));
    app.get("/salon/breeds", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/account", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/settings", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/settings/*", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/reports/breeds", async (_request, reply) => reply.redirect("/salon/breeds", 308));
    app.get("/overview/breeds", async (_request, reply) => reply.redirect("/salon/breeds", 308));
  }
  startup?.log("Plugins registered");
  app.addHook("onRequest", async (request, reply) => {
    if (!["POST","PUT","PATCH","DELETE"].includes(request.method)) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") {
      return reply.code(403).send({ error: "Cross-site mutation is not allowed" });
    }
    if (origin && origin !== config.APP_ORIGIN) {
      return reply.code(403).send({ error: "Request origin is not allowed" });
    }
  });

  app.get("/health", async () => {
    await db`select 1`;
    return { status: "ok" };
  });

  startup?.log("Creating document storage");
  const documentStorage = options.documentStorage ?? createDocumentStorage(config);
  startup?.log("Document storage ready");
  startup?.log("Registering authentication and API routes");
  registerRoutes(app, db, config, documentStorage,
    options.schedulingHooks, options.lifecycleHooks, options.financialHooks,
    options.documentHooks);
  startup?.log("Authentication and API routes registered");
  let worker: NodeJS.Timeout | undefined;
  startup?.log("Registering background workers");
  if (options.runWorker !== false) {
    const emailProvider = config.SMTP_HOST ? new SmtpEmailProvider(config) : new LogEmailProvider();
    worker = setInterval(async () => {
      try {
        await processOutbox(db);
        await deliverNotifications(db, emailProvider, (value) => openSecret(value, config.SESSION_SECRET));
      } catch (error) {
        app.log.error({ err: error }, "background processing failed");
      }
    }, 15_000);
    worker.unref();
  }
  startup?.log("Background workers registered");

  app.setErrorHandler<Error>((error, request, reply) => {
    request.log.error({
      errorName: error.name,
      errorCode: (error as { code?: string }).code,
      errorMessage: error.message,
      method: request.method,
      route: request.routeOptions.url
    }, "request failed");
    if (error.name === "ZodError") return reply.code(400).send({ error: "Invalid request", details: error });
    if (error instanceof WallTimeError) {
      const messages = {
        INVALID_LOCAL_TIME:"Enter a valid local date and time.",
        NONEXISTENT_LOCAL_TIME:"This time does not occur on this date because of the daylight-saving time change. Choose another time.",
        AMBIGUOUS_LOCAL_TIME:"This time occurs twice because of the daylight-saving time change. Choose the first or second occurrence.",
        INVALID_TIMEZONE:"The location timezone is invalid."
      } as const;
      return reply.code(400).send({ code:error.code, error:messages[error.code] });
    }
    if ((error as { code?: string }).code === "23P01") {
      return reply.code(409).send({
        code: "SCHEDULING_CONFLICT",
        error: "This employee already has an overlapping appointment during the selected time.",
        conflicts: [],
        canOverride: false
      });
    }
    if ((error as { code?: string }).code?.startsWith("23")) {
      return reply.code(409).send({ error: "The requested change violates a data integrity rule" });
    }
    if (error.name === "FinancialRequestError") {
      const financial = error as Error & { status: number; code: string; details?: unknown };
      return reply.code(financial.status).send({ code: financial.code, error: financial.message,
        ...(financial.details && typeof financial.details === "object" ? financial.details : {}) });
    }
    if (error.name === "SchedulingRequestError") {
      const scheduling = error as Error & { status: number; code: string; details?: unknown };
      return reply.code(scheduling.status).send({ code: scheduling.code, error: scheduling.message,
        ...(scheduling.details && typeof scheduling.details === "object" ? scheduling.details : {}) });
    }
    return reply.code(400).send({ error: error.message });
  });

  app.addHook("onClose", async () => {
    if (worker) clearInterval(worker);
  });
  startup?.log("createApp complete");
  return app;
}

function runStartupOperation(
  diagnostics: StartupDiagnostics | undefined,
  component: string,
  operation: string,
  task: () => PromiseLike<unknown> | unknown
): Promise<void> | PromiseLike<unknown> | unknown {
  return diagnostics ? diagnostics.run(component, operation, task) : task();
}
