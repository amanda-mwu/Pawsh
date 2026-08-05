import { afterEach, describe, expect, it } from "vitest";
import { inspectLocalDatabaseTarget } from "../../scripts/local-db.js";

describe("local database safety guard", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("accepts only named Pawsh databases on loopback", () => {
    process.env.NODE_ENV = "development";
    expect(inspectLocalDatabaseTarget("postgres://pawsh:secret@127.0.0.1:55432/pawsh"))
      .toEqual({ host: "127.0.0.1", port: "55432", database: "pawsh" });
    expect(inspectLocalDatabaseTarget("postgres://pawsh:secret@localhost/pawsh_dev"))
      .toEqual({ host: "localhost", port: "5432", database: "pawsh_dev" });
  });

  it("rejects remote, broad, and production targets", () => {
    process.env.NODE_ENV = "development";
    expect(() => inspectLocalDatabaseTarget("postgres://pawsh:secret@db.example.test/pawsh_dev")).toThrow(/loopback/);
    expect(() => inspectLocalDatabaseTarget("postgres://postgres:secret@localhost/postgres")).toThrow(
      /pawsh or pawsh_dev/
    );
    process.env.NODE_ENV = "production";
    expect(() => inspectLocalDatabaseTarget("postgres://pawsh:secret@localhost/pawsh_dev")).toThrow(
      /disabled in production/
    );
  });
});
