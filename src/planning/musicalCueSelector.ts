export type MusicalCueTrack = {
  duration: number;
  beatsSeconds: number[];
  automaticRhythmTrust?: { usableCutBeatIndices?: number[] } | null;
  energyByBeat?: number[] | null;
  vocalProbabilityByBeat?: number[] | null;
  structureBoundaries?: Array<{ beatIndex: number; confidence: number }> | null;
};

export type MusicalCueRole = "outgoing" | "incoming";

export type RankedMusicalCue = {
  beatIndex: number;
  timeSeconds: number;
  score: number;
  meanEnergy: number | null;
  meanVocalProxy: number | null;
  nearStructureBoundary: boolean;
  reason: string;
};

export type RankedMusicalCuePair = {
  source: RankedMusicalCue;
  target: RankedMusicalCue;
  score: number;
  energyDifference: number | null;
  combinedVocalProxy: number | null;
  reason: string;
};

const meanWindow = (values: number[] | null | undefined, start: number, count = 8) => {
  if (!values || values.length < start + count) return null;
  const window = values.slice(start, start + count);
  if (window.some((value) => !Number.isFinite(value))) return null;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
};

const featureScore = (value: number | null, fallback: number) => value == null ? fallback : value;

export const rankTrustedMusicalCues = (
  track: MusicalCueTrack,
  role: MusicalCueRole,
  { minimumTimeSeconds = 0, maximumWaitSeconds = Infinity } = {}
): RankedMusicalCue[] => {
  const openingLimit = Math.min(45, track.duration * 0.25);
  const maximumTime = role === "incoming"
    ? openingLimit
    : Math.min(track.duration, minimumTimeSeconds + maximumWaitSeconds);
  const boundaries = track.structureBoundaries ?? [];
  return (track.automaticRhythmTrust?.usableCutBeatIndices ?? [])
    .map((beatIndex) => {
      const timeSeconds = track.beatsSeconds[beatIndex];
      if (!Number.isFinite(timeSeconds)) return null;
      if (timeSeconds < minimumTimeSeconds || timeSeconds > maximumTime + 0.001) return null;
      const meanEnergy = meanWindow(track.energyByBeat, beatIndex);
      const meanVocalProxy = meanWindow(track.vocalProbabilityByBeat, beatIndex);
      const boundary = boundaries.find((candidate) => Math.abs(candidate.beatIndex - beatIndex) <= 2);
      const nearStructureBoundary = Boolean(boundary);
      const hasSoftEvidence = meanEnergy != null || meanVocalProxy != null || nearStructureBoundary;
      const vocalClarity = 1 - featureScore(meanVocalProxy, 0.5);
      const energy = featureScore(meanEnergy, 0.5);
      const structure = boundary?.confidence ?? 0;
      const roleEnergy = role === "incoming"
        ? 1 - Math.min(1, Math.abs(energy - 0.55) / 0.55)
        : 1 - Math.min(1, Math.abs(energy - 0.45) / 0.55);
      const progress = track.duration > 0 ? timeSeconds / track.duration : 0;
      const positionPreference = role === "incoming"
        ? 1 - timeSeconds / Math.max(openingLimit, 0.001)
        : progress;
      const score = hasSoftEvidence
        ? vocalClarity * 0.45 + roleEnergy * 0.25 + structure * 0.2 + positionPreference * 0.1
        : -timeSeconds / Math.max(track.duration, 1);
      const reason = meanVocalProxy != null && meanVocalProxy <= 0.35
        ? nearStructureBoundary
          ? "Trusted cue where the proxy estimates fewer vocal-like frequencies, near a musical change."
          : "Trusted cue where the proxy estimates fewer vocal-like frequencies."
        : nearStructureBoundary
          ? "Trusted cue near a musical change."
          : "Best available trusted timing cue.";
      return { beatIndex, timeSeconds, score, meanEnergy, meanVocalProxy, nearStructureBoundary, reason };
    })
    .filter((cue): cue is RankedMusicalCue => cue !== null)
    .sort((left, right) => right.score - left.score || left.timeSeconds - right.timeSeconds);
};

export const rankTrustedMusicalCuePairs = (
  sourceTrack: MusicalCueTrack,
  targetTrack: MusicalCueTrack,
  sourceOptions: { minimumTimeSeconds?: number; maximumWaitSeconds?: number } = {}
): RankedMusicalCuePair[] => {
  const sourceCues = rankTrustedMusicalCues(sourceTrack, "outgoing", sourceOptions);
  const targetCues = rankTrustedMusicalCues(targetTrack, "incoming");
  const pairs: RankedMusicalCuePair[] = [];
  for (const source of sourceCues) {
    for (const target of targetCues) {
      const energyDifference = source.meanEnergy != null && target.meanEnergy != null
        ? Math.abs(source.meanEnergy - target.meanEnergy)
        : null;
      const combinedVocalProxy = source.meanVocalProxy != null && target.meanVocalProxy != null
        ? (source.meanVocalProxy + target.meanVocalProxy) / 2
        : null;
      const energyContinuity = energyDifference == null ? 0.5 : 1 - Math.min(1, energyDifference);
      const vocalClarity = combinedVocalProxy == null ? 0.5 : 1 - combinedVocalProxy;
      const score = (source.score + target.score) / 2 * 0.65 + energyContinuity * 0.25 + vocalClarity * 0.1;
      const reason = energyDifference != null && energyDifference <= 0.15
        ? combinedVocalProxy != null && combinedVocalProxy <= 0.35
          ? "Matched-energy trusted cues with lower likely vocal overlap."
          : "Matched-energy trusted cues."
        : combinedVocalProxy != null && combinedVocalProxy <= 0.35
          ? "Trusted cues with lower likely vocal overlap."
          : "Best available trusted cue pair.";
      pairs.push({ source, target, score, energyDifference, combinedVocalProxy, reason });
    }
  }
  return pairs.sort((left, right) =>
    right.score - left.score ||
    left.source.timeSeconds - right.source.timeSeconds ||
    left.target.timeSeconds - right.target.timeSeconds
  );
};
