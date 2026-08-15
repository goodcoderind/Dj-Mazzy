import { describe, expect, it, vi } from "vitest";
import {
  PARTY_FIRST_SONG_START_VERSION,
  ownsPartyFirstSongStart,
  partyFirstSongStartMayContinue,
  partyFirstSongStartRequiresRecoveryCircuit,
  startPartyFirstSongStart
} from "./partyFirstSongStart";

describe("Party first-song start runtime", () => {
  it("completes one exact start strictly before its monotonic deadline", async () => {
    let now = 0;
    let resolveTask!: (value: boolean) => void;
    const runtime = startPartyFirstSongStart({
      operation: 1,
      deck: "a",
      trackId: "track-a",
      loadAuthorityKey: "load-a",
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      timeoutMilliseconds: 10,
      nowMilliseconds: () => now,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    expect(runtime.owner).toMatchObject({
      version: PARTY_FIRST_SONG_START_VERSION,
      deck: "a",
      trackId: "track-a",
      loadAuthorityKey: "load-a"
    });
    expect(ownsPartyFirstSongStart(runtime.owner, runtime.owner)).toBe(true);
    now = 9;
    resolveTask(true);
    await expect(runtime.settlement).resolves.toEqual({ outcome: "completed", value: true });
  });

  it("times out a never-settling start at the original deadline", async () => {
    let now = 0;
    let wake!: () => void;
    const runtime = startPartyFirstSongStart({
      operation: 2,
      deck: "b",
      trackId: "track-b",
      loadAuthorityKey: null,
      task: () => new Promise(() => undefined),
      timeoutMilliseconds: 10,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    now = 10;
    wake();
    await expect(runtime.settlement).resolves.toEqual({ outcome: "timed-out" });
  });

  it("classifies a throttled settlement at the deadline as timed out", async () => {
    let now = 0;
    let resolveTask!: (value: boolean) => void;
    const runtime = startPartyFirstSongStart({
      operation: 3,
      deck: "a",
      trackId: "track-a",
      loadAuthorityKey: null,
      task: () => new Promise((resolve) => { resolveTask = resolve; }),
      timeoutMilliseconds: 10,
      nowMilliseconds: () => now,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await Promise.resolve();
    now = 10;
    resolveTask(true);
    await expect(runtime.settlement).resolves.toEqual({ outcome: "timed-out" });
  });

  it("accepts an exact pre-deadline transport commit without later timeout reclassification", async () => {
    let now = 0;
    let wake!: () => void;
    let releaseTask!: () => void;
    const runtime = startPartyFirstSongStart({
      operation: 7,
      deck: "a",
      trackId: "track-a",
      loadAuthorityKey: "load-a",
      task: async (control) => {
        now = 9;
        expect(control.claimCommit()).toBe(true);
        await new Promise<void>((resolve) => { releaseTask = resolve; });
        return true;
      },
      timeoutMilliseconds: 10,
      nowMilliseconds: () => now,
      setTimer: (callback) => { wake = callback; return 1; },
      clearTimer: () => undefined
    });
    await vi.waitFor(() => expect(runtime.snapshot().commitClaimed).toBe(true));
    now = 10;
    wake();
    expect(runtime.revoke()).toBe(false);
    releaseTask();
    await expect(runtime.settlement).resolves.toEqual({ outcome: "completed", value: true });
  });

  it("rejects a transport commit at the exact deadline", async () => {
    let now = 0;
    const runtime = startPartyFirstSongStart({
      operation: 8,
      deck: "b",
      trackId: "track-b",
      loadAuthorityKey: null,
      task: async (control) => {
        now = 10;
        expect(control.claimCommit()).toBe(false);
        return false;
      },
      timeoutMilliseconds: 10,
      nowMilliseconds: () => now,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await expect(runtime.settlement).resolves.toEqual({ outcome: "timed-out" });
  });

  it("revokes authority before a late native resume can continue", async () => {
    let control: null | { mayContinue: () => boolean } = null;
    let release!: () => void;
    const started = vi.fn();
    const runtime = startPartyFirstSongStart({
      operation: 4,
      deck: "a",
      trackId: "track-a",
      loadAuthorityKey: null,
      task: async (current) => {
        control = current;
        await new Promise<void>((resolve) => { release = resolve; });
        if (current.mayContinue()) started();
        return true;
      },
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    await vi.waitFor(() => expect(control).not.toBeNull());
    expect(runtime.revoke()).toBe(true);
    expect((control as unknown as { mayContinue: () => boolean }).mayContinue()).toBe(false);
    release();
    await expect(runtime.settlement).resolves.toEqual({ outcome: "cancelled" });
    await Promise.resolve();
    expect(started).not.toHaveBeenCalled();
  });

  it("coalesces duplicate ownership at the caller boundary", async () => {
    let owner = null as ReturnType<typeof startPartyFirstSongStart<boolean>>["owner"] | null;
    const nativeStart = vi.fn(async () => true);
    const begin = () => {
      if (owner) return null;
      const runtime = startPartyFirstSongStart({
        operation: 5,
        deck: "a",
        trackId: "track-a",
        loadAuthorityKey: null,
        task: nativeStart,
        setTimer: () => 1,
        clearTimer: () => undefined
      });
      owner = runtime.owner;
      return runtime;
    };
    const first = begin();
    expect(begin()).toBeNull();
    await expect(first?.settlement).resolves.toEqual({ outcome: "completed", value: true });
    expect(nativeStart).toHaveBeenCalledOnce();
  });

  it("rejects deadline, lock, load replacement, and successor-owner ABA", () => {
    const runtime = startPartyFirstSongStart({
      operation: 9,
      deck: "b",
      trackId: "track-b",
      loadAuthorityKey: "load-b",
      task: async () => true,
      timeoutMilliseconds: 10,
      nowMilliseconds: () => 20,
      setTimer: () => 1,
      clearTimer: () => undefined
    });
    const base = {
      current: runtime.owner,
      expected: runtime.owner,
      startAuthorityKey: runtime.owner.startAuthorityKey,
      nowMilliseconds: 29,
      blocked: false,
      trackId: "track-b",
      loadAuthorityKey: "load-b"
    };
    expect(partyFirstSongStartMayContinue(base)).toBe(true);
    expect(partyFirstSongStartMayContinue({ ...base, nowMilliseconds: 30 })).toBe(false);
    expect(partyFirstSongStartMayContinue({ ...base, blocked: true })).toBe(false);
    expect(partyFirstSongStartMayContinue({ ...base, trackId: "replacement" })).toBe(false);
    expect(partyFirstSongStartMayContinue({ ...base, loadAuthorityKey: "replacement-load" })).toBe(false);
    expect(partyFirstSongStartMayContinue({ ...base, current: null })).toBe(false);
    expect(partyFirstSongStartMayContinue({ ...base, startAuthorityKey: "successor" })).toBe(false);
    runtime.revoke();
  });

  it("requires a recovery circuit for every claimed but unaccepted commit", () => {
    expect(partyFirstSongStartRequiresRecoveryCircuit({ commitClaimed: true, accepted: false })).toBe(true);
    expect(partyFirstSongStartRequiresRecoveryCircuit({ commitClaimed: true, accepted: true })).toBe(false);
    expect(partyFirstSongStartRequiresRecoveryCircuit({ commitClaimed: false, accepted: false })).toBe(false);
  });
});
