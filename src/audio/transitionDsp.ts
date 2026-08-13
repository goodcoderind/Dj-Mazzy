import type { EqPoint, TransitionPlanV2 } from "../domain/transitionPlan";
import { TRANSITION_PLAN_SCHEMA_VERSION } from "../domain/versions";
import { MASTER_DSP_V1 } from "./masterDsp";

export const TRANSITION_DSP_VERSION = "transition-dsp/v1" as const;

export type LinearDbRamp = Readonly<{
  startOffsetSeconds: number;
  durationSeconds: number;
  fromDb: number;
  toDb: number;
}>;

export type DeckTransitionDsp = Readonly<{
  playbackRate: number;
  trimDb: number;
  gainCurve: readonly number[];
  initialEqDb: Readonly<EqPoint>;
  eqRamps: readonly Readonly<{ band: "low" | "mid" | "high"; ramp: LinearDbRamp }>[];
}>;

export type TransitionDspV1 = Readonly<{
  schemaVersion: typeof TRANSITION_DSP_VERSION;
  planSchemaVersion: typeof TRANSITION_PLAN_SCHEMA_VERSION;
  template: "safe-fade" | "downbeat-cut" | "phrase-blend";
  durationSeconds: number;
  targetCueSeconds: number;
  source: DeckTransitionDsp;
  target: DeckTransitionDsp;
  outputStage: "pre-master";
  requiredMasterVersion: typeof MASTER_DSP_V1.version;
}>;

export type TransitionDspSnapshot = Readonly<{
  sourceTrimDb: number;
  targetTrimDb: number;
  sourceEqDb: EqPoint;
  targetEqDb: EqPoint;
}>;

const finite = (value: number) => Number.isFinite(value);
const cloneEq = (eq: EqPoint): Readonly<EqPoint> => Object.freeze({ low: eq.low, mid: eq.mid, high: eq.high });
const validateEq = (eq: EqPoint, label: string) => {
  if (![eq.low, eq.mid, eq.high].every(finite)) throw new RangeError(`${label} EQ must be finite`);
};

const freezeDeck = (deck: DeckTransitionDsp): DeckTransitionDsp => Object.freeze({
  ...deck,
  gainCurve: Object.freeze([...deck.gainCurve]),
  initialEqDb: cloneEq(deck.initialEqDb),
  eqRamps: Object.freeze(deck.eqRamps.map((entry) => Object.freeze({
    band: entry.band,
    ramp: Object.freeze({ ...entry.ramp })
  })))
});

