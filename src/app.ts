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
import { registerSquareRoutes } from "./http/square-routes.js";
import type { DocumentHooks, FinancialHooks, LifecycleHooks, SchedulingHooks } from "./http/routes.js";
import { openSecret } from "./security/secrets.js";
import { createSquareClient, type SquareClient } from "./integrations/square/client.js";
import { refreshDueConnections, purgeExpiredOAuthStates } from "./integrations/square/oauth.js";
import { squareIntegration } from "./integrations/square/settings.js";
import { sweepOpenCheckouts, sweepPendingRefunds } from "./integrations/square/sweep.js";
import { expireStaleDeviceCodes } from "./integrations/square/terminal.js";
import { processSquareWebhooks } from "./integrations/square/webhooks.js";
import { createDocumentStorage, type DocumentStorage } from "./storage/documents.js";
import { WallTimeError } from "./domain/time.js";
import type { StartupDiagnostics } from "./startup.js";

/**
 * Which directory the server publishes at `/`.
 *
 * Defaults to the web client in `public`. `PAWSH_STATIC_ROOT` points it somewhere else so a
 * second instance can serve a different client from its own origin — the mobile web build, for
 * instance, which needs to share an origin with the API rather than be reached cross-origin.
 * Nothing about CORS or the mutation-origin check changes; the client simply stops being
 * cross-origin.
 */
function staticRoot(): string {
  return process.env.PAWSH_STATIC_ROOT?.trim() || "public";
}

/**
 * Unique indexes an ordinary user can hit, and what to say when they do.
 *
 * Keyed by the index name PostgreSQL reports, so the sentence and the constraint cannot drift
 * apart the way a hand-written message next to each insert would. Every entry here is also
 * checked for ahead of time by the route that writes the table; this is the answer when two
 * writers race that check, and it must still be a sentence, not a constraint name.
 */
export const uniqueViolations: Record<string, { code: string; error: string }> = {
  payment_method_name_per_business: {
    code: "PAYMENT_METHOD_NAME_TAKEN",
    error: "A payment method with that name already exists."
  },
  tax_rate_name_per_business: {
    code: "TAX_RATE_NAME_TAKEN",
    error: "A tax rate with that name already exists."
  },
  tax_rate_single_default: {
    code: "TAX_RATE_DEFAULT_CONFLICT",
    error: "Another rate was made the default at the same moment. Refresh and try again."
  },
  card_processors_business_id_provider_key: {
    code: "CARD_PROCESSOR_EXISTS",
    error: "That processor is already configured. Edit the existing one instead."
  },
  discount_name_per_business: {
    code: "DISCOUNT_NAME_TAKEN",
    error: "A discount with that name already exists."
  },
  // NOT partial on `active`, unlike the discount name index: a code that was handed out to a
  // customer stays claimed even after the coupon is retired, so this can be reached by a code the
  // operator cannot see on the screen. The route checks first and says which of the two it is;
  // reaching here means two writers raced.
  coupon_code_per_business: {
    code: "COUPON_CODE_TAKEN",
    error: "A coupon with that code already exists."
  },
  // One invoice consumes one coupon once. The checkout locks the coupon row before counting, so
  // this is the structural backstop rather than the expected path.
  coupon_redemptions_business_id_coupon_id_invoice_id_key: {
    code: "COUPON_ALREADY_REDEEMED",
    error: "That coupon was already redeemed on this invoice."
  },
  card_processor_single_default: {
    code: "CARD_PROCESSOR_DEFAULT_CONFLICT",
    error: "Another processor was made the default at the same moment. Refresh and try again."
  },
  // One workspace account belongs to at most one staff member. The Staff route checks for the
  // claim first and refuses with this same code, so reaching here means two managers linked the
  // same account at the same moment.
  employees_business_id_membership_id_key: {
    code: "MEMBERSHIP_ALREADY_LINKED",
    error: "That account was linked to another team member at the same moment. Refresh and try again."
  }
};

/**
 * The whole of what a caller learns when the fault is on this side. The request log has the rest.
 */
