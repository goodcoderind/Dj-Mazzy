import { describe, expect, it } from "vitest";
import { createTimingReview, isTimingReviewCurrent, normalizeTimingReview } from "./timingReview";
import {
  BASIC_ANALYZER_VERSION,
  BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "./versions";

const analysis = {
  schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
  analyzerVersion: BASIC_ANALYZER_VERSION,
  analysisOverrides: { schemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION }
};

describe("local timing review records", () => {
  it("creates a minimal version-bound record without raw listening traces", () => {
    const review = createTimingReview({
      analysis,
      initialVerdict: "felt_wrong",
      tempoAction: "tapped",
      tapEstimate: { tapCount: 8, bpm: 119.976, quality: "steady", timingVariation: 0.004 },
      beatAction: "aligned",
      downbeatAction: "skipped",
      beginningVerdict: "matches",
      laterVerdict: "not_sure",
      manualAdjustmentChanged: true,
      autoMixWasNewlyDisabled: true,
      reviewedOn: "2026-08-13"
    });

    expect(review).toEqual({
      schemaVersion: "timing-review/v1",
      reviewedAgainst: {
        analysisSchemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
        analyzerVersion: BASIC_ANALYZER_VERSION,
        overrideSchemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION
      },
      initialVerdict: "felt_wrong",
      tempoAction: "tapped",
      tapSummary: { tapCount: 8, bpm: 120, quality: "steady", variationBucket: "low" },
      beatAction: "aligned",
      downbeatAction: "skipped",
      beginningVerdict: "matches",
      laterVerdict: "not_sure",
      finalOutcome: "saved_adjustment",
      reviewedOn: "2026-08-13"
    });
    expect(JSON.stringify(review)).not.toMatch(/tapTimes|interval|playhead|file|trackId/i);
    expect(isTimingReviewCurrent(review, analysis)).toBe(true);
    expect(isTimingReviewCurrent(review, { ...analysis, analyzerVersion: "future/v1" })).toBe(false);
  });

  it("uses the listener's local calendar date instead of UTC", () => {
    const OriginalDate = globalThis.Date;
    class LocalDate extends OriginalDate {
      constructor(value?: string | number | Date) {
        super(value === undefined ? "2026-08-12T20:00:00.000Z" : value);
      }
    }
    globalThis.Date = LocalDate as DateConstructor;
    try {
      const review = createTimingReview({
        analysis,
        initialVerdict: "not_sure",
        tempoAction: "unchanged",
        beatAction: "kept",
        downbeatAction: "skipped",
        beginningVerdict: "not_sure",
        laterVerdict: "not_sure",
        manualAdjustmentChanged: false,
        autoMixWasNewlyDisabled: true
      });
      expect(review.reviewedOn).toBe("2026-08-13");
    } finally {
      globalThis.Date = OriginalDate;
    }
  });

  it("rejects malformed, unversioned, and conditionally invalid records", () => {
    expect(normalizeTimingReview(null)).toBeNull();
    expect(normalizeTimingReview({ schemaVersion: "timing-review/v0" })).toBeNull();
    const valid = createTimingReview({
      analysis,
      initialVerdict: "matched",
      tempoAction: "unchanged",
      beatAction: "kept",
      downbeatAction: "kept",
      beginningVerdict: "matches",
      laterVerdict: "matches",
      manualAdjustmentChanged: false,
      autoMixWasNewlyDisabled: true,
      reviewedOn: "2026-08-13"
    });
    expect(normalizeTimingReview({ ...valid, reviewedOn: "2026-08-13T12:00:00Z" })).toBeNull();
    expect(normalizeTimingReview({ ...valid, reviewedOn: "2026-02-31" })).toBeNull();
    expect(normalizeTimingReview({ ...valid, tempoAction: "tapped" })).toBeNull();
    expect(normalizeTimingReview({
      ...valid,
      tapSummary: { tapCount: 8, bpm: 120, quality: "steady", variationBucket: "low" }
    })).toBeNull();
    expect(normalizeTimingReview({ ...valid, finalOutcome: "saved_adjustment" })).toBeNull();
  });
});