export const validateTransitionDsp = (dsp: TransitionDspV1) => {
  if (dsp.schemaVersion !== TRANSITION_DSP_VERSION || dsp.planSchemaVersion !== TRANSITION_PLAN_SCHEMA_VERSION) {
    throw new RangeError("Unsupported transition DSP schema");
  }
  if (!["safe-fade", "downbeat-cut", "phrase-blend"].includes(dsp.template)) {
    throw new RangeError("Unsupported transition template");
  }
  if (dsp.outputStage !== "pre-master" || dsp.requiredMasterVersion !== MASTER_DSP_V1.version) {
    throw new RangeError("Transition DSP is not compatible with the production master");
  }
  if (!finite(dsp.durationSeconds) || dsp.durationSeconds <= 0 || !finite(dsp.targetCueSeconds) || dsp.targetCueSeconds < 0) {
    throw new RangeError("Transition DSP timing must be finite and positive");
  }
  for (const [label, deck] of [["source", dsp.source], ["target", dsp.target]] as const) {
    if (!finite(deck.playbackRate) || deck.playbackRate <= 0 || !finite(deck.trimDb) || deck.trimDb < -6 || deck.trimDb > 3) {
      throw new RangeError(`${label} DSP values must be finite and positive`);
    }
    if (deck.gainCurve.length < 2 || !deck.gainCurve.every((value) => finite(value) && value >= 0 && value <= 1)) {
      throw new RangeError(`${label} gain curve must contain finite points`);
    }
    validateEq(deck.initialEqDb, label);
    if (![deck.initialEqDb.low, deck.initialEqDb.mid, deck.initialEqDb.high].every((value) => value >= -12 && value <= 12)) {
      throw new RangeError(`${label} EQ is outside production bounds`);
    }
    for (const entry of deck.eqRamps) {
      const ramp = entry.ramp;
      if (!["low", "mid", "high"].includes(entry.band) ||
        ![ramp.startOffsetSeconds, ramp.durationSeconds, ramp.fromDb, ramp.toDb].every(finite) ||
        ramp.startOffsetSeconds < 0 || ramp.durationSeconds <= 0 ||
        ramp.startOffsetSeconds + ramp.durationSeconds > dsp.durationSeconds ||
        ramp.fromDb < -12 || ramp.fromDb > 12 || ramp.toDb < -12 || ramp.toDb > 12) {
        throw new RangeError(`${label} EQ ramp is invalid`);
      }
    }
  }
  const near = (value: number | undefined, expected: number) => value != null && Math.abs(value - expected) <= 1e-6;
  if (!near(dsp.source.gainCurve[0], 1) || !near(dsp.source.gainCurve.at(-1), 0) ||
    !near(dsp.target.gainCurve[0], 0) || !near(dsp.target.gainCurve.at(-1), 1)) {
    throw new RangeError("Transition gain curves must have production endpoints");
  }
  if (dsp.template !== "phrase-blend" && (dsp.source.eqRamps.length || dsp.target.eqRamps.length || dsp.target.playbackRate !== 1)) {
    throw new RangeError("Short transitions cannot contain stretch or EQ automation");
  }
  return true;
};

export const compileTransitionDsp = (
  plan: Readonly<TransitionPlanV2>,
  snapshot: TransitionDspSnapshot
): TransitionDspV1 => {
  if (plan.schemaVersion !== TRANSITION_PLAN_SCHEMA_VERSION) throw new RangeError("Unsupported transition plan schema");
  if (!["safe-fade", "downbeat-cut", "phrase-blend"].includes(plan.template)) {
    throw new RangeError("Transition template is not implemented by DSP v1");
  }
  const template = plan.template as TransitionDspV1["template"];
  validateEq(snapshot.sourceEqDb, "source");
  validateEq(snapshot.targetEqDb, "target");
  if (![snapshot.sourceTrimDb, snapshot.targetTrimDb].every(finite)) throw new RangeError("Track trim must be finite");
  const halfDuration = plan.schedule.durationSeconds / 2;
  const phrase = template === "phrase-blend";
  const result: TransitionDspV1 = Object.freeze({
    schemaVersion: TRANSITION_DSP_VERSION,
    planSchemaVersion: TRANSITION_PLAN_SCHEMA_VERSION,
    template,
    durationSeconds: plan.schedule.durationSeconds,
    targetCueSeconds: plan.schedule.targetCueSeconds,
    source: freezeDeck({
      playbackRate: plan.sourcePlaybackRate,
      trimDb: snapshot.sourceTrimDb,
      gainCurve: plan.automation.sourceGain,
      initialEqDb: snapshot.sourceEqDb,
      eqRamps: phrase ? [{ band: "low", ramp: { startOffsetSeconds: 0, durationSeconds: halfDuration, fromDb: snapshot.sourceEqDb.low, toDb: -12 } }] : []
    }),
    target: freezeDeck({
      playbackRate: phrase ? plan.targetPlaybackRate : 1,
      trimDb: snapshot.targetTrimDb,
      gainCurve: plan.automation.targetGain,
      initialEqDb: phrase ? { ...snapshot.targetEqDb, low: -12 } : snapshot.targetEqDb,
      eqRamps: phrase ? [{ band: "low", ramp: { startOffsetSeconds: halfDuration, durationSeconds: halfDuration, fromDb: -12, toDb: snapshot.targetEqDb.low } }] : []
    }),
    outputStage: "pre-master",
    requiredMasterVersion: MASTER_DSP_V1.version
  });
  validateTransitionDsp(result);
  return result;
};
