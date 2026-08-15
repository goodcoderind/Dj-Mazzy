import { describe, expect, it } from "vitest";
import {
  decidePartyCommittedTargetContinuation,
  type PartyCommittedTargetContinuationInput
} from "./partyCommittedTargetContinuation";

const base = (): PartyCommittedTargetContinuationInput => ({
  sourceDeck: "a",
  targetDeck: "b",
  autoPilotOwned: true,
  contextState: "running",
  playbackLocked: false,
  conflictingOwner: false,
  targetSnapshot: { channel: "b", trackId: "next", status: "ready", ready: true, playing: false, playbackRate: 1 },
  targetPartyLoad: { trackId: "next", trackOrdinal: 2, loadOrdinal: 5 },
  committedTarget: { trackId: "next", trackOrdinal: 2, loadOrdinal: 5 }
});

describe("committed target continuation", () => {
  it("starts only the exact committed ready idle target", () => {
    expect(decidePartyCommittedTargetContinuation(base())).toEqual({
      version: "party-committed-target-continuation/v1",
      kind: "start-committed-target",
      reason: "exact-committed-target"
    });
  });

  it("pauses for missing, stale, playing, or unready targets", () => {
    const input = base();
    expect(decidePartyCommittedTargetContinuation({ ...input, committedTarget: null }).kind).toBe("pause-source-stopped");
    expect(decidePartyCommittedTargetContinuation({
      ...input,
      targetPartyLoad: { ...input.targetPartyLoad!, loadOrdinal: 6 }
    }).reason).toBe("target-identity-mismatch");
    expect(decidePartyCommittedTargetContinuation({
      ...input,
      targetSnapshot: { ...input.targetSnapshot!, playing: true, status: "playing" }
    }).reason).toBe("target-not-ready");
    expect(decidePartyCommittedTargetContinuation({
      ...input,
      targetSnapshot: { ...input.targetSnapshot!, playbackRate: 0.94 }
    }).reason).toBe("target-not-ready");
  });

  it("fails closed for locks, non-running audio, or another owner", () => {
    const input = base();
    expect(decidePartyCommittedTargetContinuation({ ...input, playbackLocked: true }).reason).toBe("playback-locked");
    expect(decidePartyCommittedTargetContinuation({ ...input, contextState: "suspended" }).reason).toBe("context-not-running");
    expect(decidePartyCommittedTargetContinuation({ ...input, conflictingOwner: true }).reason).toBe("conflicting-owner");
  });
});
