import { describe, expect, it, vi } from "vitest";
import {
  ENHANCED_TIMING_PREPARATION_VERSION,
  claimEnhancedTimingPreparationReady,
  normalizeEnhancedTimingPreparationStage,
  projectEnhancedTimingPreparationUiMode,
  ownsEnhancedTimingPreparation,
  startEnhancedTimingPreparation
} from "./enhancedTimingPreparationRuntime";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("enhanced timing preparation runtime", () => {
  it("projects only fixed progress stages", () => {
    expect(normalizeEnhancedTimingPreparationStage("loading-83mb-model")).toBe("loading-83mb-model");
    expect(normalizeEnhancedTimingPreparationStage("inferring-window-2-of-4")).toBe("inferring-window-2-of-4");
    expect(normalizeEnhancedTimingPreparationStage("private-file.wav")).toBe("downloading");
    expect(normalizeEnhancedTimingPreparationStage(null)).toBe("downloading");
  });

  it("keeps truthful recovery actions reachable for every nonterminal preparation state", () => {
    expect(projectEnhancedTimingPreparationUiMode({
      preparationState: "preparing",
      timingState: "downloading"
    })).toBe("preparing");
    expect(projectEnhancedTimingPreparationUiMode({
      preparationState: "cancelling",
      timingState: "preparation-cancelling"
    })).toBe("unconfirmed");
    expect(projectEnhancedTimingPreparationUiMode({
      preparationState: "cancel-timeout",
      timingState: "preparation-unconfirmed"
    })).toBe("unconfirmed");
    expect(projectEnhancedTimingPreparationUiMode({ timingState: "check-error" })).toBe("probe-retry");
    expect(projectEnhancedTimingPreparationUiMode({ timingState: "offline" })).toBe("probe-retry");
    expect(projectEnhancedTimingPreparationUiMode({
      timingState: "coordination-unavailable"
    })).toBe("coordination-unavailable");
    expect(projectEnhancedTimingPreparationUiMode({ timingState: "partial" })).toBe("partial");
  });

  it("claims readiness only for the exact observed authority and accepted deadline commit", () => {
    const authority = { epoch: 2, token: "authority-token-000002" };
    const claimCommit = vi.fn(() => true);
    expect(claimEnhancedTimingPreparationReady({
      observed: { authority, revoked: false },
      preparedAuthority: authority,
      admissionCurrent: true,
      ownerCurrent: true,
      claimCommit
    })).toBe(true);
    expect(claimCommit).toHaveBeenCalledOnce();

    claimCommit.mockClear();
    expect(claimEnhancedTimingPreparationReady({
      observed: { authority, revoked: false },
      preparedAuthority: authority,
      admissionCurrent: true,
      ownerCurrent: true,
      claimCommit: () => false
    })).toBe(false);
    expect(claimEnhancedTimingPreparationReady({
      observed: { authority: { ...authority, token: "authority-token-foreign" }, revoked: false },
      preparedAuthority: authority,
      admissionCurrent: true,
      ownerCurrent: true,
      claimCommit
    })).toBe(false);
    expect(claimCommit).not.toHaveBeenCalled();
  });

  it("publishes one exact result strictly before the absolute deadline", async () => {
    let clock = 100;
    const run = startEnhancedTimingPreparation({
      operation: 1,
      kind: "probe",
      task: async () => "stored" as const,
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    expect(run.owner).toMatchObject({
      version: ENHANCED_TIMING_PREPARATION_VERSION,
      kind: "probe",
      deadlineMilliseconds: 110
    });
    expect(ownsEnhancedTimingPreparation(run.owner, run.owner)).toBe(true);
    clock = 109.999;
    await expect(run.settlement).resolves.toEqual({ outcome: "completed", value: "stored" });
  });

  it("keeps the original deadline when timer delivery is throttled", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    let resolveTask!: (value: string) => void;
    const run = startEnhancedTimingPreparation({
      operation: 2,
      kind: "prepare",
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
    resolveTask("late-private-result");
    await flush();
    expect(run.snapshot().active).toBe(false);
  });

  it("rejects exact-deadline completion and contains private task rejection", async () => {
    let clock = 0;
    let resolveTask!: (value: boolean) => void;
    const exact = startEnhancedTimingPreparation({
      operation: 3,
      kind: "prepare",
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await flush();
    clock = 10;
    resolveTask(true);
    await expect(exact.settlement).resolves.toEqual({ outcome: "timed-out" });

    const failed = startEnhancedTimingPreparation({
      operation: 4,
      kind: "probe",
      task: async () => { throw new Error("private model URL"); },
      now: () => 1,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await expect(failed.settlement).resolves.toEqual({ outcome: "failed" });
    expect(JSON.stringify(await failed.settlement)).not.toContain("private");
  });

  it("cancels once and leaves a successor owner distinct", async () => {
    let resolveTask!: (value: number) => void;
    const first = startEnhancedTimingPreparation({
      operation: 5,
      kind: "prepare",
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      now: () => 1,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await flush();
    expect(first.cancel()).toBe(true);
    expect(first.cancel()).toBe(false);
    const second = startEnhancedTimingPreparation({
      operation: 6,
      kind: "prepare",
      task: async () => 2,
      now: () => 2,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    resolveTask(1);
    await expect(first.settlement).resolves.toEqual({ outcome: "cancelled" });
    await expect(second.settlement).resolves.toEqual({ outcome: "completed", value: 2 });
    expect(ownsEnhancedTimingPreparation(second.owner, first.owner)).toBe(false);
  });

  it("aborts task-owned I/O before cancelled settlement and exposes bounded drain", async () => {
    let observedAbort = false;
    let release!: () => void;
    const run = startEnhancedTimingPreparation({
      operation: 7,
      kind: "probe",
      task: (signal) => new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true });
      }),
      now: () => 1,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    await flush();
    expect(run.cancel()).toBe(true);
    expect(observedAbort).toBe(true);
    await expect(run.settlement).resolves.toEqual({ outcome: "cancelled" });
    await expect(run.drained).resolves.toBeUndefined();
    release();
  });

  it("bounds cancellation drain when an entered host operation never settles", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    const run = startEnhancedTimingPreparation({
      operation: 8,
      kind: "prepare",
      task: () => new Promise(() => undefined),
      now: () => clock,
      timeoutMilliseconds: 100,
      scheduleTimeout: (callback) => { wake = callback; return 1 as ReturnType<typeof setTimeout>; },
      clearScheduledTimeout: vi.fn()
    });
    await flush();
    run.cancel();
    const drain = run.waitForDrain(10);
    clock = 10;
    wake();
    await expect(drain).resolves.toEqual({ outcome: "timed-out" });
  });

  it("makes an exact preparation proof commit terminal before Promise delivery", async () => {
    let clock = 1;
    let claim!: () => boolean;
    const run = startEnhancedTimingPreparation({
      operation: 9,
      kind: "prepare",
      task: async () => {
        expect(claim()).toBe(true);
        clock = 100;
        return "verified";
      },
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    claim = run.claimCommit;
    await flush();
    expect(run.cancel()).toBe(false);
    await expect(run.settlement).resolves.toEqual({ outcome: "completed", value: "verified" });
    expect(run.snapshot().commitClaimed).toBe(true);
  });
});
