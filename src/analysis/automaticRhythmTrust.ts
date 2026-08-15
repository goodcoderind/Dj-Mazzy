import { AUTOMATIC_RHYTHM_TRUST_SCHEMA_VERSION } from "../domain/versions";

export type AutomaticRhythmTrust = {
  schemaVersion: typeof AUTOMATIC_RHYTHM_TRUST_SCHEMA_VERSION;
  tier: "reject" | "boundary-only" | "bar-cut-candidate" | "short-sync-candidate" | "long-candidate";
  trustIndex: number;
  calibrationVersion: string | null;
  calibratedSafeProbability: number | null;
  hardFailures: string[];
  reasons: string[];
  dimensions: {
    validity: number;
    coverage: number;
    tempoStability: number;
    phaseStability: number;
    downbeatCoherence: number;
    signalActivity: number;
  };
  complete32BeatWindows: number;
  usableCutBeatIndices: number[];
  usable16BeatWindows: Array<{ startBeatIndex: number; endBeatIndex: number }>;
};

type RhythmEvidence = {
  durationSeconds: number;
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  energyByBeat: number[];
};

const CUT_WINDOW_BEATS = 16;
const CUT_PHASE_P95_LIMIT_SECONDS = 0.04;
const CUT_DRIFT_LIMIT = 0.04;
const CUT_METER_SUPPORT_LIMIT = 0.85;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
};

const strictlyIncreasingFinite = (values: number[], duration: number) =>
  values.every(
    (value, index) =>
      Number.isFinite(value) && value >= 0 && value <= duration + 0.001 &&
      (index === 0 || value > values[index - 1])
  );

const nearestIndex = (values: number[], target: number) => {
  let best = -1;
  let distance = Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const candidate = Math.abs(values[index] - target);
    if (candidate < distance) {
      best = index;
      distance = candidate;
    }
  }
  return { index: best, distance };
};

const affineResidualP95 = (values: number[]) => {
  if (values.length < 2) return Infinity;
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;
  return percentile(values.map((value, index) => Math.abs(value - (intercept + slope * index))), 0.95);
};

const windowDrift = (values: number[]) => {
  const intervals = values.slice(1).map((value, index) => value - values[index]);
  const split = Math.floor(intervals.length / 2);
  if (!split || !intervals.length) return Infinity;
  const first = median(intervals.slice(0, split));
  const second = median(intervals.slice(split));
  const typical = median(intervals);
  return typical > 0 ? Math.abs(first - second) / typical : Infinity;
};

