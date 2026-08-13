import MusicTempoModule from "music-tempo";
import {
  BASIC_ANALYZER_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "../domain/versions";
import {
  analyzeBeatSynchronousFeatures,
  type BandEnergy,
  type PhraseCandidate,
  type StructureBoundary
} from "./analyzeMusicalFeatures";
import { assessAutomaticRhythmTrust, type AutomaticRhythmTrust } from "./automaticRhythmTrust";
import { analyzeProgramLevel, type ProgramLevelAnalysis } from "./programLevel";

const MusicTempo =
  (MusicTempoModule as unknown as { default?: typeof MusicTempoModule }).default ??
  MusicTempoModule;

export type BasicAnalysisResult = {
  schemaVersion: typeof TRACK_ANALYSIS_SCHEMA_VERSION;
  analyzerVersion: typeof BASIC_ANALYZER_VERSION;
  durationSeconds: number;
  sampleRate: number;
  bpm: number | null;
  bpmCandidates: Array<{ bpm: number; confidence: number }>;
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  meter: number | null;
  tempoConfidence: number;
  beatConfidence: number;
  downbeatConfidence: number;
  key: string | null;
  scale: "major" | "minor" | null;
  keyConfidence: number;
  energyByBeat: number[];
  bandEnergyByBeat: BandEnergy[];
  vocalProbabilityByBeat: number[];
  structureBoundaries: StructureBoundary[];
  phraseCandidates: PhraseCandidate[];
  automaticRhythmTrust: AutomaticRhythmTrust;
  programLevel: ProgramLevelAnalysis;
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const MAJOR_TEMPLATE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_TEMPLATE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const normalizeTempo = (rawBpm: number) => {
  if (!Number.isFinite(rawBpm) || rawBpm <= 0) return null;
  let bpm = rawBpm;
  while (bpm > 160) bpm /= 2;
  while (bpm < 70) bpm *= 2;
  return Math.round(bpm * 10) / 10;
};

export const frequencyToPitchClass = (frequencyHz: number) => {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    throw new RangeError("frequencyHz must be a positive finite number");
  }
  const midiNote = Math.round(69 + 12 * Math.log2(frequencyHz / 440));
  return ((midiNote % 12) + 12) % 12;
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const estimateBeatConfidence = (beatsSeconds: number[]) => {
  if (beatsSeconds.length < 4) return 0;
  const intervals = beatsSeconds
    .slice(1)
    .map((beat, index) => beat - beatsSeconds[index])
    .filter((interval) => Number.isFinite(interval) && interval > 0);
  if (intervals.length < 3) return 0;
  const typicalInterval = median(intervals);
  const medianDeviation = median(intervals.map((interval) => Math.abs(interval - typicalInterval)));
  return clamp01(1 - (medianDeviation / Math.max(typicalInterval, 0.001)) * 8);
};

const fftMagnitudes = (input: Float32Array) => {
  const size = input.length;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0; index < size; index += 1) real[index] = input[index];

  let target = 0;
  for (let index = 1; index < size; index += 1) {
    let bit = size >> 1;
    while (target & bit) {
      target ^= bit;
      bit >>= 1;
    }
    target ^= bit;
    if (index < target) {
      [real[index], real[target]] = [real[target], real[index]];
      [imaginary[index], imaginary[target]] = [imaginary[target], imaginary[index]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < length / 2; index += 1) {
        const evenIndex = offset + index;
        const oddIndex = evenIndex + length / 2;
        const oddReal = real[oddIndex] * twiddleReal - imaginary[oddIndex] * twiddleImaginary;
        const oddImaginary = real[oddIndex] * twiddleImaginary + imaginary[oddIndex] * twiddleReal;
        real[oddIndex] = real[evenIndex] - oddReal;
        imaginary[oddIndex] = imaginary[evenIndex] - oddImaginary;
        real[evenIndex] += oddReal;
        imaginary[evenIndex] += oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }

  const magnitudes = new Float64Array(size / 2);
  for (let index = 1; index < magnitudes.length; index += 1) {
    magnitudes[index] = Math.hypot(real[index], imaginary[index]);
  }
  return magnitudes;
};

export const detectKey = (pcm: Float32Array, sampleRate: number) => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive finite number");
  }
  if (pcm.length < 512) return { key: null, scale: null, confidence: 0 } as const;

  const fftSize = 4096;
  const frameCount = 8;
  const chroma = new Float64Array(12);
  const frame = new Float32Array(fftSize);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const center = Math.floor((pcm.length * (frameIndex + 1)) / (frameCount + 1));
    const start = Math.max(0, Math.min(center - fftSize / 2, Math.max(0, pcm.length - fftSize)));
    for (let index = 0; index < fftSize; index += 1) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (fftSize - 1)));
      frame[index] = (pcm[start + index] ?? 0) * hann;
    }
    const magnitudes = fftMagnitudes(frame);
    for (let bin = 1; bin < magnitudes.length; bin += 1) {
      const frequency = (bin * sampleRate) / fftSize;
      if (frequency < 80 || frequency > 4000) continue;
      chroma[frequencyToPitchClass(frequency)] += magnitudes[bin];
    }
  }

  const totalEnergy = chroma.reduce((sum, value) => sum + value, 0);
  if (totalEnergy <= 1e-9) return { key: null, scale: null, confidence: 0 } as const;

  const candidates: Array<{ key: (typeof NOTE_NAMES)[number]; scale: "major" | "minor"; score: number }> = [];
  for (let root = 0; root < 12; root += 1) {
    let majorScore = 0;
    let minorScore = 0;
    for (let pitch = 0; pitch < 12; pitch += 1) {
      majorScore += chroma[(pitch + root) % 12] * MAJOR_TEMPLATE[pitch];
      minorScore += chroma[(pitch + root) % 12] * MINOR_TEMPLATE[pitch];
    }
    candidates.push({ key: NOTE_NAMES[root], scale: "major", score: majorScore });
    candidates.push({ key: NOTE_NAMES[root], scale: "minor", score: minorScore });
  }
  candidates.sort((left, right) => right.score - left.score);
  const [best, runnerUp] = candidates;
  const confidence = clamp01((best.score - runnerUp.score) / Math.max(Math.abs(best.score), 1e-9));
  return { key: best.key, scale: best.scale, confidence };
};

