export type HostEnergyCurve = Readonly<{
  warmUp: number;
  build: number;
  peak: number;
  cooldown: number;
}>;

export type EnergyStorylineCandidate = {
  id: string;
  energyByBeat?: readonly number[] | null;
};

export type TrackEnergySummary = Readonly<{
  status: "available" | "missing" | "malformed";
  meanEnergy: number | null;
  sampleCount: number;
  invalidSampleCount: number;
}>;

export type EnergyStorylineScore<T extends EnergyStorylineCandidate> = Readonly<{
  track: T;
  sessionProgress: number;
  targetEnergy: number;
  trackEnergy: number | null;
  deviation: number | null;
  heuristicFit: number | null;
  evidenceStatus: TrackEnergySummary["status"];
  reason: string;
}>;

export const ENERGY_STORYLINE_STAGE_PROGRESS = Object.freeze({
  warmUp: 0,
  build: 0.4,
  peak: 0.75,
  cooldown: 1
} as const);

export const DEFAULT_HOST_ENERGY_CURVE: HostEnergyCurve = Object.freeze({
  warmUp: 0.35,
  build: 0.62,
  peak: 0.9,
  cooldown: 0.4
});

const assertNormalized = (label: string, value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} energy must be a finite number from 0 to 1.`);
  }
};

export const createHostEnergyCurve = (levels: HostEnergyCurve): HostEnergyCurve => {
  assertNormalized("Warm-up", levels.warmUp);
  assertNormalized("Build", levels.build);
  assertNormalized("Peak", levels.peak);
  assertNormalized("Cooldown", levels.cooldown);
  if (levels.warmUp > levels.build || levels.build > levels.peak) {
    throw new RangeError("Warm-up, build, and peak energy must not decrease.");
  }
  if (levels.cooldown > levels.peak) {
    throw new RangeError("Cooldown energy must not exceed peak energy.");
  }
  return Object.freeze({ ...levels });
};

const normalizedProgress = (progress: number) => {
  if (!Number.isFinite(progress)) {
    throw new RangeError("Session progress must be a finite number.");
  }
  return Math.max(0, Math.min(1, progress));
};

const interpolate = (
  progress: number,
  fromProgress: number,
  toProgress: number,
  fromEnergy: number,
  toEnergy: number
) => {
  const position = (progress - fromProgress) / (toProgress - fromProgress);
  return fromEnergy + (toEnergy - fromEnergy) * position;
};

export const targetEnergyAtProgress = (curve: HostEnergyCurve, progress: number) => {
  const validatedCurve = createHostEnergyCurve(curve);
  const normalized = normalizedProgress(progress);
  const stages = ENERGY_STORYLINE_STAGE_PROGRESS;
  if (normalized <= stages.build) {
    return interpolate(normalized, stages.warmUp, stages.build, validatedCurve.warmUp, validatedCurve.build);
  }
  if (normalized <= stages.peak) {
    return interpolate(normalized, stages.build, stages.peak, validatedCurve.build, validatedCurve.peak);
  }
  return interpolate(normalized, stages.peak, stages.cooldown, validatedCurve.peak, validatedCurve.cooldown);
};

export const summarizeTrackEnergy = (
  energyByBeat: readonly number[] | null | undefined
): TrackEnergySummary => {
  if (!energyByBeat?.length) {
    return Object.freeze({
      status: "missing",
      meanEnergy: null,
      sampleCount: 0,
      invalidSampleCount: 0
    });
  }
  const invalidSampleCount = energyByBeat.filter(
    (value) => !Number.isFinite(value) || value < 0 || value > 1
  ).length;
  if (invalidSampleCount) {
    return Object.freeze({
      status: "malformed",
      meanEnergy: null,
      sampleCount: energyByBeat.length,
      invalidSampleCount
    });
  }
  const meanEnergy = energyByBeat.reduce((sum, value) => sum + value, 0) / energyByBeat.length;
  return Object.freeze({
    status: "available",
    meanEnergy,
    sampleCount: energyByBeat.length,
    invalidSampleCount: 0
  });
};

export const scoreEnergyStorylineCandidate = <T extends EnergyStorylineCandidate>(
  track: T,
  curve: HostEnergyCurve,
  progress: number
): EnergyStorylineScore<T> => {
  const sessionProgress = normalizedProgress(progress);
  const targetEnergy = targetEnergyAtProgress(curve, sessionProgress);
  const summary = summarizeTrackEnergy(track.energyByBeat);
  if (summary.meanEnergy == null) {
    const reason = summary.status === "missing"
      ? "Relative beat-activity evidence is missing; storyline fit was not scored."
      : "Relative beat-activity evidence is malformed; storyline fit was not scored.";
    return Object.freeze({
      track,
      sessionProgress,
      targetEnergy,
      trackEnergy: null,
      deviation: null,
      heuristicFit: null,
      evidenceStatus: summary.status,
      reason
    });
  }

  const deviation = Math.abs(summary.meanEnergy - targetEnergy);
  const direction = deviation <= 0.025
    ? "on the storyline target"
    : summary.meanEnergy < targetEnergy
      ? "below the storyline target"
      : "above the storyline target";
  return Object.freeze({
    track,
    sessionProgress,
    targetEnergy,
    trackEnergy: summary.meanEnergy,
    deviation,
    // This is geometric closeness on normalized analyzer output, not a probability.
    heuristicFit: 1 - deviation,
    evidenceStatus: summary.status,
    reason: `Relative beat activity is ${direction}.`
  });
};

export const rankEnergyStorylineCandidates = <T extends EnergyStorylineCandidate>(
  candidates: readonly T[],
  curve: HostEnergyCurve,
  progress: number
): Array<EnergyStorylineScore<T>> =>
  candidates
    .map((track, inputIndex) => ({
      inputIndex,
      result: scoreEnergyStorylineCandidate(track, curve, progress)
    }))
    .sort((left, right) => {
      const leftFit = left.result.heuristicFit ?? Number.NEGATIVE_INFINITY;
      const rightFit = right.result.heuristicFit ?? Number.NEGATIVE_INFINITY;
      return rightFit - leftFit || left.inputIndex - right.inputIndex;
    })
    .map(({ result }) => result);
