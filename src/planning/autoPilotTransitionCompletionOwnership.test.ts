import { describe, expect, it } from "vitest";
import {
  AUTO_PILOT_TRANSITION_COMPLETION_GRACE_SECONDS,
  AUTO_PILOT_TRANSITION_COMPLETION_DELIVERY_TOLERANCE_SECONDS,
  createAutoPilotTransitionCompletionLease,
  inspectAutoPilotTransitionCompletion,
  ownsAutoPilotTransitionCompletionLease
} from "./autoPilotTransitionCompletionOwnership";

const lease = createAutoPilotTransitionCompletionLease({
  operation: 3,
  generation: 4,
  scheduleId: 7,
  transitionKey: "1:2->3:4",
  sourceDeck: "a",
  targetDeck: "b",
  sourceTrackId: "source",
  targetTrackId: "target",
  sourceLoadKey: "1:2",
  targetLoadKey: "3:4",
  registeredAtSeconds: 9,
  startTimeSeconds: 10,
  endTimeSeconds: 20
});

const pair = {
  sourceDeck: "a" as const,
  targetDeck: "b" as const,
  sourceTrackId: "source",
  targetTrackId: "target",
  sourceLoadKey: "1:2",
  targetLoadKey: "3:4",
  targetPlaying: true
};

const inspect = (overrides = {}) => inspectAutoPilotTransitionCompletion({
  current: lease,
  expected: lease,
  nowSeconds: 20,
  engineSchedule: { id: 7, source: "a", target: "b", startTime: 10, endTime: 20 },
  pair,
  signal: "primary",
  contextRunning: true,
  playbackLocked: false,
  ...overrides
});

describe("Autopilot transition completion ownership", () => {
  it("creates an exact half-second audio-clock grace window", () => {
    expect(lease.deadlineSeconds).toBe(20 + AUTO_PILOT_TRANSITION_COMPLETION_GRACE_SECONDS);
    expect(ownsAutoPilotTransitionCompletionLease(lease, { ...lease })).toBe(true);
  });

  it("accepts primary completion at the end and watchdog recovery only at its deadline", () => {
    expect(inspect({ nowSeconds: 19.98 })).toBe("waiting");
    expect(inspect({ nowSeconds: 20 })).toBe("primary-ready");
    expect(inspect({ signal: "watchdog", nowSeconds: 20.499999 })).toBe("waiting");
    expect(inspect({ signal: "watchdog", nowSeconds: 20.5 })).toBe("watchdog-ready");
    expect(inspect({ signal: "watchdog", nowSeconds: 20.501 })).toBe("watchdog-ready");
    expect(inspect({ signal: "watchdog", nowSeconds: 20.5 + AUTO_PILOT_TRANSITION_COMPLETION_DELIVERY_TOLERANCE_SECONDS })).toBe("watchdog-ready");
    expect(inspect({ signal: "watchdog", nowSeconds: 20.521 })).toBe("late-ready");
    expect(inspect({ signal: "primary", nowSeconds: 20.521 })).toBe("late-ready");
  });

  it("rejects stale leases without touching a successor", () => {
    const successor = createAutoPilotTransitionCompletionLease({
      ...lease,
      scheduleId: 8,
      endTimeSeconds: 22
    });
    expect(inspect({ current: successor })).toBe("superseded");
  });

  it("fails closed on schedule, load, target, context, or recovery-lock mismatch", () => {
    expect(inspect({ engineSchedule: { id: 8, source: "a", target: "b", startTime: 10, endTime: 20 } })).toBe("ownership-lost");
    expect(inspect({ engineSchedule: { id: 7, source: "a", target: "b", startTime: 10, endTime: 21 } })).toBe("ownership-lost");
    expect(inspect({ pair: { ...pair, targetLoadKey: "3:5" } })).toBe("ownership-lost");
    expect(inspect({ pair: { ...pair, targetPlaying: false } })).toBe("ownership-lost");
    expect(inspect({ contextRunning: false })).toBe("ownership-lost");
    expect(inspect({ playbackLocked: true })).toBe("ownership-lost");
  });

  it("rejects malformed or future-incoherent ownership", () => {
    expect(() => createAutoPilotTransitionCompletionLease({ ...lease, scheduleId: 0 })).toThrow(RangeError);
    expect(() => createAutoPilotTransitionCompletionLease({ ...lease, transitionKey: "wrong" })).toThrow(RangeError);
    expect(() => createAutoPilotTransitionCompletionLease({ ...lease, endTimeSeconds: Number.NaN })).toThrow(RangeError);
    expect(() => createAutoPilotTransitionCompletionLease({ ...lease, registeredAtSeconds: 21 })).toThrow(RangeError);
    expect(inspect({ nowSeconds: 8.999 })).toBe("superseded");
    expect(() => inspect({ nowSeconds: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
