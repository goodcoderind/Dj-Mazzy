export type BandEnergy = {
  low: number;
  mid: number;
  high: number;
};

export type StructureBoundary = {
  beatIndex: number;
  type: "energy-change";
  confidence: number;
};

export type PhraseCandidate = {
  beatIndex: number;
  confidence: number;
};

export type MusicalFeatureAnalysis = {
  energyByBeat: number[];
  bandEnergyByBeat: BandEnergy[];
  vocalProbabilityByBeat: number[];
  structureBoundaries: StructureBoundary[];
  phraseCandidates: PhraseCandidate[];
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
};

const mean = (values: number[], start: number, end: number) => {
  let total = 0;
  let count = 0;
  for (let index = Math.max(0, start); index < Math.min(values.length, end); index += 1) {
    total += values[index];
    count += 1;
  }
  return count ? total / count : 0;
};

const meanBand = (values: BandEnergy[], start: number, end: number): BandEnergy => {
  let low = 0;
  let mid = 0;
  let high = 0;
  let count = 0;
  for (let index = Math.max(0, start); index < Math.min(values.length, end); index += 1) {
    low += values[index].low;
    mid += values[index].mid;
    high += values[index].high;
    count += 1;
  }
  return count ? { low: low / count, mid: mid / count, high: high / count } : { low: 0, mid: 0, high: 0 };
};

const boundaryNovelty = (
  energyByBeat: number[],
  bandEnergyByBeat: BandEnergy[],
  beatIndex: number
) => {
  const window = 4;
  const beforeEnergy = mean(energyByBeat, beatIndex - window, beatIndex);
  const afterEnergy = mean(energyByBeat, beatIndex, beatIndex + window);
  const beforeBand = meanBand(bandEnergyByBeat, beatIndex - window, beatIndex);
  const afterBand = meanBand(bandEnergyByBeat, beatIndex, beatIndex + window);
  const energyChange = Math.abs(afterEnergy - beforeEnergy);
  const bandChange =
    (Math.abs(afterBand.low - beforeBand.low) +
      Math.abs(afterBand.mid - beforeBand.mid) +
      Math.abs(afterBand.high - beforeBand.high)) /
    2;
  return clamp01(energyChange * 0.65 + bandChange * 0.35);
};

const findStructureBoundaries = (
  energyByBeat: number[],
  bandEnergyByBeat: BandEnergy[]
) => {
  if (energyByBeat.length < 12) return [];
  const candidates = [] as Array<{ beatIndex: number; novelty: number }>;
  for (let beatIndex = 4; beatIndex <= energyByBeat.length - 4; beatIndex += 1) {
    const novelty = boundaryNovelty(energyByBeat, bandEnergyByBeat, beatIndex);
    if (novelty >= 0.18) candidates.push({ beatIndex, novelty });
  }
  candidates.sort((left, right) => right.novelty - left.novelty);
  const selected: StructureBoundary[] = [];
  for (const candidate of candidates) {
    if (selected.some((boundary) => Math.abs(boundary.beatIndex - candidate.beatIndex) < 8)) {
      continue;
    }
    selected.push({
      beatIndex: candidate.beatIndex,
      type: "energy-change",
      // This deterministic baseline is intentionally capped below an autonomous gate.
      confidence: Math.min(0.7, clamp01(candidate.novelty / 0.6))
    });
  }
  return selected.sort((left, right) => left.beatIndex - right.beatIndex);
};

export const analyzeBeatSynchronousFeatures = (
  pcm: Float32Array,
  sampleRate: number,
  beatsSeconds: number[]
): MusicalFeatureAnalysis => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive finite number");
  }
  const validBeats = beatsSeconds.filter(
    (beat, index) => Number.isFinite(beat) && beat >= 0 && (index === 0 || beat > beatsSeconds[index - 1])
  );
  if (!pcm.length || validBeats.length < 2) {
    return {
      energyByBeat: [],
      bandEnergyByBeat: [],
      vocalProbabilityByBeat: [],
      structureBoundaries: [],
      phraseCandidates: []
    };
  }

  const beatCount = validBeats.length;
  const totalSquares = new Float64Array(beatCount);
  const lowSquares = new Float64Array(beatCount);
  const midSquares = new Float64Array(beatCount);
  const highSquares = new Float64Array(beatCount);
  const sampleCounts = new Uint32Array(beatCount);
  const lowAlpha = 1 - Math.exp((-2 * Math.PI * 220) / sampleRate);
  const midAlpha = 1 - Math.exp((-2 * Math.PI * 4000) / sampleRate);
  let lowState = 0;
  let midLowPassState = 0;
  let beatIndex = 0;

  for (let sampleIndex = 0; sampleIndex < pcm.length; sampleIndex += 1) {
    const time = sampleIndex / sampleRate;
    while (beatIndex + 1 < beatCount && time >= validBeats[beatIndex + 1]) beatIndex += 1;
    if (time < validBeats[0]) continue;
    const sample = Number.isFinite(pcm[sampleIndex]) ? pcm[sampleIndex] : 0;
    lowState += lowAlpha * (sample - lowState);
    midLowPassState += midAlpha * (sample - midLowPassState);
    const low = lowState;
    const mid = midLowPassState - lowState;
    const high = sample - midLowPassState;
    totalSquares[beatIndex] += sample * sample;
    lowSquares[beatIndex] += low * low;
    midSquares[beatIndex] += mid * mid;
    highSquares[beatIndex] += high * high;
    sampleCounts[beatIndex] += 1;
  }

  const rawEnergy = Array.from(totalSquares, (sum, index) =>
    sampleCounts[index] ? Math.sqrt(sum / sampleCounts[index]) : 0
  );
  const energyReference = Math.max(percentile(rawEnergy, 0.95), 1e-9);
  const energyByBeat = rawEnergy.map((energy) => clamp01(energy / energyReference));
  const bandEnergyByBeat = Array.from({ length: beatCount }, (_, index) => {
    const total = lowSquares[index] + midSquares[index] + highSquares[index];
    if (total <= 1e-12) return { low: 0, mid: 0, high: 0 };
    return {
      low: clamp01(lowSquares[index] / total),
      mid: clamp01(midSquares[index] / total),
      high: clamp01(highSquares[index] / total)
    };
  });
  const vocalProbabilityByBeat = bandEnergyByBeat.map((bands, index) => {
    const vocalBandShape = clamp01((bands.mid - 0.22) / 0.55);
    const lowDominancePenalty = clamp01(1 - Math.max(0, bands.low - 0.55) * 1.8);
    return clamp01(vocalBandShape * lowDominancePenalty * Math.sqrt(energyByBeat[index]));
  });
  const structureBoundaries = findStructureBoundaries(energyByBeat, bandEnergyByBeat);
  const phraseCandidates = structureBoundaries.map((boundary) => ({
    beatIndex: boundary.beatIndex,
    confidence: Math.min(0.55, boundary.confidence * 0.8)
  }));

  return {
    energyByBeat,
    bandEnergyByBeat,
    vocalProbabilityByBeat,
    structureBoundaries,
    phraseCandidates
  };
};
