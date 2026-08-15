export const AUTO_PILOT_TRANSITION_COMPLETION_VERSION =
  "auto-pilot-transition-completion-ownership/v1" as const;
export const AUTO_PILOT_TRANSITION_COMPLETION_GRACE_SECONDS = 0.5;
export const AUTO_PILOT_TRANSITION_COMPLETION_DELIVERY_TOLERANCE_SECONDS = 0.02;

export type AutoPilotTransitionCompletionDeck = "a" | "b";

export type AutoPilotTransitionCompletionLease = Readonly<{
  version: typeof AUTO_PILOT_TRANSITION_COMPLETION_VERSION;
  operation: number;
  generation: number;
  scheduleId: number;
  transitionKey: string;
  sourceDeck: AutoPilotTransitionCompletionDeck;
  targetDeck: AutoPilotTransitionCompletionDeck;
  sourceTrackId: string;
  targetTrackId: string;
  sourceLoadKey: string;
  targetLoadKey: string;
  registeredAtSeconds: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  deadlineSeconds: number;
}>;

export type AutoPilotTransitionCompletionPair = Readonly<{
  sourceDeck: AutoPilotTransitionCompletionDeck;
  targetDeck: AutoPilotTransitionCompletionDeck;
  sourceTrackId: string | null;
  targetTrackId: string | null;
  sourceLoadKey: string | null;
  targetLoadKey: string | null;
  targetPlaying: boolean;
}>;

export type AutoPilotTransitionCompletionSchedule = Readonly<{
  id: number;
  source: AutoPilotTransitionCompletionDeck;
  target: AutoPilotTransitionCompletionDeck;
  startTime: number;
  endTime: number;
}>;

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const nonEmpty = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 512;

const validLease = (lease: AutoPilotTransitionCompletionLease) =>
  lease.version === AUTO_PILOT_TRANSITION_COMPLETION_VERSION &&
  positiveInteger(lease.operation) && positiveInteger(lease.generation) && positiveInteger(lease.scheduleId) &&
  ["a", "b"].includes(lease.sourceDeck) && ["a", "b"].includes(lease.targetDeck) &&
  lease.sourceDeck !== lease.targetDeck &&
  nonEmpty(lease.sourceTrackId) && nonEmpty(lease.targetTrackId) &&
  nonEmpty(lease.sourceLoadKey) && nonEmpty(lease.targetLoadKey) &&
  lease.transitionKey === `${lease.sourceLoadKey}->${lease.targetLoadKey}` &&
  finiteNonNegative(lease.registeredAtSeconds) && finiteNonNegative(lease.startTimeSeconds) &&
  finiteNonNegative(lease.endTimeSeconds) && finiteNonNegative(lease.deadlineSeconds) &&
  lease.registeredAtSeconds <= lease.endTimeSeconds && lease.startTimeSeconds < lease.endTimeSeconds &&
  Math.abs(
    lease.deadlineSeconds - lease.endTimeSeconds - AUTO_PILOT_TRANSITION_COMPLETION_GRACE_SECONDS
  ) <= 1e-9;

export const createAutoPilotTransitionCompletionLease = (
  input: Omit<AutoPilotTransitionCompletionLease, "version" | "deadlineSeconds">
) => {
  const lease = Object.freeze({
    version: AUTO_PILOT_TRANSITION_COMPLETION_VERSION,
    ...input,
    deadlineSeconds: input.endTimeSeconds + AUTO_PILOT_TRANSITION_COMPLETION_GRACE_SECONDS
  });
  if (!validLease(lease)) {
    throw new RangeError("transition completion lease must have exact finite schedule and load ownership");
  }
  return lease;
};

export const ownsAutoPilotTransitionCompletionLease = (
  current: AutoPilotTransitionCompletionLease | null | undefined,
  expected: AutoPilotTransitionCompletionLease | null | undefined
) => Boolean(current && expected && validLease(current) && validLease(expected) &&
  current.scheduleId === expected.scheduleId && current.transitionKey === expected.transitionKey &&
  current.operation === expected.operation && current.generation === expected.generation &&
  current.sourceDeck === expected.sourceDeck && current.targetDeck === expected.targetDeck &&
  current.sourceTrackId === expected.sourceTrackId && current.targetTrackId === expected.targetTrackId &&
  current.sourceLoadKey === expected.sourceLoadKey && current.targetLoadKey === expected.targetLoadKey &&
  current.registeredAtSeconds === expected.registeredAtSeconds &&
  current.startTimeSeconds === expected.startTimeSeconds &&
  current.endTimeSeconds === expected.endTimeSeconds && current.deadlineSeconds === expected.deadlineSeconds);

export type AutoPilotTransitionCompletionState =
  | "superseded"
  | "ownership-lost"
  | "waiting"
  | "primary-ready"
  | "watchdog-ready"
  | "late-ready";

export const inspectAutoPilotTransitionCompletion = (input: Readonly<{
  current: AutoPilotTransitionCompletionLease | null;
  expected: AutoPilotTransitionCompletionLease;
  nowSeconds: number;
  engineSchedule: AutoPilotTransitionCompletionSchedule | null;
  pair: AutoPilotTransitionCompletionPair;
  signal: "primary" | "watchdog";
  contextRunning: boolean;
  playbackLocked: boolean;
}>): AutoPilotTransitionCompletionState => {
  if (!finiteNonNegative(input.nowSeconds)) {
    throw new RangeError("nowSeconds must be finite and non-negative");
  }
  if (!ownsAutoPilotTransitionCompletionLease(input.current, input.expected)) return "superseded";
  const lease = input.expected;
  if (input.nowSeconds < lease.registeredAtSeconds) return "superseded";
  if (input.engineSchedule?.id !== lease.scheduleId ||
    input.engineSchedule.source !== lease.sourceDeck || input.engineSchedule.target !== lease.targetDeck ||
    input.engineSchedule.startTime !== lease.startTimeSeconds || input.engineSchedule.endTime !== lease.endTimeSeconds ||
    input.pair.sourceDeck !== lease.sourceDeck || input.pair.targetDeck !== lease.targetDeck ||
    input.pair.sourceTrackId !== lease.sourceTrackId || input.pair.targetTrackId !== lease.targetTrackId ||
    input.pair.sourceLoadKey !== lease.sourceLoadKey || input.pair.targetLoadKey !== lease.targetLoadKey ||
    !input.pair.targetPlaying || !input.contextRunning || input.playbackLocked) {
    return "ownership-lost";
  }
  if (input.signal === "primary") {
    if (input.nowSeconds + 0.01 < lease.endTimeSeconds) return "waiting";
    return input.nowSeconds > lease.deadlineSeconds + AUTO_PILOT_TRANSITION_COMPLETION_DELIVERY_TOLERANCE_SECONDS + 1e-9
      ? "late-ready"
      : "primary-ready";
  }
  if (input.nowSeconds + 1e-9 < lease.deadlineSeconds) return "waiting";
  return input.nowSeconds > lease.deadlineSeconds + AUTO_PILOT_TRANSITION_COMPLETION_DELIVERY_TOLERANCE_SECONDS + 1e-9
    ? "late-ready"
    : "watchdog-ready";
};
