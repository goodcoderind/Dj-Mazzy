export const DECK_PLAYBACK_COMPLETION_VERSION =
  "deck-playback-completion-ownership/v1" as const;

export const DECK_PLAYBACK_COMPLETION_WATCHDOG_GRACE_SECONDS = 0.05;

export type DeckPlaybackCompletionSignal =
  | "source-onended"
  | "audio-clock"
  | "reconcile";

export type DeckPlaybackCompletionLease = Readonly<{
  version: typeof DECK_PLAYBACK_COMPLETION_VERSION;
  operation: number;
  channel: "a" | "b";
  loadRevision: number;
  transportRevision: number;
  ratePlanRevision: number;
  sourceId: number;
  trackId: string | null;
  intent: "natural" | "scheduled-stop";
  startTimeSeconds: number;
  startOffsetSeconds: number;
  durationSeconds: number;
  endPositionSeconds: number;
  expectedEndTimeSeconds: number;
  watchdogTimeSeconds: number;
}>;

const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const nonNegativeFinite = (value: number) => Number.isFinite(value) && value >= 0;
const positiveFinite = (value: number) => Number.isFinite(value) && value > 0;

const validTrackId = (value: string | null) => value == null ||
  (typeof value === "string" && value.length > 0 && value.length <= 256);

export const deriveConstantRatePlaybackEndTime = (input: Readonly<{
  startTimeSeconds: number;
  startOffsetSeconds: number;
  durationSeconds: number;
  playbackRate: number;
}>) => {
  if (!nonNegativeFinite(input.startTimeSeconds) || !nonNegativeFinite(input.startOffsetSeconds) ||
    !positiveFinite(input.durationSeconds) || input.startOffsetSeconds >= input.durationSeconds ||
    !positiveFinite(input.playbackRate)) {
    throw new RangeError("invalid constant-rate playback interval");
  }
  return input.startTimeSeconds +
    (input.durationSeconds - input.startOffsetSeconds) / input.playbackRate;
};

export const deriveRampedPlaybackEndTime = (input: Readonly<{
  durationSeconds: number;
  rampStartTimeSeconds: number;
  rampStartPositionSeconds: number;
  rampDurationSeconds: number;
  startRate: number;
  targetRate: number;
}>) => {
  if (!positiveFinite(input.durationSeconds) || !nonNegativeFinite(input.rampStartTimeSeconds) ||
    !nonNegativeFinite(input.rampStartPositionSeconds) ||
    input.rampStartPositionSeconds >= input.durationSeconds ||
    !positiveFinite(input.rampDurationSeconds) || !positiveFinite(input.startRate) ||
    !positiveFinite(input.targetRate)) {
    throw new RangeError("invalid playback-rate ramp interval");
  }
  const remaining = input.durationSeconds - input.rampStartPositionSeconds;
  const slope = (input.targetRate - input.startRate) / input.rampDurationSeconds;
  const rampDistance = (input.startRate + input.targetRate) * 0.5 * input.rampDurationSeconds;
  if (remaining <= rampDistance + 1e-12) {
    const elapsed = Math.abs(slope) < 1e-12
      ? remaining / input.startRate
      : (-input.startRate + Math.sqrt(
        input.startRate * input.startRate + 2 * slope * remaining
      )) / slope;
    if (!nonNegativeFinite(elapsed) || elapsed > input.rampDurationSeconds + 1e-9) {
      throw new RangeError("playback-rate ramp has no finite completion");
    }
    return input.rampStartTimeSeconds + Math.min(elapsed, input.rampDurationSeconds);
  }
  return input.rampStartTimeSeconds + input.rampDurationSeconds +
    (remaining - rampDistance) / input.targetRate;
};

