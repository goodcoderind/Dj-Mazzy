import { describe, expect, it } from "vitest";
import type { TransitionPlanV3 } from "../domain/transitionPlan";
import { rankNextTracks } from "./nextTrackSelector";

const plan = (template: TransitionPlanV3["template"]) => ({ template }) as TransitionPlanV3;

describe("automatic next-track selection", () => {
  it("prioritizes transition safety before key or tempo similarity", () => {
    const source = { id: "source", bpm: 120, key: "C", scale: "major" as const, keyConfidence: 0.9 };
    const candidates = [
      { id: "perfect-key-safe", bpm: 120, key: "C", scale: "major" as const, keyConfidence: 0.9 },
      { id: "bar-handoff", bpm: 128, key: "F#", scale: "minor" as const, keyConfidence: 0.9 }
    ];
    const ranked = rankNextTracks(source, candidates, (target) =>
      plan(target.id === "bar-handoff" ? "downbeat-cut" : "safe-fade")
    );
    expect(ranked[0].track.id).toBe("bar-handoff");
    expect(ranked[0].reasons[0]).toContain("bar handoff");
  });

  it("uses harmonic and octave-aware tempo fit within one safety tier", () => {
    const source = { id: "source", bpm: 80, key: "C", scale: "major" as const, keyConfidence: 0.9 };
    const candidates = [
      { id: "contrast", bpm: 123, key: "F#", scale: "minor" as const, keyConfidence: 0.9 },
      { id: "relative", bpm: 160, key: "A", scale: "minor" as const, keyConfidence: 0.9 }
    ];
    const ranked = rankNextTracks(source, candidates, () => plan("downbeat-cut"));
    expect(ranked[0].track.id).toBe("relative");
    expect(ranked[0].reasons).toContain("Relative major/minor harmonic match.");
    expect(ranked[0].reasons).toContain("Tempos are naturally close.");
  });

  it("preserves queue order for exact ties", () => {
    const source = { id: "source" };
    const candidates = [{ id: "first" }, { id: "second" }];
    expect(rankNextTracks(source, candidates, () => plan("safe-fade")).map((item) => item.track.id))
      .toEqual(["first", "second"]);
  });

  it("treats low-confidence key estimates as unknown", () => {
    const ranked = rankNextTracks(
      { id: "source", bpm: 120, key: "C", scale: "major", keyConfidence: 0.4 },
      [{ id: "candidate", bpm: 120, key: "C", scale: "major" as const, keyConfidence: 0.99 }],
      () => plan("safe-fade")
    );
    expect(ranked[0].reasons).toContain("Key compatibility is unknown.");
  });

  it("uses musical cue continuity inside the same transition-safety tier", () => {
    const source = { id: "source" };
    const candidates = [{ id: "plain" }, { id: "musical" }];
    const ranked = rankNextTracks(source, candidates, (target) => ({
      ...plan("downbeat-cut"),
      scoreBreakdown: { musicalCuePreference: target.id === "musical" ? 0.9 : 0.1 }
    }));
    expect(ranked[0].track.id).toBe("musical");
    expect(ranked[0].reasons).toContain("The selected cue pair has stronger musical continuity.");
  });
});
