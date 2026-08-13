import { describe, expect, it } from "vitest";
import { buildDeviceSoakReport } from "./deviceSoakReport";

const health = (overrides = {}) => ({
  schemaVersion: "audio-health/v2" as const,
  supported: true,
  expectedOutputActive: false,
  sampleRate: 48_000,
  renderedFrames: 48_000 * 60,
  expectedActiveFrames: 48_000 * 60,
  silentFrames: 0,
  renderQuanta: 22_500,
  nonFiniteSamples: 0,
  clippedSamples: 0,
  processorErrors: 0,
  peak: 0.4,
  longestUnexpectedSilentSeconds: 0,
  reports: 60,
  contextStates: ["running"] as AudioContextState[],
  ...overrides
});

const valid = (overrides = {}) => ({
  buildContract: "mazzy-audio-engine/v1",
  runnerContract: "mazzy-device-soak-runner/v2" as const,
  mode: "smoke-1m" as const,
  requestedDurationSeconds: 60,
  wallElapsedSeconds: 60,
  audioElapsedSeconds: 60,
  scheduledTransitions: 8,
  completedTransitions: 8,
  cancelledTransitions: 0,
  maximumCompletionLatenessSeconds: 0.04,
  uncaughtErrors: 0,
  unhandledRejections: 0,
  health: health(),
  pageStayedVisible: true,
  aborted: false,
  ...overrides
});

describe("device soak report", () => {
  it("passes complete anonymous audio evidence", () => {
    const report = buildDeviceSoakReport(valid());
    expect(report.passed).toBe(true);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.failureCodes).toEqual([]);
    expect(Object.keys(report)).not.toContain("tracks");
    expect(JSON.stringify(report)).not.toMatch(/trackId|userAgent|\.mp3|\/Users\//);
  });

  it.each([
    ["unexpected-audio-gap", { health: health({ longestUnexpectedSilentSeconds: 0.101 }) }],
    ["post-limiter-clipping", { health: health({ clippedSamples: 1, peak: 1.01 }) }],
    ["orphan-transition", { scheduledTransitions: 8, completedTransitions: 7 }],
    ["completion-late", { maximumCompletionLatenessSeconds: 0.501 }],
    ["audio-context-interrupted", { health: health({ contextStates: ["running", "suspended"] }) }]
  ])("fails closed for %s", (code, overrides) => {
    expect(buildDeviceSoakReport(valid(overrides)).failureCodes).toContain(code);
  });

  it("rejects malformed evidence", () => {
    expect(() => buildDeviceSoakReport(valid({ wallElapsedSeconds: Number.NaN }))).toThrow("finite");
    expect(() => buildDeviceSoakReport(valid({ health: health({ peak: Number.NaN }) }))).toThrow("malformed");
    expect(() => buildDeviceSoakReport(valid({ health: health({ renderedFrames: -1 }) }))).toThrow("malformed");
    expect(() => buildDeviceSoakReport(valid({ completedTransitions: 7.5 }))).toThrow("integers");
    expect(() => buildDeviceSoakReport(valid({ requestedDurationSeconds: 61 }))).toThrow("canonical");
    expect(() => buildDeviceSoakReport(valid({ pageStayedVisible: "yes" as unknown as boolean }))).toThrow("malformed");
  });

  it("fails when monitoring coverage or its processor disappears", () => {
    expect(buildDeviceSoakReport(valid({ health: health({ expectedActiveFrames: 48_000 * 59 }) })).failureCodes)
      .toContain("audio-health-coverage-incomplete");
    expect(buildDeviceSoakReport(valid({ health: health({ processorErrors: 1 }) })).failureCodes)
      .toContain("audio-health-processor-error");
    expect(buildDeviceSoakReport(valid({ health: health({ renderedFrames: 48_000 * 63 }) })).failureCodes)
      .toContain("audio-health-coverage-incomplete");
  });

  it("requires a running context, enough transitions, and a complete run", () => {
    expect(buildDeviceSoakReport(valid({ health: health({ contextStates: ["interrupted", "running"] }) })).failureCodes)
      .toContain("audio-context-interrupted");
    expect(buildDeviceSoakReport(valid({ scheduledTransitions: 5, completedTransitions: 5 })).failureCodes)
      .toContain("too-few-transitions");
    expect(buildDeviceSoakReport(valid({ cancelledTransitions: 8, completedTransitions: 0 })).failureCodes)
      .toContain("too-few-completed-transitions");
    expect(buildDeviceSoakReport(valid({ aborted: true })).failureCodes).toContain("run-aborted");
  });

  it("fails clock divergence and any hidden interval", () => {
    expect(buildDeviceSoakReport(valid({ audioElapsedSeconds: 58.9 })).failureCodes).toContain("wall-audio-clock-diverged");
    expect(buildDeviceSoakReport(valid({ pageStayedVisible: false })).failureCodes).toContain("page-not-always-visible");
  });

  it("allows the expected initial suspended-to-running gesture transition", () => {
    expect(buildDeviceSoakReport(valid({ health: health({ contextStates: ["suspended", "running"] }) })).passed).toBe(true);
  });

  it("marks only the literal two-hour mode as release-gate evidence", () => {
    const report = buildDeviceSoakReport(valid({
      mode: "acceptance-2h",
      requestedDurationSeconds: 7_200,
      wallElapsedSeconds: 7_200,
      audioElapsedSeconds: 7_200,
      scheduledTransitions: 900,
      completedTransitions: 900,
      health: health({
        renderedFrames: 48_000 * 7_200,
        expectedActiveFrames: 48_000 * 7_200,
        renderQuanta: 48_000 * 7_200 / 128,
        reports: 7_200
      })
    }));
    expect(report.releaseGatePassed).toBe(true);
  });

  it("accepts exact frame coverage at 44.1 kHz without assuming one report per second", () => {
    const seconds = 7_200;
    const sampleRate = 44_100;
    const renderedFrames = sampleRate * seconds;
    const report = buildDeviceSoakReport(valid({
      mode: "acceptance-2h",
      requestedDurationSeconds: seconds,
      wallElapsedSeconds: seconds,
      audioElapsedSeconds: seconds,
      scheduledTransitions: 900,
      completedTransitions: 900,
      health: health({
        sampleRate,
        renderedFrames,
        expectedActiveFrames: renderedFrames,
        renderQuanta: renderedFrames / 128,
        reports: 7_190
      })
    }));
    expect(report.releaseGatePassed).toBe(true);
  });
});
