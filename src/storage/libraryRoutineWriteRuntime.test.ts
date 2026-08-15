import { describe, expect, it, vi } from "vitest";
import {
  createLibraryRoutinePatchBatch,
  createLibraryRoutineMembershipBatch,
  createLibraryRoutineSnapshotBatch,
  hasUnpersistedLibraryRoutineGeneration,
  libraryRoutineEnqueueOwnsPersistence,
  libraryRoutineSaveStatusAfterSettlement,
  shouldEnqueueLibraryRoutineSnapshot,
  mergeLibraryRoutineWriteBatches,
  retryRejectedLibraryRoutineSnapshot,
  shouldQueueLibraryRoutineSnapshot
} from "./libraryRoutineWriteBatch";
import { createLibraryRoutineWriteRuntime } from "./libraryRoutineWriteRuntime";

describe("library routine write batches", () => {
  it("keeps only the newest snapshot and merges manual fields per exact track", () => {
    const first = createLibraryRoutineSnapshotBatch([{ id: "old" }]);
    const withPatch = mergeLibraryRoutineWriteBatches(first, createLibraryRoutinePatchBatch(
      "track", "file-content-sha256/v1:a", { analysisOverrides: { shift: 1 } }
    ));
    const updatedPatch = mergeLibraryRoutineWriteBatches(withPatch, createLibraryRoutinePatchBatch(
      "track", "file-content-sha256/v1:a", { timingReview: { answer: "yes" } }
    ));
    const finalBatch = mergeLibraryRoutineWriteBatches(
      updatedPatch,
      createLibraryRoutineSnapshotBatch([{ id: "new" }])
    );
    expect(finalBatch.tracks).toEqual([{ id: "new" }]);
    expect(finalBatch.patches).toEqual([{
      trackId: "track",
      contentIdentity: "file-content-sha256/v1:a",
      patch: {
        analysisOverrides: { shift: 1 },
        timingReview: { answer: "yes" }
      }
    }]);
    expect(finalBatch.routineGeneration).toBe(0);
  });

  it("does not rewrite a freshly hydrated or membership-committed snapshot", () => {
    const hydrated = [{ id: "stored" }];
    expect(shouldQueueLibraryRoutineSnapshot({
      library: hydrated,
      skipSnapshot: hydrated,
      circuitOpen: false
    })).toBe(false);
    expect(shouldQueueLibraryRoutineSnapshot({
      library: [...hydrated],
      skipSnapshot: hydrated,
      circuitOpen: false
    })).toBe(true);
    expect(shouldQueueLibraryRoutineSnapshot({
      library: [...hydrated],
      skipSnapshot: null,
      circuitOpen: true
    })).toBe(false);
  });

  it("does not carry pending manual fields into same-id replacement content", () => {
    const predecessor = createLibraryRoutinePatchBatch("track", "identity-a", { timingReview: "old" });
    const successor = createLibraryRoutinePatchBatch("track", "identity-b", { analysisOverrides: "new" });
    expect(mergeLibraryRoutineWriteBatches(predecessor, successor).patches).toEqual([{
      trackId: "track",
      contentIdentity: "identity-b",
      patch: { analysisOverrides: "new" }
    }]);
  });

  it("rebases pending patches onto exact surviving membership only", () => {
    const first = mergeLibraryRoutineWriteBatches(
      createLibraryRoutinePatchBatch("removed", "old", { timingReview: "remove-me" }),
      createLibraryRoutinePatchBatch("kept", "same", { timingReview: "keep-me" })
    );
    const boundary = createLibraryRoutineMembershipBatch([
      { id: "kept", contentIdentity: "same" },
      { id: "replacement", contentIdentity: "new" }
    ]);
    expect(mergeLibraryRoutineWriteBatches(first, boundary)).toEqual({
      tracks: boundary.tracks,
      patches: [{ trackId: "kept", contentIdentity: "same", patch: { timingReview: "keep-me" } }],
      membershipBoundary: true,
      routineGeneration: 0
    });
  });

  it("retries rejected automatic snapshots but not rejected manual commands", () => {
    const snapshot = createLibraryRoutineSnapshotBatch([{ id: "track" }]);
    const patch = createLibraryRoutinePatchBatch("track", "identity", { timingReview: "yes" });
    expect(retryRejectedLibraryRoutineSnapshot(snapshot)).toEqual(snapshot);
    expect(retryRejectedLibraryRoutineSnapshot(patch)).toBeNull();
    expect(retryRejectedLibraryRoutineSnapshot(mergeLibraryRoutineWriteBatches(snapshot, patch))).toEqual({
      tracks: snapshot.tracks,
      patches: [],
      membershipBoundary: false,
      routineGeneration: 0
    });
  });

  it("keeps synchronous routine dirtiness authoritative across a skipped React snapshot", () => {
    const localAnalysis = createLibraryRoutineSnapshotBatch([{ id: "kept", analysis: "new" }], 4);
    const remoteMembership = createLibraryRoutineMembershipBatch([{ id: "kept", analysis: "new" }], 4);
    expect(hasUnpersistedLibraryRoutineGeneration({ dirtyGeneration: 4, savedGeneration: 3 })).toBe(true);
    expect(mergeLibraryRoutineWriteBatches(localAnalysis, remoteMembership)).toMatchObject({
      tracks: [{ id: "kept", analysis: "new" }],
      membershipBoundary: true,
      routineGeneration: 4
    });
    expect(hasUnpersistedLibraryRoutineGeneration({ dirtyGeneration: 4, savedGeneration: 4 })).toBe(false);
  });

  it("keeps status truthful while a newer generation is pending and rejects circuit ownership", () => {
    expect(libraryRoutineSaveStatusAfterSettlement({
      pending: true,
      dirtyGeneration: 2,
      savedGeneration: 1
    })).toBe("saving");
    expect(libraryRoutineSaveStatusAfterSettlement({
      pending: false,
      dirtyGeneration: 2,
      savedGeneration: 2
    })).toBe("saved");
    expect(libraryRoutineEnqueueOwnsPersistence("started")).toBe(true);
    expect(libraryRoutineEnqueueOwnsPersistence("coalesced")).toBe(true);
    expect(libraryRoutineEnqueueOwnsPersistence("circuit-open")).toBe(false);
    expect(libraryRoutineEnqueueOwnsPersistence("paused")).toBe(false);
  });

  it("rebases remote membership while same-generation routine work is still owned", () => {
    expect(shouldEnqueueLibraryRoutineSnapshot({
      membershipChanged: true,
      active: true,
      pending: false,
      dirtyGeneration: 4,
      savedGeneration: 4
    })).toBe(true);
    expect(shouldEnqueueLibraryRoutineSnapshot({
      membershipChanged: true,
      active: false,
      pending: true,
      dirtyGeneration: 4,
      savedGeneration: 4
    })).toBe(true);
    expect(shouldEnqueueLibraryRoutineSnapshot({
      membershipChanged: true,
      active: false,
      pending: false,
      dirtyGeneration: 4,
      savedGeneration: 4
    })).toBe(false);
  });
});

