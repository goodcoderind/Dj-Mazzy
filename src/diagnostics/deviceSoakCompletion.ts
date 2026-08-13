export type DeviceSoakCompletionDecision = "continue" | "finish" | "finish-stalled";

export const decideDeviceSoakCompletion = (
  wallElapsedSeconds: number,
  audioElapsedSeconds: number,
  requestedDurationSeconds: number,
  maximumWallSlackSeconds = 5
): DeviceSoakCompletionDecision => {
  if (![wallElapsedSeconds, audioElapsedSeconds, requestedDurationSeconds, maximumWallSlackSeconds]
    .every(Number.isFinite) || wallElapsedSeconds < 0 || audioElapsedSeconds < 0 ||
    requestedDurationSeconds <= 0 || maximumWallSlackSeconds < 0) {
    throw new RangeError("device soak completion clocks must be finite and non-negative");
  }
  if (wallElapsedSeconds >= requestedDurationSeconds && audioElapsedSeconds >= requestedDurationSeconds) return "finish";
  if (wallElapsedSeconds >= requestedDurationSeconds + maximumWallSlackSeconds) return "finish-stalled";
  return "continue";
};
