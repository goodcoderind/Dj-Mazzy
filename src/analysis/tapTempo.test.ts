import { describe, expect, it } from "vitest";
import { appendTap, applyTapTempo, estimateTapTempo, MIN_TAP_COUNT } from "./tapTempo";

describe("non-DJ tap tempo repair", () => {
  it("requires enough increasing taps and estimates a steady pulse", () => {
    expect(estimateTapTempo(Array.from({ length: MIN_TAP_COUNT - 1 }, (_, index) => index * 0.5))).toBeNull();
    const estimate = estimateTapTempo([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
    expect(estimate).toMatchObject({ bpm: 120, firstBeatSeconds: 2, quality: "steady" });
  });

  it("rejects one accidental early tap without moving the median pulse", () => {
    const estimate = estimateTapTempo([0, 0.5, 1, 1.5, 1.61, 2, 2.5, 3, 3.5, 4]);
    expect(estimate?.bpm).toBeCloseTo(120);
    expect(estimate?.keptIntervalCount).toBeGreaterThanOrEqual(4);
  });

  it("starts a fresh sequence after a long gap or backwards seek", () => {
    expect(appendTap([1, 1.5], 5)).toEqual([5]);
    expect(appendTap([1, 1.5], 0.2)).toEqual([0.2]);
  });

  it("creates a manual grid but explicitly keeps Auto Mix disabled", () => {
    const estimate = estimateTapTempo([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]);
    expect(estimate).not.toBeNull();
    const overrides = applyTapTempo({ durationSeconds: 10, bpm: null, beatsSeconds: [] }, estimate!);
    expect(overrides.correctedBpm).toBe(120);
    expect(overrides.firstBeatSeconds).toBe(1);
    expect(overrides.autoMixDisabled).toBe(true);
  });
});
