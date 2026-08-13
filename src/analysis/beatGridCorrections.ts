import type { BeatGridAnalysis, BeatGridOverrides } from "../domain/beatGrid";
import { BEAT_GRID_OVERRIDE_SCHEMA_VERSION } from "../domain/versions";

const MIN_BPM = 40;
const MAX_BPM = 250;
const EPSILON = 1e-6;

export const emptyBeatGridOverrides = (): BeatGridOverrides => ({
  schemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION
});

export const normalizeBeatGridOverrides = (
  value?: Partial<BeatGridOverrides> | null
): BeatGridOverrides => {
  const correctedBpm = Number(value?.correctedBpm);
  const firstBeatSeconds = Number(value?.firstBeatSeconds);
  const firstDownbeatBeatIndex = Number(value?.firstDownbeatBeatIndex);
  return {
    schemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
    ...(Number.isFinite(correctedBpm) && correctedBpm >= MIN_BPM && correctedBpm <= MAX_BPM
      ? { correctedBpm }
      : {}),
    ...(Number.isFinite(firstBeatSeconds) && firstBeatSeconds >= 0 ? { firstBeatSeconds } : {}),
    ...(Number.isInteger(firstDownbeatBeatIndex) && firstDownbeatBeatIndex >= 0
      ? { firstDownbeatBeatIndex }
      : {}),
    ...(value?.autoMixDisabled === true ? { autoMixDisabled: true } : {})
  };
};

const finiteTimes = (values: number[] | undefined, durationSeconds: number) =>
  (values ?? [])
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= durationSeconds + EPSILON)
    .sort((left, right) => left - right);

