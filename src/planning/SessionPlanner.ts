import type { TransitionPlanV2 } from "../domain/transitionPlan";
import type { HostEnergyCurve } from "./EnergyStoryline";
import { scoreEnergyStorylineCandidate } from "./EnergyStoryline";
import type { RankedNextTrack, SelectionTrack } from "./nextTrackSelector";
import { rankNextTracks } from "./nextTrackSelector";

export type SessionCandidate = SelectionTrack & {
  duration?: number | null;
  energyByBeat?: readonly number[] | null;
  analysisOverrides?: { autoMixDisabled?: boolean } | null;
};

export type SessionHorizon<T extends SessionCandidate> = Readonly<{
  nextTrack: T;
  afterNextTrack: T | null;
  firstPlan: Readonly<TransitionPlanV2>;
  nextTemplate: TransitionPlanV2["template"];
  afterNextTemplate: TransitionPlanV2["template"] | null;
  reasons: string[];
  energyReason: string;
}>;

export type SessionPlannerOptions<T extends SessionCandidate> = {
  playedTrackIds?: readonly string[];
  curve: HostEnergyCurve;
  sessionProgress: number;
  planFirstLeg: (track: T) => Readonly<TransitionPlanV2>;
  planSecondLeg: (source: T, target: T) => Readonly<TransitionPlanV2>;
  candidateLimit?: number;
  beamWidth?: number;
};

const templateRank = (template: TransitionPlanV2["template"]) =>
  template === "phrase-blend" ? 3 : template === "downbeat-cut" ? 2 : 1;

type Path<T extends SessionCandidate> = {
  first: RankedNextTrack<T>;
  second: RankedNextTrack<T> | null;
  firstQueueIndex: number;
  secondQueueIndex: number;
  bottleneck: number;
  energyFit: number | null;
  energyReason: string;
};

export const planSessionHorizon = <T extends SessionCandidate>(
  current: SelectionTrack,
  candidates: readonly T[],
  options: SessionPlannerOptions<T>
): SessionHorizon<T> | null => {
  const played = new Set(options.playedTrackIds ?? []);
  const seen = new Set<string>();
  const eligible = candidates.filter((track) => {
    if (!track?.id || track.id === current.id || played.has(track.id) || seen.has(track.id)) return false;
    seen.add(track.id);
    return !track.analysisOverrides?.autoMixDisabled;
  }).slice(0, Math.max(1, options.candidateLimit ?? 20));
  if (!eligible.length) return null;

  const queueIndex = new Map(eligible.map((track, index) => [track.id, index]));
  const firstLegs = rankNextTracks(current, [...eligible], options.planFirstLeg);
  const paths: Array<Path<T>> = [];
  for (const first of firstLegs) {
    const remaining = eligible.filter((track) => track.id !== first.track.id);
    const second = remaining.length
      ? rankNextTracks(first.track, remaining, (target) => options.planSecondLeg(first.track, target))[0]
      : null;
    const energy = scoreEnergyStorylineCandidate(first.track, options.curve, options.sessionProgress);
    const firstRank = templateRank(first.plan.template);
    const secondRank = second ? templateRank(second.plan.template) : firstRank;
    paths.push({
      first,
      second,
      firstQueueIndex: queueIndex.get(first.track.id) ?? Number.MAX_SAFE_INTEGER,
      secondQueueIndex: second ? queueIndex.get(second.track.id) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
      bottleneck: Math.min(firstRank, secondRank),
      energyFit: energy.heuristicFit,
      energyReason: energy.reason
    });
  }

  paths.sort((left, right) =>
    right.bottleneck - left.bottleneck ||
    templateRank(right.first.plan.template) - templateRank(left.first.plan.template) ||
    templateRank(right.second?.plan.template ?? right.first.plan.template) -
      templateRank(left.second?.plan.template ?? left.first.plan.template) ||
    (right.energyFit ?? -1) - (left.energyFit ?? -1) ||
    (right.first.score + (right.second?.score ?? 0) * 0.65) -
      (left.first.score + (left.second?.score ?? 0) * 0.65) ||
    left.firstQueueIndex - right.firstQueueIndex ||
    left.secondQueueIndex - right.secondQueueIndex
  );
  const winner = paths[0];
  return Object.freeze({
    nextTrack: winner.first.track,
    afterNextTrack: winner.second?.track ?? null,
    firstPlan: winner.first.plan,
    nextTemplate: winner.first.plan.template,
    afterNextTemplate: winner.second?.plan.template ?? null,
    reasons: Object.freeze([
      winner.first.reasons[0],
      winner.second
        ? `The following handoff can use ${winner.second.plan.template === "downbeat-cut" ? "a trusted bar cue" : winner.second.plan.template === "phrase-blend" ? "a calibrated phrase blend" : "a protected fade"}.`
        : "No third track is currently available.",
      winner.energyReason
    ]) as unknown as string[],
    energyReason: winner.energyReason
  });
};
