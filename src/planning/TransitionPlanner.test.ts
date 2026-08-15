import { describe, expect, it } from "vitest";
import { DOWNBEAT_CUT_SECONDS, FILTERED_FADE_SECONDS, planAutomaticTransition, SAFE_FADE_SECONDS } from "./TransitionPlanner";
import { TRANSITION_PLAN_SCHEMA_VERSION } from "../domain/versions";
import { BEAT_THIS_EXPERIMENT_VERSION, BEAT_THIS_MODEL_SHA256 } from "../experimental/beatThisContract";
import { BASIC_ANALYZER_VERSION } from "../domain/versions";

const grid = (bpm: number, duration = 240) => {
  const interval = 60 / bpm;
  const beatsSeconds = Array.from(
    { length: Math.floor(duration / interval) },
    (_, index) => index * interval
  );
  return {
    duration,
    bpm,
    beatsSeconds,
    downbeatsSeconds: beatsSeconds.filter((_, index) => index % 4 === 0),
    meter: 4,
    beatConfidence: 0.95,
    downbeatConfidence: 0.92
  };
};

const usableCutBeatIndices = Array.from({ length: 100 }, (_, index) => index * 4);

const qualifiedInput = {
  requestedAt: 100,
  source: { trackId: "source", ...grid(120), rhythmDetector: "beat-this/final0/onnx-v1", rhythmAnalysisVersion: BEAT_THIS_EXPERIMENT_VERSION, rhythmModelSha256: BEAT_THIS_MODEL_SHA256, rhythmBackend: "wasm", automaticRhythmTrust: { schemaVersion: "automatic-rhythm-trust/v2", tier: "long-candidate", calibrationVersion: "test-calibration/v1", calibratedSafeProbability: 0.99, usableCutBeatIndices } },
  target: { trackId: "target", ...grid(124), rhythmDetector: "beat-this/final0/onnx-v1", rhythmAnalysisVersion: BEAT_THIS_EXPERIMENT_VERSION, rhythmModelSha256: BEAT_THIS_MODEL_SHA256, rhythmBackend: "wasm", automaticRhythmTrust: { schemaVersion: "automatic-rhythm-trust/v2", tier: "long-candidate", calibrationVersion: "test-calibration/v1", calibratedSafeProbability: 0.99, usableCutBeatIndices } },
  keyLockCapability: { schemaVersion: "key-lock-capability/v1", processor: "signalsmith-stretch-web/1.3.2", status: "benchmark-approved", minimumRate: 0.94, maximumRate: 1.06, sampleRate: 48_000, contextSampleRate: 48_000, acceptanceContract: "key-lock-device-acceptance/v1", sourceLoadKey: "deck-a-load-1", targetLoadKey: "deck-b-load-1", sourceBackend: "signalsmith-stretch-web/1.3.2", targetBackend: "signalsmith-stretch-web/1.3.2" },
  keyLockRuntime: { contextSampleRate: 48_000, sourceLoadKey: "deck-a-load-1", targetLoadKey: "deck-b-load-1", sourceBackend: "signalsmith-stretch-web/1.3.2", targetBackend: "signalsmith-stretch-web/1.3.2" },
  sourceDeck: { positionSeconds: 10.2, playbackRate: 1 }
} as const;

const currentAutomaticTrust = {
  schemaVersion: "automatic-rhythm-trust/v2",
  tier: "bar-cut-candidate",
  calibrationVersion: null,
  calibratedSafeProbability: null,
  usableCutBeatIndices
};
const currentEnhanced = {
  rhythmDetector: "beat-this/final0/onnx-v1",
  rhythmAnalysisVersion: BEAT_THIS_EXPERIMENT_VERSION,
  rhythmModelSha256: BEAT_THIS_MODEL_SHA256,
  rhythmBackend: "wasm"
};

