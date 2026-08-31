import { createHash } from "node:crypto";
import { z } from "zod";
import {
  IntegrationEncryptionError, IntegrationKeyring, integrationKeyMaterial, sameKeyMaterial
} from "./security/integration-encryption.js";

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
  DOCUMENT_STORAGE_SECRET_ACCESS_KEY: optionalText,
  /**
   * Key material for third-party credentials at rest, as `<version>:<base64 32 bytes>` entries.
   *
   * Its own variable rather than a derivation of `SESSION_SECRET`, and checked below to be sure
   * it stayed that way: these keys open standing authorisations to take money, while the session
   * secret is held by everything that serves a request and is rotated whenever an operator wants
   * everybody logged out. Required in production because a deployment that stores a Square
   * refresh token without one has nowhere safe to put it; optional everywhere else, where the
   * consequence is simply that the integration is unavailable.
   */
  PAWSH_INTEGRATION_ENCRYPTION_KEYS: optionalText,
  PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: optionalText,
  PAWSH_SQUARE_APPLICATION_ID: optionalText,
  PAWSH_SQUARE_APPLICATION_SECRET: optionalText,
  PAWSH_SQUARE_ENVIRONMENT: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.enum(["sandbox", "production"]).optional()
  ),
  /**
   * The exact string Square signs against, from configuration and never from the request.
   *
   * Square computes its signature over `notificationUrl + rawBody`. Deriving the URL from the
   * inbound `Host` header would let whoever controls that header choose the string we verify.
   */
  PAWSH_SQUARE_NOTIFICATION_URL: optionalText,
  PAWSH_SQUARE_WEBHOOK_SIGNATURE_KEY: optionalText
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

  const keys = value.PAWSH_INTEGRATION_ENCRYPTION_KEYS;
  const activeKey = value.PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE;
  if (value.NODE_ENV === "production" && !keys) {
    context.addIssue({
      code: "custom",
      message: "Production requires PAWSH_INTEGRATION_ENCRYPTION_KEYS for third-party credentials at rest"
    });
  }
  if (Boolean(keys) !== Boolean(activeKey)) {
    context.addIssue({
      code: "custom",
      message: "PAWSH_INTEGRATION_ENCRYPTION_KEYS requires PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE"
    });
  }
  if (keys && activeKey) {
    try {
      IntegrationKeyring.parse(keys, activeKey);
      // The separation from SESSION_SECRET is checked, not assumed. An operator who "generated"
      // the integration key by base64-encoding the session secret or its SHA-256 has produced a
      // key that looks correct and is not independent of it, and the failure mode of that
      // mistake - one leak opening both cookies and payment credentials - is invisible until it
      // matters.
      const forbidden = [
        Buffer.from(value.SESSION_SECRET, "utf8"),
        // Exactly what `secrets.ts` derives for its own key, which is the derivation somebody
        // reaching for a "32-byte key from the secret we already have" would reproduce.
        createHash("sha256").update(value.SESSION_SECRET).digest()
      ];
      for (const material of integrationKeyMaterial(keys)) {
        if (forbidden.some((candidate) => sameKeyMaterial(material, candidate))) {
          context.addIssue({
            code: "custom",
            message: "An integration encryption key must not be SESSION_SECRET or derived from it"
          });
          break;
        }
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof IntegrationEncryptionError
          ? `PAWSH_INTEGRATION_ENCRYPTION_KEYS is invalid: ${error.message}`
          : "PAWSH_INTEGRATION_ENCRYPTION_KEYS is invalid"
      });
    }
  }

  // Square is configured as a set or not at all. A half-configured integration is the state that
  // produces a connect button that reaches Square and a webhook receiver that cannot verify what
  // comes back, which is worse than being switched off.
  const squareSettings = [
    value.PAWSH_SQUARE_APPLICATION_ID, value.PAWSH_SQUARE_APPLICATION_SECRET,
    value.PAWSH_SQUARE_ENVIRONMENT, value.PAWSH_SQUARE_NOTIFICATION_URL,
    value.PAWSH_SQUARE_WEBHOOK_SIGNATURE_KEY
  ];
  const configuredCount = squareSettings.filter(Boolean).length;
  if (configuredCount > 0 && configuredCount < squareSettings.length) {
    context.addIssue({
      code: "custom",
      message: "Square requires PAWSH_SQUARE_APPLICATION_ID, PAWSH_SQUARE_APPLICATION_SECRET, "
        + "PAWSH_SQUARE_ENVIRONMENT, PAWSH_SQUARE_NOTIFICATION_URL and "
        + "PAWSH_SQUARE_WEBHOOK_SIGNATURE_KEY together"
    });
  }
  if (configuredCount === squareSettings.length && !keys) {
    context.addIssue({
      code: "custom",
      message: "Square requires PAWSH_INTEGRATION_ENCRYPTION_KEYS: its tokens are stored sealed"
    });
  }
  if (value.PAWSH_SQUARE_NOTIFICATION_URL) {
    let notificationUrl: URL | undefined;
    try {
      notificationUrl = new URL(value.PAWSH_SQUARE_NOTIFICATION_URL);
    } catch {
      notificationUrl = undefined;
    }
    if (!notificationUrl || !["http:", "https:"].includes(notificationUrl.protocol)) {
      context.addIssue({
        code: "custom",
        message: "PAWSH_SQUARE_NOTIFICATION_URL must be an absolute http or https URL"
      });
    } else if (value.NODE_ENV === "production" && notificationUrl.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Production PAWSH_SQUARE_NOTIFICATION_URL must use HTTPS" });
    } else if (value.PAWSH_SQUARE_NOTIFICATION_URL !== notificationUrl.toString()
      && value.PAWSH_SQUARE_NOTIFICATION_URL !== notificationUrl.origin + notificationUrl.pathname) {
      // Square signs the string it was given. If ours is not already in the form the signature
      // was computed over, every verification fails for a reason nobody will find quickly.
      context.addIssue({
        code: "custom",
        message: "PAWSH_SQUARE_NOTIFICATION_URL must be the exact subscription URL, without a query or fragment"
      });
    }
  }
});

export type Config = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(source);
  return { ...config, APP_ORIGIN: normalizeAppOrigin(config.APP_ORIGIN, config.NODE_ENV) };
}
