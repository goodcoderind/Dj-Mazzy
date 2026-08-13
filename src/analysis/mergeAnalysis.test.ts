import { describe, expect, it } from "vitest";
import { mergeGeneratedAnalysis } from "./mergeAnalysis";
import {
  BASIC_ANALYZER_VERSION,
  BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "../domain/versions";

describe("generated analysis merge", () => {
  it("keeps human beat-grid corrections across reanalysis", () => {
    const merged = mergeGeneratedAnalysis(
      {
        id: "track-1",
        duration: 10,
        bpm: 120,
        analysisOverrides: {
          schemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
          correctedBpm: 121,
          firstBeatSeconds: 0.14,
          firstDownbeatBeatIndex: 2
        },
        timingReview: { schemaVersion: "timing-review/v1" }
      },
      {
        schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
        analyzerVersion: BASIC_ANALYZER_VERSION,
        durationSeconds: 12,
        sampleRate: 44_100,
        bpm: 122,
        bpmCandidates: [{ bpm: 122, confidence: 0.6 }],
        beatsSeconds: [0.2, 0.69],
        downbeatsSeconds: [],
        meter: null,
        tempoConfidence: 0.6,
        beatConfidence: 0.5,
        downbeatConfidence: 0,
        key: "A",
        scale: "minor",
        keyConfidence: 0.4,
        energyByBeat: [0.4, 0.7],
        bandEnergyByBeat: [
          { low: 0.5, mid: 0.4, high: 0.1 },
          { low: 0.4, mid: 0.5, high: 0.1 }
        ],
        vocalProbabilityByBeat: [0.1, 0.3],
        structureBoundaries: [],
        phraseCandidates: [],
        automaticRhythmTrust: {
          schemaVersion: "automatic-rhythm-trust/v2",
          tier: "boundary-only",
          trustIndex: 0,
          calibrationVersion: null,
          calibratedSafeProbability: null,
          hardFailures: [],
          reasons: ["No automatic bar-start grid is available."],
          dimensions: { validity: 1, coverage: 0, tempoStability: 1, phaseStability: 1, downbeatCoherence: 0, signalActivity: 1 },
          complete32BeatWindows: 0,
          usableCutBeatIndices: [],
          usable16BeatWindows: []
        },
        programLevel: { schemaVersion: "program-level/v1", activeRmsDbfs: -14, samplePeakDbfs: -3, trimDb: 0, activeBlockCount: 2 }
      }
    );
    expect(merged).toMatchObject({
      bpm: 122,
      duration: 12,
      energyByBeat: [0.4, 0.7],
      analysisOverrides: {
        correctedBpm: 121,
        firstBeatSeconds: 0.14,
        firstDownbeatBeatIndex: 2
      },
      timingReview: null,
      automaticRhythmTrust: {
        schemaVersion: "automatic-rhythm-trust/v2",
        tier: "boundary-only"
      }
    });
  });
});
