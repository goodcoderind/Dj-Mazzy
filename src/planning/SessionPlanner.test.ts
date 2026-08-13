import { describe, expect, it } from "vitest";
import type { TransitionPlanV2 } from "../domain/transitionPlan";
import { planSessionHorizon } from "./SessionPlanner";

const plan = (template: TransitionPlanV2["template"]) => ({ template }) as TransitionPlanV2;
const candidates = [
  { id: "dead-end", bpm: 120, energyByBeat: [0.6] },
  { id: "bridge", bpm: 120, energyByBeat: [0.55] },
  { id: "finish", bpm: 120, energyByBeat: [0.8] }
];
const options = {
  curve: { warmUp: 0.3, build: 0.6, peak: 0.9, cooldown: 0.4 },
  sessionProgress: 0.4,
  planFirstLeg: (track: { id: string }) => plan(track.id === "finish" ? "safe-fade" : "downbeat-cut"),
  planSecondLeg: (source: { id: string }, target: { id: string }) =>
    plan(source.id === "bridge" && target.id === "finish" ? "downbeat-cut" : "safe-fade")
};

describe("three-track session horizon", () => {
  it("avoids an immediate-looking dead end when a safer two-leg path exists", () => {
    const result = planSessionHorizon({ id: "current", bpm: 120 }, candidates, options);
    expect(result?.nextTrack.id).toBe("bridge");
    expect(result?.afterNextTrack?.id).toBe("finish");
    expect(result?.afterNextTemplate).toBe("downbeat-cut");
  });

  it("does not prune a later safe horizon behind six attractive dead ends", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ id: `track-${index + 1}` }));
    const result = planSessionHorizon({ id: "current" }, many, {
      ...options,
      planFirstLeg: () => plan("downbeat-cut"),
      planSecondLeg: (source) => plan(source.id === "track-7" ? "downbeat-cut" : "safe-fade")
    });
    expect(result?.nextTrack.id).toBe("track-7");
  });

  it("filters played, duplicate, current, and disabled tracks", () => {
    const result = planSessionHorizon(
      { id: "current" },
      [
        { id: "current" },
        { id: "played" },
        { id: "disabled", analysisOverrides: { autoMixDisabled: true } },
        { id: "only" },
        { id: "only" }
      ],
      { ...options, playedTrackIds: ["played"], planFirstLeg: () => plan("safe-fade") }
    );
    expect(result?.nextTrack.id).toBe("only");
    expect(result?.afterNextTrack).toBeNull();
  });

  it("never lets energy preference outrank transition safety", () => {
    const result = planSessionHorizon(
      { id: "current" },
      [
        { id: "perfect-energy", energyByBeat: [0.6] },
        { id: "safe-path", energyByBeat: [0.1] },
        { id: "finish", energyByBeat: [0.2] }
      ],
      {
        ...options,
        planFirstLeg: (track) => plan(track.id === "perfect-energy" ? "safe-fade" : "downbeat-cut"),
        planSecondLeg: () => plan("downbeat-cut")
      }
    );
    expect(result?.nextTrack.id).not.toBe("perfect-energy");
    expect(result?.nextTemplate).toBe("downbeat-cut");
  });

  it("lets the selected energy target change a winner inside identical safety tiers", () => {
    const energyCandidates = [
      { id: "calm", energyByBeat: [0.2] },
      { id: "peak", energyByBeat: [0.9] }
    ];
    const low = planSessionHorizon({ id: "current" }, energyCandidates, {
      ...options,
      curve: { warmUp: 0.2, build: 0.2, peak: 0.2, cooldown: 0.2 },
      sessionProgress: 0,
      planFirstLeg: () => plan("safe-fade"),
      planSecondLeg: () => plan("safe-fade")
    });
    const high = planSessionHorizon({ id: "current" }, energyCandidates, {
      ...options,
      curve: { warmUp: 0.9, build: 0.9, peak: 0.9, cooldown: 0.9 },
      sessionProgress: 0,
      planFirstLeg: () => plan("safe-fade"),
      planSecondLeg: () => plan("safe-fade")
    });
    expect(low?.nextTrack.id).toBe("calm");
    expect(high?.nextTrack.id).toBe("peak");
  });

  it("is deterministic, non-mutating, and exposes no speculative schedule", () => {
    const input = structuredClone(candidates);
    const first = planSessionHorizon({ id: "current" }, candidates, options);
    const second = planSessionHorizon({ id: "current" }, candidates, options);
    expect(first).toEqual(second);
    expect(candidates).toEqual(input);
    expect(first).not.toHaveProperty("schedule");
  });
});
