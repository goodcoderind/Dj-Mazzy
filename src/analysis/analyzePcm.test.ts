import { describe, expect, it } from "vitest";
import {
  analyzePcm,
  detectKey,
  estimateBeatConfidence,
  frequencyToPitchClass,
  normalizeTempo
} from "./analyzePcm";
import {
  BASIC_ANALYZER_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "../domain/versions";

describe("basic PCM analysis", () => {
  it("normalizes common half/double-tempo interpretations", () => {
    expect(normalizeTempo(240)).toBe(120);
    expect(normalizeTempo(60)).toBe(120);
    expect(normalizeTempo(128.04)).toBe(128);
    expect(normalizeTempo(Number.NaN)).toBeNull();
  });

  it("uses C-based pitch classes instead of treating A440 as C", () => {
    expect(frequencyToPitchClass(261.6256)).toBe(0);
    expect(frequencyToPitchClass(440)).toBe(9);
    expect(frequencyToPitchClass(493.8833)).toBe(11);
  });

  it("assigns high confidence to a stable beat grid", () => {
    expect(estimateBeatConfidence([0, 0.5, 1, 1.5, 2, 2.5])).toBe(1);
    expect(estimateBeatConfidence([0, 0.5, 1.15, 1.5, 2.3])).toBeLessThan(0.5);
  });

  it("identifies a synthetic C-major chord", () => {
    const sampleRate = 8192;
    const pcm = new Float32Array(sampleRate * 4);
    const frequencies = [261.6256, 329.6276, 391.9954];
    for (let index = 0; index < pcm.length; index += 1) {
      const time = index / sampleRate;
      pcm[index] = frequencies.reduce(
        (sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * time) / frequencies.length,
        0
      );
    }
    expect(detectKey(pcm, sampleRate)).toMatchObject({ key: "C", scale: "major" });
  });

  it("returns an explicitly versioned result even when rhythm is uncertain", () => {
    const result = analyzePcm(new Float32Array(4096), 8192, 0.5);
    expect(result).toMatchObject({
      schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
      analyzerVersion: BASIC_ANALYZER_VERSION,
      durationSeconds: 0.5,
      bpm: null,
      downbeatsSeconds: [],
      meter: null,
      key: null,
      tempoConfidence: 0,
      downbeatConfidence: 0,
      keyConfidence: 0
    });
  });
});