describe("automatic transition planning", () => {
  it("creates an immutable 32-beat phrase plan only for qualified grids", () => {
    const plan = planAutomaticTransition(qualifiedInput);
    expect(plan).toMatchObject({
      schemaVersion: TRANSITION_PLAN_SCHEMA_VERSION,
      template: "phrase-blend",
      targetBpm: 120,
      lengthBeats: 32,
      confidence: 0.92,
      eligibility: { longBlendEligible: true, reasons: [] },
      schedule: {
        startTime: 101.8,
        durationSeconds: 16,
        targetCueSeconds: 0
      }
    });
    expect(plan.targetPlaybackRate).toBeCloseTo(120 / 124);
    expect(plan.schedule.endTime).toBeCloseTo(117.8);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.schedule)).toBe(true);
  });

  it("is deterministic for identical state", () => {
    expect(planAutomaticTransition(qualifiedInput)).toEqual(planAutomaticTransition(qualifiedInput));
  });

  it("refuses a tempo-changing phrase blend until pitch-preserving key lock is ready", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      keyLockCapability: null
    });
    expect(plan.template).toBe("downbeat-cut");
    expect(plan.eligibility.reasons).toContain("Pitch-preserving tempo sync is not ready on this device.");
  });

  it("also requires key lock when the already-playing source is off natural speed", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      sourceDeck: { positionSeconds: 10.2, playbackRate: 1.02 },
      target: { ...qualifiedInput.target, bpm: 122.4 },
      keyLockCapability: null
    });
    expect(plan.template).toBe("downbeat-cut");
    expect(plan.eligibility.reasons).toContain("Pitch-preserving tempo sync is not ready on this device.");
  });

  it("rejects a capability that is not bound to the exact current loads and context", () => {
    const wrongLoad = planAutomaticTransition({
      ...qualifiedInput,
      keyLockRuntime: { ...qualifiedInput.keyLockRuntime, targetLoadKey: "deck-b-load-2" }
    });
    expect(wrongLoad.template).toBe("downbeat-cut");
    expect(wrongLoad.eligibility.reasons).toContain("Pitch-preserving tempo sync is not ready on this device.");

    const wrongSampleRate = planAutomaticTransition({
      ...qualifiedInput,
      keyLockRuntime: { ...qualifiedInput.keyLockRuntime, contextSampleRate: 44_100 }
    });
    expect(wrongSampleRate.template).toBe("downbeat-cut");
  });

  it("selects a short no-stretch safe fade when downbeats are unavailable", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, downbeatsSeconds: [], downbeatConfidence: 0 }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.targetPlaybackRate).toBe(1);
    expect(plan.schedule.durationSeconds).toBe(SAFE_FADE_SECONDS);
    expect(plan.schedule.startTime).toBe(qualifiedInput.requestedAt + 0.25);
    expect(plan.eligibility.reasons).toContain("A trusted downbeat grid is missing.");
  });

  it("selects an intentional Filtered Fade only with complete bounded outgoing evidence", () => {
    const source = {
      ...qualifiedInput.source,
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: "track-analysis/v5",
      analysisStatus: "ready",
      downbeatsSeconds: [],
      downbeatConfidence: 0,
      energyByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.5),
      vocalProbabilityByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.2),
      bandEnergyByBeat: Array.from({ length: qualifiedInput.source.beatsSeconds.length }, () => ({ low: 0.4, mid: 0.4, high: 0.2 }))
    };
    const plan = planAutomaticTransition({ ...qualifiedInput, source });
    expect(plan.template).toBe("filtered-fade");
    expect(plan.schedule.durationSeconds).toBe(FILTERED_FADE_SECONDS);
    expect(plan.targetPlaybackRate).toBe(1);
    expect(plan.automation.filter).toEqual([20_000, 420]);
    expect(plan.explanation[0]).toContain("Filtered Fade");
  });

  it("forces Safe Fade when either exact loaded deck lacks trusted timing facts", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      target: { ...qualifiedInput.target, forceSafeFadeOnly: true }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.eligibility.reasons).toContain("This loaded deck has no trusted timing facts for this play.");
  });

  it("does not let source-only filter evidence bypass the loaded target's Safe Fade policy", () => {
    const source = {
      ...qualifiedInput.source,
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: "track-analysis/v5",
      analysisStatus: "ready",
      downbeatsSeconds: [],
      downbeatConfidence: 0,
      energyByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.5),
      vocalProbabilityByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.2),
      bandEnergyByBeat: Array.from({ length: qualifiedInput.source.beatsSeconds.length }, () => ({ low: 0.4, mid: 0.4, high: 0.2 }))
    };
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source,
      target: { ...qualifiedInput.target, forceSafeFadeOnly: true }
    });
    expect(plan.template).toBe("safe-fade");
  });

  it.each([
    { label: "stale analyzer evidence", analyzerVersion: "basic-worker/v4" },
    { label: "missing vocal evidence", vocalProbabilityByBeat: undefined },
    { label: "vocal section", vocalProbabilityByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.8) },
    { label: "silent section", energyByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.01) },
    { label: "no useful high-frequency content", bandEnergyByBeat: Array.from({ length: qualifiedInput.source.beatsSeconds.length }, () => ({ low: 0.8, mid: 0.19, high: 0.01 })) }
  ])("keeps Safe Fade for $label", (override) => {
    const source = {
      ...qualifiedInput.source,
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: "track-analysis/v5",
      analysisStatus: "ready",
      downbeatsSeconds: [],
      downbeatConfidence: 0,
      energyByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.5),
      vocalProbabilityByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.2),
      bandEnergyByBeat: Array.from({ length: qualifiedInput.source.beatsSeconds.length }, () => ({ low: 0.4, mid: 0.4, high: 0.2 })),
      ...override
    };
    expect(planAutomaticTransition({ ...qualifiedInput, source }).template).toBe("safe-fade");
  });

  it("never uses Filtered Fade for a manual grid or insufficient remaining audio", () => {
    const features = {
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: "track-analysis/v5",
      analysisStatus: "ready",
      energyByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.5),
      vocalProbabilityByBeat: Array(qualifiedInput.source.beatsSeconds.length).fill(0.2),
      bandEnergyByBeat: Array.from({ length: qualifiedInput.source.beatsSeconds.length }, () => ({ low: 0.4, mid: 0.4, high: 0.2 }))
    };
    expect(planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, ...features, downbeatsSeconds: [], analysisOverrides: { firstBeatSeconds: 0.1 } }
    }).template).toBe("safe-fade");
    expect(planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, ...features, downbeatsSeconds: [] },
      target: { ...qualifiedInput.target, analysisOverrides: { autoMixDisabled: true } }
    }).template).toBe("safe-fade");
    expect(planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, ...features, downbeatsSeconds: [] },
      sourceDeck: { positionSeconds: qualifiedInput.source.duration - 3, playbackRate: 1 }
    }).template).toBe("safe-fade");
  });

  it.each([
    { label: "truncated band evidence", change: { bandEnergyByBeat: [{ low: 0.4, mid: 0.4, high: 0.2 }] } },
    { label: "null band evidence", change: { bandEnergyByBeat: Object.assign(Array.from({ length: 480 }, () => ({ low: 0.4, mid: 0.4, high: 0.2 })), { 20: null }) } },
    { label: "sparse vocal evidence", change: { vocalProbabilityByBeat: Object.assign(Array(480), { 40: 0.2 }) } },
    { label: "negative vocal proxy", change: { vocalProbabilityByBeat: Array(480).fill(-0.1) } },
    { label: "out-of-range energy", change: { energyByBeat: Array(480).fill(1.2) } },
    { label: "misaligned energy", change: { energyByBeat: Array(479).fill(0.5) } },
    { label: "non-finite duration", change: { durationSeconds: Number.NaN } },
    { label: "infinite duration", change: { durationSeconds: Number.POSITIVE_INFINITY } },
    { label: "unsorted beats", change: { beatsSeconds: [0.5, 0, ...Array.from({ length: 478 }, (_, index) => (index + 2) * 0.5)] } },
    { label: "duplicate beats", change: { beatsSeconds: [0, 0, ...Array.from({ length: 478 }, (_, index) => (index + 2) * 0.5)] } },
    { label: "stale schema", change: { schemaVersion: "track-analysis/v4" } },
    { label: "unfinished analysis", change: { analysisStatus: "pending" } }
  ])("keeps Safe Fade for malformed $label", ({ change }) => {
    const source = {
      ...qualifiedInput.source,
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: "track-analysis/v5",
      analysisStatus: "ready",
      downbeatsSeconds: [],
      downbeatConfidence: 0,
      energyByBeat: Array(480).fill(0.5),
      vocalProbabilityByBeat: Array(480).fill(0.2),
      bandEnergyByBeat: Array.from({ length: 480 }, () => ({ low: 0.4, mid: 0.4, high: 0.2 })),
      ...change
    };
    expect(planAutomaticTransition({ ...qualifiedInput, source }).template).toBe("safe-fade");
  });

  it.each([0.1, 0.35, 1, 3.5, 3.75])("never schedules a Safe Fade beyond %.2f seconds of source audio", (remainingSeconds) => {
    const duration = 240;
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, duration, downbeatsSeconds: [], downbeatConfidence: 0 },
      sourceDeck: { positionSeconds: duration - remainingSeconds, playbackRate: 1 }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.schedule.endTime).toBeLessThanOrEqual(plan.schedule.requestedAt + remainingSeconds + 1e-9);
  });

  it("rejects a long blend at low calibrated confidence but keeps the short automatic handoff", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      target: { ...qualifiedInput.target, downbeatConfidence: 0.79 }
    });
    expect(plan.template).toBe("downbeat-cut");
    expect(plan.eligibility.reasons).toContain(
      "Downbeat confidence is below the phrase-blend threshold."
    );
  });

  it("never promotes machine self-consistency without a real-music calibrator", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, ...currentEnhanced, automaticRhythmTrust: currentAutomaticTrust },
      target: { ...qualifiedInput.target, ...currentEnhanced, automaticRhythmTrust: currentAutomaticTrust }
    });
    expect(plan.template).toBe("downbeat-cut");
    expect(plan.schedule.durationSeconds).toBe(DOWNBEAT_CUT_SECONDS);
    expect(plan.targetPlaybackRate).toBe(1);
    expect(plan.eligibility.reasons).toContain("Automatic timing has not passed real-music calibration yet.");
  });

  it("rejects a trusted-looking result whose enhanced detector identity was lost on reload", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: {
        ...qualifiedInput.source,
        rhythmDetector: null,
        rhythmAnalysisVersion: null,
        rhythmModelSha256: null,
        rhythmBackend: null,
        automaticRhythmTrust: currentAutomaticTrust
      },
      target: { ...qualifiedInput.target, ...currentEnhanced, automaticRhythmTrust: currentAutomaticTrust }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.eligibility.reasons).toContain(
      "A locally trusted automatic bar handoff is unavailable for this pair."
    );
  });

  it("never jumps deep into the target merely to find a trusted bar cue", () => {
    const lateOnlyTrust = { ...currentAutomaticTrust, usableCutBeatIndices: [160] };
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, ...currentEnhanced, automaticRhythmTrust: currentAutomaticTrust },
      target: { ...qualifiedInput.target, ...currentEnhanced, automaticRhythmTrust: lateOnlyTrust }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.schedule.targetCueSeconds).toBe(0);
    expect(plan.eligibility.reasons).toContain(
      "The next track has no trusted automatic bar cue in its opening section."
    );
  });

  it("ranks musical quality only within the exact trusted cue set", () => {
    const sourceGrid = grid(120);
    const targetGrid = grid(120);
    const sourceVocals = Array(sourceGrid.beatsSeconds.length).fill(0.8);
    const targetVocals = Array(targetGrid.beatsSeconds.length).fill(0.8);
    sourceVocals.fill(0.1, 28, 36);
    targetVocals.fill(0.1, 8, 16);
    // Beat 12 is even cleaner but is deliberately not in the trust contract.
    targetVocals.fill(0, 12, 20);
    const trusted = {
      ...currentAutomaticTrust,
      usableCutBeatIndices: [0, 4, 8, 24, 28, 32]
    };
    const plan = planAutomaticTransition({
      requestedAt: 100,
      source: {
        trackId: "source",
        ...sourceGrid,
        ...currentEnhanced,
        automaticRhythmTrust: trusted,
        energyByBeat: Array(sourceGrid.beatsSeconds.length).fill(0.5),
        vocalProbabilityByBeat: sourceVocals,
        structureBoundaries: [{ beatIndex: 28, confidence: 0.6 }]
      },
      target: {
        trackId: "target",
        ...targetGrid,
        ...currentEnhanced,
        automaticRhythmTrust: trusted,
        energyByBeat: Array(targetGrid.beatsSeconds.length).fill(0.55),
        vocalProbabilityByBeat: targetVocals,
        structureBoundaries: [{ beatIndex: 8, confidence: 0.6 }]
      },
      sourceDeck: { positionSeconds: 10.2, playbackRate: 1 }
    });
    expect(plan.template).toBe("downbeat-cut");
    expect(plan.sourceStartBeat).toBe(28);
    expect(plan.targetStartBeat).toBe(8);
    expect(plan.explanation[0]).toContain("Matched-energy trusted cues with lower likely vocal overlap.");
    expect(plan.scoreBreakdown.musicalCuePreference).toBeGreaterThan(0);
    expect(plan.scoreBreakdown.energyContinuity).toBeGreaterThan(0.8);
    expect(plan.scoreBreakdown.vocalClarity).toBeGreaterThan(0.5);
  });

  it("uses Safe Fade when automatic self-checks do not support a bar-aligned cut", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, automaticRhythmTrust: { tier: "boundary-only", calibrationVersion: null, calibratedSafeProbability: null } }
    });
    expect(plan.template).toBe("safe-fade");
  });

  it("rejects tempo stretch beyond ten percent", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      target: { trackId: "target", ...grid(150) }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.eligibility.reasons).toContain("Required tempo stretch exceeds the 10% hard limit.");
  });

  it("rejects tracks without a full 32-beat window", () => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: { trackId: "short", ...grid(120, 20) },
      sourceDeck: { positionSeconds: 8, playbackRate: 1 }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.eligibility.reasons).toContain("A complete 32-beat downbeat window is unavailable.");
  });

  it.each([
    { correctedBpm: 120 },
    { firstBeatSeconds: 0.01 },
    { firstDownbeatBeatIndex: 0 },
    { correctedBpm: 120, firstBeatSeconds: 0.01, firstDownbeatBeatIndex: 0 }
  ])("keeps every manually repaired grid on Safe Fade (%j)", (analysisOverrides) => {
    const plan = planAutomaticTransition({
      ...qualifiedInput,
      source: { ...qualifiedInput.source, analysisOverrides }
    });
    expect(plan.template).toBe("safe-fade");
    expect(plan.confidence).toBe(0);
    expect(plan.eligibility.reasons).toContain(
      "A manually repaired grid is not calibrated for long blends."
    );
  });
});
