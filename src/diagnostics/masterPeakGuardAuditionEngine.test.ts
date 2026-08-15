import { describe, expect, it } from "vitest";
import { validateMasterPeakGuardAuditionPcm } from "./masterPeakGuardAuditionEngine";

describe("diagnostics-only master peak-guard audition boundary", () => {
  it("requires native-rate finite stereo PCM at or below -6 dBTP", () => {
    const quiet = Float32Array.from({ length: 48_000 }, (_, frame) =>
      0.4 * Math.sin(2 * Math.PI * 1_000 * frame / 48_000));
    const hot = Float32Array.from({ length: 48_000 }, (_, frame) =>
      0.8 * Math.sin(2 * Math.PI * 1_000 * frame / 48_000));
    expect(validateMasterPeakGuardAuditionPcm([quiet, quiet], 48_000, 48_000)).toBe(true);
    expect(validateMasterPeakGuardAuditionPcm([hot, hot], 48_000, 48_000)).toBe(false);
    expect(validateMasterPeakGuardAuditionPcm([quiet, quiet], 44_100, 48_000)).toBe(false);
    expect(validateMasterPeakGuardAuditionPcm([
      Float32Array.from([0, Number.NaN]),
      Float32Array.from([0, 0])
    ], 48_000, 48_000)).toBe(false);
  });
});
