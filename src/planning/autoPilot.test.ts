import { describe, expect, it } from "vitest";
import { shouldArmAutoPilotTransition } from "./autoPilot";

describe("party autopilot arming", () => {
  it("waits for a trusted bar cue near the track ending", () => {
    expect(shouldArmAutoPilotTransition({
      template: "downbeat-cut",
      remainingSeconds: 20,
      untilPlannedStartSeconds: 6
    })).toBe(true);
    expect(shouldArmAutoPilotTransition({
      template: "downbeat-cut",
      remainingSeconds: 21,
      untilPlannedStartSeconds: 2
    })).toBe(false);
    expect(shouldArmAutoPilotTransition({
      template: "downbeat-cut",
      remainingSeconds: 10,
      untilPlannedStartSeconds: -0.001
    })).toBe(false);
  });

  it("uses the protected fade only at the end and rejects malformed clocks", () => {
    expect(shouldArmAutoPilotTransition({
      template: "safe-fade",
      remainingSeconds: 3.75,
      untilPlannedStartSeconds: 0.08
    })).toBe(true);
    expect(shouldArmAutoPilotTransition({
      template: "safe-fade",
      remainingSeconds: 3.751,
      untilPlannedStartSeconds: 0.08
    })).toBe(false);
    expect(shouldArmAutoPilotTransition({
      template: "safe-fade",
      remainingSeconds: Number.NaN,
      untilPlannedStartSeconds: 0
    })).toBe(false);
  });

  it("allows a full tick of lead to arm Filtered Fade without starting it early", () => {
    expect(shouldArmAutoPilotTransition({
      template: "filtered-fade",
      remainingSeconds: 6,
      untilPlannedStartSeconds: 0.5
    })).toBe(true);
    expect(shouldArmAutoPilotTransition({
      template: "filtered-fade",
      remainingSeconds: 6.001,
      untilPlannedStartSeconds: 0.25
    })).toBe(false);
    expect(shouldArmAutoPilotTransition({
      template: "filtered-fade",
      remainingSeconds: 5,
      untilPlannedStartSeconds: 0.501
    })).toBe(false);
  });
});
