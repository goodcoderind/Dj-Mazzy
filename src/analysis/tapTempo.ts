import type { BeatGridAnalysis, BeatGridOverrides } from "../domain/beatGrid";
import { buildEffectiveBeatGrid, normalizeBeatGridOverrides } from "./beatGridCorrections";

export const MIN_TAP_COUNT = 8;
export const MAX_TAP_GAP_SECONDS = 2.5;

export type TapTempoEstimate = {
  bpm: number;
  firstBeatSeconds: number;
  tapCount: number;
  keptIntervalCount: number;
  timingVariation: number;
  quality: "steady" | "rough";
};

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const appendTap = (taps: number[], trackTimeSeconds: number) => {
  if (!Number.isFinite(trackTimeSeconds) || trackTimeSeconds < 0) return [...taps];
  const last = taps[taps.length - 1];
  if (last !== undefined && trackTimeSeconds <= last) return [trackTimeSeconds];
  if (last !== undefined && trackTimeSeconds - last > MAX_TAP_GAP_SECONDS) return [trackTimeSeconds];
  return [...taps, trackTimeSeconds].slice(-16);
};

export const estimateTapTempo = (taps: number[]): TapTempoEstimate | null => {
  if (taps.length < MIN_TAP_COUNT || taps.some((tap) => !Number.isFinite(tap) || tap < 0)) return null;
  if (taps.some((tap, index) => index > 0 && tap <= taps[index - 1])) return null;
  const intervals = taps.slice(1).map((tap, index) => tap - taps[index]);
  const center = median(intervals);
  if (!Number.isFinite(center) || center <= 0) return null;
  const deviations = intervals.map((interval) => Math.abs(interval - center));
  const mad = median(deviations);
  const tolerance = Math.max(0.04, Math.min(center * 0.15, 3 * 1.4826 * mad));
  const kept = intervals.filter((interval) => Math.abs(interval - center) <= tolerance);
  if (kept.length < 6 || kept.length / intervals.length < 0.75) return null;
  const interval = median(kept);
  const bpm = 60 / interval;
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 250) return null;
  const timingVariation = 1.4826 * median(kept.map((value) => Math.abs(value - interval))) / interval;
  const middle = Math.floor(kept.length / 2);
  const firstHalf = median(kept.slice(0, middle));
  const secondHalf = median(kept.slice(middle));
  if (Math.abs(firstHalf - secondHalf) / interval > 0.02 || timingVariation > 0.025) return null;
  return {
    bpm,
    firstBeatSeconds: taps[0],
    tapCount: taps.length,
    keptIntervalCount: kept.length,
    timingVariation,
    quality: timingVariation <= 0.015 ? "steady" : "rough"
  };
};

export const applyTapTempo = (
  analysis: BeatGridAnalysis,
  estimate: TapTempoEstimate
): BeatGridOverrides => {
  const grid = buildEffectiveBeatGrid(analysis);
  return normalizeBeatGridOverrides({
    ...grid.overrides,
    correctedBpm: estimate.bpm,
    firstBeatSeconds: estimate.firstBeatSeconds,
    autoMixDisabled: true
  });
};
