import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  DATABASE_URL: "postgres://localhost/pawsh",
  SESSION_SECRET: "a-session-secret-that-is-long-enough",
  APP_ORIGIN: "https://app.pawsh.example",
  DOCUMENT_STORAGE_ADAPTER: "s3",
  DOCUMENT_STORAGE_BUCKET: "pawsh-private-test",
  DOCUMENT_STORAGE_REGION: "us-west-2"
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
});
