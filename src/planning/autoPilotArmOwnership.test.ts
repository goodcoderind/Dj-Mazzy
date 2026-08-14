import { describe, expect, it } from "vitest";
import {
  AUTO_PILOT_ARM_MAX_LEASE_SECONDS,
  AUTO_PILOT_ARM_RETRY_RUNWAY_SECONDS,
  createAutoPilotArmLease,
  decideAutoPilotArmFailure,
  deriveAutoPilotArmDeadline,
  inspectAutoPilotArmLease,
  ownsAutoPilotArmLease
} from "./autoPilotArmOwnership";

const lease = () => createAutoPilotArmLease({
  operation: 1,
  generation: 2,
  transitionKey: "1:1->2:2",
  sourceDeck: "a",
  targetDeck: "b",
  sourceTrackId: "source",
  targetTrackId: "target",
  sourceLoadKey: "1:1",
  targetLoadKey: "2:2",
  startedAtSeconds: 10,
  deadlineSeconds: 18
});

describe("Autopilot arm ownership", () => {
  it("derives a cue-bound deadline with an eight-second maximum", () => {
    expect(deriveAutoPilotArmDeadline({ nowSeconds: 10, scheduledStartSeconds: 30, minimumArmLeadSeconds: 0.1 }))
      .toBe(10 + AUTO_PILOT_ARM_MAX_LEASE_SECONDS);
    expect(deriveAutoPilotArmDeadline({ nowSeconds: 10, scheduledStartSeconds: 10.2, minimumArmLeadSeconds: 0.1 }))
      .toBeCloseTo(10.1);
    expect(deriveAutoPilotArmDeadline({ nowSeconds: 10, scheduledStartSeconds: 10.14, minimumArmLeadSeconds: 0.1 }))
      .toBeNull();
  });

  it("rejects malformed, future, and overlong leases", () => {
    expect(() => createAutoPilotArmLease({ ...lease(), operation: 0 })).toThrow(RangeError);
    expect(() => createAutoPilotArmLease({ ...lease(), sourceLoadKey: "" })).toThrow(RangeError);
    expect(() => createAutoPilotArmLease({ ...lease(), sourceDeck: "x" as "a" })).toThrow(RangeError);
    expect(() => createAutoPilotArmLease({ ...lease(), transitionKey: "wrong" })).toThrow(RangeError);
    expect(() => createAutoPilotArmLease({ ...lease(), deadlineSeconds: 18.01 })).toThrow(RangeError);
  });

  it("requires exact ownership and pair identity through the deadline boundary", () => {
    const current = lease();
    const pair = {
      sourceDeck: "a" as const,
      targetDeck: "b" as const,
      sourceTrackId: "source",
      targetTrackId: "target",
      sourceLoadKey: "1:1",
      targetLoadKey: "2:2"
    };
    expect(ownsAutoPilotArmLease(current, current)).toBe(true);
    expect(ownsAutoPilotArmLease(current, { ...current, generation: 3 })).toBe(false);
    expect(inspectAutoPilotArmLease({ current, expected: current, nowSeconds: 9.999, pair })).toBe("superseded");
    expect(inspectAutoPilotArmLease({ current, expected: current, nowSeconds: 10, pair })).toBe("active");
    expect(inspectAutoPilotArmLease({ current, expected: current, nowSeconds: 17.999, pair })).toBe("active");
    expect(inspectAutoPilotArmLease({ current, expected: current, nowSeconds: 18, pair })).toBe("expired");
    expect(inspectAutoPilotArmLease({ current, expected: current, nowSeconds: 11, pair: { ...pair, targetLoadKey: "2:3" } }))
      .toBe("superseded");
  });

  it("allows one retry only with enough source runway", () => {
    expect(decideAutoPilotArmFailure({ consecutiveFailures: 1, sourceRemainingSeconds: AUTO_PILOT_ARM_RETRY_RUNWAY_SECONDS }))
      .toBe("retry");
    expect(decideAutoPilotArmFailure({ consecutiveFailures: 1, sourceRemainingSeconds: AUTO_PILOT_ARM_RETRY_RUNWAY_SECONDS - 0.001 }))
      .toBe("pause");
    expect(decideAutoPilotArmFailure({ consecutiveFailures: 2, sourceRemainingSeconds: 30 })).toBe("pause");
  });
});
