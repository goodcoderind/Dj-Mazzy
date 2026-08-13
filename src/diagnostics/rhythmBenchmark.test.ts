import { describe, expect, it } from "vitest";
import { createGoldenRhythmFixtures } from "./goldenRhythmFixtures";
import {
  benchmarkRhythmDetector,
  formatRhythmCasesMarkdown,
  formatRhythmBenchmarkMarkdown,
  isTempoCorrect,
  scoreEvents
} from "./rhythmBenchmark";
import { inferAccentDownbeats, rhythmBenchmarkDetectors } from "./rhythmDetectors";

describe("rhythm benchmark metrics", () => {
  it("scores tempo with explicit half/double-time tolerance", () => {
    expect(isTempoCorrect(60, 120)).toBe(true);
    expect(isTempoCorrect(240, 120)).toBe(true);
    expect(isTempoCorrect(126, 120)).toBe(false);
    expect(isTempoCorrect(null, null)).toBe(true);
    expect(isTempoCorrect(120, null)).toBe(false);
  });

  it("matches beat events one-to-one within the standard 70 ms window", () => {
    const result = scoreEvents([0.02, 0.52, 1.2], [0, 0.5, 1]);
    expect(result).toMatchObject({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 2 / 3,
      recall: 2 / 3,
      fMeasure: 2 / 3
    });
    expect(result.meanAbsoluteErrorMs).toBeCloseTo(20);
  });

  it("maximizes one-to-one matches before minimizing timing error", () => {
    const result = scoreEvents([-0.06, 0.05], [0, 0.1]);
    expect(result).toMatchObject({ truePositives: 2, falsePositives: 0, falseNegatives: 0 });
    expect(result.meanAbsoluteErrorMs).toBeCloseTo(55);
    expect(scoreEvents([0.07], [0]).truePositives).toBe(1);
    expect(scoreEvents([0.070001], [0]).truePositives).toBe(0);
    expect(scoreEvents([], [0])).toMatchObject({ truePositives: 0, falseNegatives: 1, fMeasure: 0 });
    expect(() => scoreEvents([Number.NaN], [0])).toThrow("finite");
  });

  it("finds the strongest four-beat accent phase", () => {
    const fixture = createGoldenRhythmFixtures()[0];
    const result = inferAccentDownbeats(
      fixture.pcm,
      fixture.sampleRate,
      fixture.reference.beatsSeconds
    );
    expect(scoreEvents(result.downbeatsSeconds, fixture.reference.downbeatsSeconds).fMeasure).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.2);
  });
});

describe("detector comparison on generated plumbing fixtures", () => {
  it("executes every adapter and emits comparable metrics", async () => {
    const fixtures = createGoldenRhythmFixtures();
    const results = await Promise.all(
      rhythmBenchmarkDetectors.map((detector) => benchmarkRhythmDetector(detector, fixtures))
    );
    const report = formatRhythmBenchmarkMarkdown(results);
    const cases = formatRhythmCasesMarkdown(results);
    console.log(
      `\nGenerated-fixture rhythm benchmark (not a production quality claim)\n\n${report}\n\n${cases}\n`
    );

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.cases).toHaveLength(fixtures.length);
      expect(result.aggregate.tempoAccuracy).toBeGreaterThanOrEqual(0);
      expect(result.aggregate.tempoAccuracy).toBeLessThanOrEqual(1);
      expect(Number.isFinite(result.aggregate.meanRuntimeMs)).toBe(true);
      expect(report).toContain(result.detector.id);
    }
  }, 20_000);
});