const findNearestIndex = (values: number[], target: number) => {
  if (!values.length) return -1;
  let bestIndex = 0;
  let bestDistance = Math.abs(values[0] - target);
  for (let index = 1; index < values.length; index += 1) {
    const distance = Math.abs(values[index] - target);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
};

const generateRegularGrid = (anchor: number, bpm: number, durationSeconds: number) => {
  const interval = 60 / bpm;
  let first = Math.max(0, anchor);
  while (first - interval >= -EPSILON) first -= interval;
  const beats: number[] = [];
  for (let beat = first; beat <= durationSeconds + EPSILON; beat += interval) {
    if (beat >= -EPSILON) beats.push(Math.max(0, beat));
  }
  return beats;
};

export type EffectiveBeatGrid = {
  bpm: number | null;
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  meter: number;
  overrides: BeatGridOverrides;
  isManual: boolean;
};

export const buildEffectiveBeatGrid = (analysis: BeatGridAnalysis): EffectiveBeatGrid => {
  const durationSeconds = Math.max(0, Number(analysis.durationSeconds ?? analysis.duration ?? 0));
  const meter = Number.isInteger(analysis.meter) && Number(analysis.meter) >= 2
    ? Number(analysis.meter)
    : 4;
  const overrides = normalizeBeatGridOverrides(analysis.analysisOverrides);
  const generatedBeats = finiteTimes(analysis.beatsSeconds, durationSeconds);
  const generatedDownbeats = finiteTimes(analysis.downbeatsSeconds, durationSeconds);
  const bpm = overrides.correctedBpm ?? analysis.bpm ?? null;
  let beatsSeconds: number[];

  if (overrides.correctedBpm && durationSeconds > 0) {
    const anchor = overrides.firstBeatSeconds ?? generatedBeats[0] ?? 0;
    beatsSeconds = generateRegularGrid(anchor, overrides.correctedBpm, durationSeconds);
  } else if (overrides.firstBeatSeconds !== undefined && generatedBeats.length) {
    const shift = overrides.firstBeatSeconds - generatedBeats[0];
    beatsSeconds = generatedBeats
      .map((beat) => beat + shift)
      .filter((beat) => beat >= 0 && beat <= durationSeconds + EPSILON);
  } else if (overrides.firstBeatSeconds !== undefined && bpm && durationSeconds > 0) {
    beatsSeconds = generateRegularGrid(overrides.firstBeatSeconds, bpm, durationSeconds);
  } else {
    beatsSeconds = generatedBeats;
  }

  let downbeatsSeconds: number[] = [];
  if (overrides.firstDownbeatBeatIndex !== undefined && beatsSeconds.length) {
    const phase = overrides.firstDownbeatBeatIndex % meter;
    downbeatsSeconds = beatsSeconds.filter((_, index) => index % meter === phase);
  } else if (generatedDownbeats.length && !overrides.correctedBpm) {
    const shift = overrides.firstBeatSeconds !== undefined && generatedBeats.length
      ? overrides.firstBeatSeconds - generatedBeats[0]
      : 0;
    downbeatsSeconds = generatedDownbeats
      .map((beat) => beat + shift)
      .filter((beat) => beat >= 0 && beat <= durationSeconds + EPSILON);
  } else if (generatedDownbeats.length && beatsSeconds.length) {
    const nearest = findNearestIndex(beatsSeconds, generatedDownbeats[0]);
    if (nearest >= 0) downbeatsSeconds = beatsSeconds.filter((_, index) => index % meter === nearest % meter);
  }

  return {
    bpm,
    beatsSeconds,
    downbeatsSeconds,
    meter,
    overrides,
    isManual:
      overrides.correctedBpm !== undefined ||
      overrides.firstBeatSeconds !== undefined ||
      overrides.firstDownbeatBeatIndex !== undefined
  };
};

export const setBeatAtTime = (analysis: BeatGridAnalysis, timeSeconds: number) => {
  const grid = buildEffectiveBeatGrid(analysis);
  const requestedTime = Number(timeSeconds);
  if (!Number.isFinite(requestedTime)) return grid.overrides;
  const durationSeconds = Math.max(0, Number(analysis.durationSeconds ?? analysis.duration ?? 0));
  const safeTime = Math.max(0, Math.min(requestedTime, durationSeconds));
  const nearestIndex = findNearestIndex(grid.beatsSeconds, safeTime);
  const currentFirst = grid.beatsSeconds[0] ?? safeTime;
  const nearest = nearestIndex >= 0 ? grid.beatsSeconds[nearestIndex] : safeTime;
  return normalizeBeatGridOverrides({
    ...grid.overrides,
    firstBeatSeconds: Math.max(0, currentFirst + safeTime - nearest)
  });
};

export const nudgeBeatGrid = (analysis: BeatGridAnalysis, deltaSeconds: number) => {
  const grid = buildEffectiveBeatGrid(analysis);
  if (!Number.isFinite(deltaSeconds)) return grid.overrides;
  const first = grid.beatsSeconds[0] ?? grid.overrides.firstBeatSeconds ?? 0;
  return normalizeBeatGridOverrides({
    ...grid.overrides,
    firstBeatSeconds: Math.max(0, first + deltaSeconds)
  });
};

export const setDownbeatAtTime = (analysis: BeatGridAnalysis, timeSeconds: number) => {
  const grid = buildEffectiveBeatGrid(analysis);
  const requestedTime = Number(timeSeconds);
  if (!Number.isFinite(requestedTime)) return grid.overrides;
  const durationSeconds = Math.max(0, Number(analysis.durationSeconds ?? analysis.duration ?? 0));
  const nearestIndex = findNearestIndex(
    grid.beatsSeconds,
    Math.max(0, Math.min(requestedTime, durationSeconds))
  );
  if (nearestIndex < 0) return grid.overrides;
  return normalizeBeatGridOverrides({
    ...grid.overrides,
    firstDownbeatBeatIndex: nearestIndex % grid.meter
  });
};

export const scaleCorrectedBpm = (analysis: BeatGridAnalysis, factor: number) => {
  const grid = buildEffectiveBeatGrid(analysis);
  if (!grid.bpm || !Number.isFinite(factor) || factor <= 0) return grid.overrides;
  const nextOverrides = normalizeBeatGridOverrides({
    ...grid.overrides,
    correctedBpm: Math.max(MIN_BPM, Math.min(MAX_BPM, grid.bpm * factor)),
    firstBeatSeconds: grid.beatsSeconds[0] ?? grid.overrides.firstBeatSeconds ?? 0
  });
  if (grid.overrides.firstDownbeatBeatIndex === undefined || !grid.downbeatsSeconds.length) {
    return nextOverrides;
  }
  const withoutDownbeat = { ...nextOverrides };
  delete withoutDownbeat.firstDownbeatBeatIndex;
  const nextGrid = buildEffectiveBeatGrid({ ...analysis, analysisOverrides: withoutDownbeat });
  const nearestIndex = findNearestIndex(nextGrid.beatsSeconds, grid.downbeatsSeconds[0]);
  if (
    nearestIndex < 0 ||
    Math.abs(nextGrid.beatsSeconds[nearestIndex] - grid.downbeatsSeconds[0]) > 0.07
  ) {
    return normalizeBeatGridOverrides(withoutDownbeat);
  }
  return normalizeBeatGridOverrides({
    ...nextOverrides,
    firstDownbeatBeatIndex: nearestIndex % nextGrid.meter
  });
};

export const getEffectiveBpm = (analysis: BeatGridAnalysis) =>
  normalizeBeatGridOverrides(analysis.analysisOverrides).correctedBpm ?? analysis.bpm ?? null;
