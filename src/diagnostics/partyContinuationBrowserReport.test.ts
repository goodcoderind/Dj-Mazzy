import { describe, expect, it } from "vitest";
import { buildPartyContinuationBrowserReport, type PartyContinuationBrowserReportInput } from "./partyContinuationBrowserReport";

const valid = (): PartyContinuationBrowserReportInput => ({
  completion: { channel: "a", trackId: "not-recorded", operation: 4, loadRevision: 2, settledBy: "source-onended", outcome: "on-time" },
  completionCount: 1,
  ingestion: { version: "party-deck-completion-ingestion/v1", kind: "pause-unexpected-source", reason: "non-final-source-ended" },
  continuation: { version: "party-committed-target-continuation/v1", kind: "start-committed-target", reason: "exact-committed-target" },
  audioTransaction: {
    version: "party-committed-target-audio-transaction/v1", status: "scheduled", scheduledStart: 1,
    priorGain: 0, cleanupConfirmed: true, reason: "scheduled"
  },
  targetStartCount: 1,
  targetOffsetSeconds: 0,
  gainRampDurationSeconds: 0.08,
  scheduledAudioClockGapSeconds: 0.04,
  sourceActiveAfter: false,
  targetActiveAfter: true,
  targetPlaybackBackend: "native",
  targetStatusAfter: "playing",
  targetIdentityMatchedAfter: true,
  targetCompletionOwnerInstalled: true,
  targetGainAfter: 1,
  contextStateAtStart: "running",
  contextStateAtEnd: "running",
  health: {
    schemaVersion: "audio-health/v2", supported: true, expectedOutputActive: false, sampleRate: 48_000,
    renderedFrames: 48_000, expectedActiveFrames: 48_000, silentFrames: 0, renderQuanta: 375,
    nonFiniteSamples: 0, clippedSamples: 0, processorErrors: 0, peak: 0.2,
    longestUnexpectedSilentSeconds: 0.04, reports: 2, contextStates: ["running"]
  },
  uncaughtErrors: 0,
  unhandledRejections: 0,
  aborted: false
});

describe("party continuation browser report", () => {
  it("accepts one healthy composed native-EOF continuation", () => {
    const report = buildPartyContinuationBrowserReport(valid());
    expect(report.passed).toBe(true);
    expect(report.failureCodes).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("not-recorded");
  });

  it("rejects duplicate completion, an oversized gap, missing target ownership, and unhealthy output", () => {
    const base = valid();
    const report = buildPartyContinuationBrowserReport({
      ...base,
      completionCount: 2,
      scheduledAudioClockGapSeconds: 0.201,
      targetCompletionOwnerInstalled: false,
      health: { ...base.health!, nonFiniteSamples: 1, clippedSamples: 1 }
    });
    expect(report.passed).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "native-completion-count", "scheduled-gap", "target-owner-missing", "non-finite-output", "clipped-output"
    ]));
  });

  it("rejects silent, unexpectedly gapped, or interrupted monitoring intervals", () => {
    const base = valid();
    const report = buildPartyContinuationBrowserReport({
      ...base,
      health: {
        ...base.health!,
        peak: 0,
        longestUnexpectedSilentSeconds: 0.201,
        contextStates: ["suspended", "running", "suspended", "running"]
      }
    });
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "audio-health-error", "output-silent", "unexpected-silence"
    ]));
  });

  it("rejects recovered completion, malformed ownership provenance, and inadequate frame coverage", () => {
    const base = valid();
    const report = buildPartyContinuationBrowserReport({
      ...base,
      completion: { ...base.completion!, settledBy: "reconcile", outcome: "recovered" },
      targetPlaybackBackend: null,
      targetStatusAfter: "ready",
      targetIdentityMatchedAfter: false,
      health: {
        ...base.health!, renderedFrames: 128, expectedActiveFrames: 0,
        silentFrames: 0, renderQuanta: 1
      }
    });
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "native-completion-count", "target-owner-missing", "audio-health-error"
    ]));
  });

  it("never projects an unknown runtime status string", () => {
    const report = buildPartyContinuationBrowserReport({
      ...valid(), targetStatusAfter: "private value"
    });
    expect(report.passed).toBe(false);
    expect(report.targetOwner.status).toBeNull();
    expect(JSON.stringify(report)).not.toContain("private value");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects non-finite evidence %s", (value) => {
    expect(() => buildPartyContinuationBrowserReport({
      ...valid(), scheduledAudioClockGapSeconds: value
    })).toThrow(RangeError);
  });
});
