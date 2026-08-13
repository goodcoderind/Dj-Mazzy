import { describe, expect, it } from "vitest";
import {
  aggregatePrivateRhythmScores,
  BEAT_THIS_FINAL0_BROWSER_DETECTOR,
  scorePrivateRhythmPrediction,
  toAnonymousPrivateRhythmSummary,
  validatePrivateAnnotation,
  type PrivateRhythmAnnotation
} from "./privateRhythmEvaluation";

const trackHash = "a".repeat(64);
const annotation: PrivateRhythmAnnotation = {
  trackHash,
  reviewedByHuman: true,
  canonicalTimebase: "browser-web-audio/v1",
  regions: [{
    startSeconds: 10,
    endSeconds: 12,
    beatsSeconds: [10, 10.5, 11, 11.5],
    downbeatsSeconds: [10]
  }]
};

const prediction = (overrides: Partial<Parameters<typeof scorePrivateRhythmPrediction>[0]> = {}) => ({
  trackHash,
  detector: BEAT_THIS_FINAL0_BROWSER_DETECTOR,
  beatsSeconds: [10, 10.5, 11, 11.5],
  downbeatsSeconds: [10],
  ...overrides
});

describe("private rhythm evaluation", () => {
  it("requires explicit human-reviewed, bounded, non-empty, sorted annotations", () => {
    expect(validatePrivateAnnotation(annotation)).toBe(true);
    expect(validatePrivateAnnotation(null)).toBe(false);
    expect(validatePrivateAnnotation({ ...annotation, reviewedByHuman: false })).toBe(false);
    expect(validatePrivateAnnotation({ ...annotation, regions: [{ ...annotation.regions[0], beatsSeconds: [] }] })).toBe(false);
    expect(validatePrivateAnnotation({ ...annotation, regions: [{ ...annotation.regions[0], beatsSeconds: [11, 10] }] })).toBe(false);
    expect(validatePrivateAnnotation({ ...annotation, regions: [annotation.regions[0], { ...annotation.regions[0], startSeconds: 11 }] })).toBe(false);
  });

  it("scores only predictions inside annotated regions", () => {
    const score = scorePrivateRhythmPrediction(prediction({
      beatsSeconds: [0, 10.02, 10.48, 11.4, 20],
      downbeatsSeconds: [0, 10.02, 20]
    }), annotation);
    expect(score.beat).toMatchObject({ truePositives: 2, falsePositives: 1, falseNegatives: 2 });
    expect(score.downbeat).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
  });

  it("validates every prediction before region filtering", () => {
    expect(() => scorePrivateRhythmPrediction(prediction({ beatsSeconds: [10, Number.NaN] }), annotation)).toThrow("finite");
    expect(() => scorePrivateRhythmPrediction(prediction({ beatsSeconds: [-1, 10] }), annotation)).toThrow("non-negative");
    expect(() => scorePrivateRhythmPrediction(prediction({ beatsSeconds: [10.5, 10] }), annotation)).toThrow("increasing");
    expect(() => scorePrivateRhythmPrediction(prediction({ beatsSeconds: [10, 10] }), annotation)).toThrow("increasing");
    expect(() => scorePrivateRhythmPrediction(prediction({ downbeatsSeconds: [10.25] }), annotation)).toThrow("also be a predicted beat");
  });

  it("matches each annotated region independently", () => {
    const adjacent: PrivateRhythmAnnotation = {
      ...annotation,
      regions: [
        { startSeconds: 0, endSeconds: 1, beatsSeconds: [0.94], downbeatsSeconds: [0.94] },
        { startSeconds: 1, endSeconds: 2, beatsSeconds: [1.04], downbeatsSeconds: [1.04] }
      ]
    };
    const score = scorePrivateRhythmPrediction(prediction({ beatsSeconds: [0.98, 1.5], downbeatsSeconds: [0.98] }), adjacent);
    expect(score.beat).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1 });
  });

  it("reports macro headline and micro event totals without accepting empty evidence", () => {
    const first = scorePrivateRhythmPrediction(prediction(), annotation);
    const secondAnnotation = { ...annotation, trackHash: "b".repeat(64) };
    const second = scorePrivateRhythmPrediction(prediction({ trackHash: secondAnnotation.trackHash, beatsSeconds: [], downbeatsSeconds: [] }), secondAnnotation);
    const aggregate = aggregatePrivateRhythmScores([first, second]);
    expect(aggregate.beat.micro).toMatchObject({ truePositives: 4, falseNegatives: 4, fMeasure: 2 / 3 });
    expect(aggregate.beat.macroFMeasure).toBe(0.5);
    expect(() => aggregatePrivateRhythmScores([])).toThrow("At least one");
  });

  it("refuses mixed detector contracts and unsafe public summaries", () => {
    const score = scorePrivateRhythmPrediction(prediction(), annotation);
    expect(() => aggregatePrivateRhythmScores([
      score,
      { ...score, trackHash: "f".repeat(64), detector: "other" }
    ])).toThrow("different detectors");
    expect(() => aggregatePrivateRhythmScores([score, score])).toThrow("unique");
    expect(() => toAnonymousPrivateRhythmSummary(aggregatePrivateRhythmScores([score]))).toThrow("ten tracks");
    const aggregate = aggregatePrivateRhythmScores(Array.from({ length: 10 }, (_, index) => ({
      ...score,
      trackHash: index.toString(16).padStart(64, "0")
    })));
    const summary = toAnonymousPrivateRhythmSummary(aggregate);
    expect(Object.keys(summary)).toEqual([
      "schemaVersion", "detector", "cohortSize", "annotatedHoursRounded", "beat", "downbeat"
    ]);
    expect(JSON.stringify(summary)).not.toContain(trackHash);
    expect(summary.cohortSize).toBe("10-19");
  });
});
