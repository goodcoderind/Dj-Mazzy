import { describe, expect, it, vi } from "vitest";
import {
  commitDeckTransportStart,
  deckPlaybackStartIsLocked,
  ownsDeferredDeckInteraction,
  partySetupRevokesDeckTransport,
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

    const throwingAuthorityRollback = vi.fn();
    expect(commitDeckTransportStart({
      start: () => 16,
      ownsAuthority: () => { throw new Error("detached observer"); },
      rollback: throwingAuthorityRollback,
      notify: vi.fn()
    })).toBeNull();
    expect(throwingAuthorityRollback).toHaveBeenCalledOnce();

    expect(commitDeckTransportStart({
      start: () => 17,
      ownsAuthority: () => true,
      rollback: () => { throw new Error("audio cleanup failed"); },
      notify: () => { throw new Error("host publication failed"); }
    })).toBeNull();
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

  it("allows only the exact owned start while a first-song owner is active", () => {
    const base = {
      renderedLocked: false,
      mutableLocked: false,
      activeOwnerKey: "party-first-song-start/v1:7"
    };
    expect(deckPlaybackStartIsLocked({ ...base, requestOwnerKey: null })).toBe(true);
    expect(deckPlaybackStartIsLocked({ ...base, requestOwnerKey: "party-first-song-start/v1:6" })).toBe(true);
    expect(deckPlaybackStartIsLocked({ ...base, requestOwnerKey: "party-first-song-start/v1:7" })).toBe(false);
    expect(deckPlaybackStartIsLocked({ ...base, mutableLocked: true, requestOwnerKey: "party-first-song-start/v1:7" })).toBe(true);
  });

  it("keeps the rendered busy label separate from exact owned start authority", () => {
    const ownerKey = "party-first-song-start/v1:8";
    expect(deckPlaybackStartIsLocked({
      renderedLocked: false,
      mutableLocked: false,
      activeOwnerKey: ownerKey,
      requestOwnerKey: ownerKey
    })).toBe(false);
    expect(deckPlaybackStartIsLocked({
      renderedLocked: false,
      mutableLocked: false,
      activeOwnerKey: ownerKey,
      requestOwnerKey: null
    })).toBe(true);
    expect(partySetupRevokesDeckTransport({ partySetupLocked: true, activeStartOwnerKey: ownerKey })).toBe(false);
    expect(partySetupRevokesDeckTransport({ partySetupLocked: true, activeStartOwnerKey: null })).toBe(true);
  });
});
