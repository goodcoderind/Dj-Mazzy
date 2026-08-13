export type SoakSimulationOptions = {
  sessionDurationSeconds?: number;
  trackDurationSeconds?: number;
  transitionDurationSeconds?: number;
};

export type SimulatedPlaybackInterval = Readonly<{
  deck: "a" | "b";
  trackIndex: number;
  startTime: number;
  endTime: number;
}>;

export type SoakSimulationResult = Readonly<{
  completed: boolean;
  sessionDurationSeconds: number;
  renderedUntilSeconds: number;
  transitions: number;
  tracksUsed: number;
  uncoveredSeconds: number;
  maximumConcurrentTracks: number;
  maximumDecodedTracks: number;
  intervals: readonly SimulatedPlaybackInterval[];
  errors: readonly string[];
}>;

const requirePositiveFinite = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
};

/**
 * Deterministic long-session scheduler simulation.
 *
 * This does not replace a real-time browser/audio-device soak test. It catches
 * timeline gaps, runaway preloading, and non-deterministic handoff logic before
 * spending two wall-clock hours on the full system test.
 */
export const simulatePlaybackSoak = ({
  sessionDurationSeconds = 2 * 60 * 60,
  trackDurationSeconds = 3.5 * 60,
  transitionDurationSeconds = 16
}: SoakSimulationOptions = {}): SoakSimulationResult => {
  requirePositiveFinite(sessionDurationSeconds, "sessionDurationSeconds");
  requirePositiveFinite(trackDurationSeconds, "trackDurationSeconds");
  requirePositiveFinite(transitionDurationSeconds, "transitionDurationSeconds");
  if (transitionDurationSeconds >= trackDurationSeconds) {
    throw new RangeError("transitionDurationSeconds must be shorter than a track");
  }

  const intervals: SimulatedPlaybackInterval[] = [];
  let trackIndex = 0;
  let startTime = 0;
  let renderedUntil = 0;

  while (renderedUntil < sessionDurationSeconds) {
    const endTime = startTime + trackDurationSeconds;
    intervals.push(
      Object.freeze({
        deck: trackIndex % 2 === 0 ? "a" : "b",
        trackIndex,
        startTime,
        endTime
      })
    );
    renderedUntil = Math.max(renderedUntil, endTime);
    startTime = endTime - transitionDurationSeconds;
    trackIndex += 1;
  }

  let coveredUntil = 0;
  let uncoveredSeconds = 0;
  const boundaryEvents: Array<{ time: number; delta: number }> = [];
  for (const interval of intervals) {
    if (interval.startTime > coveredUntil) {
      uncoveredSeconds += interval.startTime - coveredUntil;
    }
    coveredUntil = Math.max(coveredUntil, interval.endTime);
    boundaryEvents.push({ time: interval.startTime, delta: 1 });
    boundaryEvents.push({ time: interval.endTime, delta: -1 });
  }

  boundaryEvents.sort((left, right) => left.time - right.time || left.delta - right.delta);
  let concurrentTracks = 0;
  let maximumConcurrentTracks = 0;
  for (const event of boundaryEvents) {
    concurrentTracks += event.delta;
    maximumConcurrentTracks = Math.max(maximumConcurrentTracks, concurrentTracks);
  }

  const errors: string[] = [];
  if (uncoveredSeconds > 0) errors.push(`timeline contains ${uncoveredSeconds} seconds of silence`);
  if (maximumConcurrentTracks > 2) errors.push("more than two tracks overlap");

  return Object.freeze({
    completed: renderedUntil >= sessionDurationSeconds && errors.length === 0,
    sessionDurationSeconds,
    renderedUntilSeconds: renderedUntil,
    transitions: Math.max(0, intervals.length - 1),
    tracksUsed: intervals.length,
    uncoveredSeconds,
    maximumConcurrentTracks,
    maximumDecodedTracks: Math.min(2, intervals.length),
    intervals: Object.freeze(intervals),
    errors: Object.freeze(errors)
  });
};
