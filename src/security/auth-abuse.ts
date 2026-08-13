import { createHmac } from "node:crypto";

type Entry = { attempts:number; windowStartedAt:number; blockedUntil:number };

export interface SecurityEvent {
  type: "login.failed" | "login.succeeded" | "auth.throttled" | "password_reset.requested";
  accountRef: string;
  networkRef: string;
}

export class AuthAbuseProtector {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: {
      secret: string;
      now?: (() => number) | undefined;
      accountThreshold?: number | undefined;
      networkThreshold?: number | undefined;
      windowMs?: number | undefined;
      baseBackoffMs?: number | undefined;
      maxBackoffMs?: number | undefined;
      record?: ((event: SecurityEvent) => void) | undefined;
    }
  ) {}

  refs(account: string, network: string) {
    return {
      accountRef:this.reference(`account:${account}`),
      networkRef:this.reference(`network:${network}`)
    };
  }

  retryAfter(account: string, network: string, scope = "login"): number {
    const now = this.now();
    return Math.max(
      this.remaining(`${scope}:account:${account}`, now),
      this.remaining(`${scope}:network:${network}`, now)
    );
  }

  failure(account: string, network: string, scope = "login"): void {
    const now = this.now();
    this.increment(`${scope}:account:${account}`, now);
    this.increment(`${scope}:network:${network}`, now);
  }

  success(account: string, scope = "login"): void {
    this.entries.delete(`${scope}:account:${account}`);
  }

  event(type: SecurityEvent["type"], account: string, network: string): void {
    this.options.record?.({ type, ...this.refs(account, network) });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private reference(value: string): string {
    return createHmac("sha256", this.options.secret).update(value).digest("hex").slice(0, 24);
  }

  private remaining(key: string, now: number): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (now - entry.windowStartedAt >= (this.options.windowMs ?? 15 * 60_000)) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, entry.blockedUntil - now);
  }

  private increment(key: string, now: number): void {
    const windowMs = this.options.windowMs ?? 15 * 60_000;
    let entry = this.entries.get(key);
    if (!entry || now - entry.windowStartedAt >= windowMs) {
      entry = { attempts:0, windowStartedAt:now, blockedUntil:0 };
    }
    entry.attempts += 1;
    const threshold = key.includes(":account:")
      ? (this.options.accountThreshold ?? 5)
      : (this.options.networkThreshold ?? 50);
    if (entry.attempts >= threshold) {
      const exponent = entry.attempts - threshold;
      entry.blockedUntil = now + Math.min(
        (this.options.baseBackoffMs ?? 1_000) * (2 ** exponent),
        this.options.maxBackoffMs ?? 60_000
      );
    }
    this.entries.set(key, entry);
  }
}
