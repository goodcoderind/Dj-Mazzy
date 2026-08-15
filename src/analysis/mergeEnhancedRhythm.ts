import type { BeatThisTrackDiagnosticResult } from "../experimental/beatThisContract";
import { BEAT_THIS_EXPERIMENT_VERSION, BEAT_THIS_MODEL_SHA256 } from "../experimental/beatThisContract";
import { assessAutomaticRhythmTrust } from "./automaticRhythmTrust";
import { ENHANCED_RHYTHM_DETECTOR } from "./enhancedRhythmVersion";

type BasicRecord = {
  duration: number | null;
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  energyByBeat: number[];
  bandEnergyByBeat?: unknown[];
  vocalProbabilityByBeat?: unknown[];
  structureBoundaries?: unknown[];
  phraseCandidates?: unknown[];
  [key: string]: unknown;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const inferMeter = (beats: number[], downbeats: number[]) => {
  if (downbeats.length < 2 || beats.length < 4) return null;
  const indices = downbeats.map((downbeat) => {
    let nearest = 0;
    for (let index = 1; index < beats.length; index += 1) {
      if (Math.abs(beats[index] - downbeat) < Math.abs(beats[nearest] - downbeat)) nearest = index;
    }
    return nearest;
  });
  const spacings = indices.slice(1).map((index, offset) => index - indices[offset]);
  const three = spacings.filter((spacing) => spacing === 3).length;
  const four = spacings.filter((spacing) => spacing === 4).length;
  const winner = Math.max(three, four);
  return spacings.length && winner / spacings.length >= 0.7 ? (four >= three ? 4 : 3) : null;
};

export const mergeEnhancedRhythm = <T extends BasicRecord>(
  record: T,
  enhanced: BeatThisTrackDiagnosticResult
) => {
  const beatsSeconds = [...enhanced.beatsSeconds];
  const downbeatsSeconds = [...enhanced.downbeatsSeconds];
  const intervals = beatsSeconds.slice(1).map((beat, index) => beat - beatsSeconds[index]);
  // The BPM must describe the event grid itself. Do not octave-fold the scalar
  // without also transforming every beat timestamp.
  const bpm = intervals.length ? 60 / median(intervals) : null;
  const energyByBeat = enhanced.energyByBeat ?? [];
  const automaticRhythmTrust = assessAutomaticRhythmTrust({
    durationSeconds: Number(record.duration ?? enhanced.durationSeconds),
    beatsSeconds,
    downbeatsSeconds,
    energyByBeat
  });
  return {
    ...record,
    bpm,
    bpmCandidates: bpm == null ? [] : [{ bpm, confidence: 0 }],
    beatsSeconds,
    downbeatsSeconds,
    meter: inferMeter(beatsSeconds, downbeatsSeconds),
    // The detector is automatic but not calibrated as a probability yet.
    tempoConfidence: 0,
    beatConfidence: 0,
    downbeatConfidence: 0,
    rhythmDetector: ENHANCED_RHYTHM_DETECTOR,
    rhythmAnalysisVersion: BEAT_THIS_EXPERIMENT_VERSION,
    rhythmModelSha256: BEAT_THIS_MODEL_SHA256,
    rhythmBackend: enhanced.backend,
    automaticRhythmTrust,
    energyByBeat,
    bandEnergyByBeat: enhanced.bandEnergyByBeat ?? [],
    vocalProbabilityByBeat: enhanced.vocalProbabilityByBeat ?? [],
    structureBoundaries: enhanced.structureBoundaries ?? [],
    phraseCandidates: enhanced.phraseCandidates ?? [],
    timingReview: null,
    analysisStatus: "ready"
  };
};