const validLease = (lease: DeckPlaybackCompletionLease | null | undefined) => Boolean(lease &&
  lease.version === DECK_PLAYBACK_COMPLETION_VERSION &&
  positiveSafeInteger(lease.operation) && ["a", "b"].includes(lease.channel) &&
  positiveSafeInteger(lease.loadRevision) && positiveSafeInteger(lease.transportRevision) &&
  positiveSafeInteger(lease.ratePlanRevision) && positiveSafeInteger(lease.sourceId) &&
  validTrackId(lease.trackId) && nonNegativeFinite(lease.startTimeSeconds) &&
  ["natural", "scheduled-stop"].includes(lease.intent) &&
  nonNegativeFinite(lease.startOffsetSeconds) && positiveFinite(lease.durationSeconds) &&
  lease.startOffsetSeconds < lease.durationSeconds &&
  nonNegativeFinite(lease.endPositionSeconds) && lease.endPositionSeconds <= lease.durationSeconds &&
  positiveFinite(lease.expectedEndTimeSeconds) &&
  lease.expectedEndTimeSeconds >= lease.startTimeSeconds &&
  lease.watchdogTimeSeconds ===
    lease.expectedEndTimeSeconds + DECK_PLAYBACK_COMPLETION_WATCHDOG_GRACE_SECONDS);

export const createDeckPlaybackCompletionLease = (input: Omit<
  DeckPlaybackCompletionLease,
  "version" | "watchdogTimeSeconds"
>): DeckPlaybackCompletionLease => {
  const lease = Object.freeze({
    ...input,
    version: DECK_PLAYBACK_COMPLETION_VERSION,
    watchdogTimeSeconds:
      input.expectedEndTimeSeconds + DECK_PLAYBACK_COMPLETION_WATCHDOG_GRACE_SECONDS
  });
  if (!validLease(lease)) throw new RangeError("invalid deck playback completion lease");
  return lease;
};

export const ownsDeckPlaybackCompletionLease = (
  current: DeckPlaybackCompletionLease | null | undefined,
  expected: DeckPlaybackCompletionLease | null | undefined
) => Boolean(validLease(current) && validLease(expected) &&
  current?.operation === expected?.operation && current?.channel === expected?.channel &&
  current?.loadRevision === expected?.loadRevision &&
  current?.transportRevision === expected?.transportRevision &&
  current?.ratePlanRevision === expected?.ratePlanRevision &&
  current?.sourceId === expected?.sourceId && current?.trackId === expected?.trackId &&
  current?.intent === expected?.intent &&
  current?.startTimeSeconds === expected?.startTimeSeconds &&
  current?.startOffsetSeconds === expected?.startOffsetSeconds &&
  current?.durationSeconds === expected?.durationSeconds &&
  current?.endPositionSeconds === expected?.endPositionSeconds &&
  current?.expectedEndTimeSeconds === expected?.expectedEndTimeSeconds &&
  current?.watchdogTimeSeconds === expected?.watchdogTimeSeconds);

export const inspectDeckPlaybackCompletion = (input: Readonly<{
  current: DeckPlaybackCompletionLease | null;
  expected: DeckPlaybackCompletionLease;
  nowSeconds: number;
  loadRevision: number;
  transportRevision: number;
  sourceId: number;
  trackId: string | null;
  sourcePresent: boolean;
  signal: DeckPlaybackCompletionSignal;
}>): "superseded" | "waiting" | "ready" => {
  if (!nonNegativeFinite(input.nowSeconds) || !positiveSafeInteger(input.loadRevision) ||
    !positiveSafeInteger(input.transportRevision) || !positiveSafeInteger(input.sourceId) ||
    !validTrackId(input.trackId) || typeof input.sourcePresent !== "boolean" ||
    !["source-onended", "audio-clock", "reconcile"].includes(input.signal)) {
    return "superseded";
  }
  if (!ownsDeckPlaybackCompletionLease(input.current, input.expected) ||
    input.loadRevision !== input.expected.loadRevision ||
    input.transportRevision !== input.expected.transportRevision ||
    input.sourceId !== input.expected.sourceId || input.trackId !== input.expected.trackId ||
    !input.sourcePresent) {
    return "superseded";
  }
  const readyTime = input.signal === "source-onended"
    ? input.expected.expectedEndTimeSeconds
    : input.expected.watchdogTimeSeconds;
  return input.nowSeconds + 1e-9 < readyTime
    ? "waiting"
    : "ready";
};
