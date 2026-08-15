import { describe, expect, it } from "vitest";
import { buildAutoPilotCandidateIds, buildAutoPilotPlanningIds } from "./autoPilotCrate";

const library = [
  { id: "a" },
  { id: "b" },
  { id: "c" },
  { id: "disabled", analysisOverrides: { autoMixDisabled: true } }
];

describe("Autopilot crate candidates", () => {
  it("preserves the explicit queue when library fill is off", () => {
    expect(buildAutoPilotCandidateIds(["c", "b"], library, [], ["a"], false)).toEqual(["c", "b"]);
  });

  it("fills from library after queued choices without repeats or disabled tracks", () => {
    expect(buildAutoPilotCandidateIds(["c", "c"], library, [], [], true)).toEqual(["c", "a", "b"]);
  });

  it("excludes already played and loaded tracks", () => {
    expect(buildAutoPilotCandidateIds(["a", "b", "c"], library, ["a"], ["b"], true)).toEqual(["c"]);
  });

  it("plans strictly from the queue until no eligible queued track remains", () => {
    expect(buildAutoPilotPlanningIds(["c", "b"], library, [], [], true)).toEqual(["c", "b"]);
    expect(buildAutoPilotPlanningIds(["disabled"], library, [], [], true)).toEqual(["a", "b", "c"]);
  });

  it("keeps queue priority while skipping session-unavailable tracks", () => {
    expect(buildAutoPilotPlanningIds(["b", "c"], library, [], [], true, ["b"])).toEqual(["c"]);
    expect(buildAutoPilotPlanningIds(["b"], library, [], [], true, ["b"])).toEqual(["a", "c"]);
  });
});
