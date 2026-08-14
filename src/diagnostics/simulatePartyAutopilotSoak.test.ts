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
