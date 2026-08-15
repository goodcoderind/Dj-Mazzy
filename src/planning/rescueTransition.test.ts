import { describe, expect, it } from "vitest";
import type { CrossfadeSchedule } from "../audio/AudioEngine";
import { decideRescueTransition } from "./rescueTransition";

const schedule: CrossfadeSchedule = Object.freeze({
  id: 3,
  source: "a",
  target: "b",
  startTime: 10,
  endTime: 14
});

describe("transition rescue", () => {
  it("keeps the source before the handoff midpoint", () => {
    expect(decideRescueTransition(schedule, 11)).toEqual({
      keep: "a",
      stop: "b",
      progress: 0.25
    });
  });

  it("keeps the target from the midpoint onward", () => {
    expect(decideRescueTransition(schedule, 12)).toEqual({
      keep: "b",
      stop: "a",
      progress: 0.5
    });
    expect(decideRescueTransition(schedule, 20).progress).toBe(1);
  });

  it("fails closed on invalid clock evidence", () => {
    expect(() => decideRescueTransition(schedule, Number.NaN)).toThrow("audioTime must be finite");
    expect(() => decideRescueTransition({ ...schedule, endTime: 10 }, 10)).toThrow(
      "crossfade schedule must have a positive duration"
    );
  });
});
