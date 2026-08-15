import { describe, expect, it, vi } from "vitest";
import {
  ownsLibraryHydration,
  startLibraryHydration,
  type LibraryHydrationOwner
} from "./libraryHydrationRuntime";

describe("library hydration runtime", () => {
  it("commits one exact on-time hydration", async () => {
    let current: LibraryHydrationOwner | null = null;
    const run = startLibraryHydration({
      epoch: 1,
      operation: 1,
      task: async () => "bundle",
      ownsAuthority: (owner) => ownsLibraryHydration(current, owner),
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    current = run.owner;
    await expect(run.settlement).resolves.toMatchObject({ outcome: "completed", value: "bundle" });
  });

  it("times out at the exact monotonic deadline, aborts, and ignores late success", async () => {
    let now = 0;
    let wake!: () => void;
    let signal!: AbortSignal;
    let resolveTask!: (value: string) => void;
    let current: LibraryHydrationOwner | null = null;
    const run = startLibraryHydration({
      epoch: 1,
      operation: 1,
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      task: (currentSignal) => {
        signal = currentSignal;
        return new Promise((resolve) => { resolveTask = resolve; });
      },
      ownsAuthority: (owner) => ownsLibraryHydration(current, owner),
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    current = run.owner;
    await Promise.resolve();
    now = 30;
    wake();
    await expect(run.settlement).resolves.toMatchObject({ outcome: "timed-out" });
    expect(signal.aborted).toBe(true);
    resolveTask("late");
    await Promise.resolve();
    await expect(run.settlement).resolves.toMatchObject({ outcome: "timed-out" });
  });

  it("keeps an ordinary on-time failure retryable", async () => {
    let current: LibraryHydrationOwner | null = null;
    const run = startLibraryHydration({
      epoch: 1,
      operation: 1,
      task: async () => { throw new Error("ordinary failure"); },
      ownsAuthority: (owner) => ownsLibraryHydration(current, owner),
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    current = run.owner;
    await expect(run.settlement).resolves.toMatchObject({ outcome: "failed" });
  });

  it("cancels an old operation when retry or unmount revokes its owner", async () => {
    let resolveTask!: (value: string) => void;
    let current: LibraryHydrationOwner | null = null;
    const run = startLibraryHydration({
      epoch: 1,
      operation: 1,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      ownsAuthority: (owner) => ownsLibraryHydration(current, owner),
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    current = run.owner;
    await Promise.resolve();
    current = null;
    expect(run.cancel()).toBe(true);
    resolveTask("late");
    await expect(run.settlement).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("rejects malformed clocks and owner counters", () => {
    expect(() => startLibraryHydration({ epoch: 0, operation: 1, task: async () => null })).toThrow();
    expect(() => startLibraryHydration({
      epoch: 1,
      operation: 1,
      task: async () => null,
      nowMilliseconds: () => Number.NaN
    })).toThrow();
  });
});
