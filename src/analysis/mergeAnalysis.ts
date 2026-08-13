import type { BasicAnalysisResult } from "./analyzePcm";
import type { BeatGridAnalysis } from "../domain/beatGrid";
import { normalizeBeatGridOverrides } from "./beatGridCorrections";

type LibraryAnalysisRecord = BeatGridAnalysis & Record<string, unknown>;

export const mergeGeneratedAnalysis = <T extends LibraryAnalysisRecord>(
  record: T,
  result: BasicAnalysisResult
) => ({
  ...record,
  duration: result.durationSeconds,
  bpm: result.bpm,
  key: result.key,
  scale: result.scale,
  schemaVersion: result.schemaVersion,
  analyzerVersion: result.analyzerVersion,
  bpmCandidates: result.bpmCandidates,
  beatsSeconds: result.beatsSeconds,
  downbeatsSeconds: result.downbeatsSeconds,
  meter: result.meter,
  tempoConfidence: result.tempoConfidence,
  beatConfidence: result.beatConfidence,
  downbeatConfidence: result.downbeatConfidence,
  keyConfidence: result.keyConfidence,
  energyByBeat: result.energyByBeat,
  bandEnergyByBeat: result.bandEnergyByBeat,
  vocalProbabilityByBeat: result.vocalProbabilityByBeat,
  structureBoundaries: result.structureBoundaries,
  phraseCandidates: result.phraseCandidates,
  automaticRhythmTrust: result.automaticRhythmTrust,
  programLevel: result.programLevel,
  rhythmDetector: null,
  rhythmAnalysisVersion: null,
  rhythmModelSha256: null,
  rhythmBackend: null,
  sampleRate: result.sampleRate,
  analysisOverrides: normalizeBeatGridOverrides(record.analysisOverrides),
  // A new detector run changes the grid that a listener reviewed. Keep the
  // functional overrides, but require a fresh timing review for the new grid.
  timingReview: null,
  analysisStatus: "ready" as const
});
