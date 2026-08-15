import { describe, expect, it } from "vitest";
import {
  PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION,
  createPartySessionCheckpoint,
  createPartySessionCheckpointTombstone,
  isPartySessionCheckpointOwnershipTransfer,
  normalizePartySessionCheckpointRecord,
  partySessionCheckpointFingerprint,
  projectRestoredPausedPartyState,
  projectPausedPartySessionCheckpoint,
  reconcilePartySessionCheckpoint,
  refreshOwnedPartySessionCheckpointDiscardTarget,
  resolvePartySessionCheckpointDiscardTarget,
  transferPartySessionCheckpointOwnership
} from "./partySessionCheckpoint";

const sessionId = "11111111-1111-4111-8111-111111111111";
const writerToken = "22222222-2222-4222-8222-222222222222";
const available = () => createPartySessionCheckpoint({
  sessionId,
  writerToken,
  libraryEpoch: 4,
  libraryRevision: 8,
  checkpointReason: "active-periodic",
  plannedDurationSeconds: 10_800,
  accumulatedActiveSeconds: 1_234,
  energyProfile: "journey",
  energyShiftSteps: -2,
  includeRestOfLibrary: true,
  playedTrackIds: ["source", "played"],
  remainingTrackIds: ["next", "later"],
  lastStableSourceTrackId: "source"
}, 3);

