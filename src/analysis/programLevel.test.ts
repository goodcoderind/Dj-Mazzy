import { describe, expect, it } from "vitest";
import {
  analyzeProgramLevel,
  deriveCandidateProgramTrim,
  deriveProgramTrim,
  normalizeProgramLevel,
  PARTY_DECODED_PEAK_CEILING_DBTP,
  PARTY_LEVEL_TARGET_LUFS,
} from "./programLevel";

const sine = (
  peakDbfs: number,
  seconds = 5,
  sampleRate = 48_000,
  frequency = 1_000,
  phase = 0
) => {
  const amplitude = 10 ** (peakDbfs / 20);
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, index) =>
    Math.sin(2 * Math.PI * frequency * index / sampleRate + phase) * amplitude
  );
};

const toneSequence = (
  segments: ReadonlyArray<{ peakDbfs: number; seconds: number }>,
  sampleRate = 48_000
) => {
  const channel = new Float32Array(
    Math.round(segments.reduce((total, segment) => total + segment.seconds, 0) * sampleRate)
  );
  let offset = 0;
  for (const segment of segments) {
    const next = sine(segment.peakDbfs, segment.seconds, sampleRate);
    channel.set(next, offset);
    offset += next.length;
  }
  return channel;
};

describe("perceptual program level v4", () => {
  it.each([44_100, 48_000, 96_000])("matches the EBU stereo calibration tone at %i Hz", (sampleRate) => {
    const channel = sine(-18, 5, sampleRate);
    const result = analyzeProgramLevel([channel, channel], sampleRate);
    expect(result.measurement).toMatchObject({
      status: "measured",
      channelCount: 2,
      integratedLufs: -18,
      samplePeakDbfs: -18,
      estimatedTruePeakDbtp: -17.9
    });
    expect(analyzeProgramLevel([channel], sampleRate).measurement.integratedLufs).toBe(-21);
  });

  // Fixed independent reference readings from FFmpeg 8.1.1's ebur128 filter.
  it.each([
    { sampleRate: 44_100, frequency: 50, expected: -22.6 },
    { sampleRate: 48_000, frequency: 50, expected: -22.6 },
    { sampleRate: 96_000, frequency: 50, expected: -22.7 },
    { sampleRate: 44_100, frequency: 10_000, expected: -14.6 },
    { sampleRate: 48_000, frequency: 10_000, expected: -14.6 },
    { sampleRate: 96_000, frequency: 10_000, expected: -14.7 }
  ])("matches the independent K-weighted reference at $sampleRate Hz / $frequency Hz", ({ sampleRate, frequency, expected }) => {
    const channel = sine(-18, 5, sampleRate, frequency);
    const actual = analyzeProgramLevel([channel, channel], sampleRate).measurement.integratedLufs;
    expect(Math.abs((actual ?? Number.POSITIVE_INFINITY) - expected)).toBeLessThanOrEqual(0.1 + Number.EPSILON);
  });

  it.each([
    { name: "absolute calibration", expected: -33, segments: [{ peakDbfs: -33, seconds: 10 }] },
    { name: "relative gate", expected: -23, segments: [
      { peakDbfs: -36, seconds: 10 }, { peakDbfs: -23, seconds: 60 }, { peakDbfs: -36, seconds: 10 }
    ] },
    { name: "absolute and relative gates", expected: -23, segments: [
      { peakDbfs: -72, seconds: 10 }, { peakDbfs: -36, seconds: 10 },
      { peakDbfs: -23, seconds: 60 }, { peakDbfs: -36, seconds: 10 }, { peakDbfs: -72, seconds: 10 }
    ] },
    { name: "power-domain averaging", expected: -23, segments: [
      { peakDbfs: -26, seconds: 20 }, { peakDbfs: -20, seconds: 20.1 }, { peakDbfs: -26, seconds: 20 }
    ] }
  ])("matches the EBU Tech 3341 $name vector", ({ segments, expected }) => {
    const channel = toneSequence(segments);
    expect(analyzeProgramLevel([channel, channel], 48_000).measurement.integratedLufs).toBe(expected);
  });

  it.each([
    { name: "10 LU two-level range", expected: 10, segments: [
      { peakDbfs: -20, seconds: 20 }, { peakDbfs: -30, seconds: 20 }
    ] },
    { name: "5 LU two-level range", expected: 5, segments: [
      { peakDbfs: -20, seconds: 20 }, { peakDbfs: -15, seconds: 20 }
    ] },
    { name: "20 LU two-level range", expected: 20, segments: [
      { peakDbfs: -40, seconds: 20 }, { peakDbfs: -20, seconds: 20 }
    ] },
    { name: "relative-gated five-level range", expected: 15, segments: [
      { peakDbfs: -50, seconds: 20 }, { peakDbfs: -35, seconds: 20 },
      { peakDbfs: -20, seconds: 20 }, { peakDbfs: -35, seconds: 20 },
      { peakDbfs: -50, seconds: 20 }
    ] }
  ])("matches the EBU Tech 3342 $name vector", ({ segments, expected }) => {
    const channel = toneSequence(segments);
    const measurement = analyzeProgramLevel([channel, channel], 48_000).measurement;
    expect(measurement.loudnessRangeLu).toBeGreaterThanOrEqual(expected - 1);
    expect(measurement.loudnessRangeLu).toBeLessThanOrEqual(expected + 1);
    expect(measurement.loudnessRangeStatus).toBe(channel.length / 48_000 < 60 ? "provisional" : "stable");
    expect(measurement.loudnessRangeGatedBlockCount).toBeGreaterThan(0);
  });

  it("uses complete 3-second windows at a 10 Hz cadence and marks early LRA provisional", () => {
    const short = analyzeProgramLevel([sine(-23, 2.999)], 48_000).measurement;
    expect(short).toMatchObject({
      shortTermBlockCount: 0,
      shortTermMinimumLufs: null,
      shortTermMaximumLufs: null,
      loudnessRangeLu: null,
      loudnessRangeStatus: "unavailable"
    });
    const exact = analyzeProgramLevel([sine(-23, 3)], 48_000).measurement;
    expect(exact).toMatchObject({
      shortTermWindowSeconds: 3,
      shortTermHopSeconds: 0.1,
      shortTermBlockCount: 1,
      shortTermMinimumLufs: -26,
      shortTermMaximumLufs: -26,
      loudnessRangeLu: 0,
      loudnessRangeGatedBlockCount: 1,
      loudnessRangeStatus: "provisional"
    });
    const stable = analyzeProgramLevel([sine(-23, 60)], 48_000).measurement;
    expect(stable.shortTermBlockCount).toBe(571);
    expect(stable.loudnessRangeStatus).toBe("stable");
  });

  it("keeps stereo channels independent of phase and channel order", () => {
    const left = sine(-18);
    const right = sine(-24, 5, 48_000, 1_000, Math.PI);
    const forward = analyzeProgramLevel([left, right], 48_000);
    const swapped = analyzeProgramLevel([right, left], 48_000);
    expect(forward.measurement.integratedLufs).toBe(swapped.measurement.integratedLufs);
    expect(forward.measurement.samplePeakDbfs).toBe(-18);
    const inPhase = analyzeProgramLevel([left, sine(-24)], 48_000);
    expect(forward.measurement.integratedLufs).toBe(inPhase.measurement.integratedLufs);
  });

  it("measures a loud right channel that the rhythm mono signal would miss", () => {
    const silence = new Float32Array(48_000 * 5);
    const right = sine(-12);
    const stereo = analyzeProgramLevel([silence, right], 48_000);
    const mono = analyzeProgramLevel([right], 48_000);
    expect(stereo.measurement.integratedLufs).toBe(mono.measurement.integratedLufs);
    expect(stereo.measurement.samplePeakDbfs).toBe(-12);
  });

  it("applies the absolute and relative gates to 400 ms blocks", () => {
    const sampleRate = 48_000;
    const quiet = sine(-36, 2, sampleRate, 1_000);
    const active = sine(-23, 6, sampleRate, 1_000);
    const channel = new Float32Array(quiet.length * 2 + active.length);
    channel.set(quiet, 0);
    channel.set(active, quiet.length);
    channel.set(quiet, quiet.length + active.length);
    const result = analyzeProgramLevel([channel, channel], sampleRate);
    expect(result.measurement.integratedLufs).toBeGreaterThanOrEqual(-23.3);
    expect(result.measurement.integratedLufs).toBeLessThanOrEqual(-23);
    expect(result.measurement.absoluteGatedBlockCount).toBeGreaterThan(result.measurement.relativeGatedBlockCount);
    expect(result.measurement.relativeGatedBlockCount).toBeGreaterThan(0);
  });

  it("excludes an incomplete terminal block from loudness but still scans its sample peak", () => {
    const channel = sine(-6, 0.399, 48_000);
    const result = analyzeProgramLevel([channel], 48_000);
    expect(result.measurement).toMatchObject({
      status: "silence",
      integratedLufs: null,
      samplePeakDbfs: -6,
      estimatedTruePeakDbtp: -5.9,
      absoluteGatedBlockCount: 0
    });
    expect(result.normalization.trimDb).toBe(0);
  });

  it("fails closed for invalid samples, unequal channels, and unsupported layouts", () => {
    const good = sine(-18, 1);
    const invalid = new Float32Array(good);
    invalid[100] = Number.NaN;
    expect(analyzeProgramLevel([invalid], 48_000).measurement.status).toBe("invalid-input");
    expect(analyzeProgramLevel([good, good.subarray(1)], 48_000).measurement.status).toBe("invalid-input");
    expect(analyzeProgramLevel([good, good], 48_000, 6).measurement.status).toBe("unsupported-channels");
  });

  it("keeps trim policy separate, bounded, and decoded-peak limited", () => {
    const measured = analyzeProgramLevel([sine(-30)], 48_000).measurement;
    const trim = deriveProgramTrim(measured);
    expect(trim).toMatchObject({
      targetLufs: PARTY_LEVEL_TARGET_LUFS,
      decodedPeakCeilingDbtp: PARTY_DECODED_PEAK_CEILING_DBTP
    });
    expect(trim.trimDb).toBeGreaterThanOrEqual(-6);
    expect(trim.trimDb).toBeLessThanOrEqual(3);
    expect((measured.estimatedTruePeakDbtp ?? 0) + trim.trimDb).toBeLessThanOrEqual(PARTY_DECODED_PEAK_CEILING_DBTP);
    const boundaryTrim = deriveProgramTrim({
      ...measured,
      integratedLufs: -20,
      samplePeakDbfs: -2.05,
      estimatedTruePeakDbtp: -2.05
    });
    expect(boundaryTrim.trimDb).toBe(0);
    expect(-2.05 + boundaryTrim.trimDb).toBeLessThanOrEqual(PARTY_DECODED_PEAK_CEILING_DBTP);
  });

  it("uses intersample rather than sample peak to constrain boost", () => {
    const sampleRate = 48_000;
    const channel = sine(-3, 1, sampleRate, 12_000, Math.PI / 4);
    const analysis = analyzeProgramLevel([channel], sampleRate);
    expect(analysis.measurement.samplePeakDbfs).toBeCloseTo(-6, 1);
    expect(analysis.measurement.estimatedTruePeakDbtp).toBeCloseTo(-2.9, 1);
    expect(analysis.normalization.trimDb).toBeLessThanOrEqual(0.9);
    expect(
      (analysis.measurement.estimatedTruePeakDbtp ?? 0) + analysis.normalization.trimDb
    ).toBeLessThanOrEqual(PARTY_DECODED_PEAK_CEILING_DBTP);
  });

  it("keeps listening-only target candidates inside the same trim and peak bounds", () => {
    const measurement = analyzeProgramLevel([sine(-24)], 48_000).measurement;
    expect(deriveCandidateProgramTrim(measurement, -16).trimDb).toBe(3);
    const hot = { ...measurement, integratedLufs: -20, estimatedTruePeakDbtp: -1.95 };
    expect(deriveCandidateProgramTrim(hot, -12).trimDb).toBe(-0.1);
    expect(() => deriveCandidateProgramTrim(measurement, Number.NaN)).toThrow(RangeError);
    expect(() => deriveCandidateProgramTrim(measurement, 1)).toThrow(RangeError);
  });

  it("rejects stale or hostile persisted records instead of trusting their trim", () => {
    expect(normalizeProgramLevel({
      schemaVersion: "program-level/v2",
      activeRmsDbfs: -14,
      trimDb: 3
    })).toBeNull();
    const valid = analyzeProgramLevel([sine(-18)], 48_000);
    expect(normalizeProgramLevel(valid)).toEqual(valid);
    expect(normalizeProgramLevel({ ...valid, schemaVersion: "program-level/v3" })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      normalization: { ...valid.normalization, trimDb: Number.NaN }
    })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      measurement: {
        ...valid.measurement,
        decodedPeakAlgorithmVersion: "caller-claimed-peak/v1"
      }
    })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      measurement: {
        ...valid.measurement,
        estimatedTruePeakDbtp: (valid.measurement.samplePeakDbfs ?? 0) - 1
      }
    })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      normalization: { ...valid.normalization, decodedPeakCeilingDbtp: 0 }
    })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      measurement: { ...valid.measurement, shortTermBlockCount: valid.measurement.shortTermBlockCount + 1 }
    })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      measurement: { ...valid.measurement, loudnessRangeStatus: "stable" }
    })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      measurement: { ...valid.measurement, loudnessRangeLu: -1 }
    })).toBeNull();
    expect(normalizeProgramLevel({
      ...valid,
      measurement: { ...valid.measurement, loudnessRangeLu: 100 }
    })).toBeNull();
  });

  it("round-trips every terminal result for extreme finite PCM", () => {
    const veryQuiet = sine(-170, 1);
    const veryHot = Float32Array.from({ length: 48_000 }, () => 100);
    const maximum = Float32Array.from({ length: 48_000 }, () => 3.402823466e38);
    for (const channel of [new Float32Array(48_000), veryQuiet, veryHot, maximum]) {
      const result = analyzeProgramLevel([channel], 48_000);
      expect(normalizeProgramLevel(result)).toEqual(result);
    }
    const short = analyzeProgramLevel([sine(-6, 0.1)], 48_000);
    expect(normalizeProgramLevel(short)).toEqual(short);
    const unsupported = analyzeProgramLevel([sine(-6)], 48_000, 6);
    expect(normalizeProgramLevel(unsupported)).toEqual(unsupported);
  });
});
