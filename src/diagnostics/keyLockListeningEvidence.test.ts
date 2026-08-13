import { describe, expect, it } from "vitest";
import type { AudioHealthSnapshot } from "../audio/AudioEngine";
import { evaluatePrivateListeningHealth } from "./keyLockListeningEvidence";

const sampleRate = 48_000;
const baseline = { renderedFrames: 100, expectedActiveFrames: 50, silentFrames: 0, renderQuanta: 0,
  nonFiniteSamples: 0, clippedSamples: 0, processorErrors: 0, reports: 2 };
const current = (): AudioHealthSnapshot => ({
  schemaVersion: "audio-health/v2", supported: true, expectedOutputActive: false, sampleRate,
  renderedFrames: baseline.renderedFrames + sampleRate * 11,
  expectedActiveFrames: baseline.expectedActiveFrames + sampleRate * 10,
  silentFrames: 1, renderQuanta: sampleRate * 11 / 128,
  nonFiniteSamples: 0, clippedSamples: 0, processorErrors: 0, peak: 0.1,
  longestUnexpectedSilentSeconds: 1 / sampleRate, reports: baseline.reports + 10,
  contextStates: ["running"]
});

describe("private listening health evidence", () => {
  it("accepts a complete healthy owned handoff", () => {
    expect(evaluatePrivateListeningHealth(baseline, current(), 10, true, true).passed).toBe(true);
  });

  it("rejects under/over coverage, silence, clipping, and lost handoff ownership", () => {
    const good = current();
    expect(evaluatePrivateListeningHealth(baseline, { ...good, expectedActiveFrames: baseline.expectedActiveFrames }, 10, false, false).passed).toBe(false);
    expect(evaluatePrivateListeningHealth(baseline, { ...good, expectedActiveFrames: good.expectedActiveFrames + sampleRate }, 10, false, false).passed).toBe(false);
    expect(evaluatePrivateListeningHealth(baseline, { ...good, silentFrames: sampleRate }, 10, false, false).passed).toBe(false);
    expect(evaluatePrivateListeningHealth(baseline, { ...good, clippedSamples: 1 }, 10, false, false).passed).toBe(false);
    expect(evaluatePrivateListeningHealth(baseline, good, 10, true, false).passed).toBe(false);
  });
});
