export type ClockSource = {
  readonly currentTime: number;
};

export type BeatBoundaryRequest = {
  anchorTime: number;
  bpm: number;
  boundaryBeats: number;
  fromTime?: number;
  minimumLeadSeconds?: number;
};

const requireFinite = (value: number, name: string) => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
};

const requirePositiveFinite = (value: number, name: string) => {
  requireFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
};

/**
 * A small, deterministic wrapper around the Web Audio clock.
 *
 * React state and wall-clock timers may display this clock, but all audio
 * scheduling must ultimately use the times returned here.
 */
export class TransportClock {
  constructor(private readonly source: ClockSource) {}

  now() {
    const currentTime = this.source.currentTime;
    requireFinite(currentTime, "currentTime");
    return currentTime;
  }

  resolveScheduleTime(requestedTime: number, minimumLeadSeconds = 0) {
    requireFinite(requestedTime, "requestedTime");
    requireFinite(minimumLeadSeconds, "minimumLeadSeconds");
    if (minimumLeadSeconds < 0) {
      throw new RangeError("minimumLeadSeconds cannot be negative");
    }
    return Math.max(requestedTime, this.now() + minimumLeadSeconds);
  }

  nextBeatBoundary({
    anchorTime,
    bpm,
    boundaryBeats,
    fromTime = this.now(),
    minimumLeadSeconds = 0
  }: BeatBoundaryRequest) {
    requireFinite(anchorTime, "anchorTime");
    requirePositiveFinite(bpm, "bpm");
    requirePositiveFinite(boundaryBeats, "boundaryBeats");
    requireFinite(fromTime, "fromTime");
    requireFinite(minimumLeadSeconds, "minimumLeadSeconds");
    if (minimumLeadSeconds < 0) {
      throw new RangeError("minimumLeadSeconds cannot be negative");
    }

    const boundarySeconds = (boundaryBeats * 60) / bpm;
    const earliestTime = fromTime + minimumLeadSeconds;
    const elapsedBoundaries = (earliestTime - anchorTime) / boundarySeconds;
    const boundaryIndex = Math.max(0, Math.ceil(elapsedBoundaries - Number.EPSILON * 8));
    return anchorTime + boundaryIndex * boundarySeconds;
  }

  mediaTimeAt(
    contextTime: number,
    startContextTime: number,
    startOffsetSeconds: number,
    playbackRate: number
  ) {
    requireFinite(contextTime, "contextTime");
    requireFinite(startContextTime, "startContextTime");
    requireFinite(startOffsetSeconds, "startOffsetSeconds");
    requirePositiveFinite(playbackRate, "playbackRate");
    return startOffsetSeconds + Math.max(0, contextTime - startContextTime) * playbackRate;
  }
}
