import { describe, expect, it } from "vitest";
import {
  ownsAutoPilotPreloadLease,
  maySettleAutoPilotPreloadLease,
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
  it("requires every immutable lease identity field before a late settlement may mutate state", () => {
    const lease = { operation: 3, generation: 5, deck: "b" as const, trackId: "next", loadOrdinal: 8, sourceTrackId: "source", sourceLoadKey: "1:1" };
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
});
