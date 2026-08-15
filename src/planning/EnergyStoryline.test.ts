import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_ENERGY_CURVE,
  createHostEnergyCurve,
  rankEnergyStorylineCandidates,
  scoreEnergyStorylineCandidate,
  summarizeTrackEnergy,
  targetEnergyAtProgress
} from "./EnergyStoryline";

describe("Energy Storyline", () => {
  it("interpolates the host's four stages at fixed session positions", () => {
    const curve = createHostEnergyCurve({ warmUp: 0.2, build: 0.6, peak: 1, cooldown: 0.3 });

    expect(targetEnergyAtProgress(curve, 0)).toBe(0.2);
    expect(targetEnergyAtProgress(curve, 0.2)).toBeCloseTo(0.4);
    expect(targetEnergyAtProgress(curve, 0.4)).toBe(0.6);
    expect(targetEnergyAtProgress(curve, 0.575)).toBeCloseTo(0.8);
    expect(targetEnergyAtProgress(curve, 0.75)).toBe(1);
    expect(targetEnergyAtProgress(curve, 1)).toBeCloseTo(0.3);
  });

  it("clamps elapsed progress but rejects non-finite progress", () => {
    expect(targetEnergyAtProgress(DEFAULT_HOST_ENERGY_CURVE, -1)).toBe(
      DEFAULT_HOST_ENERGY_CURVE.warmUp
    );
    expect(targetEnergyAtProgress(DEFAULT_HOST_ENERGY_CURVE, 2)).toBeCloseTo(
      DEFAULT_HOST_ENERGY_CURVE.cooldown
    );
    expect(() => targetEnergyAtProgress(DEFAULT_HOST_ENERGY_CURVE, Number.NaN)).toThrow(
      "Session progress"
    );
  });

  it("rejects levels that contradict the named host curve", () => {
    expect(() => createHostEnergyCurve({ warmUp: 0.7, build: 0.5, peak: 0.9, cooldown: 0.3 }))
      .toThrow("must not decrease");
    expect(() => createHostEnergyCurve({ warmUp: 0.2, build: 0.5, peak: 0.8, cooldown: 0.9 }))
      .toThrow("must not exceed peak");
    expect(() => createHostEnergyCurve({ warmUp: -0.1, build: 0.5, peak: 0.8, cooldown: 0.3 }))
      .toThrow("from 0 to 1");
  });

  it("summarizes bounded beat energy with a transparent arithmetic mean", () => {
    expect(summarizeTrackEnergy([0.2, 0.4, 0.6, 0.8])).toEqual({
      status: "available",
      meanEnergy: 0.5,
      sampleCount: 4,
      invalidSampleCount: 0
    });
  });

  it("does not manufacture a neutral score for missing or malformed evidence", () => {
    const missing = scoreEnergyStorylineCandidate(
      { id: "missing", energyByBeat: [] },
      DEFAULT_HOST_ENERGY_CURVE,
      0.4
    );
    const malformed = scoreEnergyStorylineCandidate(
      { id: "malformed", energyByBeat: [0.4, Number.NaN, 1.2] },
      DEFAULT_HOST_ENERGY_CURVE,
      0.4
    );

    expect(missing).toMatchObject({
      evidenceStatus: "missing",
      trackEnergy: null,
      deviation: null,
      heuristicFit: null
    });
    expect(malformed).toMatchObject({
      evidenceStatus: "malformed",
      trackEnergy: null,
      deviation: null,
      heuristicFit: null
    });
  });

  it("scores normalized closeness without calling it confidence or probability", () => {
    const result = scoreEnergyStorylineCandidate(
      { id: "candidate", energyByBeat: [0.5, 0.7] },
      { warmUp: 0.2, build: 0.6, peak: 0.9, cooldown: 0.4 },
      0.4
    );

    expect(result).toMatchObject({
      targetEnergy: 0.6,
      trackEnergy: 0.6,
      deviation: 0,
      heuristicFit: 1,
      evidenceStatus: "available",
      reason: "Relative beat activity is on the storyline target."
    });
    expect(result).not.toHaveProperty("confidence");
    expect(result).not.toHaveProperty("probability");
  });

  it("ranks available candidates by fit, leaves unavailable evidence last, and preserves ties", () => {
    const candidates = [
      { id: "first-tie", energyByBeat: [0.5] },
      { id: "missing", energyByBeat: [] },
      { id: "closest", energyByBeat: [0.6] },
      { id: "second-tie", energyByBeat: [0.7] }
    ];
    const snapshot = structuredClone(candidates);
    const ranked = rankEnergyStorylineCandidates(
      candidates,
      { warmUp: 0.2, build: 0.6, peak: 0.9, cooldown: 0.4 },
      0.4
    );

    expect(ranked.map(({ track }) => track.id)).toEqual([
      "closest",
      "first-tie",
      "second-tie",
      "missing"
    ]);
    expect(candidates).toEqual(snapshot);
  });
});
