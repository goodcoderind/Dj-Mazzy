import type { HostEnergyCurve } from "./EnergyStoryline";
import type { SessionCandidate, SessionHorizon } from "./SessionPlanner";
import { planSessionHorizon } from "./SessionPlanner";
import type { TransitionTrack } from "./TransitionPlanner";
import { planAutomaticTransition } from "./TransitionPlanner";
import { shouldArmAutoPilotTransition } from "./autoPilot";
import { buildAutoPilotPlanningIds } from "./autoPilotCrate";
import type { TransitionPlanV3 } from "../domain/transitionPlan";
import type { KeyLockCapability } from "../domain/keyLockCapability";

export const PARTY_AUTOPILOT_DECISION_VERSION = "party-autopilot-decision/v2" as const;

export type AutoPilotDeck = "a" | "b";

export type AutoPilotSessionTrack = SessionCandidate &
  Partial<Omit<TransitionTrack, "trackId" | "duration">> & Readonly<{
    id: string;
    duration?: number | null;
  }>;

export type AutoPilotDeckObservation = Readonly<{
  deck: AutoPilotDeck;
  trackId: string | null;
  loadKey: string | null;
  ready: boolean;
  playing: boolean;
  durationSeconds: number;
  positionSeconds: number;
  playbackRate: number;
  analysis?: Partial<TransitionTrack> | null;
}>;

export type AutoPilotSessionDecisionInput = Readonly<{
  nowSeconds: number;
  source: AutoPilotDeckObservation;
  target: AutoPilotDeckObservation;
  queueTrackIds: readonly string[];
  library: readonly AutoPilotSessionTrack[];
  playedTrackIds: readonly string[];
  includeRestOfLibrary: boolean;
  energyCurve: HostEnergyCurve;
  sessionProgress: number;
  preloadBusy: boolean;
  activeTransitionKey: string | null;
  keyLockCapability?: KeyLockCapability | null;
}>;

export type AutoPilotSessionDecision =
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "pause-source-stopped" }>
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "wait-preload" }>
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "eject-blocked-target"; targetTrackId: string }>
  | Readonly<{
      version: typeof PARTY_AUTOPILOT_DECISION_VERSION;
      kind: "preload";
      trackId: string;
      selectionSource: "queue" | "library";
      afterNextTrackId: string | null;
      reasons: readonly string[];
    }>
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "declare-final"; sourceTrackId: string | null }>
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "wait-target"; reason: "target-active" | "invalid-observation" | "unsupported-template" }>
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "wait-owned-transition"; transitionKey: string }>
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "wait-cue"; transitionKey: string; plan: Readonly<TransitionPlanV3> }>
  | Readonly<{ version: typeof PARTY_AUTOPILOT_DECISION_VERSION; kind: "arm"; transitionKey: string; plan: Readonly<TransitionPlanV3> }>;

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;

const validObservation = (observation: AutoPilotDeckObservation) =>
  finiteNonNegative(observation.durationSeconds) &&
  finiteNonNegative(observation.positionSeconds) &&
  Number.isFinite(observation.playbackRate) && observation.playbackRate > 0 &&
  observation.positionSeconds <= observation.durationSeconds + 0.001;

const transitionTrack = (
  observation: AutoPilotDeckObservation,
  fallbackId: string
): TransitionTrack => ({
  ...(observation.analysis ?? {}),
  trackId: observation.trackId ?? fallbackId,
  duration: observation.durationSeconds
});

const planPair = (
  nowSeconds: number,
  source: AutoPilotDeckObservation,
  target: AutoPilotDeckObservation,
  keyLockCapability: KeyLockCapability | null | undefined
) => planAutomaticTransition({
  requestedAt: nowSeconds,
  source: transitionTrack(source, `session-${source.deck}`),
  target: transitionTrack(target, `session-${target.deck}`),
  sourceDeck: {
    positionSeconds: source.positionSeconds,
    playbackRate: source.playbackRate
  },
  keyLockCapability
});

const planHorizon = (
  input: AutoPilotSessionDecisionInput,
  candidates: AutoPilotSessionTrack[]
): SessionHorizon<AutoPilotSessionTrack> | null => {
  if (!input.source.ready) return null;
  const sourceAnalysis = input.source.analysis ?? {};
  return planSessionHorizon(
    {
      id: input.source.trackId ?? `session-${input.source.deck}`,
      bpm: sourceAnalysis.bpm ?? null,
      key: (sourceAnalysis as { key?: string | null }).key ?? null,
      scale: (sourceAnalysis as { scale?: "major" | "minor" | null }).scale ?? null,
      keyConfidence: (sourceAnalysis as { keyConfidence?: number | null }).keyConfidence ?? 0
    },
    candidates,
    {
      playedTrackIds: input.playedTrackIds,
      curve: input.energyCurve,
      sessionProgress: input.sessionProgress,
      planFirstLeg: (candidate) => planAutomaticTransition({
        requestedAt: input.nowSeconds,
        source: transitionTrack({
          ...input.source,
          positionSeconds: Math.max(
            input.source.positionSeconds,
            input.source.durationSeconds - 20 * Math.max(input.source.playbackRate, 0.001)
          )
        }, `session-${input.source.deck}`),
        target: { ...candidate, trackId: candidate.id, duration: Number(candidate.duration ?? 0) },
        sourceDeck: {
          positionSeconds: Math.max(
            input.source.positionSeconds,
            input.source.durationSeconds - 20 * Math.max(input.source.playbackRate, 0.001)
          ),
          playbackRate: input.source.playbackRate
        },
        keyLockCapability: input.keyLockCapability
      }),
      planSecondLeg: (futureSource, futureTarget) => planAutomaticTransition({
        requestedAt: 0,
        source: { ...futureSource, trackId: futureSource.id, duration: Number(futureSource.duration ?? 0) },
        target: { ...futureTarget, trackId: futureTarget.id, duration: Number(futureTarget.duration ?? 0) },
        sourceDeck: {
          positionSeconds: Math.max(0, Number(futureSource.duration ?? 0) - 20),
          playbackRate: 1
        },
        keyLockCapability: input.keyLockCapability
      })
    }
  );
};

