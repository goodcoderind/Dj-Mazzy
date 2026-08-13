export const DEFAULT_PHRASE_BEATS = 32;

const requirePositiveFinite = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const secondsForBeats = (beats: number, bpm: number) => {
  requirePositiveFinite(beats, "beats");
  requirePositiveFinite(bpm, "bpm");
  return (beats * 60) / bpm;
};

export const playbackRateForBpm = (originalBpm: number, targetBpm: number) => {
  requirePositiveFinite(originalBpm, "originalBpm");
  requirePositiveFinite(targetBpm, "targetBpm");
  return targetBpm / originalBpm;
};

export type OctaveAwareTempoMatch = {
  adjustedBpm: number;
  distance: number;
  octaveShift: -1 | 0 | 1;
};

export const octaveAwareTempoMatch = (
  referenceBpm: number,
  candidateBpm: number
): OctaveAwareTempoMatch => {
  requirePositiveFinite(referenceBpm, "referenceBpm");
  requirePositiveFinite(candidateBpm, "candidateBpm");

  const shifts = [-1, 0, 1] as const;
  return shifts
    .map((octaveShift) => {
      const adjustedBpm = candidateBpm * 2 ** octaveShift;
      return {
        adjustedBpm,
        distance: Math.abs(Math.log2(adjustedBpm / referenceBpm)),
        octaveShift
      };
    })
    .reduce((best, current) => (current.distance < best.distance ? current : best));
};

export const equalPowerGains = (progress: number) => {
  if (!Number.isFinite(progress)) {
    throw new RangeError("progress must be finite");
  }
  const safeProgress = clamp01(progress);
  return {
    source: Math.cos(safeProgress * Math.PI * 0.5),
    target: Math.sin(safeProgress * Math.PI * 0.5)
  };
};

export const createEqualPowerCurves = (points = 512) => {
  if (!Number.isInteger(points) || points < 2) {
    throw new RangeError("points must be an integer greater than one");
  }

  const source = new Float32Array(points);
  const target = new Float32Array(points);
  for (let index = 0; index < points; index += 1) {
    const gains = equalPowerGains(index / (points - 1));
    source[index] = gains.source;
    target[index] = gains.target;
  }
  return { source, target };
};

export const minimumConfidence = (values: number[]) => {
  if (!values.length) {
    throw new RangeError("at least one confidence value is required");
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("confidence values must be finite");
  }
  return Math.min(...values.map(clamp01));
};

export const stretchSeverity = (
  playbackRate: number,
  preferredLimit = 0.06,
  hardLimit = 0.1
) => {
  requirePositiveFinite(playbackRate, "playbackRate");
  requirePositiveFinite(preferredLimit, "preferredLimit");
  requirePositiveFinite(hardLimit, "hardLimit");
  if (preferredLimit > hardLimit) {
    throw new RangeError("preferredLimit cannot exceed hardLimit");
  }

  const adjustment = Math.abs(playbackRate - 1);
  if (adjustment <= preferredLimit) return "preferred" as const;
  if (adjustment <= hardLimit) return "allowed" as const;
  return "reject" as const;
};
