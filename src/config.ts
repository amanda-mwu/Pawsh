import { z } from "zod";

const optionalText = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional()
);
const optionalEmail = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().email().optional()
);
const databaseUrl = z.string().min(1).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
      context.addIssue({ code: "custom", message: "DATABASE_URL must be a PostgreSQL URL with a host and database" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "DATABASE_URL must be a valid PostgreSQL URL" });
  }
});

export function normalizeAppOrigin(value: string, nodeEnv: "development" | "test" | "production"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN must be a valid URL origin");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("APP_ORIGIN uses an unsupported protocol");
  if (url.username || url.password) throw new Error("APP_ORIGIN must not contain credentials");
  if (url.search || url.hash) throw new Error("APP_ORIGIN must not contain a query or fragment");
  if (url.pathname !== "/") throw new Error("APP_ORIGIN must not contain a path");
  if (url.hostname.includes("*")) throw new Error("APP_ORIGIN must not contain a wildcard");
  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("Production APP_ORIGIN must use HTTPS");
  }
  return url.origin;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url().default("http://127.0.0.1:3000"),
  SMTP_HOST: optionalText,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(["true","false"]).transform((value) => value === "true").default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: optionalEmail
  ,DOCUMENT_STORAGE_ADAPTER: z.enum(["memory", "filesystem", "s3"]).optional(),
  DOCUMENT_STORAGE_PATH: optionalText,
  DOCUMENT_STORAGE_BUCKET: optionalText,
  DOCUMENT_STORAGE_REGION: optionalText,
  DOCUMENT_STORAGE_ENDPOINT: optionalText,
  DOCUMENT_STORAGE_ACCESS_KEY_ID: optionalText,
  DOCUMENT_STORAGE_SECRET_ACCESS_KEY: optionalText
  ,DOCUMENT_SCANNER_ADAPTER: z.enum(["deterministic","http"]).optional(),
  DOCUMENT_SCANNER_ENDPOINT: optionalText,
  DOCUMENT_SCANNER_TOKEN: optionalText
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production" && (!value.SMTP_HOST || !value.EMAIL_FROM)) {
    context.addIssue({
      code: "custom",
      message: "Production requires SMTP_HOST and EMAIL_FROM"
    });
  }
  if (!value.DOCUMENT_STORAGE_ADAPTER) {
    context.addIssue({ code: "custom", message: "DOCUMENT_STORAGE_ADAPTER is required" });
  }
  if (value.NODE_ENV === "production" && value.DOCUMENT_STORAGE_ADAPTER !== "s3") {
    context.addIssue({ code: "custom", message: "Production requires S3 document storage" });
  }
  if (value.NODE_ENV === "test" && value.DOCUMENT_STORAGE_ADAPTER !== "memory") {
    context.addIssue({ code: "custom", message: "Tests require isolated memory document storage" });
  }
  if (value.DOCUMENT_STORAGE_ADAPTER === "filesystem" && !value.DOCUMENT_STORAGE_PATH) {
    context.addIssue({ code: "custom", message: "Filesystem storage requires DOCUMENT_STORAGE_PATH" });
  }
  if (value.DOCUMENT_STORAGE_ADAPTER === "s3" && (!value.DOCUMENT_STORAGE_BUCKET || !value.DOCUMENT_STORAGE_REGION)) {
    context.addIssue({ code: "custom", message: "S3 storage requires bucket and region" });
  }
  if (Boolean(value.DOCUMENT_STORAGE_ACCESS_KEY_ID) !== Boolean(value.DOCUMENT_STORAGE_SECRET_ACCESS_KEY)) {
    context.addIssue({ code: "custom", message: "S3 static credentials require both access key ID and secret" });
  }
  if (value.NODE_ENV !== "test" && value.DOCUMENT_SCANNER_ADAPTER !== "http") {
    context.addIssue({ code:"custom",message:"Non-test environments require the managed HTTP document scanner" });
  }
  if (value.DOCUMENT_SCANNER_ADAPTER === "http" && !value.DOCUMENT_SCANNER_ENDPOINT) {
    context.addIssue({ code:"custom",message:"HTTP document scanner requires DOCUMENT_SCANNER_ENDPOINT" });
  }
});

export type Config = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(source);
  return { ...config, APP_ORIGIN: normalizeAppOrigin(config.APP_ORIGIN, config.NODE_ENV) };
}