export const assessAutomaticRhythmTrust = (evidence: RhythmEvidence): AutomaticRhythmTrust => {
  const { durationSeconds, beatsSeconds, downbeatsSeconds, energyByBeat } = evidence;
  const hardFailures: string[] = [];
  const reasons: string[] = [];
  const durationValid = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const beatsValid = durationValid && strictlyIncreasingFinite(beatsSeconds, durationSeconds);
  const downbeatsValid = durationValid && strictlyIncreasingFinite(downbeatsSeconds, durationSeconds);
  const signalEvidenceValid = energyByBeat.length === beatsSeconds.length &&
    energyByBeat.every((energy) => Number.isFinite(energy) && energy >= 0);
  if (!durationValid) hardFailures.push("Track duration is invalid.");
  if (!beatsValid) hardFailures.push("Beat events are malformed.");
  if (!downbeatsValid) hardFailures.push("Downbeat events are malformed.");
  if (beatsSeconds.length < 8) hardFailures.push("Too few beats were found.");
  if (!signalEvidenceValid) hardFailures.push("Beat-aligned signal evidence is unavailable.");

  const intervals = beatsValid
    ? beatsSeconds.slice(1).map((beat, index) => beat - beatsSeconds[index])
    : [];
  const typical = intervals.length ? median(intervals) : 0;
  const mad = intervals.length
    ? median(intervals.map((interval) => Math.abs(interval - typical)))
    : Infinity;
  const jitter = typical > 0 ? (1.4826 * mad) / typical : Infinity;
  const split = Math.floor(intervals.length / 2);
  const firstTempo = split ? median(intervals.slice(0, split)) : 0;
  const secondTempo = intervals.length - split ? median(intervals.slice(split)) : 0;
  const drift = typical > 0 ? Math.abs(firstTempo - secondTempo) / typical : Infinity;

  const downbeatMatches = downbeatsValid && beatsValid
    ? downbeatsSeconds.map((downbeat) => nearestIndex(beatsSeconds, downbeat))
    : [];
  const downbeatsOnBeats = downbeatMatches.length
    ? downbeatMatches.filter((match) => match.distance <= 0.07).length / downbeatMatches.length
    : 0;
  const downbeatIndices = downbeatMatches.map((match) => match.index);
  const downbeatSpacings = downbeatIndices.slice(1).map((value, index) => value - downbeatIndices[index]);
  const counts = {
    3: downbeatSpacings.filter((spacing) => spacing === 3).length,
    4: downbeatSpacings.filter((spacing) => spacing === 4).length
  };
  const meterCandidate = downbeatSpacings.length ? (counts[4] >= counts[3] ? 4 : 3) : null;
  const modalSpacingSupport = downbeatSpacings.length && meterCandidate
    ? counts[meterCandidate] / downbeatSpacings.length
    : 0;
  const complete32BeatWindows = downbeatIndices.filter((index) => index + 31 < beatsSeconds.length).length;
  const nonSilentBeats = signalEvidenceValid && energyByBeat.length
    ? energyByBeat.filter((energy) => energy >= 0.02).length / energyByBeat.length
    : 0;
  if (signalEvidenceValid && nonSilentBeats < 0.2) {
    hardFailures.push("The signal has too little rhythmic activity.");
  }

  const usable16BeatWindows: Array<{ startBeatIndex: number; endBeatIndex: number }> = [];
  const usableCutBeatIndices: number[] = [];
  let bestLocalPhaseP95 = Infinity;
  let bestLocalDrift = Infinity;
  if (
    !hardFailures.length && meterCandidate && downbeatsOnBeats === 1 &&
    modalSpacingSupport >= CUT_METER_SUPPORT_LIMIT
  ) {
    for (let downbeatOffset = 0; downbeatOffset < downbeatIndices.length; downbeatOffset += 1) {
      const startBeatIndex = downbeatIndices[downbeatOffset];
      const endBeatIndex = startBeatIndex + CUT_WINDOW_BEATS;
      if (endBeatIndex > beatsSeconds.length) continue;
      const localBeats = beatsSeconds.slice(startBeatIndex, endBeatIndex);
      const phaseP95 = affineResidualP95(localBeats);
      const localDrift = windowDrift(localBeats);
      bestLocalPhaseP95 = Math.min(bestLocalPhaseP95, phaseP95);
      bestLocalDrift = Math.min(bestLocalDrift, localDrift);
      const previousSpacing = downbeatOffset > 0
        ? startBeatIndex - downbeatIndices[downbeatOffset - 1]
        : null;
      const nextSpacing = downbeatOffset + 1 < downbeatIndices.length
        ? downbeatIndices[downbeatOffset + 1] - startBeatIndex
        : null;
      const locallyBarAligned = previousSpacing === meterCandidate || nextSpacing === meterCandidate;
      const localActivity = energyByBeat.slice(startBeatIndex, endBeatIndex)
        .filter((energy) => energy >= 0.02).length / CUT_WINDOW_BEATS;
      if (
        phaseP95 <= CUT_PHASE_P95_LIMIT_SECONDS && localDrift <= CUT_DRIFT_LIMIT &&
        locallyBarAligned && localActivity >= 0.5
      ) {
        usableCutBeatIndices.push(startBeatIndex);
        usable16BeatWindows.push({ startBeatIndex, endBeatIndex });
      }
    }
  }

  if (!downbeatsSeconds.length) reasons.push("No automatic bar-start grid is available.");
  else if (!meterCandidate || modalSpacingSupport < CUT_METER_SUPPORT_LIMIT) {
    reasons.push(`Automatic bar grouping support is ${(modalSpacingSupport * 100).toFixed(0)}%; 85% is required.`);
  }
  if (jitter > 0.03) reasons.push("The detected tempo is not stable enough across the track.");
  if (drift > 0.04) reasons.push("The detected pulse changes too much across the track.");
  if (downbeatsSeconds.length && downbeatsOnBeats < 1) reasons.push("Some bar starts do not align with detected beats.");
  if (downbeatsSeconds.length && meterCandidate && modalSpacingSupport >= CUT_METER_SUPPORT_LIMIT && !usableCutBeatIndices.length) {
    const phaseText = Number.isFinite(bestLocalPhaseP95) ? `${Math.round(bestLocalPhaseP95 * 1000)} ms` : "unavailable";
    reasons.push(`No local bar handoff passed the 40 ms timing check (best ${phaseText}).`);
  }
  if (!complete32BeatWindows) reasons.push("No complete 32-beat bar-aligned window is available.");

  const dimensions = {
    validity: hardFailures.length ? 0 : 1,
    coverage: clamp01(beatsSeconds.length / 64),
    tempoStability: clamp01(1 - Math.max(jitter / 0.03, drift / 0.04)),
    phaseStability: clamp01(1 - bestLocalPhaseP95 / 0.07),
    downbeatCoherence: meterCandidate ? clamp01(Math.min(downbeatsOnBeats, modalSpacingSupport)) : 0,
    signalActivity: clamp01(nonSilentBeats / 0.8)
  };
  const trustIndex = Math.round(100 * Math.min(...Object.values(dimensions)));

  let tier: AutomaticRhythmTrust["tier"] = "reject";
  if (!hardFailures.length && beatsSeconds.length >= 8) tier = "boundary-only";
  if (tier !== "reject" && usableCutBeatIndices.length) tier = "bar-cut-candidate";
  if (
    tier === "bar-cut-candidate" && complete32BeatWindows > 0 && beatsSeconds.length >= 64 &&
    jitter <= 0.01 && drift <= 0.015 && bestLocalPhaseP95 <= 0.025 && modalSpacingSupport >= 0.9
  ) tier = "long-candidate";

  return {
    schemaVersion: AUTOMATIC_RHYTHM_TRUST_SCHEMA_VERSION,
    tier,
    trustIndex,
    calibrationVersion: null,
    calibratedSafeProbability: null,
    hardFailures: [...new Set(hardFailures)],
    reasons: [...new Set(reasons)],
    dimensions,
    complete32BeatWindows,
    usableCutBeatIndices,
    usable16BeatWindows
  };
};
