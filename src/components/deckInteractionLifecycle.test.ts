import { describe, expect, it, vi } from "vitest";
import {
  commitDeckTransportStart,
  ownsDeferredDeckInteraction,
  runDeckLoadInvalidationBoundary
} from "./deckInteractionLifecycle";

describe("Deck host interaction lifecycle", () => {
  it("notifies the old load before replacement authority is revoked", () => {
    const order: string[] = [];
    runDeckLoadInvalidationBoundary({
      notify: () => order.push("notified-old-owner"),
      revoke: () => order.push("revoked")
    });
    expect(order).toEqual(["notified-old-owner", "revoked"]);

    const revokeAfterThrow = vi.fn();
    runDeckLoadInvalidationBoundary({
      notify: () => { throw new Error("detached host"); },
      revoke: revokeAfterThrow
    });
    expect(revokeAfterThrow).toHaveBeenCalledOnce();
  });

  it("publishes immediate and scheduled transport starts only after authority survives", () => {
    const notifyImmediate = vi.fn();
    const notifyScheduled = vi.fn();
    expect(commitDeckTransportStart({
      start: () => 10,
      ownsAuthority: () => true,
      rollback: vi.fn(),
      notify: notifyImmediate
    })).toBe(10);
    expect(notifyImmediate).toHaveBeenCalledOnce();

    const rollback = vi.fn();
    expect(commitDeckTransportStart({
      start: () => 12,
      ownsAuthority: () => false,
      rollback,
      notify: notifyScheduled
    })).toBeNull();
    expect(rollback).toHaveBeenCalledOnce();
    expect(notifyScheduled).not.toHaveBeenCalled();

    const callbackRollback = vi.fn();
    expect(commitDeckTransportStart({
      start: () => 14,
      ownsAuthority: () => true,
      rollback: callbackRollback,
      notify: () => { throw new Error("detached host"); }
    })).toBeNull();
    expect(callbackRollback).toHaveBeenCalledOnce();
  });

  it("refuses a transport start when a synchronous host lock is claimed across an await", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const mutableStartLock = { current: false };
    const start = vi.fn(() => 18);
    const notify = vi.fn();
    const attemptedStart = (async () => {
      await preparation;
      if (mutableStartLock.current) return null;
      return commitDeckTransportStart({
        start,
        ownsAuthority: () => !mutableStartLock.current,
        rollback: vi.fn(),
        notify
      });
    })();

    mutableStartLock.current = true;
    releasePreparation();

    await expect(attemptedStart).resolves.toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects deferred timing settlement after lock, load replacement, or track replacement", () => {
    const owned = {
      locked: false,
      expectedLoadGeneration: 3,
      currentLoadGeneration: 3,
      expectedTrackId: "track-a",
      currentTrackId: "track-a"
    };
    expect(ownsDeferredDeckInteraction(owned)).toBe(true);
    expect(ownsDeferredDeckInteraction({ ...owned, locked: true })).toBe(false);
    expect(ownsDeferredDeckInteraction({ ...owned, currentLoadGeneration: 4 })).toBe(false);
    expect(ownsDeferredDeckInteraction({ ...owned, currentTrackId: "track-b" })).toBe(false);
  });
});
