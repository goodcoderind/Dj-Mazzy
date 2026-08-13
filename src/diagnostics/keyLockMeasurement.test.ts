import { describe, expect, it } from "vitest";
import { carrierProminenceDb, estimateCarrierFrequency, estimatePulseRate, stereoLeakageDb } from "./keyLockMeasurement";

const fixture = (sampleRate: number, carrier: number, pulseRate: number, seconds = 0.8) => {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    const pulse = Math.sin(2 * Math.PI * pulseRate * index / sampleRate) >= 0 ? 1 : 0.25;
    samples[index] = Math.sin(2 * Math.PI * carrier * index / sampleRate) * 0.03 * pulse;
  }
  return samples;
};

describe("key-lock browser measurement primitives", () => {
  for (const sampleRate of [44_100, 48_000]) {
    it(`recovers distinct stereo pitch, tempo, and separation at ${sampleRate} Hz`, () => {
      for (const rate of [0.94, 1, 1.06]) {
        const left = fixture(sampleRate, 440, 16 * rate);
        const right = fixture(sampleRate, 660, 16 * rate);
        expect(estimateCarrierFrequency(left.subarray(0, 8192), sampleRate, 440)).toBeCloseTo(440, 1);
        expect(estimateCarrierFrequency(right.subarray(0, 8192), sampleRate, 660)).toBeCloseTo(660, 1);
        expect(Math.abs(estimatePulseRate(left, sampleRate) - 16 * rate)).toBeLessThan(0.01);
        expect(Math.abs(estimatePulseRate(right, sampleRate) - 16 * rate)).toBeLessThan(0.01);
        expect(stereoLeakageDb(left, right, sampleRate)).toBeLessThan(-30);
        expect(carrierProminenceDb(left, sampleRate, 440)).toBeGreaterThan(15);
        expect(carrierProminenceDb(right, sampleRate, 660)).toBeGreaterThan(15);
      }
    });
  }

  it("detects deliberate stereo crossfeed", () => {
    const sampleRate = 48_000;
    const left = fixture(sampleRate, 440, 16);
    const right = fixture(sampleRate, 660, 16);
    const crossedLeft = Float32Array.from(left, (value, index) => value + right[index] * 0.1);
    expect(stereoLeakageDb(crossedLeft, right, sampleRate)).toBeGreaterThan(-25);
  });

  it("rejects off-target energy as weak carrier evidence", () => {
    const noise = fixture(48_000, 520, 16);
    expect(carrierProminenceDb(noise, 48_000, 440)).toBeLessThan(15);
  });
});
