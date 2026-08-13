import { describe, expect, it } from "vitest";
import { assessAutomaticRhythmTrust } from "./automaticRhythmTrust";

const regularGrid = (beatCount = 96, interval = 0.5) => {
  const beatsSeconds = Array.from({ length: beatCount }, (_, index) => index * interval);
  return {
    durationSeconds: beatCount * interval,
    beatsSeconds,
    downbeatsSeconds: beatsSeconds.filter((_, index) => index % 4 === 0),
    energyByBeat: beatsSeconds.map(() => 0.8)
  };
};

describe("automatic rhythm trust", () => {
  it("identifies a machine-only long candidate without granting calibrated confidence", () => {
    const result = assessAutomaticRhythmTrust(regularGrid());
    expect(result).toMatchObject({
      schemaVersion: "automatic-rhythm-trust/v2",
      tier: "long-candidate",
      calibrationVersion: null,
      calibratedSafeProbability: null
    });
    expect(result.trustIndex).toBe(100);
    expect(result.complete32BeatWindows).toBeGreaterThan(0);
  });

  it("rejects malformed events and rhythm over silence", () => {
    const malformed = regularGrid();
    malformed.beatsSeconds[3] = malformed.beatsSeconds[2];
    expect(assessAutomaticRhythmTrust(malformed).tier).toBe("reject");
    expect(assessAutomaticRhythmTrust({ ...regularGrid(), energyByBeat: Array(96).fill(0) })).toMatchObject({
      tier: "reject",
      hardFailures: ["The signal has too little rhythmic activity."]
    });
  });

  it("does not hide an absent downbeat grid behind regular beat spacing", () => {
    const result = assessAutomaticRhythmTrust({ ...regularGrid(), downbeatsSeconds: [] });
    expect(result.tier).toBe("boundary-only");
    expect(result.trustIndex).toBe(0);
    expect(result.reasons).toContain("No automatic bar-start grid is available.");
  });

  it("trusts a locally fitted quantized grid without accumulating whole-track phase error", () => {
    const beatsSeconds = Array.from({ length: 480 }, (_, index) =>
      index === 0 ? 0 : Number((index * (60 / 138.9) + (index % 3 - 1) * 0.01).toFixed(2))
    );
    const result = assessAutomaticRhythmTrust({
      durationSeconds: (beatsSeconds.at(-1) ?? 0) + 1,
      beatsSeconds,
      downbeatsSeconds: beatsSeconds.filter((_, index) => index % 4 === 0),
      energyByBeat: beatsSeconds.map(() => 0.8)
    });
    expect(["bar-cut-candidate", "long-candidate"]).toContain(result.tier);
    expect(result.usableCutBeatIndices.length).toBeGreaterThan(0);
  });

  it("does not reuse signal evidence from a different beat grid", () => {
    expect(assessAutomaticRhythmTrust({ ...regularGrid(), energyByBeat: [0.8] })).toMatchObject({
      tier: "reject",
      hardFailures: ["Beat-aligned signal evidence is unavailable."]
    });
  });
});
