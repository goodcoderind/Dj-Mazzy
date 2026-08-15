import { describe, expect, it, vi } from "vitest";
import {
  createLibraryReconciliationRuntime,
  libraryReconciliationResultCovers,
  mergeLibraryReconciliationRequirements,
  shouldQuiescePartyForRemoteCheckpoint
} from "./libraryReconciliationRuntime";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((currentResolve, currentReject) => {
    resolve = currentResolve;
    reject = currentReject;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("library reconciliation runtime", () => {
  it("merges pending counter coverage without regressing a newer epoch", () => {
    const merged = mergeLibraryReconciliationRequirements(
      { minimumLibraryEpoch: 4, minimumLibraryRevision: 9, minimumCheckpointRevision: 12 },
      { minimumLibraryEpoch: 5, minimumLibraryRevision: 2, minimumCheckpointRevision: 11 }
    );
    expect(merged).toEqual({
      minimumLibraryEpoch: 5,
      minimumLibraryRevision: 2,
      minimumCheckpointRevision: 12
    });
    expect(libraryReconciliationResultCovers({
      requirements: merged,
      libraryEpoch: 5,
      libraryRevision: 2,
      checkpointRevision: 12
    })).toBe(true);
    expect(libraryReconciliationResultCovers({
      requirements: merged,
      libraryEpoch: 5,
      libraryRevision: 1,
      checkpointRevision: 12
    })).toBe(false);
  });

  it("quiesces every newer remote checkpoint mutation, including same-owner clear", () => {
    const base = {
      eventType: "party-checkpoint-claimed",
      eventCheckpointRevision: 8,
      eventSessionId: "remote-session",
      eventWriterToken: "remote-writer",
      currentCheckpointRevision: 7,
      currentSessionId: "local-session",
      currentWriterToken: "local-writer"
    };
    expect(shouldQuiescePartyForRemoteCheckpoint(base)).toBe(true);
    expect(shouldQuiescePartyForRemoteCheckpoint({
      ...base,
      eventCheckpointRevision: 7
    })).toBe(false);
    expect(shouldQuiescePartyForRemoteCheckpoint({
      ...base,
      eventSessionId: "local-session",
      eventWriterToken: "local-writer"
    })).toBe(true);
    expect(shouldQuiescePartyForRemoteCheckpoint({
      ...base,
      eventType: "track-deleted"
    })).toBe(false);
  });

  it("coalesces a trigger burst to one active and one latest read", async () => {
    const runs: Array<{ trigger: number; signal: AbortSignal; task: ReturnType<typeof deferred<string>> }> = [];
    const completed = vi.fn();
    const runtime = createLibraryReconciliationRuntime<number, string>({
      read: (trigger, signal) => {
        const task = deferred<string>();
        runs.push({ trigger, signal, task });
        return task.promise;
      },
      onCompleted: completed
    });
    runtime.request(0);
    await flush();
    for (let trigger = 1; trigger <= 1_000; trigger += 1) runtime.request(trigger);
    expect(runs).toHaveLength(1);
    expect(runs[0].signal.aborted).toBe(false);
    runs[0].task.resolve("superseded");
    await flush();
    expect(runs).toHaveLength(2);
    expect(runs[1].trigger).toBe(1_000);
    runs[1].task.resolve("latest");
    await flush();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toBe(1_000);
  });

  it("does not let later triggers postpone the active deadline", async () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const runs: Array<{ trigger: number; signal: AbortSignal }> = [];
    const timedOut = vi.fn();
    const runtime = createLibraryReconciliationRuntime<number, string>({
      read: (trigger, signal) => {
        runs.push({ trigger, signal });
        return new Promise(() => undefined);
      },
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { timers.push(callback); return callback; },
      clearTimer: () => undefined,
      onTimedOut: timedOut
    });
    runtime.request(0);
    await flush();
    for (const value of [5, 10, 29]) {
      now = value;
      runtime.request(value);
      await flush();
    }
    expect(runs).toHaveLength(1);
    now = 30;
    timers[0]();
    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(runs[0].signal.aborted).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ mode: "circuit-open", active: false, pending: false });
  });

  it("opens a circuit when the newest read fails", async () => {
    const task = deferred<string>();
    const failed = vi.fn();
    const runtime = createLibraryReconciliationRuntime<string, string>({
      read: () => task.promise,
      onFailed: failed
    });
    runtime.request("focus");
    await flush();
    task.reject(new Error("private adapter detail"));
    await flush();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().mode).toBe("circuit-open");
    expect(runtime.request("again")).toBe("blocked");
  });

  it("uses the monotonic deadline when a throttled timer has not fired", async () => {
    let now = 10;
    const timers: Array<() => void> = [];
    const task = deferred<string>();
    const timedOut = vi.fn();
    const completed = vi.fn();
    const runtime = createLibraryReconciliationRuntime<string, string>({
      read: () => task.promise,
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { timers.push(callback); return callback; },
      clearTimer: () => undefined,
      onTimedOut: timedOut,
      onCompleted: completed
    });
    runtime.request("visibility");
    await flush();
    now = 40;
    task.resolve("late");
    await flush();
    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    timers.forEach((timer) => timer());
    expect(timedOut).toHaveBeenCalledTimes(1);
  });

  it("pauses an exact read for local mutation and drains one latest trigger after resume", async () => {
    const runs: Array<{ trigger: string; signal: AbortSignal; task: ReturnType<typeof deferred<string>> }> = [];
    const completed = vi.fn();
    const runtime = createLibraryReconciliationRuntime<string, string>({
      read: (trigger, signal) => {
        const task = deferred<string>();
        runs.push({ trigger, signal, task });
        return task.promise;
      },
      onCompleted: completed
    });
    runtime.request("focus");
    await flush();
    expect(runtime.pause()).toBe(true);
    expect(runs[0].signal.aborted).toBe(true);
    runtime.request("remote-a");
    runtime.request("remote-b");
    expect(runs).toHaveLength(1);
    expect(runtime.resume()).toBe(true);
    await flush();
    expect(runs).toHaveLength(2);
    expect(runs[1].trigger).toBe("remote-b");
    runs[1].task.resolve("current");
    await flush();
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("halts by aborting the exact read and making late settlement inert", async () => {
    const task = deferred<string>();
    const signals: AbortSignal[] = [];
    const completed = vi.fn();
    const runtime = createLibraryReconciliationRuntime<string, string>({
      read: (_trigger, currentSignal) => {
        signals.push(currentSignal);
        return task.promise;
      },
      onCompleted: completed
    });
    runtime.request("focus");
    await flush();
    runtime.halt();
    expect(signals[0]?.aborted).toBe(true);
    task.resolve("late");
    await flush();
    expect(completed).not.toHaveBeenCalled();
    expect(runtime.snapshot().mode).toBe("halted");
  });
});
