import { describe, expect, it, vi } from "vitest";
import {
  startTransitionRehearsalRuntime,
  transitionRehearsalBlocksPlayback,
  transitionRehearsalSettlementOpensCircuit
} from "./transitionRehearsalRuntime";

describe("transition rehearsal runtime", () => {
  it("locks playback for every exact rehearsal owner and only circuits on timeout", () => {
    const clear = { preparationOwned: false, renderOwned: false, previewOwned: false, circuitOpen: false };
    expect(transitionRehearsalBlocksPlayback(clear)).toBe(false);
    for (const key of Object.keys(clear)) {
      expect(transitionRehearsalBlocksPlayback({ ...clear, [key]: true })).toBe(true);
    }
    expect(transitionRehearsalSettlementOpensCircuit("timed-out")).toBe(true);
    expect(transitionRehearsalSettlementOpensCircuit("completed")).toBe(false);
    expect(transitionRehearsalSettlementOpensCircuit("cancelled")).toBe(false);
    expect(transitionRehearsalSettlementOpensCircuit("failed")).toBe(false);
  });

  it("completes only before the exact monotonic deadline", async () => {
    let now = 0;
    let resolveTask!: (value: string) => void;
    const runtime = startTransitionRehearsalRuntime({
      operation: 1,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    now = 29;
    resolveTask("preview");
    await expect(runtime.settlement).resolves.toEqual({ outcome: "completed", value: "preview" });
  });

  it("times out a cancelled render that never settles and ignores its late value", async () => {
    let now = 0;
    let wake!: () => void;
    let resolveTask!: (value: string) => void;
    const runtime = startTransitionRehearsalRuntime({
      operation: 2,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    await Promise.resolve();
    expect(runtime.requestCancel()).toBe(true);
    now = 30;
    wake();
    await expect(runtime.settlement).resolves.toEqual({ outcome: "timed-out" });
    resolveTask("late");
    await Promise.resolve();
    expect(runtime.snapshot()).toEqual({ settled: true, cancelRequested: true });
  });

  it("settles cancellation when the unabortable task returns before deadline", async () => {
    let resolveTask!: (value: string) => void;
    const runtime = startTransitionRehearsalRuntime({
      operation: 3,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      nowMilliseconds: () => 0,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    runtime.requestCancel();
    resolveTask("discarded");
    await expect(runtime.settlement).resolves.toEqual({ outcome: "cancelled" });
  });

  it("classifies settlement at or after a throttled deadline as timed out", async () => {
    let now = 0;
    let resolveTask!: (value: string) => void;
    const runtime = startTransitionRehearsalRuntime({
      operation: 4,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    now = 30;
    resolveTask("late-before-timer");
    await expect(runtime.settlement).resolves.toEqual({ outcome: "timed-out" });
  });

  it("revokes exact authority and prevents task continuation", async () => {
    let control = null as null | { mayContinue: () => boolean };
    const runtime = startTransitionRehearsalRuntime({
      operation: 5,
      task: async (current) => {
        control = current;
        await new Promise(() => undefined);
        return "never";
      },
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await vi.waitFor(() => expect(control).not.toBeNull());
    expect(runtime.revoke()).toBe(true);
    expect(control?.mayContinue()).toBe(false);
    await expect(runtime.settlement).resolves.toEqual({ outcome: "cancelled" });
  });

  it("prevents a timed-out render from reaching a later resume/start phase", async () => {
    let now = 0;
    let wake!: () => void;
    let releaseRender!: () => void;
    const resumed = vi.fn();
    const runtime = startTransitionRehearsalRuntime({
      operation: 6,
      task: async (control) => {
        await new Promise<void>((resolve) => { releaseRender = resolve; });
        if (control.mayContinue()) resumed();
        return "late";
      },
      timeoutMilliseconds: 30,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    await Promise.resolve();
    now = 30;
    wake();
    await expect(runtime.settlement).resolves.toEqual({ outcome: "timed-out" });
    releaseRender();
    await Promise.resolve();
    expect(resumed).not.toHaveBeenCalled();
  });
});
