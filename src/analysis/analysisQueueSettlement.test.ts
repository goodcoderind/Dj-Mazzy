import { describe, expect, it } from "vitest";
import { applyQueuedAnalysisFailure } from "./analysisQueueSettlement";
import { analyzeProgramLevel } from "./programLevel";
import { BASIC_ANALYZER_VERSION, TRACK_ANALYSIS_SCHEMA_VERSION } from "../domain/versions";

describe("analysis queue failure ownership", () => {
  it("preserves current rhythm, corrections, and review when only level migration fails", () => {
    const timingReview = { schemaVersion: "timing-review/v1", finalOutcome: "saved_adjustment" };
    const analysisOverrides = { correctedBpm: 121, firstBeatSeconds: 0.1 };
    const record = {
      analysisStatus: "ready",
      bpm: 120,
      key: "A",
      scale: "minor",
      beatsSeconds: [0.1, 0.6],
      timingReview,
      analysisOverrides,
      programLevel: { schemaVersion: "program-level/v1" }
    };
    const next = applyQueuedAnalysisFailure(record, false, true);
    expect(next).toMatchObject({
      analysisStatus: "ready",
      bpm: 120,
      key: "A",
      scale: "minor",
      beatsSeconds: [0.1, 0.6],
      programLevel: null,
      programLevelStatus: "failed"
    });
    expect(next.timingReview).toBe(timingReview);
    expect(next.analysisOverrides).toBe(analysisOverrides);
  });

  it("reserves destructive failure state for missing basic analysis", () => {
    expect(applyQueuedAnalysisFailure({ analysisStatus: "pending", bpm: 120, key: "C", scale: "major" }, true, true))
      .toMatchObject({ analysisStatus: "failed", bpm: null, key: null, scale: null });
  });

  it("ignores a stale level failure after a manual deck load has already succeeded", () => {
    const current = {
      analysisStatus: "ready",
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
      duration: 120,
      programLevel: analyzeProgramLevel([new Float32Array(48_000)], 48_000),
      bpm: 120
    };
    expect(applyQueuedAnalysisFailure(current, false, true)).toBe(current);
  });

  it("ignores a stale basic failure after a manual deck analysis has already succeeded", () => {
    const current = {
      analysisStatus: "ready",
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
      duration: 120,
      programLevel: analyzeProgramLevel([new Float32Array(48_000)], 48_000),
      bpm: 120,
      key: "C"
    };
    expect(applyQueuedAnalysisFailure(current, true, true)).toBe(current);
  });
});
