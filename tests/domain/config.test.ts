import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  DATABASE_URL: "postgres://localhost/pawsh",
  SESSION_SECRET: "a-session-secret-that-is-long-enough",
  APP_ORIGIN: "https://app.pawsh.example"
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
});
