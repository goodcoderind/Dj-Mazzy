import { describe, expect, it, vi } from "vitest";
import {
  createLibraryImportPickerOwner,
  createLibraryMembershipMutationOwner,
  libraryMembershipRevocationDisposition,
  mayCancelLibraryMembershipPreparation,
  mayClaimPreparedImportCommit,
  mayContinueLibraryMembershipAfterExclusive,
  membershipFailureHasDefiniteRollback,
  ownsLibraryImportPicker,
  ownsLibraryMembershipMutation,
  retryExactDeckMembershipCleanup,
  startBoundedLibraryMembershipStage,
  verifyDeckMembershipCleanup
} from "./libraryMembershipMutationRuntime";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const owner = () => createLibraryMembershipMutationOwner({
  epoch: 1,
  operation: 2,
  kind: "import",
  expectedLibraryEpoch: 3,
  expectedLibraryRevision: 4
});

describe("library membership mutation runtime", () => {
  it("keeps picker-return focus bound to one exact file-picker operation", () => {
    const first = createLibraryImportPickerOwner(1);
    const second = createLibraryImportPickerOwner(2);
    expect(ownsLibraryImportPicker(first, first)).toBe(true);
    expect(ownsLibraryImportPicker(first, second)).toBe(false);
    expect(ownsLibraryImportPicker(null, first)).toBe(false);
  });

  it("uses an exact immutable operation owner", () => {
    const value = owner();
    expect(ownsLibraryMembershipMutation(value, value)).toBe(true);
    expect(ownsLibraryMembershipMutation(value, { ...value, operation: 3 })).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("keeps preparation cancellation independent from unrelated global storage modes", () => {
    expect(mayCancelLibraryMembershipPreparation("preparing")).toBe(true);
    expect(mayCancelLibraryMembershipPreparation("waiting-exclusive")).toBe(false);
    expect(libraryMembershipRevocationDisposition("preparing")).toBe("cancelled");
    expect(libraryMembershipRevocationDisposition("waiting-exclusive")).toBe("cancelled");
    expect(libraryMembershipRevocationDisposition("committing")).toBe("uncertain");
  });

  it("rechecks exact owner and library state after exclusive admission", () => {
    expect(mayContinueLibraryMembershipAfterExclusive({
      ownerCurrent: true,
      expectedLibraryEpoch: 2,
      expectedLibraryRevision: 3,
      currentLibraryEpoch: 2,
      currentLibraryRevision: 3
    })).toBe(true);
    expect(mayContinueLibraryMembershipAfterExclusive({
      ownerCurrent: false,
      expectedLibraryEpoch: 2,
      expectedLibraryRevision: 3,
      currentLibraryEpoch: 2,
      currentLibraryRevision: 3
    })).toBe(false);
    expect(mayContinueLibraryMembershipAfterExclusive({
      ownerCurrent: true,
      expectedLibraryEpoch: 2,
      expectedLibraryRevision: 3,
      currentLibraryEpoch: 2,
      currentLibraryRevision: 4
    })).toBe(false);
  });

  it("never downgrades an active or failed reconciliation into import commit", () => {
    const baseline = {
      phase: "preparing" as const,
      globalMutationMode: "idle",
      reconciliationMode: "running",
      reconciliationActive: false,
      reconciliationPending: false,
      checkpointBusy: false,
      checkpointClaimOwned: false,
      checkpointClearOwned: false
    };
    expect(mayClaimPreparedImportCommit(baseline)).toBe(true);
    expect(mayClaimPreparedImportCommit({
      ...baseline,
      globalMutationMode: "reconciling",
      reconciliationActive: true
    })).toBe(false);
    expect(mayClaimPreparedImportCommit({
      ...baseline,
      globalMutationMode: "reconcile-circuit",
      reconciliationMode: "circuit-open"
    })).toBe(false);
    expect(mayClaimPreparedImportCommit({ ...baseline, reconciliationPending: true })).toBe(false);
    expect(mayClaimPreparedImportCommit({ ...baseline, checkpointBusy: true })).toBe(false);
    expect(mayClaimPreparedImportCommit({ ...baseline, checkpointClaimOwned: true })).toBe(false);
    expect(mayClaimPreparedImportCommit({ ...baseline, checkpointClearOwned: true })).toBe(false);
  });

  it("distinguishes definite transaction rollback from uncertain failures", () => {
    expect(membershipFailureHasDefiniteRollback({
      version: "library-membership-mutation-failure/v1",
      rollbackVerified: true
    })).toBe(true);
    expect(membershipFailureHasDefiniteRollback(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(membershipFailureHasDefiniteRollback(new Error("unknown adapter failure"))).toBe(false);
    expect(membershipFailureHasDefiniteRollback({
      version: "library-membership-mutation-failure/v1",
      rollbackVerified: false
    })).toBe(false);
  });

  it("verifies exact Deck cleanup and fails closed on either Deck adapter failure", () => {
    let trackA: string | null = "removed";
    let playingA = true;
    const deckA = {
      getTrackId: () => trackA,
      isPlaying: () => playingA,
      eject: () => { trackA = null; playingA = false; }
    };
    expect(verifyDeckMembershipCleanup(deckA, "removed")).toEqual({ affected: true, confirmed: true });
    expect(verifyDeckMembershipCleanup({
      getTrackId: () => "removed",
      isPlaying: () => true,
      eject: () => { throw new Error("Deck B cleanup failed"); }
    }, "removed")).toEqual({ affected: true, confirmed: false });
    expect(verifyDeckMembershipCleanup(deckA, "other")).toEqual({ affected: false, confirmed: true });
  });

  it("retries only an exact removed Deck buffer and preserves a successor", () => {
    let current: string | null = "removed";
    let playing = false;
    const deck = {
      getTrackId: () => current,
      isPlaying: () => playing,
      eject: () => { current = null; playing = false; }
    };
    expect(retryExactDeckMembershipCleanup(deck, { trackId: "removed", exact: true }))
      .toEqual({ confirmed: true, clearLoadedIdentity: true });
    current = "successor";
    expect(retryExactDeckMembershipCleanup(deck, { trackId: "removed", exact: true }))
      .toEqual({ confirmed: true, clearLoadedIdentity: false });
    expect(current).toBe("successor");
    expect(retryExactDeckMembershipCleanup(deck, { trackId: null, exact: false }))
      .toEqual({ confirmed: false, clearLoadedIdentity: false });
  });

  it("aborts and times out at the absolute deadline even when the timer is throttled", async () => {
    let now = 10;
    let wake: (() => void) | null = null;
    let signal: AbortSignal | null = null;
    const task = deferred<string>();
    const current = owner();
    const run = startBoundedLibraryMembershipStage({
      mutation: current,
      stage: "committing",
      stageOperation: 1,
      task: (nextSignal) => { signal = nextSignal; return task.promise; },
      timeoutMilliseconds: 20,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: vi.fn()
    });
    await Promise.resolve();
    now = 30;
    task.resolve("late");
    expect((await run.settlement).outcome).toBe("timed-out");
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    (wake as (() => void) | null)?.();
  });

  it("times out a never-settling task when a throttled wake arrives at the original deadline", async () => {
    let now = 0;
    let wake: (() => void) | null = null;
    let signal: AbortSignal | null = null;
    const run = startBoundedLibraryMembershipStage({
      mutation: owner(),
      stage: "committing",
      stageOperation: 1,
      task: (nextSignal) => {
        signal = nextSignal;
        return new Promise<string>(() => undefined);
      },
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: vi.fn()
    });
    await Promise.resolve();
    now = 30;
    (wake as (() => void) | null)?.();
    expect((await run.settlement).outcome).toBe("timed-out");
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("cancels lost authority and leaves a late result inert", async () => {
    let owns = true;
    const task = deferred<string>();
    const run = startBoundedLibraryMembershipStage({
      mutation: owner(),
      stage: "reading",
      stageOperation: 1,
      task: () => task.promise,
      ownsAuthority: () => owns,
      setTimer: () => 1,
      clearTimer: vi.fn()
    });
    await Promise.resolve();
    owns = false;
    task.resolve("late");
    expect((await run.settlement).outcome).toBe("cancelled");
  });

  it("does not start a stage task after synchronous cancellation", async () => {
    const task = vi.fn(async () => "late");
    const run = startBoundedLibraryMembershipStage({
      mutation: owner(),
      stage: "reading",
      stageOperation: 1,
      task,
      setTimer: () => 1,
      clearTimer: vi.fn()
    });
    run.cancel();
    expect((await run.settlement).outcome).toBe("cancelled");
    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();
  });

  it("keeps a private rejection for exact rollback classification", async () => {
    const failure = new DOMException("full", "QuotaExceededError");
    const run = startBoundedLibraryMembershipStage({
      mutation: owner(),
      stage: "committing",
      stageOperation: 1,
      task: async () => { throw failure; },
      setTimer: () => 1,
      clearTimer: vi.fn()
    });
    const settlement = await run.settlement;
    expect(settlement).toMatchObject({ outcome: "failed", error: failure });
  });

  it("completes only strictly before the deadline", async () => {
    let now = 1;
    const run = startBoundedLibraryMembershipStage({
      mutation: owner(),
      stage: "estimating",
      stageOperation: 1,
      task: async () => "ok",
      timeoutMilliseconds: 10,
      nowMilliseconds: () => now,
      setTimer: () => 1,
      clearTimer: vi.fn()
    });
    await Promise.resolve();
    now = 10;
    expect(await run.settlement).toMatchObject({ outcome: "completed", value: "ok" });
  });
});
