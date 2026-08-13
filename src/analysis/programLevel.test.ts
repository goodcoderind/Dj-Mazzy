import { describe, expect, it } from "vitest";
import { analyzeProgramLevel } from "./programLevel";

const sine = (amplitude: number, seconds = 2, sampleRate = 1_000) =>
  Float32Array.from({ length: seconds * sampleRate }, (_, index) =>
    Math.sin(2 * Math.PI * 20 * index / sampleRate) * amplitude
  );

describe("conservative program level trim", () => {
  it("attenuates a loud track and never exceeds the peak ceiling", () => {
    const result = analyzeProgramLevel([sine(0.8)], 1_000);
    expect(result.activeRmsDbfs).toBeCloseTo(-4.9, 1);
    expect(result.trimDb).toBe(-6);
  });

  it("limits quiet-track boost to three decibels", () => {
    expect(analyzeProgramLevel([sine(0.05)], 1_000).trimDb).toBe(3);
  });

  it("does not boost silence or invalid samples", () => {
    const result = analyzeProgramLevel([Float32Array.from([0, Number.NaN, 0, 0])], 10);
    expect(result).toMatchObject({ activeRmsDbfs: null, trimDb: 0, activeBlockCount: 0 });
  });

  it("does not mistake phase-opposed stereo for silence", () => {
    const left = sine(0.25);
    const right = Float32Array.from(left, (sample) => -sample);
    const result = analyzeProgramLevel([left, right], 1_000);
    expect(result.activeRmsDbfs).not.toBeNull();
    expect(result.activeBlockCount).toBeGreaterThan(0);
  });
});
