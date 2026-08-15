import { describe, expect, it, vi } from "vitest";
import {
  ENHANCED_TIMING_REMOVAL_VERSION,
  enhancedTimingRemovalDisposition,
  ownsEnhancedTimingRemoval,
  startEnhancedTimingRemoval
} from "./enhancedTimingRemovalRuntime";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("enhanced timing removal runtime", () => {
  it("accepts one verified removal strictly before its deadline", async () => {
    let clock = 100;
    const run = startEnhancedTimingRemoval({
      operation: 1,
      task: async () => true,
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    expect(run.owner).toMatchObject({
      version: ENHANCED_TIMING_REMOVAL_VERSION,
      deadlineMilliseconds: 110
    });
    expect(ownsEnhancedTimingRemoval(run.owner, run.owner)).toBe(true);
    clock = 109.999;
    await expect(run.settlement).resolves.toEqual({ outcome: "completed", absent: true });
  });

  it("times out at the original boundary despite delayed timer delivery", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    let resolveTask!: (absent: boolean) => void;
    const run = startEnhancedTimingRemoval({
      operation: 2,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: (callback) => { wake = callback; return 1 as ReturnType<typeof setTimeout>; },
      clearScheduledTimeout: vi.fn()
    });
    await flush();
    clock = 25;
    wake();
    await expect(run.settlement).resolves.toEqual({ outcome: "timed-out" });
    resolveTask(true);
    await flush();
    expect(run.snapshot().active).toBe(false);
  });

  it("rejects exact-deadline success and contains ordinary rejection", async () => {
    let clock = 10;
    let resolveTask!: (absent: boolean) => void;
    const exact = startEnhancedTimingRemoval({
      operation: 3,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await flush();
    clock = 20;
    resolveTask(true);
    await expect(exact.settlement).resolves.toEqual({ outcome: "timed-out" });

    clock = 30;
    const failed = startEnhancedTimingRemoval({
      operation: 4,
      task: async () => { throw new Error("private cache failure"); },
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await expect(failed.settlement).resolves.toEqual({ outcome: "failed" });
    expect(JSON.stringify(await failed.settlement)).not.toContain("private");
  });

  it("cancels once and ignores a late result", async () => {
    let resolveTask!: (absent: boolean) => void;
    const run = startEnhancedTimingRemoval({
      operation: 5,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      now: () => 1,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await flush();
    expect(run.cancel()).toBe(true);
    expect(run.cancel()).toBe(false);
    resolveTask(true);
    await expect(run.settlement).resolves.toEqual({ outcome: "cancelled" });
  });

  it("fails closed when deletion does not prove absence", async () => {
    const run = startEnhancedTimingRemoval({
      operation: 6,
      task: async () => false,
      now: () => 1,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await expect(run.settlement).resolves.toEqual({ outcome: "failed" });
    expect(enhancedTimingRemovalDisposition(await run.settlement)).toBe("reload-required");
    expect(enhancedTimingRemovalDisposition({ outcome: "cancelled" })).toBe("cancelled");
    expect(enhancedTimingRemovalDisposition({ outcome: "completed", absent: true })).toBe("verified-removed");
  });
});
