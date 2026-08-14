import { describe, expect, it } from "vitest";
import { simulatePartyAutopilotSoak, type SimulatedPartyTrack } from "./simulatePartyAutopilotSoak";
import { BEAT_THIS_EXPERIMENT_VERSION, BEAT_THIS_MODEL_SHA256 } from "../experimental/beatThisContract";

const library = (count: number, durationSeconds = 240): SimulatedPartyTrack[] =>
  Array.from({ length: count }, (_, index) => ({ id: `track-${index}`, durationSeconds }));

const timedTrack = (id: string, bpm: number, calibrated: boolean): SimulatedPartyTrack => {
  const durationSeconds = 180;
  const interval = 60 / bpm;
  const beatsSeconds = Array.from({ length: Math.floor(durationSeconds / interval) }, (_, index) => index * interval);
  return {
    id,
    durationSeconds,
    analysis: {
      bpm,
      beatsSeconds,
      downbeatsSeconds: beatsSeconds.filter((_, index) => index % 4 === 0),
      beatConfidence: 0.96,
      downbeatConfidence: 0.94,
      rhythmDetector: "beat-this/final0/onnx-v1",
      rhythmAnalysisVersion: BEAT_THIS_EXPERIMENT_VERSION,
      rhythmModelSha256: BEAT_THIS_MODEL_SHA256,
      rhythmBackend: "wasm",
      automaticRhythmTrust: {
        schemaVersion: "automatic-rhythm-trust/v2",
        tier: "long-candidate",
        calibrationVersion: calibrated ? "synthetic-calibration/v1" : null,
        calibratedSafeProbability: calibrated ? 0.99 : null,
        usableCutBeatIndices: beatsSeconds.map((_, index) => index).filter((index) => index % 4 === 0)
      }
    }
  };
};

