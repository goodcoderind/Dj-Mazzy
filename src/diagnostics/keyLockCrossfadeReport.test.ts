import { describe, expect, it } from "vitest";
import { evaluateKeyLockCrossfadeEvidence, type KeyLockCrossfadeEvidence } from "./keyLockCrossfadeReport";

const goodEvidence = (): KeyLockCrossfadeEvidence => ({
  mode: "quick-20s",
  transitionCount: 12,
  scheduledIds: Array.from({ length: 12 }, (_, index) => index + 1),
  completedIds: Array.from({ length: 12 }, (_, index) => index + 1),
  completionLatenessSeconds: Array.from({ length: 12 }, () => 0.01),
  expectedActiveSeconds: 20,
  sampleRate: 48_000,
  contextStates: ["suspended", "running"],
  sourceBackendReady: true,
  targetBackendReady: true,
  activeCrossfadeRemaining: false,
  aborted: false,
  health: {
    renderedFrames: 960_000,
    expectedActiveFrames: 960_000,
    silentFrames: 0,
    renderQuanta: 7_500,
    nonFiniteSamples: 0,
    clippedSamples: 0,
    processorErrors: 0,
    peak: 0.04,
    longestUnexpectedSilentSeconds: 0,
    reports: 20
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
    expect(evaluateKeyLockCrossfadeEvidence({
      ...evidence,
      completionLatenessSeconds: [...evidence.completionLatenessSeconds.slice(0, -1), 1.01]
    }).passed).toBe(false);
  });

  it("rejects interruption, an active schedule, and cancellation", () => {
    const evidence = goodEvidence();
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, contextStates: ["running", "suspended"] }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, activeCrossfadeRemaining: true }).passed).toBe(false);
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, aborted: true }).passed).toBe(false);
  });

  it("requires the full interval promised by each mode", () => {
    const evidence = goodEvidence();
    expect(evaluateKeyLockCrossfadeEvidence({ ...evidence, transitionCount: 11 }).failures).toContain("mode-coverage");
    expect(evaluateKeyLockCrossfadeEvidence({
      ...evidence,
      mode: "sustained-1m",
      transitionCount: 37,
      scheduledIds: Array.from({ length: 37 }, (_, index) => index + 1),
      completedIds: Array.from({ length: 37 }, (_, index) => index + 1),
      completionLatenessSeconds: Array.from({ length: 37 }, () => 0.01),
      expectedActiveSeconds: 59.99,
      health: {
        ...evidence.health,
        renderedFrames: 2_880_000,
        expectedActiveFrames: 2_880_000,
        renderQuanta: 22_500,
        reports: 60
      }
    }).failures).toContain("mode-coverage");
    expect(evaluateKeyLockCrossfadeEvidence({
      ...evidence,
      mode: "sustained-1m",
      transitionCount: 37,
      scheduledIds: Array.from({ length: 37 }, (_, index) => index + 1),
      completedIds: Array.from({ length: 37 }, (_, index) => index + 1),
      completionLatenessSeconds: Array.from({ length: 37 }, () => 0.01),
      expectedActiveSeconds: 60,
      health: {
        ...evidence.health,
        renderedFrames: 2_880_000,
        expectedActiveFrames: 2_736_000,
        renderQuanta: 22_500,
        reports: 60
      }
    }).failures).toContain("health-coverage");
  });
});
