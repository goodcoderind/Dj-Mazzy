import { describe, expect, it, vi } from "vitest";
import {
  backgroundAnalysisRowsAfterMutationRollback,
  createBackgroundAnalysisLease,
  createBackgroundAnalysisStageLease,
  decideBackgroundDecodeFailure,
  deriveBackgroundAnalysisNotice,
  isRetryableBackgroundAnalysisDeferral,
  isRetryableBackgroundAnalysisStage,
  ownsBackgroundAnalysisLease,
  ownsBackgroundAnalysisStageLease,
  readBlobForBackgroundAnalysis,
  shouldRetainBackgroundAnalysisDeferral,
  sortBackgroundAnalysisJobs,
  startBoundedBackgroundStage
} from "./backgroundAnalysisRuntime";

describe("background analysis runtime", () => {
  it("keeps all basic work ahead of optional enhanced work", () => {
    const jobs = [
      { id: "loaded", kind: "enhanced" as const },
      { id: "rest", kind: "basic-program" as const },
      { id: "queue", kind: "basic-program" as const }
    ];
    expect(sortBackgroundAnalysisJobs(jobs, ["loaded"], ["queue"]).map((job) => `${job.kind}:${job.id}`))
      .toEqual(["basic-program:queue", "basic-program:rest", "enhanced:loaded"]);
  });

  it("settles a never-ending stage once and ignores its late completion", async () => {
    let now = 0;
    let wake!: () => void;
    let finishTask!: (value: string) => void;
    const onTimeout = vi.fn();
    const run = startBoundedBackgroundStage({
      task: () => new Promise<string>((resolve) => { finishTask = resolve; }),
      timeoutMs: 10,
      deadlineMilliseconds: 10,
      nowMilliseconds: () => now,
      ownsAuthority: () => true,
      onTimeout,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: vi.fn()
    });
    now = 10;
    wake();
    await expect(run.settlement).resolves.toEqual({ outcome: "timed-out" });
    expect(onTimeout).toHaveBeenCalledOnce();
    finishTask("late");
    await Promise.resolve();
  });

  it("contains throwing timeout cleanup and an old timer cannot settle a successor", async () => {
    let now = 0;
    const wakes: Array<() => void> = [];
    const throwing = startBoundedBackgroundStage({
      task: () => new Promise<string>(() => undefined),
      timeoutMs: 10,
      deadlineMilliseconds: 10,
      nowMilliseconds: () => now,
      ownsAuthority: () => true,
      onTimeout: () => { throw new Error("cleanup failed"); },
      setTimer: (callback) => { wakes.push(callback); return wakes.length; },
      clearTimer: () => undefined
    });
    now = 10;
    wakes[0]();
    await expect(throwing.settlement).resolves.toEqual({ outcome: "timed-out" });
    await Promise.resolve();

    now = 0;
    const first = startBoundedBackgroundStage({
      task: async () => "first",
      timeoutMs: 10,
      deadlineMilliseconds: 10,
      nowMilliseconds: () => now,
      ownsAuthority: () => true,
      setTimer: (callback) => { wakes.push(callback); return wakes.length; },
      clearTimer: () => undefined
    });
    await expect(first.settlement).resolves.toEqual({ outcome: "completed", value: "first" });
    const second = startBoundedBackgroundStage({
      task: () => new Promise<string>(() => undefined),
      timeoutMs: 10,
      deadlineMilliseconds: 10,
      nowMilliseconds: () => now,
      ownsAuthority: () => true,
      setTimer: (callback) => { wakes.push(callback); return wakes.length; },
      clearTimer: () => undefined
    });
    wakes[1]();
    let secondSettled = false;
    void second.settlement.then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    now = 10;
    wakes[2]();
    await expect(second.settlement).resolves.toEqual({ outcome: "timed-out" });
  });

  it("uses the monotonic deadline when the timer wake is throttled", async () => {
    let now = 10;
    let resolveTask!: (value: string) => void;
    let rejectTask!: (error: Error) => void;
    const cleanup = vi.fn();
    const completed = startBoundedBackgroundStage({
      task: () => new Promise<string>((resolve) => { resolveTask = resolve; }),
      timeoutMs: 5,
      deadlineMilliseconds: 15,
      nowMilliseconds: () => now,
      ownsAuthority: () => true,
      onTimeout: cleanup,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    now = 14.999;
    resolveTask("inside");
    await expect(completed.settlement).resolves.toEqual({ outcome: "completed", value: "inside" });

    now = 20;
    const rejectedLate = startBoundedBackgroundStage({
      task: () => new Promise<string>((_resolve, reject) => { rejectTask = reject; }),
      timeoutMs: 5,
      deadlineMilliseconds: 25,
      nowMilliseconds: () => now,
      ownsAuthority: () => true,
      onTimeout: cleanup,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    now = 25;
    rejectTask(new Error("late worker error"));
    await expect(rejectedLate.settlement).resolves.toEqual({ outcome: "timed-out" });
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("drops a deferral once another exact path supplies its facts", () => {
    expect(shouldRetainBackgroundAnalysisDeferral({
      kind: "basic-program",
      rowPresent: true,
      basicProgramComplete: true,
      enhancedComplete: false
    })).toBe(false);
    expect(shouldRetainBackgroundAnalysisDeferral({
      kind: "enhanced",
      rowPresent: true,
      basicProgramComplete: true,
      enhancedComplete: false
    })).toBe(true);
    expect(isRetryableBackgroundAnalysisStage("basic-program")).toBe(true);
    expect(isRetryableBackgroundAnalysisStage("enhanced-inference")).toBe(true);
    expect(isRetryableBackgroundAnalysisStage("decode")).toBe(false);
    expect(isRetryableBackgroundAnalysisStage("enhanced-render")).toBe(false);
    expect(isRetryableBackgroundAnalysisStage("decode-runtime")).toBe(true);
  });

  it("requeues only surviving rows after a destructive mutation rolls back", () => {
    expect(backgroundAnalysisRowsAfterMutationRollback(
      [{ id: "restored" }, { id: "still-removed" }],
      new Set(["still-removed"])
    )).toEqual([{ id: "restored" }]);
  });

  it("derives notice and retry actions from current deferrals and lane circuits", () => {
    expect(deriveBackgroundAnalysisNotice({
      deferrals: [],
      decodeCircuitOpen: false,
      enhancedRenderCircuitOpen: false,
      retryUsed: false
    })).toBeNull();
    expect(deriveBackgroundAnalysisNotice({
      deferrals: [{ kind: "basic-program", stage: "basic-program" }],
      decodeCircuitOpen: false,
      enhancedRenderCircuitOpen: true,
      retryUsed: false
    })).toMatchObject({ type: "circuit-open", retryable: true });
    expect(deriveBackgroundAnalysisNotice({
      deferrals: [{ kind: "basic-program", stage: "basic-program" }],
      decodeCircuitOpen: true,
      enhancedRenderCircuitOpen: false,
      retryUsed: false
    })).toMatchObject({ type: "circuit-open", retryable: false });
    expect(deriveBackgroundAnalysisNotice({
      deferrals: [{ kind: "enhanced", stage: "enhanced-inference" }],
      decodeCircuitOpen: false,
      enhancedRenderCircuitOpen: true,
      retryUsed: false
    })).toMatchObject({ type: "circuit-open", retryable: false });
    expect(isRetryableBackgroundAnalysisDeferral({
      deferral: { kind: "basic-program", stage: "basic-program" },
      decodeCircuitOpen: false,
      enhancedRenderCircuitOpen: true
    })).toBe(true);
    expect(isRetryableBackgroundAnalysisDeferral({
      deferral: { kind: "enhanced", stage: "enhanced-inference" },
      decodeCircuitOpen: false,
      enhancedRenderCircuitOpen: true
    })).toBe(false);
  });

  it("distinguishes a resettable decode-runtime acquisition failure from a hung decode", () => {
    expect(decideBackgroundDecodeFailure({ outcome: "failed", runtimeUnavailable: true }))
      .toEqual({ deferStage: "decode-runtime", unabortable: false });
    expect(decideBackgroundDecodeFailure({ outcome: "timed-out", runtimeUnavailable: false }))
      .toEqual({ deferStage: "decode", unabortable: true });
    expect(decideBackgroundDecodeFailure({ outcome: "failed", runtimeUnavailable: false }))
      .toEqual({ deferStage: null, unabortable: false });
  });

  it("cancels on lost authority and compares every lease field", async () => {
    const fileToken = {};
    const lease = createBackgroundAnalysisLease({
      epoch: 1,
      operation: 2,
      trackId: "track",
      contentIdentity: null,
      fileToken,
      kind: "basic-program"
    });
    expect(ownsBackgroundAnalysisLease(lease, lease)).toBe(true);
    expect(ownsBackgroundAnalysisLease(lease, { ...lease!, operation: 3 })).toBe(false);
    expect(ownsBackgroundAnalysisLease(lease, { ...lease!, fileToken: {} })).toBe(false);
    const stageLease = createBackgroundAnalysisStageLease({
      job: lease!,
      stage: "decode",
      startedAtMilliseconds: 100,
      timeoutMilliseconds: 20
    });
    expect(stageLease?.deadlineMilliseconds).toBe(120);
    expect(ownsBackgroundAnalysisStageLease(stageLease, stageLease)).toBe(true);
    expect(ownsBackgroundAnalysisStageLease(stageLease, { ...stageLease!, stage: "read" })).toBe(false);
    const run = startBoundedBackgroundStage({
      task: async () => "done",
      timeoutMs: 10,
      ownsAuthority: () => false,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await expect(run.settlement).resolves.toEqual({ outcome: "cancelled" });
  });

  it("aborts an owned file read instead of leaving it behind the queue", async () => {
    const controller = new AbortController();
    const reader = {
      result: null,
      error: null,
      readyState: 1,
      onload: null,
      onerror: null,
      onabort: null,
      readAsArrayBuffer: vi.fn(),
      abort: vi.fn()
    } as unknown as FileReader;
    const read = readBlobForBackgroundAnalysis(new Blob(["x"]), controller.signal, () => reader);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.abort).toHaveBeenCalledOnce();
  });
});
