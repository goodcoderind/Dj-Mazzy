import { describe, expect, it } from "vitest";
import { decideAutoPilotSessionTick, type AutoPilotSessionDecisionInput } from "./autoPilotSessionDecision";
import { PARTY_ENERGY_CURVES } from "./energyProfiles";

const track = (id: string, duration = 120, energy = 0.5) => ({
  id,
  duration,
  bpm: null,
  energyByBeat: [energy],
  beatsSeconds: [],
  downbeatsSeconds: [],
  beatConfidence: 0,
  downbeatConfidence: 0
});

const input = (overrides: Partial<AutoPilotSessionDecisionInput> = {}): AutoPilotSessionDecisionInput => ({
  nowSeconds: 10,
  source: {
    deck: "a",
    trackId: "source",
    loadKey: "a-load-1",
    ready: true,
    playing: true,
    durationSeconds: 120,
    positionSeconds: 20,
    playbackRate: 1,
    analysis: track("source")
  },
  target: {
    deck: "b",
    trackId: null,
    loadKey: null,
    ready: false,
    playing: false,
    durationSeconds: 0,
    positionSeconds: 0,
    playbackRate: 1,
    analysis: null
  },
  queueTrackIds: ["next", "later"],
  library: [track("source"), track("next", 120, 0.4), track("later", 120, 0.8)],
  playedTrackIds: ["source"],
  unavailableTrackIds: [],
  includeRestOfLibrary: false,
  energyCurve: PARTY_ENERGY_CURVES.steady,
  sessionProgress: 0.2,
  preloadBusy: false,
  activeTransitionKey: null,
  ...overrides
});

describe("production Autopilot tick decision", () => {
  it("pauses when the source is not playing and waits for unsettled preload ownership", () => {
    expect(decideAutoPilotSessionTick(input({ source: { ...input().source, playing: false } })).kind)
      .toBe("pause-source-stopped");
    expect(decideAutoPilotSessionTick(input({ preloadBusy: true })).kind).toBe("wait-preload");
  });

  it("uses queue-first planning and exposes only an advisory later identity", () => {
    const decision = decideAutoPilotSessionTick(input());
    expect(decision.kind).toBe("preload");
    if (decision.kind !== "preload") return;
    expect(decision.selectionSource).toBe("queue");
    expect(["next", "later"]).toContain(decision.trackId);
    expect(decision).not.toHaveProperty("schedule");
  });

  it("uses library continuation only after the eligible queue is empty", () => {
    const library = [track("source"), track("fill")];
    const decision = decideAutoPilotSessionTick(input({
      queueTrackIds: ["unknown"],
      library,
      includeRestOfLibrary: true
    }));
    expect(decision).toMatchObject({ kind: "preload", trackId: "fill", selectionSource: "library" });
  });

  it("declares the exact source final when no candidate remains", () => {
    expect(decideAutoPilotSessionTick(input({ queueTrackIds: [], library: [track("source")] })))
      .toMatchObject({ kind: "declare-final", sourceTrackId: "source" });
  });

  it("fails over past unavailable queue entries and declares final when all candidates are unavailable", () => {
    expect(decideAutoPilotSessionTick(input({ unavailableTrackIds: ["next"] })))
      .toMatchObject({ kind: "preload", trackId: "later", selectionSource: "queue" });
    expect(decideAutoPilotSessionTick(input({ unavailableTrackIds: ["next", "later"] })))
      .toMatchObject({ kind: "declare-final", sourceTrackId: "source" });
  });

  it("ejects played or disabled idle targets before they can arm", () => {
    const target = { ...input().target, trackId: "played", ready: true, durationSeconds: 120 };
    expect(decideAutoPilotSessionTick(input({ target, playedTrackIds: ["source", "played"] })))
      .toMatchObject({ kind: "eject-blocked-target", targetTrackId: "played" });
  });

  it("waits until the real Safe Fade arm window, then returns the exact live plan", () => {
    const target = {
      ...input().target,
      trackId: "next",
      ready: true,
      durationSeconds: 120,
      analysis: track("next")
    };
    const early = decideAutoPilotSessionTick(input({ target }));
    expect(early.kind).toBe("wait-cue");
    const nearEnd = decideAutoPilotSessionTick(input({
      source: { ...input().source, positionSeconds: 116.4 },
      target
    }));
    expect(nearEnd.kind).toBe("arm");
    if (nearEnd.kind !== "arm") return;
    expect(nearEnd.plan.template).toBe("safe-fade");
    expect(nearEnd.plan.schedule.endTime).toBeLessThanOrEqual(13.6 + 1e-9);
  });

  it("deduplicates an already-owned pair and never mutates its input", () => {
    const original = input({
      target: { ...input().target, trackId: "next", loadKey: "b-load-1", ready: true, durationSeconds: 120, analysis: track("next") },
      activeTransitionKey: "a-load-1->b-load-1"
    });
    const copy = structuredClone(original);
    expect(decideAutoPilotSessionTick(original)).toMatchObject({ kind: "wait-owned-transition" });
    expect(original).toEqual(copy);
  });

  it("rejects invalid clocks and progress", () => {
    expect(() => decideAutoPilotSessionTick(input({ nowSeconds: Number.NaN }))).toThrow("nowSeconds");
    expect(() => decideAutoPilotSessionTick(input({ sessionProgress: 1.1 }))).toThrow("sessionProgress");
  });

  it("fails closed on a malformed deck observation", () => {
    const decision = decideAutoPilotSessionTick(input({
      source: { ...input().source, positionSeconds: Number.NaN }
    }));
    expect(decision).toMatchObject({ kind: "wait-target", reason: "invalid-observation" });
  });
});
