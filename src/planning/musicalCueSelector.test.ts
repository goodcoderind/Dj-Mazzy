import { describe, expect, it } from "vitest";
import { rankTrustedMusicalCuePairs, rankTrustedMusicalCues } from "./musicalCueSelector";

const track = () => ({
  duration: 120,
  beatsSeconds: Array.from({ length: 240 }, (_, index) => index * 0.5),
  automaticRhythmTrust: { usableCutBeatIndices: [0, 4, 8, 20, 160] },
  energyByBeat: Array(240).fill(0.55),
  vocalProbabilityByBeat: Array(240).fill(0.6),
  structureBoundaries: [] as Array<{ beatIndex: number; confidence: number }>
});

describe("role-aware musical cue ranking", () => {
  it("ranks only already-trusted timing cues", () => {
    const input = track();
    input.vocalProbabilityByBeat.fill(0, 12, 20);
    const ranked = rankTrustedMusicalCues(input, "incoming");
    expect(ranked.map((cue) => cue.beatIndex)).not.toContain(12);
    expect(ranked.every((cue) => input.automaticRhythmTrust.usableCutBeatIndices.includes(cue.beatIndex))).toBe(true);
  });

  it("prefers a lower vocal-frequency-proxy opening cue without jumping deep into the song", () => {
    const input = track();
    input.vocalProbabilityByBeat.fill(0.1, 8, 16);
    input.structureBoundaries.push({ beatIndex: 8, confidence: 0.6 });
    const ranked = rankTrustedMusicalCues(input, "incoming");
    expect(ranked[0]).toMatchObject({ beatIndex: 8, nearStructureBoundary: true });
    expect(ranked.map((cue) => cue.beatIndex)).not.toContain(160);
  });

  it("keeps outgoing selection within the scheduling horizon", () => {
    const ranked = rankTrustedMusicalCues(track(), "outgoing", {
      minimumTimeSeconds: 1,
      maximumWaitSeconds: 5
    });
    expect(ranked.map((cue) => cue.timeSeconds)).toEqual(expect.arrayContaining([2, 4]));
    expect(ranked.every((cue) => cue.timeSeconds <= 6)).toBe(true);
  });

  it("uses deterministic timing-only fallbacks when soft features are absent", () => {
    const input = track();
    const ranked = rankTrustedMusicalCues({
      ...input,
      energyByBeat: [],
      vocalProbabilityByBeat: [],
      structureBoundaries: []
    }, "incoming");
    expect(ranked[0].beatIndex).toBe(0);
    expect(ranked[0].reason).toBe("Best available trusted timing cue.");
  });

  it("uses the earliest schedulable outgoing cue when soft evidence is absent", () => {
    const input = track();
    const ranked = rankTrustedMusicalCues({
      ...input,
      energyByBeat: [],
      vocalProbabilityByBeat: [],
      structureBoundaries: []
    }, "outgoing", { minimumTimeSeconds: 1, maximumWaitSeconds: 12 });
    expect(ranked[0].beatIndex).toBe(4);
  });

  it("prefers a musically continuous pair over independently loudest choices", () => {
    const source = track();
    const target = track();
    source.automaticRhythmTrust.usableCutBeatIndices = [4, 8];
    target.automaticRhythmTrust.usableCutBeatIndices = [0, 4];
    source.energyByBeat.fill(0.9, 4, 12);
    source.energyByBeat.fill(0.4, 8, 16);
    target.energyByBeat.fill(0.4, 0, 8);
    target.energyByBeat.fill(0.9, 4, 12);
    source.vocalProbabilityByBeat.fill(0.2);
    target.vocalProbabilityByBeat.fill(0.2);
    const ranked = rankTrustedMusicalCuePairs(source, target, {
      minimumTimeSeconds: 1,
      maximumWaitSeconds: 10
    });
    expect(ranked[0].energyDifference).toBeLessThanOrEqual(0.15);
    expect(ranked[0].reason).toContain("Matched-energy");
  });
});
