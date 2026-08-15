import { describe, expect, it } from "vitest";
import { assessTransitionRenderQuality, measureSamples, renderEqualPowerTransition } from "./renderTransition";

const constantSignal = (length: number, value: number) =>
  Float32Array.from({ length }, () => value);

describe("offline transition render harness", () => {
  it("renders the same transition plan deterministically", () => {
    const source = Float32Array.from({ length: 128 }, (_, index) => Math.sin(index / 8) * 0.4);
    const target = Float32Array.from({ length: 128 }, (_, index) => Math.cos(index / 11) * 0.3);
    const first = renderEqualPowerTransition(source, target);
    const second = renderEqualPowerTransition(source, target);

    expect(Array.from(first.mixed)).toEqual(Array.from(second.mixed));
    expect(first.metrics).toEqual(second.metrics);
    expect(first.metrics.nonFiniteSamples).toBe(0);
  });

  it("preserves source and target values at transition endpoints", () => {
    const rendered = renderEqualPowerTransition(
      constantSignal(64, 0.6),
      constantSignal(64, 0.25)
    );
    expect(rendered.mixed[0]).toBeCloseTo(0.6);
    expect(rendered.mixed[63]).toBeCloseTo(0.25);
  });

  it("detects peak risk when correlated tracks overlap", () => {
    const source = constantSignal(256, 0.8);
    const target = constantSignal(256, 0.8);
    const unsafe = renderEqualPowerTransition(source, target);
    const withHeadroom = renderEqualPowerTransition(source, target, {
      headroomGain: Math.SQRT1_2
    });

    expect(unsafe.metrics.peak).toBeGreaterThan(1);
    expect(unsafe.metrics.clippedSamples).toBeGreaterThan(0);
    expect(withHeadroom.metrics.peak).toBeLessThanOrEqual(0.81);
    expect(withHeadroom.metrics.clippedSamples).toBe(0);
  });

  it("reports invalid and silent samples for future audio health gates", () => {
    const samples = Float32Array.from([0, 0, 0.5, Number.NaN, 1.2]);
    const metrics = measureSamples(samples);
    expect(metrics.longestSilentRun).toBe(2);
    expect(metrics.nonFiniteSamples).toBe(1);
    expect(metrics.clippedSamples).toBe(1);
  });

  it("passes a protected short handoff without a dropout or boundary jump", () => {
    const sampleRate = 8_000;
    const length = Math.round(0.35 * sampleRate);
    const source = Float32Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * 220 * index / sampleRate) * 0.4);
    const target = Float32Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * 330 * index / sampleRate) * 0.35);
    const rendered = renderEqualPowerTransition(source, target, { headroomGain: Math.SQRT1_2 });
    expect(assessTransitionRenderQuality(rendered.mixed, sampleRate)).toMatchObject({
      passed: true,
      reasons: []
    });
  });

  it("rejects clipping, silence gaps, and abrupt discontinuities", () => {
    const clipped = assessTransitionRenderQuality(Float32Array.from([0, 1.2, 0]), 1_000);
    expect(clipped.passed).toBe(false);
    expect(clipped.reasons).toContain("Rendered transition exceeds the peak ceiling.");
    expect(clipped.reasons).toContain("Rendered transition contains a discontinuity risk.");

    const gap = assessTransitionRenderQuality(new Float32Array(25), 1_000);
    expect(gap.reasons).toContain("Rendered transition contains an audible silence gap.");
  });
});
