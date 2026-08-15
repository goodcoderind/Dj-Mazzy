import EssentiaPackage from "essentia.js";
import {
  analyzeMusicTempoRhythm,
  estimateBeatConfidence,
  normalizeTempo
} from "../analysis/analyzePcm";
import type { RhythmDetector, RhythmEstimate } from "./rhythmBenchmark";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const emptyEstimate = (): RhythmEstimate => ({
  bpm: null,
  beatsSeconds: [],
  downbeatsSeconds: [],
  tempoConfidence: 0,
  beatConfidence: 0,
  downbeatConfidence: 0
});

const localAccent = (pcm: Float32Array, sampleRate: number, timeSeconds: number) => {
  const start = Math.max(0, Math.round((timeSeconds - 0.015) * sampleRate));
  const end = Math.min(pcm.length, start + Math.round(sampleRate * 0.12));
  let energy = 0;
  for (let index = start; index < end; index += 1) energy += pcm[index] * pcm[index];
  return end > start ? Math.sqrt(energy / (end - start)) : 0;
};

export const inferAccentDownbeats = (
  pcm: Float32Array,
  sampleRate: number,
  beatsSeconds: number[],
  meter = 4
) => {
  if (beatsSeconds.length < meter * 2) {
    return { downbeatsSeconds: [], confidence: 0 };
  }
  const accents = beatsSeconds.map((beat) => localAccent(pcm, sampleRate, beat));
  const phaseScores = Array.from({ length: meter }, (_, phase) => {
    const values = accents.filter((_, index) => index % meter === phase);
    return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  });
  const ranked = phaseScores
    .map((score, phase) => ({ score, phase }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  const confidence = clamp01((best.score - runnerUp.score) / Math.max(best.score, 1e-9));
  return {
    downbeatsSeconds: beatsSeconds.filter((_, index) => index % meter === best.phase),
    confidence
  };
};

const withAccentDownbeats = (
  pcm: Float32Array,
  sampleRate: number,
  estimate: Omit<RhythmEstimate, "downbeatsSeconds" | "downbeatConfidence">
): RhythmEstimate => {
  const downbeats = inferAccentDownbeats(pcm, sampleRate, estimate.beatsSeconds);
  return {
    ...estimate,
    downbeatsSeconds: downbeats.downbeatsSeconds,
    downbeatConfidence: downbeats.confidence
  };
};

export const musicTempoAccentDetector: RhythmDetector = {
  id: "music-tempo+accent/v1",
  licence: "MIT",
  distribution: "runtime-candidate",
  analyze(pcm, sampleRate) {
    try {
      const rhythm = analyzeMusicTempoRhythm(pcm, sampleRate);
      return withAccentDownbeats(pcm, sampleRate, rhythm);
    } catch {
      return emptyEstimate();
    }
  }
};

type EmbindVector = { delete?: () => void };
type EssentiaResult = {
  bpm: number;
  ticks: EmbindVector;
  confidence: number;
  estimates: EmbindVector;
  bpmIntervals: EmbindVector;
};

const { Essentia, EssentiaWASM } = EssentiaPackage;
const essentia = new Essentia(EssentiaWASM);

const runEssentia = (method: "degara" | "multifeature", pcm: Float32Array, sampleRate: number) => {
  if (sampleRate !== 44_100) {
    throw new RangeError("Essentia RhythmExtractor2013 benchmark input must be 44100 Hz");
  }
  const signal = essentia.arrayToVector(pcm) as EmbindVector;
  let result: EssentiaResult | null = null;
  try {
    result = essentia.RhythmExtractor2013(signal, 208, method, 40) as EssentiaResult;
    const beatsSeconds = Array.from(essentia.vectorToArray(result.ticks) as Float32Array);
    const bpm = normalizeTempo(Number(result.bpm));
    const beatConfidence = estimateBeatConfidence(beatsSeconds);
    const nativeConfidence = method === "multifeature" ? clamp01(Number(result.confidence) / 5.32) : 0;
    return withAccentDownbeats(pcm, sampleRate, {
      bpm,
      beatsSeconds,
      tempoConfidence: method === "multifeature" ? nativeConfidence : beatConfidence,
      beatConfidence: method === "multifeature" ? Math.min(nativeConfidence, beatConfidence) : beatConfidence
    });
  } finally {
    signal.delete?.();
    result?.ticks.delete?.();
    result?.estimates.delete?.();
    result?.bpmIntervals.delete?.();
  }
};

export const essentiaDegaraAccentDetector: RhythmDetector = {
  id: "essentia-degara+accent/v1",
  licence: "AGPL-3.0 / commercial",
  distribution: "research-only",
  analyze(pcm, sampleRate) {
    try {
      return runEssentia("degara", pcm, sampleRate);
    } catch {
      return emptyEstimate();
    }
  }
};

export const essentiaMultifeatureAccentDetector: RhythmDetector = {
  id: "essentia-multifeature+accent/v1",
  licence: "AGPL-3.0 / commercial",
  distribution: "research-only",
  analyze(pcm, sampleRate) {
    try {
      return runEssentia("multifeature", pcm, sampleRate);
    } catch {
      return emptyEstimate();
    }
  }
};

export const rhythmBenchmarkDetectors = [
  musicTempoAccentDetector,
  essentiaDegaraAccentDetector,
  essentiaMultifeatureAccentDetector
];
