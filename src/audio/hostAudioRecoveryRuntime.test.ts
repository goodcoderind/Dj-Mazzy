import { describe, expect, it, vi } from "vitest";
import {
  HOST_AUDIO_RECOVERY_TIMEOUT_MS,
  hostAudioRecoveryCanCommit,
  hostAudioRecoveryMayStart,
  hostAudioRecoveryPageHideDisposition,
  ownsHostAudioRecovery,
  planHostAudioRecoverySettlement,
  startHostAudioRecovery
} from "./hostAudioRecoveryRuntime";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("host audio recovery runtime", () => {
  it("completes only the exact owner strictly before its deadline", async () => {
    let now = 50;
    const task = deferred<boolean>();
    const runtime = startHostAudioRecovery({
      operation: 1,
      intent: "context",
      audioGeneration: 2,
      deviceGeneration: 3,
      task: () => task.promise,
      now: () => now,
      scheduleTimeout: vi.fn(() => 1 as never),
      clearScheduledTimeout: vi.fn()
    });
    expect(ownsHostAudioRecovery(runtime.owner, runtime.owner)).toBe(true);
    expect(hostAudioRecoveryCanCommit({
      currentOwner: runtime.owner,
      expectedOwner: runtime.owner,
      audioGeneration: 2,
      deviceGeneration: 3
    })).toBe(true);
    expect(hostAudioRecoveryCanCommit({
      currentOwner: runtime.owner,
      expectedOwner: runtime.owner,
      audioGeneration: 3,
      deviceGeneration: 3
    })).toBe(false);
    now = runtime.owner.deadlineMilliseconds - 0.001;
    task.resolve(true);
    await expect(runtime.settlement).resolves.toEqual({ outcome: "completed", contextRunning: true });
  });

  it("times out at the absolute deadline even when the timer is throttled", async () => {
    let now = 0;
    let timer: () => void = () => undefined;
    const task = deferred<boolean>();
    const runtime = startHostAudioRecovery({
      operation: 2,
      intent: "device",
      audioGeneration: 4,
      deviceGeneration: 5,
      task: () => task.promise,
      now: () => now,
      scheduleTimeout: (callback) => { timer = callback; return 1 as never; },
      clearScheduledTimeout: vi.fn()
    });
    now = HOST_AUDIO_RECOVERY_TIMEOUT_MS + 5_000;
    task.resolve(true);
    await expect(runtime.settlement).resolves.toEqual({ outcome: "timed-out" });
    timer();
    expect(runtime.snapshot().active).toBe(false);
  });

  it("cancels once and ignores late success or failure", async () => {
    const task = deferred<boolean>();
    const runtime = startHostAudioRecovery({
      operation: 3,
      intent: "context",
      audioGeneration: 1,
      deviceGeneration: 1,
      task: () => task.promise,
      scheduleTimeout: vi.fn(() => 1 as never),
      clearScheduledTimeout: vi.fn()
    });
    expect(runtime.cancel()).toBe(true);
    expect(runtime.cancel()).toBe(false);
    task.resolve(true);
    await expect(runtime.settlement).resolves.toEqual({ outcome: "cancelled" });
  });

  it("contains ordinary failure without private error projection", async () => {
    const runtime = startHostAudioRecovery({
      operation: 4,
      intent: "context",
      audioGeneration: 1,
      deviceGeneration: 1,
      task: async () => { throw new Error("private device label"); },
      scheduleTimeout: vi.fn(() => 1 as never),
      clearScheduledTimeout: vi.fn()
    });
    await expect(runtime.settlement).resolves.toEqual({ outcome: "failed" });
  });

  it("projects App admission, supersession, cleanup, and pagehide fail closed", () => {
    const runtime = startHostAudioRecovery({
      operation: 5,
      intent: "context",
      audioGeneration: 4,
      deviceGeneration: 7,
      task: () => new Promise(() => undefined),
      scheduleTimeout: vi.fn(() => 1 as never),
      clearScheduledTimeout: vi.fn()
    });
    expect(hostAudioRecoveryMayStart({ ownerActive: false, circuitOpen: false, cleanupSafe: true })).toBe(true);
    expect(hostAudioRecoveryMayStart({ ownerActive: true, circuitOpen: false, cleanupSafe: true })).toBe(false);
    expect(hostAudioRecoveryMayStart({ ownerActive: false, circuitOpen: true, cleanupSafe: true })).toBe(false);
    expect(hostAudioRecoveryMayStart({ ownerActive: false, circuitOpen: false, cleanupSafe: false })).toBe(false);
    const base = {
      currentOwner: runtime.owner,
      expectedOwner: runtime.owner,
      audioGeneration: 4,
      deviceGeneration: 7,
      cleanupSafe: true
    };
    expect(planHostAudioRecoverySettlement({
      ...base,
      settlement: { outcome: "completed", contextRunning: true }
    })).toBe("release-context-output");
    expect(planHostAudioRecoverySettlement({
      ...base,
      deviceGeneration: 8,
      settlement: { outcome: "completed", contextRunning: true }
    })).toBe("stale");
    expect(planHostAudioRecoverySettlement({
      ...base,
      cleanupSafe: false,
      settlement: { outcome: "completed", contextRunning: true }
    })).toBe("block-cleanup");
    expect(planHostAudioRecoverySettlement({ ...base, settlement: { outcome: "timed-out" } })).toBe("block-timeout");
    expect(planHostAudioRecoverySettlement({ ...base, settlement: { outcome: "failed" } })).toBe("retry");
    expect(hostAudioRecoveryPageHideDisposition(true)).toBe("block");
    expect(hostAudioRecoveryPageHideDisposition(false)).toBe("unchanged");
    runtime.cancel();
  });
});
