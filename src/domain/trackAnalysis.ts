import type { TRACK_ANALYSIS_SCHEMA_VERSION } from "./versions";
import type { BeatGridOverrides } from "./beatGrid";
import type { AutomaticRhythmTrust } from "../analysis/automaticRhythmTrust";

export type Confidence = number;

export type TrackAnalysisV4 = {
  trackId: string;
  contentHash: string;
  schemaVersion: typeof TRACK_ANALYSIS_SCHEMA_VERSION;
  analyzerVersion: string;
  durationSeconds: number;
  sampleRate: number;
  loudness: {
    integratedLufs: number | null;
    shortTermLufs: number[];
    loudnessRange: number | null;
    samplePeakDb: number | null;
    truePeakDbtp: number | null;
  };
  rhythm: {
    bpm: number | null;
    bpmCandidates: Array<{ bpm: number; confidence: Confidence }>;
    beatsSeconds: number[];
    downbeatsSeconds: number[];
    meter: number | null;
    tempoConfidence: Confidence;
    beatConfidence: Confidence;
    downbeatConfidence: Confidence;
  };
  automaticRhythmTrust: AutomaticRhythmTrust;
  tonal: {
    key: string | null;
    scale: "major" | "minor" | null;
    confidence: Confidence;
    tuningHz: number | null;
    beatChroma: number[][];
  };
  structure: {
    boundaries: Array<{
      beatIndex: number;
      type: string;
      confidence: Confidence;
    }>;
    phraseCandidates: Array<{
      beatIndex: number;
      confidence: Confidence;
    }>;
  };
  features: {
    energyByBeat: number[];
    bandEnergyByBeat: Array<{ low: number; mid: number; high: number }>;
    vocalProbabilityByBeat: number[];
    timbreByBeat: number[][];
    semanticEmbedding?: number[];
  };
  overrides: BeatGridOverrides & {
    manualBoundaries?: number[];
  };
};
