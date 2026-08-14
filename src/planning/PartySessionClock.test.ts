import { describe, expect, it } from "vitest";
import {
  PARTY_SESSION_CLOCK_SCHEMA_VERSION,
  createPartySessionClock,
  partySessionClockSnapshot,
  pausePartySessionClock,
  resetPartySessionClock,
  restorePausedPartySessionClock,
  setPartySessionDuration,
  startPartySessionClock
} from "./PartySessionClock";

describe("PartySessionClock", () => {
  it("starts with zero energy progress and a versioned immutable state", () => {
    const clock = createPartySessionClock(7_200);

    expect(clock).toEqual({
      schemaVersion: PARTY_SESSION_CLOCK_SCHEMA_VERSION,
      plannedDurationSeconds: 7_200,
      accumulatedActiveSeconds: 0,
      runningSinceSeconds: null,
      hasStarted: false
    });
    expect(Object.isFrozen(clock)).toBe(true);
    expect(partySessionClockSnapshot(clock, 500)).toEqual({
      status: "not-started",
      isRunning: false,
      plannedDurationSeconds: 7_200,
      elapsedActiveSeconds: 0,
      remainingSeconds: 7_200,
      overtimeSeconds: 0,
      energyProgress: 0
    });
  });

  it("derives deterministic progress from an injected authoritative clock", () => {
    const clock = startPartySessionClock(createPartySessionClock(7_200), 100);

    expect(partySessionClockSnapshot(clock, 1_900)).toMatchObject({
      status: "running",
      elapsedActiveSeconds: 1_800,
      remainingSeconds: 5_400,
      overtimeSeconds: 0,
      energyProgress: 0.25
    });
  });

  it("excludes pauses from active session and energy time", () => {
    const started = startPartySessionClock(createPartySessionClock(1_000), 100);
    const paused = pausePartySessionClock(started, 300);

    expect(partySessionClockSnapshot(paused, 800)).toMatchObject({
      status: "paused",
      elapsedActiveSeconds: 200,
      energyProgress: 0.2
    });

    const resumed = startPartySessionClock(paused, 900);
    expect(partySessionClockSnapshot(resumed, 1_000)).toMatchObject({
      status: "running",
      elapsedActiveSeconds: 300,
      energyProgress: 0.3
    });
  });

  it("clamps energy progress at one while reporting overtime without stopping playback", () => {
    const clock = startPartySessionClock(createPartySessionClock(600), 10);

    expect(partySessionClockSnapshot(clock, 670)).toMatchObject({
      status: "complete",
      isRunning: true,
      elapsedActiveSeconds: 660,
      remainingSeconds: 0,
      overtimeSeconds: 60,
      energyProgress: 1
    });
  });

  it("distinguishes paused overtime from running overtime", () => {
    const running = startPartySessionClock(createPartySessionClock(100), 10);
    const paused = pausePartySessionClock(running, 130);
    expect(partySessionClockSnapshot(paused, 500)).toMatchObject({
      status: "complete",
      isRunning: false,
      overtimeSeconds: 20
    });
  });

  it("updates a user-selected duration without losing elapsed session time", () => {
    const running = startPartySessionClock(createPartySessionClock(1_000), 100);
    const extended = setPartySessionDuration(running, 2_000);

    expect(partySessionClockSnapshot(extended, 600)).toMatchObject({
      status: "running",
      plannedDurationSeconds: 2_000,
      elapsedActiveSeconds: 500,
      energyProgress: 0.25
    });
    expect(running.plannedDurationSeconds).toBe(1_000);
  });

  it("makes start, pause, and unchanged duration idempotent", () => {
    const initial = createPartySessionClock(900);
    const started = startPartySessionClock(initial, 10);
    const paused = pausePartySessionClock(started, 20);

    expect(startPartySessionClock(started, 15)).toBe(started);
    expect(pausePartySessionClock(paused, 30)).toBe(paused);
    expect(setPartySessionDuration(paused, 900)).toBe(paused);
  });

  it("resets elapsed time and can take a new selected duration", () => {
    const elapsed = pausePartySessionClock(
      startPartySessionClock(createPartySessionClock(900), 10),
      210
    );

    expect(resetPartySessionClock(elapsed, 1_800)).toEqual(createPartySessionClock(1_800));
  });

  it("restores persisted progress without reusing an old audio-clock anchor", () => {
    const restored = restorePausedPartySessionClock(7_200, 1_237);

    expect(restored).toEqual({
      schemaVersion: PARTY_SESSION_CLOCK_SCHEMA_VERSION,
      plannedDurationSeconds: 7_200,
      accumulatedActiveSeconds: 1_237,
      runningSinceSeconds: null,
      hasStarted: true
    });
    expect(partySessionClockSnapshot(restored, 0)).toMatchObject({
      status: "paused",
      isRunning: false,
      elapsedActiveSeconds: 1_237
    });
  });

  it("rejects invalid durations, invalid times, and a backwards running clock", () => {
    expect(() => createPartySessionClock(0)).toThrow("positive finite");
    expect(() => setPartySessionDuration(createPartySessionClock(10), Number.NaN)).toThrow(
      "positive finite"
    );
    expect(() => startPartySessionClock(createPartySessionClock(10), -1)).toThrow(
      "non-negative finite"
    );
    expect(() => restorePausedPartySessionClock(10, -1)).toThrow("non-negative finite");
    const running = startPartySessionClock(createPartySessionClock(10), 5);
    expect(() => partySessionClockSnapshot(running, 4)).toThrow("cannot move backwards");
    expect(() => pausePartySessionClock(running, 4)).toThrow("cannot move backwards");
  });
});
