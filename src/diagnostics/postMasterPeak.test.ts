import { describe, expect, it } from "vitest";
import { assessPostMasterPeak } from "./postMasterPeak";

describe("post-master peak check", () => {
  it("accepts bounded stereo output and records the exact evidence contract", () => {
    const tone = Float32Array.from({ length: 48_000 }, (_, frame) =>
      0.5 * Math.sin(2 * Math.PI * 1_000 * frame / 48_000)
    );
    expect(assessPostMasterPeak([tone, tone], 48_000)).toMatchObject({
      schemaVersion: "post-master-peak-check/v2",
      requiredMasterVersion: "mazzy-master/v1",
      outputStage: "post-limiter",
      samplePeakDbfs: -6,
      estimatedTruePeakDbtp: -6,
      ceilingDbtp: -1,
      passed: true,
      failureCodes: []
    });
  });

  it("fails an intersample overload even when stored samples do not clip", () => {
    const amplitude = 1;
    const channel = Float32Array.from({ length: 48_000 }, (_, frame) =>
      amplitude * Math.sin(2 * Math.PI * 12_000 * frame / 48_000 + Math.PI / 4)
    );
    const result = assessPostMasterPeak([channel, channel], 48_000);
    expect(result.samplePeakDbfs).toBeLessThan(0);
    expect(result.estimatedTruePeakDbtp).toBeGreaterThan(0);
    expect(result.failureCodes).toContain("post-master-estimated-true-peak-overload");
    expect(result.passed).toBe(false);
  });

  it("fails closed for silence, malformed channels, and non-finite samples", () => {
    expect(assessPostMasterPeak([
      new Float32Array(32),
      new Float32Array(32)
    ], 48_000).failureCodes).toContain("no-signal");
    expect(() => assessPostMasterPeak([
      new Float32Array(2),
      new Float32Array(3)
    ], 48_000)).toThrow(RangeError);
    expect(() => assessPostMasterPeak([
      Float32Array.of(0, Number.NaN),
      new Float32Array(2)
    ], 48_000)).toThrow(RangeError);
  });
});