describe("shared Party Autopilot coordinator soak", () => {
  it("observes three active hours through the production coordinator without repeats", () => {
    const tracks = library(80);
    const result = simulatePartyAutopilotSoak({
      tracks,
      sessionDurationSeconds: 3 * 60 * 60,
      queuedTrackIds: tracks.slice(1, 7).map((track) => track.id),
      includeRestOfLibrary: true,
      clockStartSeconds: 12_345
    });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe("observation-horizon");
    expect(result.elapsedActiveSeconds).toBe(10_800);
    expect(result.playedTrackIds.length).toBeGreaterThan(40);
    expect(result.repeatTrackIds).toEqual([]);
    expect(result.evaluation.status).toBe("valid-in-progress");
    expect(result.transitionAttempts).toBeGreaterThan(40);
    expect(result.errors).toEqual([]);
  });

  it("ends with exact final ownership when the explicit queue is exhausted", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(8, 180),
      initialTrackId: "track-0",
      queuedTrackIds: ["track-2", "track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 7_200
    });

    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.playedTrackIds).toEqual(["track-0", "track-2", "track-1"]);
    expect(result.successfulHandoffs).toBe(2);
    expect(result.evaluation.status).toBe("valid-terminal");
    expect(result.errors).toEqual([]);
  });

  it("uses the exact final-deck completion lease for primary and recovered signals", () => {
    for (const [signal, recoveries] of [
      ["source-onended", 0],
      ["audio-clock", 1],
      ["reconcile", 1]
    ] as const) {
      const result = simulatePartyAutopilotSoak({
        tracks: library(2, 30),
        initialTrackId: "track-0",
        queuedTrackIds: [],
        includeRestOfLibrary: false,
        sessionDurationSeconds: 120,
        finalDeckCompletionSignal: signal
      });
      expect(result.schemaVersion).toBe("party-autopilot-coordinator-soak/v11");
      expect(result.stopReason).toBe("crate-exhausted");
      expect(result.evaluation.status).toBe("valid-terminal");
      expect(result.evaluation.counters.deckCompletionRecoveries).toBe(recoveries);
      expect(result.errors).toEqual([]);
    }
  });

  it("routes an exact non-final native ending through immediate session pause", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(4, 120),
      queuedTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      unexpectedSourceEndIteration: 2
    });
    expect(result.schemaVersion).toBe("party-autopilot-coordinator-soak/v11");
    expect(result.stopReason).toBe("unexpected-source-ended-paused");
    expect(result.evaluation.status).toBe("valid-in-progress");
    expect(result.evaluation.counters.pauses).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("honors queue order before one-time library continuation", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(5, 120),
      queuedTrackIds: ["track-2", "track-2", "unknown"],
      includeRestOfLibrary: true,
      sessionDurationSeconds: 3_600
    });

    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.playedTrackIds).toHaveLength(5);
    expect(result.playedTrackIds.slice(0, 2)).toEqual(["track-0", "track-2"]);
    expect(new Set(result.playedTrackIds).size).toBe(5);
    expect(result.evaluation.status).toBe("valid-terminal");
    expect(result.errors).toEqual([]);
  });

  it("supersedes a deferred preload before pause and resumes with a fresh operation", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(4, 120),
      initialTrackId: "track-0",
      queuedTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 1_200,
      pauseDuringPreloadAttempt: 1
    });

    expect(result.schemaVersion).toBe("party-autopilot-coordinator-soak/v11");
    expect(result.preloadPauseSupersessions).toBe(1);
    expect(result.stalePausedPreloadSettlementsIgnored).toBe(1);
    expect(result.playedTrackIds).toEqual(["track-0", "track-1", "track-2"]);
    expect(result.evaluation.status).toBe("valid-terminal");
    expect(result.evaluation.counters).toMatchObject({ preloadsCommitted: 2, pauses: 1 });
    expect(result.errors).toEqual([]);
  });

  it("skips each unplayable queued track once and continues without repeating it", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(5, 120),
      queuedTrackIds: ["track-1", "track-2", "track-3"],
      unplayableTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 1_200
    });

    expect(result.playedTrackIds).toEqual(["track-0", "track-3"]);
    expect(result.evaluation.counters.preloadsCommitted).toBe(1);
    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.errors).toEqual([]);
  });

  it("expires one never-settling preload and fails over to the next queued song", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(4, 120),
      queuedTrackIds: ["track-1", "track-2"],
      neverSettlingPreloadTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600
    });

    expect(result.playedTrackIds).toEqual(["track-0", "track-2"]);
    expect(result.evaluation.counters.preloadsTimedOut).toBe(1);
    expect(result.evaluation.failureCodes).not.toContain("timed-out-track-retried");
    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.errors).toEqual([]);
  });

  it("pauses safely after two consecutive never-settling preloads", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(4, 120),
      queuedTrackIds: ["track-1", "track-2", "track-3"],
      neverSettlingPreloadTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600
    });

    expect(result.playedTrackIds).toEqual(["track-0"]);
    expect(result.elapsedActiveSeconds).toBe(40);
    expect(result.stopReason).toBe("preload-timeout-paused");
    expect(result.evaluation.status).toBe("valid-in-progress");
    expect(result.evaluation.counters.preloadsTimedOut).toBe(2);
    expect(result.evaluation.counters.pauses).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it.each([
    { durationSeconds: 45, stopReason: "preload-timeout-paused", elapsed: 40, timeouts: 2 },
    { durationSeconds: 30, stopReason: "preload-timeout-paused", elapsed: 25, timeouts: 2 },
    { durationSeconds: 10, stopReason: "preload-runway-paused", elapsed: 5, timeouts: 1 },
    { durationSeconds: 4, stopReason: "preload-runway-paused", elapsed: 0, timeouts: 0 }
  ])("preserves source runway for a $durationSeconds-second starting song", ({ durationSeconds, stopReason, elapsed, timeouts }) => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(4, durationSeconds),
      queuedTrackIds: ["track-1", "track-2", "track-3"],
      neverSettlingPreloadTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 300
    });
    expect(result.stopReason).toBe(stopReason);
    expect(result.elapsedActiveSeconds).toBe(elapsed);
    expect(result.evaluation.counters.preloadsTimedOut).toBe(timeouts);
    expect(result.evaluation.status).toBe("valid-in-progress");
    expect(result.errors).toEqual([]);
  });

  it("models production Rescue as an immediate paused state", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(10, 180),
      queuedTrackIds: ["track-1", "track-2", "track-3"],
      includeRestOfLibrary: true,
      sessionDurationSeconds: 1_200,
      rescues: [{ transitionAttempt: 1, progress: 0.25 }]
    });

    expect(result.stopReason).toBe("rescue-paused");
    expect(result.rescueEvents).toEqual([{ transitionAttempt: 1, kept: "source", progress: 0.25 }]);
    expect(result.evaluation.status).toBe("valid-in-progress");
    expect(result.evaluation.counters.pauses).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("retries one failed arm with runway, then resets the failure budget on success", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: [timedTrack("track-0", 120, false), timedTrack("track-1", 122, false)],
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      armOutcomes: ["failed", "scheduled"]
    });
    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.transitionAttempts).toBe(2);
    expect(result.successfulHandoffs).toBe(1);
    expect(result.evaluation.counters.armFailures).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("converts a nominal success at or beyond its audio-clock lease into a timeout", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: [timedTrack("track-0", 120, false), timedTrack("track-1", 122, false)],
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      armOutcomes: ["scheduled", "scheduled"],
      armSettlementDelaysSeconds: [8, 0]
    });
    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.transitionAttempts).toBe(2);
    expect(result.evaluation.counters).toMatchObject({ armFailures: 1, armTimeouts: 1 });
    expect(result.successfulHandoffs).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("cancels a superseded arm without consuming the failure budget or scheduling it", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: [timedTrack("track-0", 120, false), timedTrack("track-1", 122, false)],
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      supersededArmAttempts: [1]
    });
    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.transitionAttempts).toBe(2);
    expect(result.evaluation.counters.armFailures).toBe(0);
    expect(result.successfulHandoffs).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("rejects malformed synthetic arm delays instead of treating them as instant success", () => {
    const base = { tracks: library(2), sessionDurationSeconds: 600 };
    expect(() => simulatePartyAutopilotSoak({ ...base, armSettlementDelaysSeconds: [Number.NaN] })).toThrow(RangeError);
    expect(() => simulatePartyAutopilotSoak({ ...base, armSettlementDelaysSeconds: [Number.POSITIVE_INFINITY] })).toThrow(RangeError);
    expect(() => simulatePartyAutopilotSoak({ ...base, armSettlementDelaysSeconds: [-0.1] })).toThrow(RangeError);
  });

  it("recovers a missing primary completion at the exact audio-clock watchdog boundary", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(3, 120),
      queuedTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      missingPrimaryCompletionAttempts: [1, 2]
    });
    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.successfulHandoffs).toBe(2);
    expect(result.evaluation.counters.transitionCompletionRecoveries).toBe(2);
    expect(result.evaluation.counters.lateTransitionCompletions).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("keeps the half-second grace plus callback tolerance but pauses beyond it", () => {
    const atBoundary = simulatePartyAutopilotSoak({
      tracks: library(2, 120),
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      transitionCompletionDelaysSeconds: [0.52]
    });
    expect(atBoundary.stopReason).toBe("crate-exhausted");
    expect(atBoundary.evaluation.counters.lateTransitionCompletions).toBe(0);

    const late = simulatePartyAutopilotSoak({
      tracks: library(2, 120),
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      transitionCompletionDelaysSeconds: [0.520001]
    });
    expect(late.stopReason).toBe("transition-completion-paused");
    expect(late.playedTrackIds).toEqual(["track-0", "track-1"]);
    expect(late.evaluation.counters).toMatchObject({
      transitionsCompleted: 1,
      lateTransitionCompletions: 1,
      pauses: 1
    });
    expect(late.errors).toEqual([]);
  });

  it("pauses without committing a superseded completion target", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(2, 120),
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      supersededCompletionAttempts: [1]
    });
    expect(result.stopReason).toBe("transition-completion-paused");
    expect(result.playedTrackIds).toEqual(["track-0"]);
    expect(result.evaluation.counters).toMatchObject({
      transitionsCompleted: 0,
      transitionCompletionFailures: 1,
      pauses: 1
    });
    expect(result.errors).toEqual([]);
  });

  it("records one fatal coordinator claim and its immediate safety pause", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(4, 120),
      queuedTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      coordinatorFailureIteration: 2
    });
    expect(result.stopReason).toBe("coordinator-failure-paused");
    expect(result.playedTrackIds).toEqual(["track-0"]);
    expect(result.evaluation.counters.coordinatorFailures).toBe(1);
    expect(result.evaluation.counters.pauses).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("rejects malformed completion injections", () => {
    const base = { tracks: library(2), sessionDurationSeconds: 600 };
    expect(() => simulatePartyAutopilotSoak({ ...base, transitionCompletionDelaysSeconds: [Number.NaN] })).toThrow(RangeError);
    expect(() => simulatePartyAutopilotSoak({ ...base, transitionCompletionDelaysSeconds: [Number.POSITIVE_INFINITY] })).toThrow(RangeError);
    expect(() => simulatePartyAutopilotSoak({ ...base, transitionCompletionDelaysSeconds: [-0.1] })).toThrow(RangeError);
    expect(() => simulatePartyAutopilotSoak({ ...base, missingPrimaryCompletionAttempts: [1, 1] })).toThrow(RangeError);
    expect(() => simulatePartyAutopilotSoak({ ...base, coordinatorFailureIteration: 0 })).toThrow(RangeError);
    expect(() => simulatePartyAutopilotSoak({ ...base, coordinatorFailureIteration: 1.5 })).toThrow(RangeError);
  });

  it("pauses after two arm failures or one failure without retry runway", () => {
    const twice = simulatePartyAutopilotSoak({
      tracks: [timedTrack("track-0", 120, false), timedTrack("track-1", 122, false)],
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      armOutcomes: ["failed", "timed-out"]
    });
    expect(twice.stopReason).toBe("transition-arm-paused");
    expect(twice.evaluation.counters).toMatchObject({ armFailures: 2, armTimeouts: 1, pauses: 1 });
    expect(twice.errors).toEqual([]);

    const short = simulatePartyAutopilotSoak({
      tracks: library(2, 30),
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 120,
      armOutcomes: ["failed"]
    });
    expect(short.stopReason).toBe("transition-arm-paused");
    expect(short.transitionAttempts).toBe(1);
    expect(short.errors).toEqual([]);
  });

  it("accounts for target cue time instead of granting every target a fresh full duration", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: library(3, 180),
      queuedTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 1_000
    });

    expect(result.stopReason).toBe("crate-exhausted");
    expect(result.elapsedActiveSeconds).toBeLessThan(3 * 180);
    expect(result.elapsedActiveSeconds).toBeGreaterThan(500);
  });

  it("reaches the real bar-handoff template with current uncalibrated timing evidence", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: [timedTrack("track-0", 120, false), timedTrack("track-1", 122, false)],
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600
    });
    expect(result.transitionTemplates["downbeat-cut"]).toBe(1);
    expect(result.evaluation.status).toBe("valid-terminal");
    expect(result.errors).toEqual([]);
  });

  it("keeps a calibrated-looking synthetic fixture off phrase blends without exact runtime key-lock ownership", () => {
    const result = simulatePartyAutopilotSoak({
      tracks: [timedTrack("track-0", 120, true), timedTrack("track-1", 124, true)],
      queuedTrackIds: ["track-1"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 600,
      keyLockCapability: null
    });
    expect(result.transitionTemplates["phrase-blend"]).toBe(0);
    expect(result.transitionTemplates["downbeat-cut"]).toBe(1);
    expect(result.evaluation.status).toBe("valid-terminal");
    expect(result.errors).toEqual([]);
  });

  it("is deterministic across absolute clock origins", () => {
    const options = {
      tracks: library(3, 100),
      queuedTrackIds: ["track-1", "track-2"],
      includeRestOfLibrary: false,
      sessionDurationSeconds: 1_000
    } as const;
    const first = simulatePartyAutopilotSoak(options);
    const shifted = simulatePartyAutopilotSoak({ ...options, clockStartSeconds: 50_000 });
    expect(shifted).toEqual(first);
  });

  it("rejects malformed crates, clocks, and rescue instructions", () => {
    expect(() => simulatePartyAutopilotSoak({ tracks: [], sessionDurationSeconds: 100 })).toThrow("tracks must not be empty");
    expect(() => simulatePartyAutopilotSoak({
      tracks: [{ id: "same", durationSeconds: 100 }, { id: "same", durationSeconds: 100 }],
      sessionDurationSeconds: 100
    })).toThrow("unique");
    expect(() => simulatePartyAutopilotSoak({
      tracks: library(2), sessionDurationSeconds: 100, rescues: [{ transitionAttempt: 1, progress: 1.1 }]
    })).toThrow("from 0 to 1");
  });
});
