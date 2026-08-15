import { describe, expect, it } from "vitest";
import {
  PARTY_FIRST_SONG_LOAD_VERSION,
  createPartyFirstSongLoadOwner,
  decidePartyFirstSongLoadSettlement,
  mayClearPartyFirstSongRecoveryStatus,
  matchesPartyFirstSongReadyOwner,
  ownsPartyFirstSongLoad,
  ownsPartyFirstSongTimer,
  partyFirstSongBlocksAutopilotStart,
  partyFirstSongReadyActionMessage,
  shouldClearPartyFirstSongReadyForLoad,
  shouldClearPartyFirstSongReadyForLoadInvalidation,
  shouldClearPartyFirstSongReadyForTransportStart,
  shouldClearPartyFirstSongStatusAfterStop
} from "./partyFirstSongLoad";

describe("party first-song load ownership", () => {
  const owner = createPartyFirstSongLoadOwner({ operation: 1, deck: "a", trackId: "track-1" });
  const readyInput = {
    current: owner,
    expected: owner,
    outcome: "loaded" as const,
    currentTrackId: "track-1",
    ready: true,
    playing: false,
    playbackRate: 1,
    readinessCurrent: true,
    contextRunning: true,
    libraryCurrent: true,
    recoveryLocked: false
  };

  it("creates an opaque session-only owner and matches every identity field", () => {
    expect(owner).toEqual({
      version: PARTY_FIRST_SONG_LOAD_VERSION,
      operation: 1,
      deck: "a",
      trackId: "track-1",
      loadAuthorityKey: "party-first:1"
    });
    expect(ownsPartyFirstSongLoad(owner, owner)).toBe(true);
    expect(ownsPartyFirstSongLoad({ ...owner, trackId: "track-2" }, owner)).toBe(false);
    expect(ownsPartyFirstSongLoad({ ...owner, operation: 2 }, owner)).toBe(false);
    expect(() => createPartyFirstSongLoadOwner({ operation: 0, deck: "a", trackId: "track-1" })).toThrow();
  });

  it("accepts only an exact decoded, idle, 1x, current-library load", () => {
    expect(decidePartyFirstSongLoadSettlement(readyInput)).toBe("ready");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, readinessCurrent: false })).toBe("cleanup-required");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, currentTrackId: "track-2" })).toBe("cleanup-required");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, playing: true })).toBe("cleanup-required");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, playbackRate: 1.01 })).toBe("cleanup-required");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, contextRunning: false })).toBe("cleanup-required");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, libraryCurrent: false })).toBe("cleanup-required");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, recoveryLocked: true })).toBe("cleanup-required");
  });

  it("classifies terminal outcomes and leaves a stale successor inert", () => {
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, outcome: "cancelled" })).toBe("cancelled");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, outcome: "unplayable-file" })).toBe("read-failed");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, outcome: "audio-blocked" })).toBe("audio-blocked");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, current: { ...owner, operation: 2 } })).toBe("ignore-stale");
    expect(decidePartyFirstSongLoadSettlement({ ...readyInput, current: null })).toBe("ignore-stale");
  });

  it("never lets a stale settlement claim its successor's slow-opening timer", () => {
    const successor = createPartyFirstSongLoadOwner({ operation: 2, deck: "a", trackId: "track-2" });
    const successorTimer = { operation: successor.operation };
    expect(ownsPartyFirstSongTimer(successorTimer, successor)).toBe(true);
    expect(ownsPartyFirstSongTimer(successorTimer, owner)).toBe(false);
  });

  it("preserves the Stop guidance until destructive cleanup is verified", () => {
    expect(mayClearPartyFirstSongRecoveryStatus(true)).toBe(true);
    expect(mayClearPartyFirstSongRecoveryStatus(false)).toBe(false);
    expect(mayClearPartyFirstSongRecoveryStatus(undefined)).toBe(false);
  });

  it("binds ready UI to the exact deck and load while ignoring the other deck", () => {
    expect(matchesPartyFirstSongReadyOwner({
      readyOwner: owner,
      deck: "a",
      trackId: "track-1",
      loadAuthorityKey: owner.loadAuthorityKey
    })).toBe(true);
    expect(matchesPartyFirstSongReadyOwner({
      readyOwner: owner,
      deck: "b",
      trackId: "track-1",
      loadAuthorityKey: owner.loadAuthorityKey
    })).toBe(false);
    expect(matchesPartyFirstSongReadyOwner({
      readyOwner: owner,
      deck: "a",
      trackId: "track-1",
      loadAuthorityKey: "party-first:2"
    })).toBe(false);

    expect(shouldClearPartyFirstSongReadyForLoad({
      readyOwner: owner,
      deck: "b",
      trackId: "other-track",
      loadAuthorityKey: "manual"
    })).toBe(false);
    expect(shouldClearPartyFirstSongReadyForLoad({
      readyOwner: owner,
      deck: "a",
      trackId: "track-1",
      loadAuthorityKey: owner.loadAuthorityKey
    })).toBe(false);
    expect(shouldClearPartyFirstSongReadyForLoad({
      readyOwner: owner,
      deck: "a",
      trackId: "track-1",
      loadAuthorityKey: "party-first:2"
    })).toBe(true);
    expect(shouldClearPartyFirstSongReadyForLoad({
      readyOwner: owner,
      deck: "a",
      trackId: "replacement",
      loadAuthorityKey: "manual"
    })).toBe(true);

    const exactStart = {
      readyOwner: owner,
      deck: "a" as const,
      trackId: "track-1",
      loadAuthorityKey: owner.loadAuthorityKey
    };
    expect(shouldClearPartyFirstSongReadyForTransportStart(exactStart)).toBe(true);
    expect(shouldClearPartyFirstSongReadyForTransportStart(exactStart)).toBe(true); // scheduled start
    expect(shouldClearPartyFirstSongReadyForTransportStart({
      ...exactStart,
      deck: "b"
    })).toBe(false);
    expect(shouldClearPartyFirstSongReadyForLoadInvalidation(exactStart)).toBe(true);
    expect(shouldClearPartyFirstSongReadyForLoadInvalidation({
      ...exactStart,
      deck: "b"
    })).toBe(false);
  });

  it("keeps the ready action truthful when the unrelated deck is playing", () => {
    expect(partyFirstSongReadyActionMessage(false)).toContain("stays stopped");
    expect(partyFirstSongReadyActionMessage(true)).toContain("Another deck is playing");
    expect(partyFirstSongReadyActionMessage(true)).toContain("pause it");
  });

  it("clears ready proof only after Stop verifies every sound owner", () => {
    expect(shouldClearPartyFirstSongStatusAfterStop({ verifiedStopped: true, status: "ready" })).toBe(true);
    expect(shouldClearPartyFirstSongStatusAfterStop({ verifiedStopped: true, status: "cleanup-error" })).toBe(true);
    expect(shouldClearPartyFirstSongStatusAfterStop({ verifiedStopped: false, status: "ready" })).toBe(false);
    expect(shouldClearPartyFirstSongStatusAfterStop({ verifiedStopped: true, status: "opening" })).toBe(false);
  });

  it("blocks every Autopilot entry while first-song ownership is unresolved", () => {
    expect(partyFirstSongBlocksAutopilotStart({ openingOwned: true, readyOwned: false })).toBe(true);
    expect(partyFirstSongBlocksAutopilotStart({ openingOwned: false, readyOwned: true })).toBe(true);
    expect(partyFirstSongBlocksAutopilotStart({ openingOwned: false, readyOwned: false })).toBe(false);
  });
});
