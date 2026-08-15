import type { CrossfadeSchedule, DeckChannel } from "../audio/AudioEngine";

export type RescueTransitionDecision = Readonly<{
  keep: DeckChannel;
  stop: DeckChannel;
  progress: number;
}>;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const decideRescueTransition = (
  schedule: CrossfadeSchedule,
  audioTime: number
): RescueTransitionDecision => {
  if (!Number.isFinite(audioTime)) {
    throw new RangeError("audioTime must be finite");
  }
  const duration = schedule.endTime - schedule.startTime;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError("crossfade schedule must have a positive duration");
  }
  const progress = clamp01((audioTime - schedule.startTime) / duration);
  const keep = progress < 0.5 ? schedule.source : schedule.target;
  return Object.freeze({
    keep,
    stop: keep === schedule.source ? schedule.target : schedule.source,
    progress
  });
};
