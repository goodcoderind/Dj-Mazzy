import { describe, expect, it } from "vitest";
import {
  assessStereoTransitionQuality,
  computeTransitionRehearsalWindow,
  deriveRehearsalSourceCueSeconds
} from "./transitionRehearsal";

describe("transition rehearsal window", () => {
  it("places a normal-rate cue after the requested pre-roll", () => {
    expect(computeTransitionRehearsalWindow(10, 1, 3.5, 2, 2)).toEqual({
      sourceOffsetSeconds: 8,
      transitionStartSeconds: 2,
      transitionEndSeconds: 5.5,
      totalSeconds: 7.5
    });
  });

  it("converts pre-roll from output time into source-track time", () => {
    expect(computeTransitionRehearsalWindow(10, 2, 1, 2, 1)).toEqual({
      sourceOffsetSeconds: 6,
      transitionStartSeconds: 2,
      transitionEndSeconds: 3,
      totalSeconds: 4
    });
    expect(computeTransitionRehearsalWindow(1, 0.5, 1, 4, 1)).toMatchObject({
      sourceOffsetSeconds: 0,
      transitionStartSeconds: 2
    });
  });

  it("rejects malformed timing instead of fabricating a window", () => {
    expect(() => computeTransitionRehearsalWindow(1, 0, 1)).toThrow("finite");
    expect(() => computeTransitionRehearsalWindow(Number.NaN, 1, 1)).toThrow("finite");
  });

  it("derives the source cue from the plan's audio-clock lead", () => {
    expect(deriveRehearsalSourceCueSeconds(10, 1.2, 5, 5.25)).toBeCloseTo(10.3);
    expect(deriveRehearsalSourceCueSeconds(20, 0.8, 5, 7)).toBeCloseTo(21.6);
    expect(deriveRehearsalSourceCueSeconds(10, 1, 5, 4.9)).toBe(10);
    expect(() => deriveRehearsalSourceCueSeconds(Number.NaN, 1, 0, 1)).toThrow("finite");
  });

  it("uses combined stereo energy for silence while retaining channel safety checks", () => {
    const sampleRate = 1_000;
    const left = new Float32Array(400);
    const right = new Float32Array(400);
    left.fill(0.2, 0, 200);
    right.fill(0.2, 200);
    expect(assessStereoTransitionQuality(left, right, sampleRate).reasons).not.toContain(
      "Rendered transition contains an audible silence gap."
    );
    expect(assessStereoTransitionQuality(new Float32Array(400), new Float32Array(400), sampleRate).reasons)
      .toContain("Rendered transition contains an audible silence gap.");
    left[30] = Number.NaN;
    expect(assessStereoTransitionQuality(left, right, sampleRate).reasons)
      .toContain("Rendered transition contains non-finite samples.");
    expect(() => assessStereoTransitionQuality(new Float32Array(2), new Float32Array(3), sampleRate)).toThrow("equal");
  });

});
