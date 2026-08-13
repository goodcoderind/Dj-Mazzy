import { SAFE_FADE_SECONDS } from "./TransitionPlanner";

export type AutoPilotDecisionInput = {
  template: "phrase-blend" | "downbeat-cut" | "filtered-fade" | "safe-fade";
  remainingSeconds: number;
  untilPlannedStartSeconds: number;
};

export const shouldArmAutoPilotTransition = ({
  template,
  remainingSeconds,
  untilPlannedStartSeconds
}: AutoPilotDecisionInput) => {
  if (![remainingSeconds, untilPlannedStartSeconds].every(Number.isFinite)) return false;
  if (remainingSeconds < 0) return false;
  if (template === "downbeat-cut") {
    return remainingSeconds <= 20 && untilPlannedStartSeconds >= 0 && untilPlannedStartSeconds <= 6;
  }
  if (template === "phrase-blend") {
    return remainingSeconds <= 30 && untilPlannedStartSeconds >= 0 && untilPlannedStartSeconds <= 8;
  }
  if (template === "filtered-fade") {
    return remainingSeconds <= 6 && untilPlannedStartSeconds >= 0 && untilPlannedStartSeconds <= 0.5;
  }
  return remainingSeconds <= SAFE_FADE_SECONDS + 0.25;
};
