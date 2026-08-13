export const PARTY_SESSION_CLOCK_SCHEMA_VERSION = "party-session-clock/v1" as const;

export type PartySessionClock = Readonly<{
  schemaVersion: typeof PARTY_SESSION_CLOCK_SCHEMA_VERSION;
  plannedDurationSeconds: number;
  accumulatedActiveSeconds: number;
  runningSinceSeconds: number | null;
  hasStarted: boolean;
}>;

export type PartySessionClockSnapshot = Readonly<{
  status: "not-started" | "running" | "paused" | "complete";
  isRunning: boolean;
  plannedDurationSeconds: number;
  elapsedActiveSeconds: number;
  remainingSeconds: number;
  overtimeSeconds: number;
  energyProgress: number;
}>;

const requirePositiveDuration = (durationSeconds: number) => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("Party duration must be a positive finite number of seconds.");
  }
};

const requireClockTime = (nowSeconds: number) => {
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0) {
    throw new RangeError("Party clock time must be a non-negative finite number.");
  }
};

const freezeClock = (clock: PartySessionClock): PartySessionClock => Object.freeze(clock);

export const createPartySessionClock = (plannedDurationSeconds: number): PartySessionClock => {
  requirePositiveDuration(plannedDurationSeconds);
  return freezeClock({
    schemaVersion: PARTY_SESSION_CLOCK_SCHEMA_VERSION,
    plannedDurationSeconds,
    accumulatedActiveSeconds: 0,
    runningSinceSeconds: null,
    hasStarted: false
  });
};

export const startPartySessionClock = (
  clock: PartySessionClock,
  nowSeconds: number
): PartySessionClock => {
  requireClockTime(nowSeconds);
  if (clock.runningSinceSeconds != null) return clock;
  return freezeClock({
    ...clock,
    runningSinceSeconds: nowSeconds,
    hasStarted: true
  });
};

const runningElapsed = (clock: PartySessionClock, nowSeconds: number) => {
  if (clock.runningSinceSeconds == null) return clock.accumulatedActiveSeconds;
  if (nowSeconds < clock.runningSinceSeconds) {
    throw new RangeError("Party clock time cannot move backwards while the session is running.");
  }
  return clock.accumulatedActiveSeconds + nowSeconds - clock.runningSinceSeconds;
};

export const pausePartySessionClock = (
  clock: PartySessionClock,
  nowSeconds: number
): PartySessionClock => {
  requireClockTime(nowSeconds);
  if (clock.runningSinceSeconds == null) return clock;
  return freezeClock({
    ...clock,
    accumulatedActiveSeconds: runningElapsed(clock, nowSeconds),
    runningSinceSeconds: null
  });
};

export const setPartySessionDuration = (
  clock: PartySessionClock,
  plannedDurationSeconds: number
): PartySessionClock => {
  requirePositiveDuration(plannedDurationSeconds);
  if (plannedDurationSeconds === clock.plannedDurationSeconds) return clock;
  return freezeClock({ ...clock, plannedDurationSeconds });
};

export const resetPartySessionClock = (
  clock: PartySessionClock,
  plannedDurationSeconds = clock.plannedDurationSeconds
): PartySessionClock => createPartySessionClock(plannedDurationSeconds);

export const partySessionClockSnapshot = (
  clock: PartySessionClock,
  nowSeconds: number
): PartySessionClockSnapshot => {
  requireClockTime(nowSeconds);
  const elapsedActiveSeconds = runningElapsed(clock, nowSeconds);
  const remainingSeconds = Math.max(0, clock.plannedDurationSeconds - elapsedActiveSeconds);
  const overtimeSeconds = Math.max(0, elapsedActiveSeconds - clock.plannedDurationSeconds);
  const energyProgress = Math.max(
    0,
    Math.min(1, elapsedActiveSeconds / clock.plannedDurationSeconds)
  );
  const status = elapsedActiveSeconds >= clock.plannedDurationSeconds
    ? "complete"
    : clock.runningSinceSeconds != null
      ? "running"
      : clock.hasStarted
        ? "paused"
        : "not-started";
  return Object.freeze({
    status,
    isRunning: clock.runningSinceSeconds != null,
    plannedDurationSeconds: clock.plannedDurationSeconds,
    elapsedActiveSeconds,
    remainingSeconds,
    overtimeSeconds,
    energyProgress
  });
};
