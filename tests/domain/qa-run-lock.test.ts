import { describe, expect, it } from "vitest";
import {
  blockedRunMessage, claimExclusiveRun, classifyHolder, createRunOwnership, describeHolder,
  parseRunOwnership, staleOwnerMs, type LockHolder, type RunLockGateway
} from "../support/test-run-lock.js";

/**
 * Who owns the database run lock, and whether that owner is still alive.
 *
 * THE DEFECT THESE EXIST TO STOP COMING BACK. The lock serialises correctly while its owner is
 * alive, and a session advisory lock is released the moment the owning session goes away - but
 * that is the liveness of a CONNECTION, not of a run. A killed Node process can leave its socket
 * open; the backend then sits idle holding the lock, and the next run waited its entire timeout
 * before reporting a concurrent run that did not exist. Recovery meant finding the backend in
 * `pg_locks` by hand.
 *
 * The claim protocol is exercised here against a scripted gateway so that every branch - live
 * owner, dead owner, an owner that comes back to life mid-reclaim, the refusal - is a test rather
 * than a scenario somebody has to reproduce by killing things. The SQL those branches issue is
 * checked against a real PostgreSQL by the database suite's own startup, which takes this lock on
 * every run.
 */

function holderAt(overrides: Partial<LockHolder> = {}): LockHolder {
  return {
    backendPid: 4242,
    applicationName: createRunOwnership({ runId: "aaaabbbbccccdddd", pid: 999 }).token,
    state: "idle",
    idleMs: 0,
    backendStartText: "2026-09-04 12:00:00.123456+00",
    stateChangeText: "2026-09-04 12:00:01.654321+00",
    ...overrides
  };
}

/** A gateway whose answers are scripted, and which records what the protocol asked it to do. */
function scriptedGateway(script: {
  acquire: boolean[];
  holder?: (LockHolder | null)[];
  reclaim?: boolean;
}): RunLockGateway & { calls: string[] } {
  const acquire = [...script.acquire];
  const holders = [...(script.holder ?? [])];
  const calls: string[] = [];
  return {
    calls,
    async tryAcquire() {
      calls.push("tryAcquire");
      return acquire.shift() ?? false;
    },
    async readHolder() {
      calls.push("readHolder");
      return holders.length ? holders.shift()! : holderAt();
    },
    async reclaim() {
      calls.push("reclaim");
      return script.reclaim ?? false;
    }
  };
}

