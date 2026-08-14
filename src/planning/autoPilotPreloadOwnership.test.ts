import { describe, expect, it } from "vitest";
import {
  AUTO_PILOT_PRELOAD_PAUSE_VERSION,
  autoPilotPreloadLoadAuthorityKey,
  decideAutoPilotPreloadPause,
  ownsAutoPilotPreloadLease,
  maySettleAutoPilotPreloadLease,
  runAutoPilotPreloadPauseCleanup,
  shouldCommitAutoPilotPreload,
  shouldDiscardSettledAutoPilotPreload,
  type AutoPilotPreloadSettlement
} from "./autoPilotPreloadOwnership";

const validSettlement = (overrides: Partial<AutoPilotPreloadSettlement> = {}): AutoPilotPreloadSettlement => ({
  loaded: true,
  autoPilotEnabled: true,
  operationCurrent: true,
  stillEligible: true,
  requestedTrackId: "next",
  targetTrackId: "next",
  targetPlaying: false,
  ...overrides
});

describe("Autopilot preload ownership", () => {
  const lease = {
    operation: 3,
    generation: 5,
    deck: "b" as const,
    trackId: "next",
    loadOrdinal: 8,
    sourceTrackId: "source",
    sourceLoadKey: "1:1"
  };

  it("requires every immutable lease identity field before a late settlement may mutate state", () => {
    expect(ownsAutoPilotPreloadLease(lease, lease)).toBe(true);
    for (const current of [
      null,
      { ...lease, operation: 4 },
      { ...lease, generation: 6 },
      { ...lease, deck: "a" as const },
      { ...lease, trackId: "replacement" },
      { ...lease, loadOrdinal: 9 },
      { ...lease, sourceTrackId: "replacement-source" },
      { ...lease, sourceLoadKey: "1:2" }
    ]) {
      expect(ownsAutoPilotPreloadLease(current, lease)).toBe(false);
    }
  });

  it("derives a stable deck-owned authority key from the exact lease", () => {
    expect(autoPilotPreloadLoadAuthorityKey(lease)).toBe("auto-pilot-preload:3:5:b:8");
    expect(() => autoPilotPreloadLoadAuthorityKey({ ...lease, operation: 0 })).toThrow(RangeError);
  });

  it("rejects a matching settlement at or after its audio-clock deadline", () => {
    const lease = {
      operation: 3, generation: 5, deck: "b" as const, trackId: "next", loadOrdinal: 8,
      sourceTrackId: "source", sourceLoadKey: "1:1",
      deadlineSeconds: 20
    };
    expect(maySettleAutoPilotPreloadLease(lease, lease, 19.999)).toBe(true);
    expect(maySettleAutoPilotPreloadLease(lease, lease, 20)).toBe(false);
    expect(maySettleAutoPilotPreloadLease(lease, lease, 20.001)).toBe(false);
    expect(maySettleAutoPilotPreloadLease({ ...lease, operation: 4 }, lease, 19)).toBe(false);
  });

  it("commits only the current eligible preload on the idle target deck", () => {
    expect(shouldCommitAutoPilotPreload(validSettlement())).toBe(true);
    for (const settlement of [
      validSettlement({ autoPilotEnabled: false }),
      validSettlement({ operationCurrent: false }),
      validSettlement({ stillEligible: false }),
      validSettlement({ targetTrackId: "host-track" }),
      validSettlement({ targetPlaying: true })
    ]) {
      expect(shouldCommitAutoPilotPreload(settlement)).toBe(false);
    }
  });

  it("discards an invalidated preload after pause even though its generation changed", () => {
    const pausedDuringDecode = validSettlement({
      autoPilotEnabled: false,
      operationCurrent: false
    });

    expect(shouldCommitAutoPilotPreload(pausedDuringDecode)).toBe(false);
    expect(shouldDiscardSettledAutoPilotPreload(pausedDuringDecode)).toBe(true);
  });

  it("never ejects a host replacement or a track that has started playing", () => {
    expect(shouldDiscardSettledAutoPilotPreload(validSettlement({
      operationCurrent: false,
      targetTrackId: "host-track"
    }))).toBe(false);
    expect(shouldDiscardSettledAutoPilotPreload(validSettlement({
      operationCurrent: false,
      targetPlaying: true
    }))).toBe(false);
  });

  it("claims an exact pending or loaded target for synchronous pause cleanup", () => {
    expect(decideAutoPilotPreloadPause({
      lease,
      pendingLoadOrdinal: 8,
      targetTrackId: null,
      targetLoadOrdinal: null,
      targetPlaying: false
    })).toEqual({
      version: AUTO_PILOT_PRELOAD_PAUSE_VERSION,
      kind: "supersede",
      cleanupTarget: true,
      observationConfirmed: true
    });
    expect(decideAutoPilotPreloadPause({
      lease,
      pendingLoadOrdinal: null,
      targetTrackId: "next",
      targetLoadOrdinal: 8,
      targetPlaying: false
    }).cleanupTarget).toBe(true);
  });

  it("supersedes ownership without touching a host replacement", () => {
    for (const observation of [
      { pendingLoadOrdinal: null, targetTrackId: "host", targetLoadOrdinal: 9, targetPlaying: false },
      { pendingLoadOrdinal: 8, targetTrackId: "next", targetLoadOrdinal: 9, targetPlaying: false }
    ]) {
      expect(decideAutoPilotPreloadPause({ lease, ...observation })).toEqual({
        version: AUTO_PILOT_PRELOAD_PAUSE_VERSION,
        kind: "supersede",
        cleanupTarget: false,
        observationConfirmed: true
      });
    }
  });

  it("stops an exact target even if it started, and fails closed on an ambiguous empty observation", () => {
    expect(decideAutoPilotPreloadPause({
      lease,
      pendingLoadOrdinal: 8,
      targetTrackId: "next",
      targetLoadOrdinal: 8,
      targetPlaying: true
    })).toMatchObject({ cleanupTarget: true, observationConfirmed: true });
    expect(decideAutoPilotPreloadPause({
      lease,
      pendingLoadOrdinal: null,
      targetTrackId: null,
      targetLoadOrdinal: null,
      targetPlaying: false
    })).toMatchObject({ cleanupTarget: false, observationConfirmed: false });
  });

  it("fails closed on malformed pause observations", () => {
    expect(() => decideAutoPilotPreloadPause({
      lease: { ...lease, operation: 0 },
      pendingLoadOrdinal: 8,
      targetTrackId: null,
      targetLoadOrdinal: null,
      targetPlaying: false
    })).toThrow(RangeError);
  });

  it("stops and ejects the exact target before confirming paused cleanup", () => {
    let observation: { targetTrackId: string | null; targetLoadOrdinal: number | null; targetPlaying: boolean } =
      { targetTrackId: "next", targetLoadOrdinal: 8, targetPlaying: true };
    let stops = 0;
    let ejects = 0;
    const result = runAutoPilotPreloadPauseCleanup({
      lease,
      pendingLoadOrdinal: 8,
      observe: () => observation,
      cancelLoadIfOwned: () => ({ owned: false, authorityRevoked: false }),
      stopAllSound: () => {
        stops += 1;
        observation = { ...observation, targetPlaying: false };
        return { cancelledLoad: false };
      },
      eject: () => {
        ejects += 1;
        observation = { targetTrackId: null, targetLoadOrdinal: 8, targetPlaying: false };
      }
    });

    expect(result).toEqual({ cleanupConfirmed: true, preservedReplacement: false });
    expect({ stops, ejects }).toEqual({ stops: 1, ejects: 1 });
  });

  it("preserves a same-track successor with a different load ordinal", () => {
    let touched = false;
    const result = runAutoPilotPreloadPauseCleanup({
      lease,
      pendingLoadOrdinal: 8,
      observe: () => ({ targetTrackId: "next", targetLoadOrdinal: 9, targetPlaying: false }),
      cancelLoadIfOwned: () => ({ owned: false, authorityRevoked: false }),
      stopAllSound: () => { touched = true; return { cancelledLoad: false }; },
      eject: () => { touched = true; }
    });

    expect(result).toEqual({ cleanupConfirmed: true, preservedReplacement: true });
    expect(touched).toBe(false);
  });

  it("never confirms adapter or observation failures", () => {
    for (const setup of [
      {
        observe: () => ({ targetTrackId: "next", targetLoadOrdinal: 8, targetPlaying: false }),
        stopAllSound: () => { throw new Error("stop failed"); },
        eject: () => undefined
      },
      {
        observe: () => { throw new Error("snapshot failed"); },
        stopAllSound: () => ({ cancelledLoad: false }),
        eject: () => undefined
      },
      {
        observe: (() => {
          let reads = 0;
          return () => {
            reads += 1;
            return { targetTrackId: "next", targetLoadOrdinal: 8, targetPlaying: reads === 1 };
          };
        })(),
        stopAllSound: () => ({ cancelledLoad: false }),
        eject: () => { throw new Error("eject failed"); }
      }
    ]) {
      expect(runAutoPilotPreloadPauseCleanup({
        lease,
        pendingLoadOrdinal: 8,
        cancelLoadIfOwned: () => ({ owned: false, authorityRevoked: false }),
        ...setup
      })).toEqual({
        cleanupConfirmed: false,
        preservedReplacement: false
      });
    }
  });

  it("requires an explicit load-generation cancellation proof for an unpublished pending target", () => {
    const empty = () => ({ targetTrackId: null, targetLoadOrdinal: null, targetPlaying: false });
    expect(runAutoPilotPreloadPauseCleanup({
      lease,
      pendingLoadOrdinal: 8,
      observe: empty,
      cancelLoadIfOwned: () => ({ owned: false, authorityRevoked: false }),
      stopAllSound: () => ({ cancelledLoad: false }),
      eject: () => undefined
    })).toEqual({ cleanupConfirmed: false, preservedReplacement: false });
    expect(runAutoPilotPreloadPauseCleanup({
      lease,
      pendingLoadOrdinal: 8,
      observe: empty,
      cancelLoadIfOwned: () => ({ owned: true, authorityRevoked: true }),
      stopAllSound: () => ({ cancelledLoad: false }),
      eject: () => undefined
    })).toEqual({ cleanupConfirmed: true, preservedReplacement: false });
  });

  it("uses deck-owned authority when the published ordinal still belongs to the predecessor", () => {
    let observation: { targetTrackId: string | null; targetLoadOrdinal: number | null; targetPlaying: boolean } =
      { targetTrackId: "next", targetLoadOrdinal: 7, targetPlaying: false };
    const result = runAutoPilotPreloadPauseCleanup({
      lease,
      pendingLoadOrdinal: 8,
      observe: () => observation,
      cancelLoadIfOwned: () => {
        observation = { targetTrackId: null, targetLoadOrdinal: 7, targetPlaying: false };
        return { owned: true, authorityRevoked: true };
      },
      stopAllSound: () => ({ cancelledLoad: false }),
      eject: () => undefined
    });
    expect(result).toEqual({ cleanupConfirmed: true, preservedReplacement: false });
  });

  it("never ejects a successor installed while the old target is stopping", () => {
    for (const successor of [
      { targetTrackId: "next", targetLoadOrdinal: 9, targetPlaying: false },
      { targetTrackId: "host", targetLoadOrdinal: 9, targetPlaying: false }
    ]) {
      let observation = { targetTrackId: "next", targetLoadOrdinal: 8, targetPlaying: false };
      let ejects = 0;
      const result = runAutoPilotPreloadPauseCleanup({
        lease,
        pendingLoadOrdinal: 8,
        observe: () => observation,
        cancelLoadIfOwned: () => ({ owned: false, authorityRevoked: false }),
        stopAllSound: () => {
          observation = successor;
          return { cancelledLoad: true };
        },
        eject: () => { ejects += 1; }
      });
      expect(result).toEqual({ cleanupConfirmed: true, preservedReplacement: true });
      expect(ejects).toBe(0);
    }
  });
});
