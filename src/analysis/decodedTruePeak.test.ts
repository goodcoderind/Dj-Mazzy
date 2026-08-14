import { describe, expect, it } from "vitest";
import { estimateDecodedTruePeakLinear } from "./decodedTruePeak";

const amplitudeForDb = (value: number) => 10 ** (value / 20);
const db = (value: number) => 20 * Math.log10(value);

describe("decoded true-peak estimate", () => {
  it("never reports below the decoded sample peak", () => {
    const impulse = new Float32Array(48);
    impulse[24] = 1;
    expect(estimateDecodedTruePeakLinear([impulse])).toBe(1);
  });

  it("finds an intersample peak hidden by quarter-rate sample phase", () => {
    const sampleRate = 48_000;
    const amplitude = amplitudeForDb(-3);
    const samples = Float32Array.from(
      { length: sampleRate },
      (_, frame) => amplitude * Math.sin(2 * Math.PI * 12_000 * frame / sampleRate + Math.PI / 4)
    );
    const samplePeak = Math.max(...samples.map((sample) => Math.abs(sample)));
    const estimatedPeak = estimateDecodedTruePeakLinear([samples]);
    expect(db(samplePeak)).toBeCloseTo(-6.01, 1);
    expect(db(estimatedPeak)).toBeCloseTo(-2.92, 1);
    expect(estimatedPeak).toBeGreaterThan(samplePeak);
  });

  it("measures the loudest channel independently", () => {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    right[64] = 0.75;
    expect(estimateDecodedTruePeakLinear([left, right])).toBeCloseTo(0.75);
  });

  it("rejects malformed or non-finite channel input", () => {
    expect(() => estimateDecodedTruePeakLinear([])).toThrow(RangeError);
    expect(() => estimateDecodedTruePeakLinear([
      new Float32Array(2),
      new Float32Array(3)
    ])).toThrow(RangeError);
    expect(() => estimateDecodedTruePeakLinear([
      Float32Array.of(0, Number.NaN)
    ])).toThrow(RangeError);
  });
});