/** Deterministic clock and sleep, so nothing here waits on a real timer. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
    advance: (ms: number) => { current += ms; }
  };
}

describe("run lock ownership", () => {
  it("records a run instance, not a process", () => {
    const first = createRunOwnership();
    const second = createRunOwnership();
    // Same process, two runs: the PID is identical and the identity is not. That is the whole
    // reason ownership is a token rather than a PID.
    expect(first.pid).toBe(second.pid);
    expect(first.runId).not.toBe(second.runId);
    const parsed = parseRunOwnership(first.token);
    expect(parsed?.runId).toBe(first.runId);
    expect(parsed?.pid).toBe(first.pid);
    expect(Math.floor(parsed!.startedAt.getTime() / 1000))
      .toBe(Math.floor(first.startedAt.getTime() / 1000));
  });

  it("fits in the 63 bytes PostgreSQL keeps of an application_name", () => {
    // A truncated token would parse as garbage and silently make every holder unidentifiable.
    const token = createRunOwnership({ pid: 4_294_967_295 }).token;
    expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(63);
  });

  it("refuses to read ownership out of something that is not one of ours", () => {
    for (const value of [null, "", "psql", "pawsh-qa", "pawsh-qa:a:b:c", "other:a:1:2",
      "pawsh-qa:runid:notapid:1700000000"]) {
      expect(parseRunOwnership(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("deciding whether the lock's owner is still alive", () => {
  it("treats a session that has gone quiet for too long as dead", () => {
    const verdict = classifyHolder(holderAt({ idleMs: staleOwnerMs + 1 }));
    expect(verdict.holder).toBe("stale");
    expect(verdict.reason).toContain("stopped heartbeating");
  });

  it("treats a session that is heartbeating as alive", () => {
    expect(classifyHolder(holderAt({ idleMs: staleOwnerMs - 1 })).holder).toBe("live");
  });

  it("treats a session that is doing something as alive however long since it changed state", () => {
    // A long migration is `active` with an old `state_change`. Reading that as death would let a
    // second run drop the database out from under a run that is busy using it.
    for (const state of ["active", "idle in transaction", "fastpath function call"]) {
      expect(classifyHolder(holderAt({ state, idleMs: staleOwnerMs * 100 })).holder, state)
        .toBe("live");
    }
  });

  it("treats anything it cannot measure as alive", () => {
    // Refusing to start is recoverable; stealing a live run's database is not.
    expect(classifyHolder(holderAt({ idleMs: null })).holder).toBe("live");
  });

  it("reclaims an older runner that recorded no ownership at all", () => {
    // The state the machine was actually left in: a holder from before ownership was recorded.
    const verdict = classifyHolder(holderAt({ applicationName: null, idleMs: staleOwnerMs + 1 }));
    expect(verdict.holder).toBe("stale");
    expect(verdict.reason).toContain("recorded no ownership");
  });

  describe("a recycled PID cannot change the answer", () => {
    it("does not revive a dead owner whose PID now belongs to this very process", () => {
      // The trap a PID-based check falls into: the recorded process id is alive, and it is alive
      // because it is US. Liveness is the SESSION's activity, so the verdict does not move.
      const recycled = createRunOwnership({ pid: process.pid, runId: "deadrun000000001" });
      const verdict = classifyHolder(
        holderAt({ applicationName: recycled.token, idleMs: staleOwnerMs + 1 })
      );
      expect(verdict.holder).toBe("stale");
    });

    it("does not kill a live owner whose PID no longer exists anywhere", () => {
      // The mirror image, and the more dangerous one: a PID check that came up empty would
      // terminate a run that is heartbeating perfectly well from another machine.
      const foreign = createRunOwnership({ pid: 2_147_483_646, runId: "liverun000000001" });
      const verdict = classifyHolder(
        holderAt({ applicationName: foreign.token, idleMs: staleOwnerMs - 1 })
      );
      expect(verdict.holder).toBe("live");
    });
  });
});

describe("claiming the run lock", () => {
  it("takes a free lock without looking for an owner", async () => {
    const gateway = scriptedGateway({ acquire: [true] });
    const clock = fakeClock();
    const outcome = await claimExclusiveRun(gateway, { now: clock.now, sleep: clock.sleep });
    expect(outcome.reclaimed).toBeNull();
    expect(gateway.calls).toEqual(["tryAcquire"]);
  });

  it("waits for a live owner and takes the lock when it lets go", async () => {
    const gateway = scriptedGateway({
      acquire: [false, false, true],
      holder: [holderAt({ idleMs: 0 }), holderAt({ idleMs: 0 })],
      reclaim: true
    });
    const clock = fakeClock();
    const outcome = await claimExclusiveRun(gateway, {
      waitMs: 60_000, pollMs: 500, now: clock.now, sleep: clock.sleep
    });
    expect(outcome.reclaimed).toBeNull();
    // THE PROPERTY: `reclaim` is never reached while the owner looks alive, even though this
    // gateway would have said yes. One run cannot steal a live lock.
    expect(gateway.calls).not.toContain("reclaim");
    expect(outcome.waitedMs).toBe(1_000);
  });

  it("reclaims a dead owner and retries immediately rather than waiting out another poll", async () => {
    const dead = holderAt({ idleMs: staleOwnerMs + 5_000 });
    const gateway = scriptedGateway({ acquire: [false, true], holder: [dead], reclaim: true });
    const clock = fakeClock();
    const reclaimed: string[] = [];
    const outcome = await claimExclusiveRun(gateway, {
      pollMs: 500, now: clock.now, sleep: clock.sleep,
      onReclaim: (_holder, reason) => reclaimed.push(reason)
    });
    expect(outcome.reclaimed).toEqual(dead);
    expect(gateway.calls).toEqual(["tryAcquire", "readHolder", "reclaim", "tryAcquire"]);
    // No sleep between the reclaim and the retry: a dead owner costs the next run one poll, not
    // the ten minutes it used to cost.
    expect(outcome.waitedMs).toBe(0);
    expect(reclaimed[0]).toContain("stopped heartbeating");
  });

  it("keeps waiting when the fence refuses to terminate a holder that came back to life", async () => {
    // The race: the holder looked stale when it was read and did something before the terminate
    // landed, so the fence rejects it. The claim must not treat that as permission to proceed.
    const gateway = scriptedGateway({
      acquire: [false, false],
      holder: [holderAt({ idleMs: staleOwnerMs + 1 }), holderAt({ idleMs: staleOwnerMs + 1 })],
      reclaim: false
    });
    const clock = fakeClock();
    await expect(claimExclusiveRun(gateway, {
      waitMs: 600, pollMs: 500, now: clock.now, sleep: clock.sleep
    })).rejects.toThrow(/another database run holds/);
    expect(gateway.calls.filter((call) => call === "reclaim")).toHaveLength(2);
  });

  it("names the owner and the way out when it gives up", async () => {
    const owner = createRunOwnership({ runId: "abcd1234abcd1234", pid: 31337 });
    const gateway = scriptedGateway({
      acquire: [false],
      holder: [holderAt({ applicationName: owner.token, backendPid: 90210, idleMs: 0 })]
    });
    const clock = fakeClock();
    const failure = await claimExclusiveRun(gateway, {
      waitMs: 0, pollMs: 500, now: clock.now, sleep: clock.sleep
    }).catch((error: Error) => error.message);

    expect(failure).toContain("abcd1234abcd1234");
    expect(failure).toContain("31337");
    expect(failure).toContain("backend pid 90210");
    // The recovery nobody should have to work out from scratch again.
    expect(failure).toContain("select pg_terminate_backend(90210);");
  });

  it("still says something useful when the holder vanished while it was being described", async () => {
    const gateway = scriptedGateway({ acquire: [false], holder: [null] });
    const clock = fakeClock();
    const failure = await claimExclusiveRun(gateway, {
      waitMs: 0, pollMs: 500, now: clock.now, sleep: clock.sleep
    }).catch((error: Error) => error.message);
    expect(failure).toContain("has since gone away");
    expect(failure).toContain("pg_terminate_backend");
  });

  it("leaves nothing behind to reclaim when runs follow one another cleanly", async () => {
    // A clean release frees the lock, so the next run finds it free and never reclaims anything.
    // A run that had to reclaim on a quiet machine would mean the previous one leaked its session.
    for (let run = 0; run < 5; run += 1) {
      const gateway = scriptedGateway({ acquire: [true] });
      const clock = fakeClock();
      const outcome = await claimExclusiveRun(gateway, { now: clock.now, sleep: clock.sleep });
      expect(outcome.reclaimed, `run ${run}`).toBeNull();
      expect(gateway.calls).toEqual(["tryAcquire"]);
    }
  });
});

describe("describing a holder", () => {
  it("names the run, the process and the session for one of ours", () => {
    const owner = createRunOwnership({ runId: "feedfacefeedface", pid: 555 });
    const description = describeHolder(holderAt({ applicationName: owner.token, backendPid: 77 }));
    expect(description).toContain("feedfacefeedface");
    expect(description).toContain("process 555");
    expect(description).toContain("backend pid 77");
  });

  it("says plainly when the holder recorded nothing about itself", () => {
    expect(describeHolder(holderAt({ applicationName: null })))
      .toContain("unidentified runner");
  });

  it("never claims a wait was shorter than it was", () => {
    expect(blockedRunMessage(holderAt(), 65_000)).toContain("Waited:  65s");
  });
});
