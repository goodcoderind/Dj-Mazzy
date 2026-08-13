import { describe, expect, it } from "vitest";
import { mergeEnhancedRhythm } from "./mergeEnhancedRhythm";
import { BEAT_THIS_EXPERIMENT_VERSION } from "../experimental/beatThisContract";

describe("automatic enhanced rhythm merge", () => {
  it("uses model beats and bar starts without manufacturing confidence", () => {
    const beats = Array.from({ length: 96 }, (_, index) => index * 0.5);
    const result = mergeEnhancedRhythm(
      { duration: 48, beatsSeconds: [], downbeatsSeconds: [], energyByBeat: Array(96).fill(0.8), key: "A" },
      {
        experimentVersion: BEAT_THIS_EXPERIMENT_VERSION,
        backend: "webgpu",
        webGpuAvailable: true,
        sourceSampleRate: 48_000,
        analysisSampleRate: 22_050,
        durationSeconds: 48,
        featureFrames: 2_400,
        chunks: 2,
        preprocessingMs: 1,
        sessionLoadMs: 2,
        inferenceMs: 3,
        beatsSeconds: beats,
        downbeatsSeconds: beats.filter((_, index) => index % 4 === 0),
        energyByBeat: beats.map(() => 0.8),
        backendFailures: [],
        experimentalOnly: true,
        eligibilityConfidence: 0
      }
    );
    expect(result).toMatchObject({
      bpm: 120,
      meter: 4,
      beatConfidence: 0,
      downbeatConfidence: 0,
      rhythmDetector: "beat-this/final0/onnx-v1",
      rhythmAnalysisVersion: BEAT_THIS_EXPERIMENT_VERSION,
      automaticRhythmTrust: { tier: "long-candidate", calibratedSafeProbability: null },
      key: "A"
    });
  });
});
