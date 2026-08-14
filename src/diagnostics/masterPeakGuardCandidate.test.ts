import { describe, expect, it } from "vitest";
import {
  buildMasterPeakGuardCurve,
  MASTER_PEAK_GUARD_CANDIDATE
} from "./masterPeakGuardCandidate";

describe("diagnostics-only master peak-guard candidate", () => {
  it("is identity below its ceiling and bounded above it", () => {
    const curve = buildMasterPeakGuardCurve();
    const ceiling = 10 ** (MASTER_PEAK_GUARD_CANDIDATE.sampleCeilingDbfs / 20);
    expect(curve.length).toBe(65_537);
    expect(curve[curve.length >> 1]).toBe(0);
    const quarter = curve[Math.round((0.25 + 1) / 2 * (curve.length - 1))];
    expect(quarter).toBeCloseTo(0.25, 6);
    expect(curve[0]).toBeCloseTo(-ceiling, 6);
    expect(curve.at(-1)).toBeCloseTo(ceiling, 6);
    expect(Math.max(...curve)).toBeLessThanOrEqual(ceiling + 1e-7);
  });
});