describe("party session checkpoint", () => {
  it("creates a strict immutable paused-plan record", () => {
    const checkpoint = available();
    expect(checkpoint).toMatchObject({
      schemaVersion: PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION,
      recordStatus: "available",
      restoreMode: "paused-plan",
      revision: 3
    });
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(checkpoint.playedTrackIds)).toBe(true);
    expect(Object.isFrozen(checkpoint.remainingTrackIds)).toBe(true);
  });

  it("round-trips only the allowlisted shape", () => {
    const checkpoint = available();
    expect(normalizePartySessionCheckpointRecord(checkpoint)).toEqual(checkpoint);
    expect(normalizePartySessionCheckpointRecord({ ...checkpoint, filename: "private.mp3" })).toBeNull();
    expect(normalizePartySessionCheckpointRecord({ ...checkpoint, runningSinceSeconds: 50 })).toBeNull();
    expect(normalizePartySessionCheckpointRecord({ ...checkpoint, autoPilotEnabled: true })).toBeNull();
  });

  it("rejects malformed counters, options, tokens, and track lists", () => {
    const checkpoint = available();
    for (const mutation of [
      { revision: 0 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER },
      { libraryEpoch: Number.NaN },
      { libraryRevision: Number.POSITIVE_INFINITY },
      { accumulatedActiveSeconds: -1 },
      { accumulatedActiveSeconds: 700_000 },
      { plannedDurationSeconds: 90 * 60 },
      { energyProfile: "club" },
      { energyShiftSteps: 4 },
      { energyShiftSteps: 0.5 },
      { sessionId: "not-a-uuid" },
      { writerToken: "not-a-uuid" },
      { playedTrackIds: ["source", "source"] },
      { remainingTrackIds: ["next", "next"] },
      { remainingTrackIds: ["played"] },
      { lastStableSourceTrackId: "missing" }
    ]) {
      expect(normalizePartySessionCheckpointRecord({ ...checkpoint, ...mutation })).toBeNull();
    }
  });

  it("rejects sparse and oversized lists", () => {
    const checkpoint = available();
    const sparse = Array(2);
    sparse[0] = "next";
    expect(normalizePartySessionCheckpointRecord({ ...checkpoint, remainingTrackIds: sparse })).toBeNull();
    expect(normalizePartySessionCheckpointRecord({
      ...checkpoint,
      remainingTrackIds: Array.from({ length: 10_001 }, (_, index) => `track-${index}`)
    })).toBeNull();
  });

  it("validates exact immutable tombstones", () => {
    const tombstone = createPartySessionCheckpointTombstone(
      "claimed",
      9,
      sessionId,
      writerToken
    );
    expect(normalizePartySessionCheckpointRecord(tombstone)).toEqual(tombstone);
    expect(normalizePartySessionCheckpointRecord({ ...tombstone, reason: "filename" })).toBeNull();
  });

  it("reconciles only complete references against the current library generation", () => {
    const checkpoint = available();
    expect(reconcilePartySessionCheckpoint(
      checkpoint,
      4,
      9,
      ["source", "played", "next", "later", "new-import"]
    )).toEqual({ status: "available", checkpoint });
    expect(reconcilePartySessionCheckpoint(checkpoint, 5, 9, ["source", "played", "next", "later"]).status)
      .toBe("stale-library");
    expect(reconcilePartySessionCheckpoint(checkpoint, 4, 7, ["source", "played", "next", "later"]).status)
      .toBe("stale-library");
    expect(reconcilePartySessionCheckpoint(checkpoint, 4, 9, ["source", "played", "next"]).status)
      .toBe("missing-track");
  });

  it("does not expose a tombstone or malformed record as recovery", () => {
    expect(reconcilePartySessionCheckpoint(null, 0, 0, [])).toEqual({ status: "none", checkpoint: null });
    expect(reconcilePartySessionCheckpoint({ private: "track.mp3" }, 0, 0, [])).toEqual({
      status: "invalid",
      checkpoint: null
    });
    expect(reconcilePartySessionCheckpoint(
      createPartySessionCheckpointTombstone("cleared", 1, null, null),
      0,
      0,
      []
    )).toEqual({ status: "none", checkpoint: null });
  });

  it("fingerprints semantic content without the storage revision", () => {
    const first = available();
    const second = { ...first, revision: 4 };
    expect(partySessionCheckpointFingerprint(first)).toBe(
      partySessionCheckpointFingerprint(second)
    );
  });

  it("transfers writer ownership without changing the recoverable paused-plan payload", () => {
    const previous = available();
    const nextWriterToken = "33333333-3333-4333-8333-333333333333";
    const transferred = transferPartySessionCheckpointOwnership(previous, nextWriterToken);
    expect(transferred).toEqual({
      ...previous,
      revision: previous.revision + 1,
      writerToken: nextWriterToken
    });
    expect(isPartySessionCheckpointOwnershipTransfer({
      previous,
      next: transferred,
      nextWriterToken
    })).toBe(true);
  });

  it("rejects a transfer with reused ownership or any changed paused-plan payload", () => {
    const previous = available();
    const nextWriterToken = "33333333-3333-4333-8333-333333333333";
    expect(() => transferPartySessionCheckpointOwnership(previous, previous.writerToken)).toThrow();
    const transferred = transferPartySessionCheckpointOwnership(previous, nextWriterToken);
    for (const changed of [
      { remainingTrackIds: ["next"] },
      { playedTrackIds: ["source"] },
      { accumulatedActiveSeconds: transferred.accumulatedActiveSeconds + 1 },
      { writerToken: "44444444-4444-4444-8444-444444444444" },
      { revision: transferred.revision + 1 },
      { recordStatus: "claimed" }
    ]) {
      expect(isPartySessionCheckpointOwnershipTransfer({
        previous,
        next: { ...transferred, ...changed },
        nextWriterToken
      })).toBe(false);
    }
  });

  it("projects every paused-plan field used by App without reordering identities", () => {
    expect(projectRestoredPausedPartyState(available())).toEqual({
      plannedDurationSeconds: 10_800,
      accumulatedActiveSeconds: 1_234,
      energyProfile: "journey",
      energyShift: -0.2,
      includeRestOfLibrary: true,
      playedTrackIds: ["source", "played"],
      remainingTrackIds: ["next", "later"],
      lastStableSourceTrackId: "source"
    });
    expect(() => projectRestoredPausedPartyState({
      ...available(),
      recordStatus: "claimed"
    } as never)).toThrow();
  });

  it("resolves deletion only for the exact healthy recovery owner", () => {
    const current = available();
    expect(resolvePartySessionCheckpointDiscardTarget({
      recoveryCheckpoint: null,
      storedCheckpoint: current,
      localSessionId: current.sessionId,
      localWriterToken: current.writerToken,
      writerLost: false,
      runtimeMode: "running",
      unownedFallbackRevision: 0
    })).toEqual({
      revision: current.revision,
      sessionId: current.sessionId,
      writerToken: current.writerToken
    });
    expect(resolvePartySessionCheckpointDiscardTarget({
      recoveryCheckpoint: null,
      storedCheckpoint: { ...current, writerToken: "33333333-3333-4333-8333-333333333333" },
      localSessionId: current.sessionId,
      localWriterToken: current.writerToken,
      writerLost: false,
      runtimeMode: "running",
      unownedFallbackRevision: 0
    })).toBeNull();
    expect(resolvePartySessionCheckpointDiscardTarget({
      recoveryCheckpoint: null,
      storedCheckpoint: current,
      localSessionId: current.sessionId,
      localWriterToken: current.writerToken,
      writerLost: true,
      runtimeMode: "halted",
      unownedFallbackRevision: 0
    })).toBeNull();
    expect(resolvePartySessionCheckpointDiscardTarget({
      recoveryCheckpoint: current,
      storedCheckpoint: null,
      localSessionId: null,
      localWriterToken: "33333333-3333-4333-8333-333333333333",
      writerLost: false,
      runtimeMode: "running",
      unownedFallbackRevision: 0
    })).toEqual({
      revision: current.revision,
      sessionId: current.sessionId,
      writerToken: current.writerToken
    });
    expect(resolvePartySessionCheckpointDiscardTarget({
      recoveryCheckpoint: current,
      storedCheckpoint: null,
      localSessionId: null,
      localWriterToken: "33333333-3333-4333-8333-333333333333",
      writerLost: false,
      runtimeMode: "circuit-open",
      unownedFallbackRevision: 0
    })).toBeNull();
    expect(resolvePartySessionCheckpointDiscardTarget({
      recoveryCheckpoint: { malformed: true },
      storedCheckpoint: null,
      localSessionId: null,
      localWriterToken: "33333333-3333-4333-8333-333333333333",
      writerLost: false,
      runtimeMode: "running",
      unownedFallbackRevision: 7
    })).toEqual({ revision: 7, sessionId: null, writerToken: null });
  });

  it("refreshes a drained local discard to the latest same owner but refuses a foreign transfer", () => {
    const current = available();
    const capturedTarget = {
      revision: current.revision,
      sessionId: current.sessionId,
      writerToken: current.writerToken
    };
    expect(refreshOwnedPartySessionCheckpointDiscardTarget({
      capturedTarget,
      storedCheckpoint: { ...current, revision: current.revision + 1 },
      localSessionId: current.sessionId,
      localWriterToken: current.writerToken
    })).toEqual({ ...capturedTarget, revision: current.revision + 1 });
    expect(refreshOwnedPartySessionCheckpointDiscardTarget({
      capturedTarget,
      storedCheckpoint: {
        ...current,
        revision: current.revision + 1,
        writerToken: "33333333-3333-4333-8333-333333333333"
      },
      localSessionId: current.sessionId,
      localWriterToken: current.writerToken
    })).toBeNull();
  });

  it("collapses a stable live view into a paused plan and reinserts the committed target once", () => {
    const projected = projectPausedPartySessionCheckpoint({
      sessionId,
      writerToken,
      libraryEpoch: 4,
      libraryRevision: 8,
      checkpointReason: "active-periodic",
      plannedDurationSeconds: 10_800,
      elapsedActiveSeconds: 61.9,
      energyProfile: "build",
      energyShift: 0.299999999,
      includeRestOfLibrary: true,
      playedTrackIds: ["played", "source"],
      queueTrackIds: ["next", "later", "next", "played"],
      committedTargetTrackId: "next",
      lastStableSourceTrackId: "source"
    });

    expect(projected).toMatchObject({
      accumulatedActiveSeconds: 61,
      energyShiftSteps: 3,
      playedTrackIds: ["played", "source"],
      remainingTrackIds: ["next", "later"]
    });
  });
});