export const analyzeMusicTempoRhythm = (pcm: Float32Array, sampleRate: number) => {
  const hopSize = Math.max(128, Math.round(sampleRate * 0.01));
  const analysis = new MusicTempo(pcm, { hopSize, timeStep: hopSize / sampleRate });
  const bpm = normalizeTempo(Number(analysis.tempo));
  const beatsSeconds = Array.from(analysis.beats ?? [], Number).filter(Number.isFinite);
  const beatConfidence = estimateBeatConfidence(beatsSeconds);
  const candidateBpms = Array.from(analysis.tempoList ?? [], Number)
    .map((interval) => normalizeTempo(60 / interval))
    .filter((candidate): candidate is number => candidate !== null);
  if (bpm !== null) candidateBpms.unshift(bpm);
  const uniqueCandidates = [...new Set(candidateBpms)].slice(0, 5);
  return {
    bpm,
    beatsSeconds,
    beatConfidence,
    tempoConfidence: bpm === null ? 0 : beatConfidence,
    bpmCandidates: uniqueCandidates.map((candidate, index) => ({
      bpm: candidate,
      confidence: clamp01(beatConfidence * (index === 0 ? 1 : 0.7 / (index + 1)))
    }))
  };
};

export const analyzePcm = (
  pcm: Float32Array,
  sampleRate: number,
  durationSeconds = pcm.length / sampleRate
): BasicAnalysisResult => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive finite number");
  }
  let rhythm: ReturnType<typeof analyzeMusicTempoRhythm> = {
    bpm: null,
    bpmCandidates: [],
    beatsSeconds: [],
    tempoConfidence: 0,
    beatConfidence: 0
  };
  try {
    rhythm = analyzeMusicTempoRhythm(pcm, sampleRate);
  } catch {
    // Tonal analysis may still be useful when rhythm extraction fails.
  }
  const tonal = detectKey(pcm, sampleRate);
  const features = analyzeBeatSynchronousFeatures(pcm, sampleRate, rhythm.beatsSeconds);
  const automaticRhythmTrust = assessAutomaticRhythmTrust({
    durationSeconds,
    beatsSeconds: rhythm.beatsSeconds,
    downbeatsSeconds: [],
    energyByBeat: features.energyByBeat
  });
  const programLevel = analyzeProgramLevel([pcm], sampleRate);
  return {
    schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: BASIC_ANALYZER_VERSION,
    durationSeconds,
    sampleRate,
    ...rhythm,
    downbeatsSeconds: [],
    meter: null,
    downbeatConfidence: 0,
    key: tonal.key,
    scale: tonal.scale,
    keyConfidence: tonal.confidence,
    ...features,
    automaticRhythmTrust,
    programLevel
  };
};
