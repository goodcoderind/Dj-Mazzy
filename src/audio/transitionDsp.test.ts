import { describe, expect, it } from "vitest";
import { planAutomaticTransition } from "../planning/TransitionPlanner";
import { compileTransitionDsp, TRANSITION_DSP_VERSION, validateTransitionDsp } from "./transitionDsp";
import { BASIC_ANALYZER_VERSION } from "../domain/versions";

const track = (id: string) => ({
  trackId: id,
  duration: 240,
  bpm: 120,
  beatsSeconds: Array.from({ length: 480 }, (_, index) => index * 0.5),
  downbeatsSeconds: Array.from({ length: 120 }, (_, index) => index * 2),
  beatConfidence: 0,
  downbeatConfidence: 0
});

const snapshot = {
  sourceTrimDb: -2,
  targetTrimDb: 1,
  sourceEqDb: { low: 3, mid: 1, high: -1 },
  targetEqDb: { low: 2, mid: -2, high: 0 }
};

describe("transition DSP contract", () => {
  it("compiles Safe Fade without changing eligibility or adding EQ automation", () => {
    const plan = planAutomaticTransition({
      requestedAt: 10,
      source: track("a"),
      target: track("b"),
      sourceDeck: { positionSeconds: 20, playbackRate: 1 }
    });
    expect(plan.template).toBe("safe-fade");
    const dsp = compileTransitionDsp(plan, snapshot);
    expect(dsp).toMatchObject({
      schemaVersion: TRANSITION_DSP_VERSION,
      template: "safe-fade",
      outputStage: "pre-master",
      source: { trimDb: -2, playbackRate: 1, initialEqDb: snapshot.sourceEqDb, eqRamps: [] },
      target: { trimDb: 1, playbackRate: 1, initialEqDb: snapshot.targetEqDb, eqRamps: [] }
    });
    expect(dsp.source.gainCurve).toEqual(plan.automation.sourceGain);
    expect(dsp.source.gainCurve).not.toBe(plan.automation.sourceGain);
    expect(Object.isFrozen(dsp.source.gainCurve)).toBe(true);
    expect(validateTransitionDsp(dsp)).toBe(true);
  });

  it("compiles the current phrase bass ownership into one ramp per deck", () => {
    const source = { ...track("a"), beatConfidence: 0.95, downbeatConfidence: 0.95,
      automaticRhythmTrust: { calibrationVersion: "cal-v1" } };
    const target = { ...track("b"), beatConfidence: 0.95, downbeatConfidence: 0.95,
      automaticRhythmTrust: { calibrationVersion: "cal-v1" } };
    const plan = planAutomaticTransition({ requestedAt: 10, source, target, sourceDeck: { positionSeconds: 20, playbackRate: 1 } });
    expect(plan.template).toBe("phrase-blend");
    const dsp = compileTransitionDsp(plan, snapshot);
    expect(dsp.source.eqRamps).toEqual([{ band: "low", ramp: {
      startOffsetSeconds: 0, durationSeconds: plan.schedule.durationSeconds / 2, fromDb: 3, toDb: -12
    } }]);
    expect(dsp.target.initialEqDb.low).toBe(-12);
    expect(dsp.target.eqRamps[0].ramp).toMatchObject({
      startOffsetSeconds: plan.schedule.durationSeconds / 2,
      fromDb: -12,
      toDb: 2
    });
  });

  it("compiles Filtered Fade as one bounded outgoing low-pass sweep", () => {
    const source = {
      ...track("a"),
      analyzerVersion: BASIC_ANALYZER_VERSION,
      schemaVersion: "track-analysis/v5",
      analysisStatus: "ready",
      energyByBeat: Array(480).fill(0.5),
      vocalProbabilityByBeat: Array(480).fill(0.2),
      bandEnergyByBeat: Array.from({ length: 480 }, () => ({ low: 0.4, mid: 0.4, high: 0.2 }))
    };
    const plan = planAutomaticTransition({
      requestedAt: 10,
      source,
      target: track("b"),
      sourceDeck: { positionSeconds: 20, playbackRate: 1 }
    });
    expect(plan.template).toBe("filtered-fade");
    const dsp = compileTransitionDsp(plan, snapshot);
    expect(dsp.source.filterSweep).toEqual({
      startOffsetSeconds: 0,
      durationSeconds: plan.schedule.durationSeconds,
      fromHz: 20_000,
      toHz: 420
    });
    expect(dsp.target.filterSweep).toBeNull();
    expect(validateTransitionDsp(dsp)).toBe(true);
  });

  it("rejects malformed DSP evidence", () => {
    expect(() => validateTransitionDsp({ schemaVersion: TRANSITION_DSP_VERSION } as never)).toThrow();
    const plan = planAutomaticTransition({ requestedAt: 10, source: track("a"), target: track("b"), sourceDeck: { positionSeconds: 20, playbackRate: 1 } });
    const valid = compileTransitionDsp(plan, snapshot);
    expect(() => validateTransitionDsp({ ...valid, requiredMasterVersion: "another-master" } as never)).toThrow("production master");
    expect(() => validateTransitionDsp({ ...valid, source: { ...valid.source, gainCurve: [1, 1.01, 0] } } as never)).toThrow("gain curve");
    expect(() => validateTransitionDsp({ ...valid, target: { ...valid.target, trimDb: 4 } } as never)).toThrow("finite and positive");
    expect(() => validateTransitionDsp({ ...valid, source: { ...valid.source, filterSweep: {
      startOffsetSeconds: 0, durationSeconds: 1, fromHz: 20_000, toHz: 420
    } } } as never)).toThrow("Only Filtered Fade");
    const filteredSource = {
      ...track("a"), analyzerVersion: BASIC_ANALYZER_VERSION, schemaVersion: "track-analysis/v5", analysisStatus: "ready",
      energyByBeat: Array(480).fill(0.5), vocalProbabilityByBeat: Array(480).fill(0.2),
      bandEnergyByBeat: Array.from({ length: 480 }, () => ({ low: 0.4, mid: 0.4, high: 0.2 }))
    };
    const filtered = compileTransitionDsp(planAutomaticTransition({ requestedAt: 10, source: filteredSource, target: track("b"), sourceDeck: { positionSeconds: 20, playbackRate: 1 } }), snapshot);
    expect(() => validateTransitionDsp({ ...filtered, source: { ...filtered.source, filterSweep: {
      ...filtered.source.filterSweep!, startOffsetSeconds: 0.1, durationSeconds: filtered.durationSeconds - 0.2
    } } })).toThrow("full-duration");
  });
});