export const decideAutoPilotSessionTick = (
  input: AutoPilotSessionDecisionInput
): AutoPilotSessionDecision => {
  if (!finiteNonNegative(input.nowSeconds)) throw new RangeError("nowSeconds must be finite and non-negative");
  if (!finiteNonNegative(input.sessionProgress) || input.sessionProgress > 1) {
    throw new RangeError("sessionProgress must be between zero and one");
  }
  if (input.source.deck === input.target.deck) throw new RangeError("source and target decks must differ");
  const version = PARTY_AUTOPILOT_DECISION_VERSION;

  if (!input.source.playing) return Object.freeze({ version, kind: "pause-source-stopped" });
  if (!validObservation(input.source) || (input.target.ready && !validObservation(input.target))) {
    return Object.freeze({ version, kind: "wait-target", reason: "invalid-observation" });
  }
  if (input.preloadBusy) return Object.freeze({ version, kind: "wait-preload" });

  const loadedTarget = input.target.trackId
    ? input.library.find((track) => track.id === input.target.trackId)
    : null;
  if (
    input.target.trackId && !input.target.playing &&
    (input.playedTrackIds.includes(input.target.trackId) || loadedTarget?.analysisOverrides?.autoMixDisabled)
  ) {
    return Object.freeze({ version, kind: "eject-blocked-target", targetTrackId: input.target.trackId });
  }

  if (!input.target.ready) {
    const candidateIds = buildAutoPilotPlanningIds(
      input.queueTrackIds,
      input.library,
      input.playedTrackIds,
      [input.source.trackId, input.target.trackId],
      input.includeRestOfLibrary
    );
    const candidates = candidateIds
      .map((id) => input.library.find((track) => track.id === id))
      .filter((track): track is AutoPilotSessionTrack => Boolean(track));
    const horizon = planHorizon(input, candidates);
    const nextTrack = horizon?.nextTrack ?? candidates[0] ?? null;
    if (!nextTrack) {
      return Object.freeze({ version, kind: "declare-final", sourceTrackId: input.source.trackId });
    }
    return Object.freeze({
      version,
      kind: "preload",
      trackId: nextTrack.id,
      selectionSource: input.queueTrackIds.includes(nextTrack.id) ? "queue" : "library",
      afterNextTrackId: horizon?.afterNextTrack?.id ?? null,
      reasons: Object.freeze(horizon?.reasons ?? ["Queue order preserved."])
    });
  }

  if (input.target.playing) return Object.freeze({ version, kind: "wait-target", reason: "target-active" });
  if (!input.source.ready || !input.target.ready) return Object.freeze({ version, kind: "wait-target", reason: "invalid-observation" });

  const sourceIdentity = input.source.loadKey ?? input.source.trackId ?? `session-${input.source.deck}`;
  const targetIdentity = input.target.loadKey ?? input.target.trackId ?? `session-${input.target.deck}`;
  const transitionKey = `${sourceIdentity}->${targetIdentity}`;
  if (input.activeTransitionKey === transitionKey) {
    return Object.freeze({ version, kind: "wait-owned-transition", transitionKey });
  }
  const plan = planPair(input.nowSeconds, input.source, input.target, input.keyLockCapability);
  if (!["safe-fade", "filtered-fade", "downbeat-cut", "phrase-blend"].includes(plan.template)) {
    return Object.freeze({ version, kind: "wait-target", reason: "unsupported-template" });
  }
  const remainingSeconds = Math.max(
    0,
    (input.source.durationSeconds - input.source.positionSeconds) /
      Math.max(input.source.playbackRate, 0.001)
  );
  const untilPlannedStartSeconds = plan.schedule.startTime - input.nowSeconds;
  if (!shouldArmAutoPilotTransition({
    template: plan.template as "safe-fade" | "filtered-fade" | "downbeat-cut" | "phrase-blend",
    remainingSeconds,
    untilPlannedStartSeconds
  })) {
    return Object.freeze({ version, kind: "wait-cue", transitionKey, plan });
  }
  return Object.freeze({ version, kind: "arm", transitionKey, plan });
};
