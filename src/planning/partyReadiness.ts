export type PartyReadinessInput = {
  sourcePlaying: boolean;
  sourceReady: boolean;
  targetReady: boolean;
  targetActive: boolean;
  queuedTracks: number;
  analyzedQueuedTracks: number;
  libraryFillTracks: number;
  enhancedTimingReady: boolean;
};

export type PartyReadiness = {
  canStart: boolean;
  level: "ready" | "safe-only" | "needs-tracks" | "start-source" | "stop-target";
  headline: string;
  details: string[];
};

export const assessPartyReadiness = (input: PartyReadinessInput): PartyReadiness => {
  const availableNextTracks = input.queuedTracks + input.libraryFillTracks + (input.targetReady ? 1 : 0);
  if (!input.sourceReady || !input.sourcePlaying) {
    return {
      canStart: false,
      level: "start-source",
      headline: "Start one deck first",
      details: ["Autopilot needs a playing source deck before it can prepare a handoff."]
    };
  }
  if (input.targetReady && input.targetActive) {
    return {
      canStart: false,
      level: "stop-target",
      headline: "Stop the other deck first",
      details: ["Autopilot will not restart or overwrite a deck that is already playing."]
    };
  }
  if (!availableNextTracks) {
    return {
      canStart: false,
      level: "needs-tracks",
      headline: "Add at least one next track",
      details: ["Load the other deck or add music to the queue."]
    };
  }
  const details = [
    `${availableNextTracks} next ${availableNextTracks === 1 ? "track" : "tracks"} available.`,
    `${input.analyzedQueuedTracks}/${input.queuedTracks} queued tracks analyzed.`
  ];
  if (input.libraryFillTracks > 0) {
    details.push(`${input.libraryFillTracks} additional unplayed library ${input.libraryFillTracks === 1 ? "track" : "tracks"} available after the queue.`);
  }
  if (!input.enhancedTimingReady) {
    return {
      canStart: true,
      level: "safe-only",
      headline: "Ready with conservative song changes",
      details: [...details, "Beat-timed changes are unavailable, so Mazzy will briefly overlap songs without beat matching."]
    };
  }
  return {
      canStart: true,
      level: "ready",
      headline: "Basic preflight passed",
      details
  };
};
