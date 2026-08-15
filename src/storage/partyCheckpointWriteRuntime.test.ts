import { describe, expect, it, vi } from "vitest";
import {
  createPartyCheckpointClaimOwner,
  createPartyCheckpointClearOwner,
  createPartyCheckpointWriteRuntime,
  ownsPartyCheckpointClaim,
  ownsPartyCheckpointClear,
  shouldQueuePartyCheckpointCandidate,
  startBoundedPartyCheckpointOperation
} from "./partyCheckpointWriteRuntime";

describe("party checkpoint write runtime", () => {
  it("queues a return to the saved fingerprint while newer work is active or pending", () => {
    expect(shouldQueuePartyCheckpointCandidate({
      fingerprint: "f0",
      lastSavedFingerprint: "f0",
      runtime: { activeFingerprint: "f1", pendingFingerprint: "f2" }
    })).toBe(true);
    expect(shouldQueuePartyCheckpointCandidate({
      fingerprint: "f0",
      lastSavedFingerprint: "f0",
      runtime: { activeFingerprint: null, pendingFingerprint: null }
    })).toBe(false);
  });

  it("keeps one active write and only the latest of one thousand pending snapshots", async () => {
    let resolveActive!: (value: string) => void;
    const calls: string[] = [];
    const runtime = createPartyCheckpointWriteRuntime<string, string>({
      write: (value) => {
        calls.push(value);
        return calls.length === 1
          ? new Promise((resolve) => { resolveActive = resolve; })
          : Promise.resolve(value);
      },
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue({ fingerprint: "f0", value: "v0" });
    for (let index = 1; index <= 1_000; index += 1) {
      runtime.enqueue({ fingerprint: `f${index}`, value: `v${index}` });
    }
    await Promise.resolve();
    expect(calls).toEqual(["v0"]);
    expect(runtime.snapshot().pendingFingerprint).toBe("f1000");
    resolveActive("saved");
    await vi.waitFor(() => expect(calls).toEqual(["v0", "v1000"]));
  });

  it("drops a pending draft when the latest state returns to the active fingerprint", async () => {
    const runtime = createPartyCheckpointWriteRuntime<string, string>({
      write: () => new Promise(() => undefined),
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue({ fingerprint: "active", value: "active" });
    runtime.enqueue({ fingerprint: "temporary", value: "temporary" });
    expect(runtime.snapshot().pendingFingerprint).toBe("temporary");
    runtime.enqueue({ fingerprint: "active", value: "active-again" });
    expect(runtime.snapshot().pendingFingerprint).toBeNull();
  });

  it("opens a circuit at the exact monotonic deadline and ignores late settlement", async () => {
    let now = 0;
    let wake!: () => void;
    let resolveActive!: (value: string) => void;
    const resolved = vi.fn();
    const timedOut = vi.fn();
    const runtime = createPartyCheckpointWriteRuntime<string, string>({
      write: (_value, signal) => new Promise((resolve) => {
        resolveActive = resolve;
        expect(signal.aborted).toBe(false);
      }),
      onResolved: resolved,
      onTimedOut: timedOut,
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    runtime.enqueue({ fingerprint: "active", value: "draft" });
    await Promise.resolve();
    runtime.enqueue({ fingerprint: "pending", value: "newest" });
    now = 30;
    wake();
    expect(runtime.snapshot()).toMatchObject({
      mode: "circuit-open", activeFingerprint: null, pendingFingerprint: null
    });
    expect(timedOut).toHaveBeenCalledOnce();
    expect(runtime.enqueue({ fingerprint: "later", value: "later" })).toBe("circuit-open");
    resolveActive("late");
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
  });

  it("uses the updated revision when starting the newest pending write", async () => {
    let revision = 4;
    let resolveFirst!: (value: { revision: number }) => void;
    const expectedRevisions: number[] = [];
    const runtime = createPartyCheckpointWriteRuntime<string, { revision: number }>({
      write: async (value) => {
        expectedRevisions.push(revision);
        if (value === "first") return new Promise((resolve) => { resolveFirst = resolve; });
        return { revision: revision + 1 };
      },
      onResolved: (_value, result) => { revision = result.revision; },
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue({ fingerprint: "first", value: "first" });
    runtime.enqueue({ fingerprint: "middle", value: "middle" });
    runtime.enqueue({ fingerprint: "latest", value: "latest" });
    await Promise.resolve();
    resolveFirst({ revision: 5 });
    await vi.waitFor(() => expect(expectedRevisions).toEqual([4, 5]));
    expect(revision).toBe(6);
  });

  it("halts on an on-time ownership failure and never applies a late duplicate", async () => {
    const ownershipLoss = vi.fn(() => false);
    const runtime = createPartyCheckpointWriteRuntime<string, string>({
      write: async () => "stale",
      onResolved: ownershipLoss,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue({ fingerprint: "one", value: "one" });
    await vi.waitFor(() => expect(runtime.snapshot().mode).toBe("halted"));
    expect(ownershipLoss).toHaveBeenCalledOnce();
    expect(runtime.enqueue({ fingerprint: "two", value: "two" })).toBe("paused");
  });

  it("bounds an exclusive clear behind the active write and refuses it after timeout", async () => {
    let now = 0;
    let wake!: () => void;
    let resolveActive!: (value: string) => void;
    const runtime = createPartyCheckpointWriteRuntime<string, string>({
      write: () => new Promise((resolve) => { resolveActive = resolve; }),
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    runtime.enqueue({ fingerprint: "one", value: "one" });
    await Promise.resolve();
    const firstExclusive = runtime.prepareExclusive();
    resolveActive("saved");
    await expect(firstExclusive).resolves.toBe(true);
    expect(runtime.resume()).toBe(true);

    runtime.enqueue({ fingerprint: "two", value: "two" });
    await Promise.resolve();
    const timedExclusive = runtime.prepareExclusive();
    now = 30;
    wake();
    await expect(timedExclusive).resolves.toBe(false);
    expect(runtime.snapshot().mode).toBe("circuit-open");
  });

  it("allows only one exclusive clear owner and reopens admission only after confirmed completion", async () => {
    const runtime = createPartyCheckpointWriteRuntime<string, string>({
      write: async (value) => value,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await expect(runtime.prepareExclusive()).resolves.toBe(true);
    await expect(runtime.prepareExclusive()).resolves.toBe(false);
    expect(runtime.reset()).toBe(false);
    expect(runtime.completeExclusive()).toBe(true);
    expect(runtime.snapshot().mode).toBe("running");
  });

  it("revokes an old epoch so unmount and restart settlements stay inert", async () => {
    let resolveOld!: (value: string) => void;
    const settled = vi.fn();
    const runtime = createPartyCheckpointWriteRuntime<string, string>({
      write: () => new Promise((resolve) => { resolveOld = resolve; }),
      onResolved: settled,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue({ fingerprint: "old", value: "old" });
    await Promise.resolve();
    runtime.halt();
    resolveOld("late");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(runtime.reset()).toBe(true);
    expect(runtime.snapshot().mode).toBe("running");
  });
});

describe("party checkpoint clear ownership", () => {
  it("matches only the exact paused-plan claim and library generation", () => {
    const owner = createPartyCheckpointClaimOwner({
      operation: 1,
      sessionId: "session",
      checkpointRevision: 2,
      previousWriterToken: "previous",
      nextWriterToken: "next",
      libraryEpoch: 3,
      libraryRevision: 4
    });
    expect(ownsPartyCheckpointClaim(owner, owner)).toBe(true);
    expect(ownsPartyCheckpointClaim(createPartyCheckpointClaimOwner({
      ...owner,
      operation: 2
    }), owner)).toBe(false);
    expect(ownsPartyCheckpointClaim(createPartyCheckpointClaimOwner({
      ...owner,
      libraryRevision: 5
    }), owner)).toBe(false);
  });

  it("matches only the exact operation, session, and writer", () => {
    const owner = createPartyCheckpointClearOwner({ operation: 1, sessionId: "session", writerToken: "writer" });
    expect(ownsPartyCheckpointClear(owner, owner)).toBe(true);
    expect(ownsPartyCheckpointClear(createPartyCheckpointClearOwner({
      operation: 2, sessionId: "session", writerToken: "writer"
    }), owner)).toBe(false);
    expect(ownsPartyCheckpointClear(createPartyCheckpointClearOwner({
      operation: 1, sessionId: "successor", writerToken: "writer"
    }), owner)).toBe(false);
  });

  it("aborts at the exact deadline and ignores a late storage settlement", async () => {
    let now = 0;
    let wake!: () => void;
    let resolveTask!: (value: string) => void;
    let signal!: AbortSignal;
    const bounded = startBoundedPartyCheckpointOperation({
      task: (currentSignal) => {
        signal = currentSignal;
        return new Promise((resolve) => { resolveTask = resolve; });
      },
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    await Promise.resolve();
    now = 30;
    wake();
    await expect(bounded.promise).resolves.toEqual({ outcome: "timed-out" });
    expect(signal.aborted).toBe(true);
    resolveTask("late");
    await Promise.resolve();
    await expect(bounded.promise).resolves.toEqual({ outcome: "timed-out" });
  });

  it("cancels when a successor owns the operation before storage settles", async () => {
    let owned = true;
    let resolveTask!: (value: string) => void;
    const bounded = startBoundedPartyCheckpointOperation({
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      ownsAuthority: () => owned,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    owned = false;
    resolveTask("old-success");
    await expect(bounded.promise).resolves.toEqual({ outcome: "cancelled" });
  });

  it("cannot regain authority after a Stop-style owner revocation", async () => {
    const owner = createPartyCheckpointClaimOwner({
      operation: 1,
      sessionId: "session",
      checkpointRevision: 2,
      previousWriterToken: "previous",
      nextWriterToken: "next",
      libraryEpoch: 3,
      libraryRevision: 4
    });
    let currentOwner: ReturnType<typeof createPartyCheckpointClaimOwner> | null = owner;
    let transientStop = false;
    let resolveTask!: (value: string) => void;
    const bounded = startBoundedPartyCheckpointOperation({
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      ownsAuthority: () => ownsPartyCheckpointClaim(currentOwner, owner) && !transientStop,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    transientStop = true;
    currentOwner = null;
    transientStop = false;
    resolveTask("late-claimed");
    await expect(bounded.promise).resolves.toEqual({ outcome: "cancelled" });
  });

  it("aborts a queued task when authority is lost before the deadline wake", async () => {
    let now = 0;
    let wake!: () => void;
    let owned = true;
    let signal!: AbortSignal;
    const bounded = startBoundedPartyCheckpointOperation({
      task: (currentSignal) => {
        signal = currentSignal;
        return new Promise(() => undefined);
      },
      ownsAuthority: () => owned,
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    await Promise.resolve();
    owned = false;
    now = 30;
    wake();
    await expect(bounded.promise).resolves.toEqual({ outcome: "cancelled" });
    expect(signal.aborted).toBe(true);
  });
});
