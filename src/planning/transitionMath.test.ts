import { describe, expect, it } from "vitest";
import {
  createEqualPowerCurves,
  equalPowerGains,
  minimumConfidence,
  octaveAwareTempoMatch,
  playbackRateForBpm,
  secondsForBeats,
  stretchSeverity
} from "./transitionMath";

describe("transition timing", () => {
  it("expresses transition duration in beats", () => {
    expect(secondsForBeats(32, 120)).toBe(16);
    expect(secondsForBeats(16, 150)).toBeCloseTo(6.4);
  });

  it("computes playback rate from original and target BPM", () => {
    expect(playbackRateForBpm(120, 126)).toBeCloseTo(1.05);
  });

  it("rejects invalid musical timing inputs", () => {
    expect(() => secondsForBeats(0, 120)).toThrow(RangeError);
    expect(() => playbackRateForBpm(120, Number.NaN)).toThrow(RangeError);
  });
});

describe("octave-aware tempo matching", () => {
  it("matches half-time and double-time candidates", () => {
    expect(octaveAwareTempoMatch(140, 70)).toEqual({
      adjustedBpm: 140,
      distance: 0,
      octaveShift: 1
    });
    expect(octaveAwareTempoMatch(70, 140)).toEqual({
      adjustedBpm: 70,
      distance: 0,
      octaveShift: -1
    });
  });
});

describe("equal-power automation", () => {
  it("has exact endpoints and a balanced midpoint", () => {
    expect(equalPowerGains(0)).toEqual({ source: 1, target: 0 });
    expect(equalPowerGains(1).source).toBeCloseTo(0, 10);
    expect(equalPowerGains(1).target).toBe(1);
    expect(equalPowerGains(0.5).source).toBeCloseTo(Math.SQRT1_2);
    expect(equalPowerGains(0.5).target).toBeCloseTo(Math.SQRT1_2);
  });

  it("creates deterministic, monotonic automation curves", () => {
    const first = createEqualPowerCurves(32);
    const second = createEqualPowerCurves(32);
    expect(Array.from(first.source)).toEqual(Array.from(second.source));
    expect(Array.from(first.target)).toEqual(Array.from(second.target));
    expect(first.source[0]).toBe(1);
    expect(first.target[31]).toBe(1);

    for (let index = 1; index < first.source.length; index += 1) {
      expect(first.source[index]).toBeLessThanOrEqual(first.source[index - 1]);
      expect(first.target[index]).toBeGreaterThanOrEqual(first.target[index - 1]);
    }
  });
});

describe("transition safety helpers", () => {
  it("uses the weakest confidence as the plan confidence", () => {
    expect(minimumConfidence([0.92, 0.84, 0.61, 0.8])).toBe(0.61);
  });

  it("classifies stretch severity against documented starting targets", () => {
    expect(stretchSeverity(1.04)).toBe("preferred");
    expect(stretchSeverity(0.92)).toBe("allowed");
    expect(stretchSeverity(1.12)).toBe("reject");
  });
});