const internalFailure = { code: "INTERNAL_ERROR", error: "Something went wrong on our side. Try again in a moment." } as const;

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
    /** Injected by tests so the Square routes and worker never reach the network. */
    squareClient?: SquareClient;
    /**
     * How many requests one address may make per minute before the limiter refuses. Tests lower
     * it to reach the refusal in a handful of requests; the product's own ceiling is fixed below.
     */
    requestsPerMinute?: number;
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
  // A refusal from the limiter is a "come back in a moment", and it has to reach the client as
  // one: 429 with a Retry-After, and a body a toast can read. The plugin's own error carries the
  // status; the code and the retry interval are pinned on it here so the error handler below can
  // answer without knowing anything about the plugin. Left to the generic fallback, the refusal
  // used to come out as a 400, which the client reads on `/api/me` as "no longer signed in" and
  // answers by putting the operator back on the sign-in screen mid-shift.
  await runStartupOperation(startup, "rate limiting", "Plugin registration", () =>
    app.register(rateLimit, {
      max: options.requestsPerMinute ?? (config.NODE_ENV === "test" ? 10_000 : 120),
      timeWindow: "1 minute",
      errorResponseBuilder: (_request, context) => Object.assign(
        new Error(`Too many requests. Try again in ${context.after}.`),
        { statusCode: context.statusCode, code: "RATE_LIMITED", retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)) }
      )
    }));
  await runStartupOperation(startup, "multipart uploads", "Plugin registration", () =>
    app.register(multipart, { limits: { files: 1, fields: 12, parts: 13, fileSize: 10 * 1024 * 1024 } }));
  if (options.serveStatic !== false) {
    await runStartupOperation(startup, "static files", "Plugin registration", () =>
      app.register(staticFiles, { root: resolve(staticRoot()), prefix: "/" }));
    app.get("/salon/breeds", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/account", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/clients/*", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/intake-submissions", async (_request, reply) => reply.sendFile("index.html"));
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
  registerSquareRoutes(app, db, config, { client: options.squareClient });
  startup?.log("Authentication and API routes registered");
  let worker: NodeJS.Timeout | undefined;
  startup?.log("Registering background workers");
  /**
   * The Square half of the worker tick.
   *
   * Refreshing is scheduled here rather than triggered by a failed request because Square's
   * refresh window does not depend on use: a salon that takes no card payments for a month still
   * needs its token refreshed inside seven days, and there is no request in that month to hang a
   * lazy refresh on. Webhook events are drained in the same tick, so the receiver stays a write
   * and an acknowledgement while every decision about what an event means - including reading a
   * Square Payment and posting it to the ledger - happens here rather than inside a request Square
   * is timing.
   *
   * A no-op when Square is unconfigured, which is the normal state of this project today.
   */
  const square = squareIntegration(config);
  async function processSquare(): Promise<void> {
    if (!square.available) return;
    const squareClient = options.squareClient ?? createSquareClient({
      environment: square.settings.environment,
      applicationId: square.settings.applicationId,
      applicationSecret: square.settings.applicationSecret
    });
    const dependencies = {
      client: squareClient,
      keyring: square.settings.keyring,
      environment: square.settings.environment
    };
    await refreshDueConnections(db, dependencies);
    await processSquareWebhooks(db, dependencies);
    // After the drain, deliberately. A webhook that has just arrived is the cheaper and more
    // timely answer for the same row, so letting it land first leaves the sweep less to do; the
    // sweep is the backstop for the notifications that never came, not a competitor for the ones
    // that did. Both call the same reconcilers, so the ordering is an efficiency rather than a
    // correctness property.
    await sweepOpenCheckouts(db, dependencies);
    await sweepPendingRefunds(db, dependencies);
    await purgeExpiredOAuthStates(db);
    // A pairing code that has passed its `pair_by` is expired whether or not anybody has looked.
    // The screen already derives that from the instant, so this is not what makes the product
    // honest - it is what keeps the column from disagreeing with the clock.
    await expireStaleDeviceCodes(db);
  }
  if (options.runWorker !== false) {
    const emailProvider = config.SMTP_HOST ? new SmtpEmailProvider(config) : new LogEmailProvider();
    worker = setInterval(async () => {
      try {
        await processOutbox(db);
        await deliverNotifications(db, emailProvider, (value) => openSecret(value, config.SESSION_SECRET));
        await processSquare();
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
    // A unique index a person can walk into - a second "Cash", two rates racing to be the one in
    // force - has to come back as something a modal can render. The routes check for these first
    // and refuse with the same code, so reaching here means two writers raced; the reply is the
    // same either way rather than "violates a data integrity rule", which explains nothing to a
    // salon owner who typed a name that was already taken.
    const violated = uniqueViolations[(error as { constraint_name?: string }).constraint_name ?? ""];
    if (violated) return reply.code(409).send(violated);
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
    // An error that arrives with its own HTTP status - the rate limiter's refusal, the body parser
    // finding a payload too large or of the wrong type - keeps it. Those messages are written to be
    // shown, and a 429 has to stay a 429 so the client can tell "wait a moment" from "not signed
    // in". Anything that says it failed on the server's side is not described further than that.
    const { statusCode, retryAfterSeconds } = error as { statusCode?: unknown; retryAfterSeconds?: unknown };
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
      if (statusCode >= 500) return reply.code(statusCode).send(internalFailure);
      if (statusCode === 429) {
        if (typeof retryAfterSeconds === "number" && !reply.hasHeader("retry-after")) {
          reply.header("retry-after", retryAfterSeconds);
        }
        return reply.code(429).send({ code: "RATE_LIMITED", error: error.message });
      }
      return reply.code(statusCode).send({ error: error.message });
    }
    // A bare `Error` is how the routes refuse a request in a sentence - "Transfer ownership before
    // removing an Owner" - and it is answered as the 400 it always was. An error of any other
    // make reaching this line was not thrown at the caller: a driver failure, a bug, a dependency
    // giving up. Its message is for the log, which already has it, and the caller is told only
    // that the fault is not theirs, so nothing they do downgrades the request into a retry loop
    // or the sign-in screen.
    if (error?.constructor === Error) return reply.code(400).send({ error: error.message });
    return reply.code(500).send(internalFailure);
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
