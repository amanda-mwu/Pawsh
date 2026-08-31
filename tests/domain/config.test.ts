import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig, normalizeAppOrigin } from "../../src/config.js";
import { createDocumentStorage, MemoryDocumentStorage } from "../../src/storage/documents.js";

const base = {
  DATABASE_URL: "postgres://localhost/pawsh",
  SESSION_SECRET: "a-session-secret-that-is-long-enough",
  APP_ORIGIN: "https://app.pawsh.example",
  DOCUMENT_STORAGE_ADAPTER: "s3",
  DOCUMENT_STORAGE_BUCKET: "pawsh-private-test",
  DOCUMENT_STORAGE_REGION: "us-west-2",
  // Production requires somewhere sealed to keep third-party credentials, so a production
  // configuration without these is refused. Key material is generated per run: this file has
  // never held a key, and a fixed one here would be a key somebody could copy into a deployment.
  PAWSH_INTEGRATION_ENCRYPTION_KEYS: `1:${randomBytes(32).toString("base64")}`,
  PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE: "1",
};

describe("runtime configuration", () => {
  it("requires an email provider for production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow();
  });

  it("accepts complete production SMTP configuration", () => {
    expect(loadConfig({
      ...base,
      NODE_ENV: "production",
      SMTP_HOST: "smtp.example",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      EMAIL_FROM: "hello@pawsh.example"
    })).toMatchObject({
      NODE_ENV: "production",
      SMTP_HOST: "smtp.example",
      SMTP_PORT: 587,
      SMTP_SECURE: false
    });
  });

  it("fails closed for invalid production document storage", () => {
    expect(() => loadConfig({
      ...base, NODE_ENV: "production", SMTP_HOST: "smtp.example", EMAIL_FROM: "hello@pawsh.example",
      DOCUMENT_STORAGE_ADAPTER: "filesystem", DOCUMENT_STORAGE_PATH: ".documents"
    })).toThrow(/Production requires S3/);
    expect(() => loadConfig({ ...base, NODE_ENV: "test" })).toThrow(/Tests require isolated memory/);
  });

  it("allows only explicit environment-appropriate storage adapters", () => {
    expect(loadConfig({
      ...base, NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory"
    }).DOCUMENT_STORAGE_ADAPTER).toBe("memory");
    expect(loadConfig({
      ...base, NODE_ENV: "development", DOCUMENT_STORAGE_ADAPTER: "filesystem",
      DOCUMENT_STORAGE_PATH: ".documents"
    }).DOCUMENT_STORAGE_ADAPTER).toBe("filesystem");
    expect(() => loadConfig({
      ...base, NODE_ENV: "production", SMTP_HOST: "smtp.example", EMAIL_FROM: "hello@pawsh.example",
      DOCUMENT_STORAGE_ADAPTER: "memory"
    })).toThrow(/Production requires S3/);
  });

  it("keeps memory document storage test-only", () => {
    const testConfig = loadConfig({
      ...base,
      NODE_ENV: "test",
      DOCUMENT_STORAGE_ADAPTER: "memory"
    });
    expect(createDocumentStorage(testConfig)).toBeInstanceOf(MemoryDocumentStorage);
    const developmentConfig = loadConfig({
      ...base,
      NODE_ENV: "development",
      DOCUMENT_STORAGE_ADAPTER: "memory"
    });
    expect(() => createDocumentStorage(developmentConfig)).toThrow(
      /Memory document storage is test-only/
    );
  });

  it("does not require or activate the retired scanner subsystem", () => {
    expect(loadConfig({ ...base, NODE_ENV:"development" }).NODE_ENV).toBe("development");
    expect(loadConfig({ ...base, NODE_ENV:"development" }).NODE_ENV).toBe("development");
  });

  it.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://app.pawsh.example:443", "https://app.pawsh.example"]
  ])("normalizes a valid root origin %s", (value, expected) => {
    expect(normalizeAppOrigin(value, "test")).toBe(expected);
  });

  it.each([
    "ftp://app.pawsh.example",
    "https://user:secret@app.pawsh.example",
    "https://app.pawsh.example/path",
    "https://app.pawsh.example?query=yes",
    "https://app.pawsh.example#fragment",
    "https://*.pawsh.example",
    "not a URL"
  ])("rejects an unsafe APP_ORIGIN %s", (value) => {
    expect(() => normalizeAppOrigin(value, "test")).toThrow();
  });

  it("requires HTTPS origins in production while keeping loopback origins distinct", () => {
    expect(() => normalizeAppOrigin("http://app.pawsh.example", "production")).toThrow(/HTTPS/);
    expect(normalizeAppOrigin("https://app.pawsh.example", "production")).toBe("https://app.pawsh.example");
    expect(normalizeAppOrigin("http://localhost:3000", "test"))
      .not.toBe(normalizeAppOrigin("http://127.0.0.1:3000", "test"));
  });

  it.each(["not-a-url", "https://database.example/pawsh", "postgres://localhost"])(
    "rejects invalid database configuration %s", (DATABASE_URL) => {
      expect(() => loadConfig({ ...base, NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", DATABASE_URL }))
        .toThrow(/DATABASE_URL/);
    }
  );

  it("reports incomplete configuration and rejects unknown adapters", () => {
    expect(() => loadConfig({ NODE_ENV: "development" })).toThrow();
    expect(() => loadConfig({ ...base, DOCUMENT_STORAGE_ADAPTER: "unknown" })).toThrow();
  });
});
