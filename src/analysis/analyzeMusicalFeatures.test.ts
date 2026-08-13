import { describe, expect, it } from "vitest";
import { analyzeBeatSynchronousFeatures } from "./analyzeMusicalFeatures";

const makeBeatGrid = (duration: number, interval = 0.5) =>
  Array.from({ length: Math.floor(duration / interval) }, (_, index) => index * interval);

describe("beat-synchronous musical feature analysis", () => {
  it("returns empty evidence rather than inventing structure without a beat grid", () => {
    const result = analyzeBeatSynchronousFeatures(new Float32Array(8_000), 8_000, []);
    expect(result).toEqual({
      energyByBeat: [],
      bandEnergyByBeat: [],
      vocalProbabilityByBeat: [],
      structureBoundaries: [],
      phraseCandidates: []
    });
  });

  it("produces deterministic, bounded beat-synchronous descriptors", () => {
    const sampleRate = 8_000;
    const duration = 8;
    const pcm = new Float32Array(sampleRate * duration);
    for (let index = 0; index < pcm.length; index += 1) {
      const time = index / sampleRate;
      pcm[index] = Math.sin(2 * Math.PI * 440 * time) * (time < 4 ? 0.15 : 0.8);
    }
    const beats = makeBeatGrid(duration);
    const first = analyzeBeatSynchronousFeatures(pcm, sampleRate, beats);
    const second = analyzeBeatSynchronousFeatures(pcm, sampleRate, beats);
    expect(first).toEqual(second);
    expect(first.energyByBeat).toHaveLength(beats.length);
    expect(first.bandEnergyByBeat).toHaveLength(beats.length);
    expect(first.vocalProbabilityByBeat).toHaveLength(beats.length);
    expect(first.energyByBeat.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(first.vocalProbabilityByBeat.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(first.structureBoundaries.some((boundary) => boundary.beatIndex >= 7 && boundary.beatIndex <= 9)).toBe(true);
    expect(first.structureBoundaries.every((boundary) => boundary.confidence <= 0.7)).toBe(true);
    expect(first.phraseCandidates.every((candidate) => candidate.confidence <= 0.55)).toBe(true);
  });

  it("treats vocal-band energy as a proxy rather than confusing bass dominance with vocals", () => {
    const sampleRate = 8_000;
    const duration = 4;
    const beats = makeBeatGrid(duration);
    const bass = new Float32Array(sampleRate * duration);
    const mid = new Float32Array(sampleRate * duration);
    for (let index = 0; index < bass.length; index += 1) {
      const time = index / sampleRate;
      bass[index] = Math.sin(2 * Math.PI * 80 * time) * 0.7;
      mid[index] = Math.sin(2 * Math.PI * 600 * time) * 0.7;
    }
    const bassResult = analyzeBeatSynchronousFeatures(bass, sampleRate, beats);
    const midResult = analyzeBeatSynchronousFeatures(mid, sampleRate, beats);
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(average(midResult.vocalProbabilityByBeat)).toBeGreaterThan(
      average(bassResult.vocalProbabilityByBeat)
    );
  });
});
