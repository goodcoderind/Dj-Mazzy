import { describe, expect, it } from "vitest";
import { evaluateKeyLockSmoke, KEY_LOCK_SMOKE_PULSE_HZ, KEY_LOCK_SMOKE_RATES } from "./keyLockSmoke";

const measurement = (rate: number) => ({
  rate,
  frequencyHz: 440,
  centsError: 0,
  rightFrequencyHz: 660,
  rightCentsError: 0,
  stereoLeakageDb: -80,
  pulseRateHz: KEY_LOCK_SMOKE_PULSE_HZ * rate,
  rightPulseRateHz: KEY_LOCK_SMOKE_PULSE_HZ * rate,
  expectedPulseRateHz: KEY_LOCK_SMOKE_PULSE_HZ * rate,
  tempoErrorPercent: 0,
  rightTempoErrorPercent: 0,
  leftOnsetErrorMs: 0,
  rightOnsetErrorMs: 0,
  leftPreStartPeak: 0,
  rightPreStartPeak: 0,
  armedLeadMs: 50,
  finite: true,
  leftPeak: 0.03,
  rightPeak: 0.03,
  channelBalanceDb: 0,
  leftCarrierProminenceDb: 40,
  rightCarrierProminenceDb: 40
});

describe("key-lock synthetic smoke evaluator", () => {
  it("requires the complete finite pitch-and-tempo rate set", () => {
    expect(evaluateKeyLockSmoke(48_000, KEY_LOCK_SMOKE_RATES.map(measurement))).toEqual({
      passed: true,
      failureCodes: []
    });
    expect(evaluateKeyLockSmoke(48_000, KEY_LOCK_SMOKE_RATES.slice(1).map(measurement)).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, [measurement(0.94), measurement(1), measurement(1)]).passed).toBe(false);
  });

  it("fails on silence, clipping, wrong pitch, unchanged tempo, or unsupported sample rate", () => {
    const base = KEY_LOCK_SMOKE_RATES.map(measurement);
    expect(evaluateKeyLockSmoke(32_000, base).failureCodes).toContain("unsupported-sample-rate");
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, leftPeak: 0 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, rightPeak: 0 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, rightPeak: 1.1 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, centsError: 11 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, frequencyHz: 460 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, rightFrequencyHz: 700 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, stereoLeakageDb: -20 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, rightOnsetErrorMs: 14 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, leftOnsetErrorMs: -0.1 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, rightPreStartPeak: 0.01 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, armedLeadMs: 24 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, channelBalanceDb: -20 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell :
      { ...cell, leftPeak: 0.015, rightPeak: 0.0011, channelBalanceDb: 0 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell, index) => index ? cell : { ...cell, rightCarrierProminenceDb: 10 })).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell) => ({
      ...cell,
      pulseRateHz: KEY_LOCK_SMOKE_PULSE_HZ,
      tempoErrorPercent: Math.abs(KEY_LOCK_SMOKE_PULSE_HZ - cell.expectedPulseRateHz) / cell.expectedPulseRateHz * 100
    }))).passed).toBe(false);
    expect(evaluateKeyLockSmoke(48_000, base.map((cell) => ({
      ...cell,
      rightPulseRateHz: KEY_LOCK_SMOKE_PULSE_HZ,
      rightTempoErrorPercent: Math.abs(KEY_LOCK_SMOKE_PULSE_HZ - cell.expectedPulseRateHz) / cell.expectedPulseRateHz * 100
    }))).passed).toBe(false);
  });
});
