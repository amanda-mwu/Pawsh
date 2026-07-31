import { z } from "zod";

const optionalText = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional()
);
const optionalEmail = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().email().optional()
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
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
});

export type Config = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(source);
}
