import type { AudioEngine } from "./AudioEngine";

export type BeatAuditionEvent = {
  audioTime: number;
  trackTime: number;
  downbeat: boolean;
};

const isDownbeat = (beat: number, downbeats: number[]) =>
  downbeats.some((downbeat) => Math.abs(downbeat - beat) <= 0.002);

export const createBeatAuditionEvents = ({
  beatsSeconds,
  downbeatsSeconds,
  trackPositionSeconds,
  playbackRate,
  audioStartTime,
  schedulingLeadSeconds = 0.03,
  maxBeats = 16
}: {
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  trackPositionSeconds: number;
  playbackRate: number;
  audioStartTime: number;
  schedulingLeadSeconds?: number;
  maxBeats?: number;
}): BeatAuditionEvent[] => {
  if (
    !Number.isFinite(playbackRate) || playbackRate <= 0 ||
    !Number.isFinite(audioStartTime) ||
    !Number.isFinite(schedulingLeadSeconds) || schedulingLeadSeconds < 0 ||
    !Number.isInteger(maxBeats) || maxBeats <= 0 ||
    beatsSeconds.some((beat, index) => !Number.isFinite(beat) || beat < 0 || (index > 0 && beat <= beatsSeconds[index - 1])) ||
    downbeatsSeconds.some((beat, index) => !Number.isFinite(beat) || beat < 0 || (index > 0 && beat <= downbeatsSeconds[index - 1]))
  ) return [];
  return beatsSeconds
    .filter((beat) => beat >= trackPositionSeconds - 0.002)
    .map((beat) => ({
      audioTime: audioStartTime + Math.max(0, beat - trackPositionSeconds) / playbackRate,
      trackTime: beat,
      downbeat: isDownbeat(beat, downbeatsSeconds)
    }))
    .filter((event) => event.audioTime >= audioStartTime + schedulingLeadSeconds)
    .slice(0, maxBeats);
};

export const startBeatGridAudition = (
  engine: AudioEngine,
  options: Omit<Parameters<typeof createBeatAuditionEvents>[0], "audioStartTime" | "trackPositionSeconds"> & {
    getTrackPosition: (audioTime: number) => number;
  }
) => {
  const audioStartTime = engine.clock.now();
  const { getTrackPosition, ...eventOptions } = options;
  const trackPositionSeconds = getTrackPosition(audioStartTime);
  const events = createBeatAuditionEvents({ ...eventOptions, trackPositionSeconds, audioStartTime });
  return {
    events,
    cancel: engine.scheduleAuditionClicks(events)
  };
};
