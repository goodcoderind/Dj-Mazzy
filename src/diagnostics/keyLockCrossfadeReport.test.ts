import { describe, expect, it } from "vitest";
import { evaluateKeyLockCrossfadeEvidence, type KeyLockCrossfadeEvidence } from "./keyLockCrossfadeReport";

const goodEvidence = (): KeyLockCrossfadeEvidence => ({
  transitionCount: 2,
  scheduledIds: [1, 2],
  completedIds: [1, 2],
  completionLatenessSeconds: [0.01, 0.02],
  expectedActiveSeconds: 4,
  sampleRate: 48_000,
  contextStates: ["suspended", "running"],
  sourceBackendReady: true,
  targetBackendReady: true,
  activeCrossfadeRemaining: false,
  aborted: false,
  health: {
    renderedFrames: 192_000,
    expectedActiveFrames: 192_000,
    silentFrames: 0,
    renderQuanta: 1_500,
    nonFiniteSamples: 0,
    clippedSamples: 0,
    processorErrors: 0,
    peak: 0.04,
    longestUnexpectedSilentSeconds: 0,
    reports: 4
  }
});

describe("key-lock crossfade evidence", () => {
  it("accepts complete consistent render evidence", () => {
    expect(evaluateKeyLockCrossfadeEvidence(goodEvidence())).toEqual({ passed: true, failures: [] });
  });

  it("rejects missing health coverage and malformed counters", () => {
    const evidence = goodEvidence();
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, health: { ...evidence.health, expectedActiveFrames: 0 } }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, health: { ...evidence.health, reports: 0 } }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, health: { ...evidence.health, silentFrames: evidence.health.expectedActiveFrames + 1 } }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({
      ...evidence,
      health: { ...evidence.health, expectedActiveFrames: evidence.health.expectedActiveFrames + 48_000 }
    }).passed).toBe(false);
  });

  it("rejects missing, duplicate, or late completion ownership", () => {
    const evidence = goodEvidence();
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, completedIds: [1, 1] }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, completionLatenessSeconds: [0.01, 1.01] }).passed).toBe(false);
  });

  it("rejects interruption, an active schedule, and cancellation", () => {
    const evidence = goodEvidence();
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, contextStates: ["running", "suspended"] }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, activeCrossfadeRemaining: true }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, aborted: true }).passed).toBe(false);
  });
});