describe("library routine write runtime", () => {
  it("keeps one active write and one merged pending batch", async () => {
    let resolveFirst!: (value: string) => void;
    const calls: number[][] = [];
    const runtime = createLibraryRoutineWriteRuntime<number[], string>({
      write: (value) => {
        calls.push(value);
        return calls.length === 1
          ? new Promise((resolve) => { resolveFirst = resolve; })
          : Promise.resolve("saved");
      },
      mergePending: (current, incoming) => [...current, ...incoming],
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue([0]);
    let pendingSettlement: Promise<unknown> | null = null;
    for (let index = 1; index <= 1_000; index += 1) {
      const queued = runtime.enqueue([index]);
      pendingSettlement ??= queued.settlement;
      expect(queued.settlement).toBe(pendingSettlement);
    }
    await Promise.resolve();
    expect(calls).toEqual([[0]]);
    expect(runtime.snapshot()).toMatchObject({ active: true, pending: true });
    resolveFirst("saved");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toHaveLength(1_000);
    await expect(pendingSettlement).resolves.toMatchObject({ outcome: "completed" });
  });

  it("times out at the exact monotonic deadline, aborts, and drops pending work", async () => {
    let now = 0;
    let wake!: () => void;
    let signal!: AbortSignal;
    let resolveLate!: (value: string) => void;
    const resolved = vi.fn();
    const timedOut = vi.fn();
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: (_value, currentSignal) => {
        signal = currentSignal;
        return new Promise((resolve) => { resolveLate = resolve; });
      },
      mergePending: (_current, incoming) => incoming,
      onResolved: resolved,
      onTimedOut: timedOut,
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    const active = runtime.enqueue("active");
    const pending = runtime.enqueue("pending");
    await Promise.resolve();
    now = 30;
    wake();
    await expect(active.settlement).resolves.toMatchObject({ outcome: "timed-out" });
    await expect(pending.settlement).resolves.toMatchObject({ outcome: "cancelled" });
    expect(signal.aborted).toBe(true);
    expect(timedOut).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toMatchObject({ mode: "circuit-open", active: false, pending: false });
    resolveLate("late");
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
  });

  it("classifies a delayed timer settlement at the deadline as timed out", async () => {
    let now = 0;
    let resolveTask!: (value: string) => void;
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: () => new Promise((resolve) => { resolveTask = resolve; }),
      mergePending: (_current, incoming) => incoming,
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    const run = runtime.enqueue("active");
    await Promise.resolve();
    now = 31;
    resolveTask("late-before-timer");
    await expect(run.settlement).resolves.toMatchObject({ outcome: "timed-out" });
  });

  it("waits for an active write before granting one exclusive membership mutation", async () => {
    let resolveTask!: (value: string) => void;
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: () => new Promise((resolve) => { resolveTask = resolve; }),
      mergePending: (_current, incoming) => incoming,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue("active");
    await Promise.resolve();
    const first = runtime.prepareExclusive();
    await expect(runtime.prepareExclusive()).resolves.toBe(false);
    resolveTask("saved");
    await expect(first).resolves.toBe(true);
    expect(runtime.snapshot().mode).toBe("exclusive");
    expect(runtime.enqueue("deferred").status).toBe("coalesced");
    expect(runtime.completeExclusive()).toBe(true);
    expect(runtime.snapshot().mode).toBe("running");
    expect(runtime.snapshot().active).toBe(true);
  });

  it("retains and rebases the latest pending batch across exclusive membership work", async () => {
    let resolveFirst!: (value: string) => void;
    const calls: string[] = [];
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: (value) => {
        calls.push(value);
        return calls.length === 1
          ? new Promise((resolve) => { resolveFirst = resolve; })
          : Promise.resolve("saved");
      },
      mergePending: (_current, incoming) => incoming,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue("active");
    runtime.enqueue("pre-membership-pending");
    await Promise.resolve();
    const exclusive = runtime.prepareExclusive();
    resolveFirst("saved");
    await expect(exclusive).resolves.toBe(true);
    runtime.enqueue("exact-post-membership");
    expect(runtime.completeExclusive()).toBe(true);
    await vi.waitFor(() => expect(calls).toEqual(["active", "exact-post-membership"]));
  });

  it("retries an on-time active failure that occurred while exclusive was waiting", async () => {
    const calls: string[] = [];
    let rejectFirst!: (error: Error) => void;
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: (value) => {
        calls.push(value);
        return calls.length === 1
          ? new Promise((_resolve, reject) => { rejectFirst = reject; })
          : Promise.resolve("saved");
      },
      mergePending: (_current, incoming) => incoming,
      retryRejectedWhileExclusive: (value) => value,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    runtime.enqueue("latest-analysis");
    await Promise.resolve();
    const exclusive = runtime.prepareExclusive();
    rejectFirst(new Error("on-time storage failure"));
    await expect(exclusive).resolves.toBe(true);
    expect(runtime.snapshot().pending).toBe(true);
    expect(runtime.completeExclusive()).toBe(true);
    await vi.waitFor(() => expect(calls).toEqual(["latest-analysis", "latest-analysis"]));
  });

  it("does not silently retry a rejected manual command across exclusive work", async () => {
    const calls: string[] = [];
    let rejectFirst!: (error: Error) => void;
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: (value) => {
        calls.push(value);
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      },
      mergePending: (_current, incoming) => incoming,
      retryRejectedWhileExclusive: () => null,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    const command = runtime.enqueue("manual-command");
    await Promise.resolve();
    const exclusive = runtime.prepareExclusive();
    rejectFirst(new Error("manual save failed"));
    await expect(command.settlement).resolves.toMatchObject({ outcome: "failed" });
    await expect(exclusive).resolves.toBe(true);
    expect(runtime.snapshot().pending).toBe(false);
    expect(runtime.completeExclusive()).toBe(true);
    expect(calls).toEqual(["manual-command"]);
  });

  it("allows membership work while preserving an analysis-only open circuit", async () => {
    let now = 0;
    let wake!: () => void;
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: () => new Promise(() => undefined),
      mergePending: (_current, incoming) => incoming,
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    runtime.enqueue("active");
    await Promise.resolve();
    now = 30;
    wake();
    await expect(runtime.prepareExclusive()).resolves.toBe(true);
    expect(runtime.completeExclusive()).toBe(true);
    expect(runtime.snapshot().mode).toBe("circuit-open");
  });

  it("continues with the latest batch after an ordinary on-time failure", async () => {
    const calls: string[] = [];
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: async (value) => {
        calls.push(value);
        if (value === "first") throw new Error("storage full");
        return "saved";
      },
      mergePending: (_current, incoming) => incoming,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    const first = runtime.enqueue("first");
    const latest = runtime.enqueue("latest");
    await expect(first.settlement).resolves.toMatchObject({ outcome: "failed" });
    await expect(latest.settlement).resolves.toMatchObject({ outcome: "completed" });
    expect(calls).toEqual(["first", "latest"]);
  });

  it("revokes active and pending batches before unmount settlement", async () => {
    let resolveTask!: (value: string) => void;
    const resolved = vi.fn();
    const runtime = createLibraryRoutineWriteRuntime<string, string>({
      write: () => new Promise((resolve) => { resolveTask = resolve; }),
      mergePending: (_current, incoming) => incoming,
      onResolved: resolved,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    const active = runtime.enqueue("active");
    const pending = runtime.enqueue("pending");
    await Promise.resolve();
    runtime.halt();
    await expect(active.settlement).resolves.toMatchObject({ outcome: "cancelled" });
    await expect(pending.settlement).resolves.toMatchObject({ outcome: "cancelled" });
    resolveTask("late");
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
  });
});
