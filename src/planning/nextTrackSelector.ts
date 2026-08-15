import type { TransitionPlanV3 } from "../domain/transitionPlan";
import { octaveAwareTempoMatch } from "./transitionMath";

export type SelectionTrack = {
  id: string;
  bpm?: number | null;
  key?: string | null;
  scale?: "major" | "minor" | null;
  keyConfidence?: number | null;
};

export type RankedNextTrack<T extends SelectionTrack> = {
  track: T;
  plan: Readonly<TransitionPlanV3>;
  score: number;
  reasons: string[];
};

const PITCH_CLASS: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11
};

const harmonicScore = (source: SelectionTrack, target: SelectionTrack) => {
  const sourcePitch = source.key ? PITCH_CLASS[source.key] : undefined;
  const targetPitch = target.key ? PITCH_CLASS[target.key] : undefined;
  if (
    sourcePitch == null || targetPitch == null || !source.scale || !target.scale ||
    Number(source.keyConfidence ?? 0) < 0.55 || Number(target.keyConfidence ?? 0) < 0.55
  ) {
    return { score: 0.4, reason: "Key compatibility is unknown." };
  }
  const distance = (targetPitch - sourcePitch + 12) % 12;
  if (distance === 0 && source.scale === target.scale) {
    return { score: 1, reason: "Same-key harmonic match." };
  }
  const relative = source.scale === "major"
    ? target.scale === "minor" && distance === 9
    : target.scale === "major" && distance === 3;
  if (relative) return { score: 0.95, reason: "Relative major/minor harmonic match." };
  if (source.scale === target.scale && (distance === 5 || distance === 7)) {
    return { score: 0.82, reason: "Neighboring-fifth harmonic match." };
  }
  if (distance === 0) return { score: 0.7, reason: "Parallel-key harmonic match." };
  return { score: 0.2, reason: "Key contrast is higher." };
};

const tempoScore = (source: SelectionTrack, target: SelectionTrack) => {
  if (!source.bpm || !target.bpm || source.bpm <= 0 || target.bpm <= 0) {
    return { score: 0.35, reason: "Tempo compatibility is unknown." };
  }
  const match = octaveAwareTempoMatch(source.bpm, target.bpm);
  const percent = Math.abs(match.adjustedBpm / source.bpm - 1);
  return {
    score: Math.max(0, 1 - percent / 0.15),
    reason: percent <= 0.03
      ? "Tempos are naturally close."
      : percent <= 0.08
        ? "Tempo movement is moderate."
        : "Tempo contrast is higher."
  };
};

const transitionScore = (template: TransitionPlanV3["template"]) =>
  template === "phrase-blend" ? 3 : template === "downbeat-cut" ? 2 : 0;

const cuePreferenceScore = (plan: TransitionPlanV3) => {
  const value = Number(plan.scoreBreakdown?.musicalCuePreference);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
};

export const rankNextTracks = <T extends SelectionTrack>(
  source: SelectionTrack,
  candidates: T[],
  planForTarget: (target: T) => Readonly<TransitionPlanV3>
): Array<RankedNextTrack<T>> =>
  candidates
    .map((track, queueIndex) => {
      const plan = planForTarget(track);
      const harmonic = harmonicScore(source, track);
      const tempo = tempoScore(source, track);
      const cuePreference = cuePreferenceScore(plan);
      const score = transitionScore(plan.template) * 100 + cuePreference * 35 + harmonic.score * 30 + tempo.score * 20 - queueIndex * 0.001;
      return {
        track,
        plan,
        score,
        reasons: [
          plan.template === "downbeat-cut"
            ? "A locally trusted bar handoff is available."
            : plan.template === "phrase-blend"
              ? "A calibrated phrase blend is available."
              : plan.template === "filtered-fade"
                ? "A bounded filtered fade is available."
              : "Only the protected fade is available.",
          cuePreference > 0
            ? "The selected cue pair has stronger musical continuity."
            : "Musical cue preference is unavailable.",
          harmonic.reason,
          tempo.reason
        ]
      };
    })
    .sort((left, right) => right.score - left.score || candidates.indexOf(left.track) - candidates.indexOf(right.track));
