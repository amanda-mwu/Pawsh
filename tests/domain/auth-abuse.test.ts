import { describe, expect, it } from "vitest";
import { AuthAbuseProtector, type SecurityEvent } from "../../src/security/auth-abuse.js";

describe("authentication abuse protection", () => {
  it("combines account and network limits with bounded backoff and injectable time", () => {
    let now = 1_000;
    const protector = new AuthAbuseProtector({
      secret:"test security reference secret",
      now:()=>now,
      accountThreshold:2,
      networkThreshold:3,
      windowMs:10_000,
      baseBackoffMs:100,
      maxBackoffMs:200
    });
    protector.failure("user@example.test","192.0.2.1");
    expect(protector.retryAfter("user@example.test","192.0.2.2")).toBe(0);
    protector.failure("user@example.test","192.0.2.2");
    expect(protector.retryAfter("user@example.test","192.0.2.3")).toBe(100);
    now += 100;
    expect(protector.retryAfter("user@example.test","192.0.2.3")).toBe(0);
    protector.failure("user@example.test","192.0.2.3");
    expect(protector.retryAfter("user@example.test","192.0.2.4")).toBe(200);
    now += 10_000;
    expect(protector.retryAfter("user@example.test","192.0.2.4")).toBe(0);
  });

  it("emits stable pseudonymous references without raw identifiers", () => {
    const events: SecurityEvent[] = [];
    const protector = new AuthAbuseProtector({
      secret:"test security reference secret",
      record:(event)=>events.push(event)
    });
    protector.event("login.failed","person@example.test","192.0.2.10");
    expect(events[0]?.accountRef).toHaveLength(24);
    expect(JSON.stringify(events)).not.toContain("person@example.test");
    expect(JSON.stringify(events)).not.toContain("192.0.2.10");
  });
});
