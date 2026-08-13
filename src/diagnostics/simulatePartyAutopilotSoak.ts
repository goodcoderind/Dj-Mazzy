import { decideAutoPilotSessionTick, type AutoPilotDeck, type AutoPilotSessionTrack } from "../planning/autoPilotSessionDecision";
import { PARTY_ENERGY_CURVES } from "../planning/energyProfiles";
import { decideRescueTransition } from "../planning/rescueTransition";
import { createPartySessionClock, partySessionClockSnapshot, pausePartySessionClock, startPartySessionClock } from "../planning/PartySessionClock";
import type { TransitionTrack } from "../planning/TransitionPlanner";
import type { KeyLockCapability } from "../domain/keyLockCapability";
import { createPartyAutopilotTraceRecorder, evaluatePartyAutopilotTrace, type PartyAutopilotEvaluation } from "./partyAutopilotTrace";

export const PARTY_AUTOPILOT_SOAK_SCHEMA_VERSION = "party-autopilot-coordinator-soak/v2" as const;

export type SimulatedPartyTrack = Readonly<{
  id: string;
  durationSeconds: number;
  bpm?: number | null;
  key?: string | null;
  scale?: "major" | "minor" | null;
  keyConfidence?: number;
  energyByBeat?: readonly number[];
  analysis?: Partial<Omit<TransitionTrack, "trackId" | "duration">>;
  analysisOverrides?: { autoMixDisabled?: boolean } | null;
}>;

export type SimulatedPartyRescue = Readonly<{
  transitionAttempt: number;
  progress: number;
}>;

export type PartyAutopilotSoakOptions = Readonly<{
  tracks: readonly SimulatedPartyTrack[];
  /** Observation horizon, not a command to stop production playback. */
  sessionDurationSeconds: number;
  initialTrackId?: string;
  queuedTrackIds?: readonly string[];
  includeRestOfLibrary?: boolean;
  clockStartSeconds?: number;
  rescues?: readonly SimulatedPartyRescue[];
  /** Synthetic fixture capability; never inferred from track metadata. */
  keyLockCapability?: KeyLockCapability | null;
}>;

export type SimulatedPartyRescueEvent = Readonly<{
  transitionAttempt: number;
  kept: "source" | "target";
  progress: number;
}>;

export type PartyAutopilotSoakResult = Readonly<{
  schemaVersion: typeof PARTY_AUTOPILOT_SOAK_SCHEMA_VERSION;
  completed: boolean;
  stopReason: "observation-horizon" | "crate-exhausted" | "rescue-paused" | "invalid";
  evidenceScope: "shared Autopilot coordinator and state invariants only; not audio continuity, musical quality, decode, or speaker output";
  observationHorizonSeconds: number;
  elapsedActiveSeconds: number;
  playedTrackIds: readonly string[];
  repeatTrackIds: readonly string[];
  transitionAttempts: number;
  successfulHandoffs: number;
  rescueEvents: readonly SimulatedPartyRescueEvent[];
  transitionTemplates: Readonly<Record<"safe-fade" | "downbeat-cut" | "phrase-blend", number>>;
  evaluation: PartyAutopilotEvaluation;
  errors: readonly string[];
}>;

const positiveFinite = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
};

const validate = (options: PartyAutopilotSoakOptions) => {
  positiveFinite(options.sessionDurationSeconds, "sessionDurationSeconds");
  const start = options.clockStartSeconds ?? 0;
  if (!Number.isFinite(start) || start < 0) throw new RangeError("clockStartSeconds must be non-negative");
  if (!options.tracks.length) throw new RangeError("tracks must not be empty");
  const ids = new Set<string>();
  for (const track of options.tracks) {
    if (!track.id || ids.has(track.id)) throw new RangeError("track ids must be non-empty and unique");
    ids.add(track.id);
    positiveFinite(track.durationSeconds, `durationSeconds for ${track.id}`);
  }
  const initial = options.initialTrackId ?? options.tracks[0].id;
  if (!ids.has(initial)) throw new RangeError("initialTrackId must identify a supplied track");
  const rescueAttempts = new Set<number>();
  for (const rescue of options.rescues ?? []) {
    if (!Number.isInteger(rescue.transitionAttempt) || rescue.transitionAttempt < 1 || rescueAttempts.has(rescue.transitionAttempt)) {
      throw new RangeError("rescue transitionAttempt values must be unique positive integers");
    }
    rescueAttempts.add(rescue.transitionAttempt);
    if (!Number.isFinite(rescue.progress) || rescue.progress < 0 || rescue.progress > 1) {
      throw new RangeError("rescue progress must be from 0 to 1");
    }
  }
  return { start, initial };
};

const coordinatorTrack = (track: SimulatedPartyTrack): AutoPilotSessionTrack => ({
  ...(track.analysis ?? {}),
  id: track.id,
  duration: track.durationSeconds,
  bpm: track.bpm ?? track.analysis?.bpm ?? null,
  key: track.key ?? null,
  scale: track.scale ?? null,
  keyConfidence: track.keyConfidence ?? 0,
  energyByBeat: Array.from(track.analysis?.energyByBeat ?? track.energyByBeat ?? [0.5]),
  beatsSeconds: Array.from(track.analysis?.beatsSeconds ?? []),
  downbeatsSeconds: Array.from(track.analysis?.downbeatsSeconds ?? []),
  beatConfidence: track.analysis?.beatConfidence ?? 0,
  downbeatConfidence: track.analysis?.downbeatConfidence ?? 0,
  analysisOverrides: track.analysisOverrides ?? null
});

const transitionAnalysis = (track: SimulatedPartyTrack) => ({
  ...(track.analysis ?? {}),
  bpm: track.bpm ?? track.analysis?.bpm ?? null,
  key: track.key ?? null,
  scale: track.scale ?? null,
  keyConfidence: track.keyConfidence ?? 0,
  beatsSeconds: Array.from(track.analysis?.beatsSeconds ?? []),
  downbeatsSeconds: Array.from(track.analysis?.downbeatsSeconds ?? []),
  beatConfidence: track.analysis?.beatConfidence ?? 0,
  downbeatConfidence: track.analysis?.downbeatConfidence ?? 0,
  energyByBeat: Array.from(track.analysis?.energyByBeat ?? track.energyByBeat ?? [0.5])
});

const repeated = (ids: readonly string[]) => ids.filter((id, index) => ids.indexOf(id) !== index)
  .filter((id, index, values) => values.indexOf(id) === index);

export const simulatePartyAutopilotSoak = (options: PartyAutopilotSoakOptions): PartyAutopilotSoakResult => {
  const { start, initial } = validate(options);
  const byId = new Map(options.tracks.map((track) => [track.id, track]));
  const library = options.tracks.map(coordinatorTrack);
  const ordinals = new Map(options.tracks.map((track, index) => [track.id, index + 1]));
  const rescueByAttempt = new Map((options.rescues ?? []).map((rescue) => [rescue.transitionAttempt, rescue]));
  const recorder = createPartyAutopilotTraceRecorder(Math.max(4_096, options.tracks.length * 12));
  const errors: string[] = [];
  const playedTrackIds = [initial];
  const rescueEvents: SimulatedPartyRescueEvent[] = [];
  const transitionTemplates = { "safe-fade": 0, "downbeat-cut": 0, "phrase-blend": 0 };
  let queue = [...new Set(options.queuedTrackIds ?? options.tracks.slice(1).map((track) => track.id))]
    .filter((id) => byId.has(id) && id !== initial);
  let queueRevision = 1;
  let now = start;
  let clock = startPartySessionClock(createPartySessionClock(options.sessionDurationSeconds), now);
  let sourceDeck: AutoPilotDeck = "a";
  let sourceId = initial;
  let sourcePosition = 0;
  let sourcePlaybackRate = 1;
  let sourceLoad = 1;
  let targetId: string | null = null;
  let targetLoad: number | null = null;
  let nextLoad = 1;
  let nextOperation = 0;
  let nextTransition = 0;
  let activeTransitionKey: string | null = null;
  let stopReason: PartyAutopilotSoakResult["stopReason"] = "invalid";

  const clockSnapshot = () => partySessionClockSnapshot(clock, now);
  const activeSecond = () => Math.max(0, Math.floor(clockSnapshot().elapsedActiveSeconds));
  const append = (event: Parameters<typeof recorder.append>[0]) => {
    if (!recorder.append({ ...event, activeSecond: activeSecond() })) errors.push("trace append failed");
  };
  const advance = (seconds: number) => {
    const bounded = Math.max(0, Math.min(seconds, clockSnapshot().remainingSeconds));
    now += bounded;
    sourcePosition += bounded * sourcePlaybackRate;
    return bounded;
  };

  append({ type: "session-started", activeSecond: 0 });
  append({ type: "queue-committed", activeSecond: 0, revision: queueRevision, trackOrdinals: queue.map((id) => ordinals.get(id)!) });
  append({ type: "track-played", activeSecond: 0, trackOrdinal: ordinals.get(initial)!, loadOrdinal: sourceLoad, cause: "host" });

  const maximumIterations = Math.max(100, options.tracks.length * 20);
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    if (clockSnapshot().elapsedActiveSeconds >= options.sessionDurationSeconds - 1e-9) {
      stopReason = "observation-horizon";
      break;
    }
    const source = byId.get(sourceId)!;
    const target = targetId ? byId.get(targetId)! : null;
    const targetDeck: AutoPilotDeck = sourceDeck === "a" ? "b" : "a";
    const decision = decideAutoPilotSessionTick({
      nowSeconds: now,
      source: {
        deck: sourceDeck,
        trackId: sourceId,
        loadKey: `${ordinals.get(sourceId)}:${sourceLoad}`,
        ready: true,
        playing: true,
        durationSeconds: source.durationSeconds,
        positionSeconds: Math.min(sourcePosition, source.durationSeconds),
        playbackRate: sourcePlaybackRate,
        analysis: transitionAnalysis(source)
      },
      target: {
        deck: targetDeck,
        trackId: targetId,
        loadKey: targetId && targetLoad ? `${ordinals.get(targetId)}:${targetLoad}` : null,
        ready: Boolean(target),
        playing: false,
        durationSeconds: target?.durationSeconds ?? 0,
        positionSeconds: 0,
        playbackRate: 1,
        analysis: target ? transitionAnalysis(target) : null
      },
      queueTrackIds: queue,
      library,
      playedTrackIds,
      includeRestOfLibrary: options.includeRestOfLibrary ?? true,
      energyCurve: PARTY_ENERGY_CURVES.build,
      sessionProgress: clockSnapshot().energyProgress,
      preloadBusy: false,
      activeTransitionKey,
      keyLockCapability: options.keyLockCapability ?? null
    });

    if (decision.kind === "preload") {
      targetId = decision.trackId;
      targetLoad = ++nextLoad;
      const operation = ++nextOperation;
      append({ type: "preload-started", activeSecond: 0, operation, generation: operation, deck: targetDeck, trackOrdinal: ordinals.get(targetId)!, loadOrdinal: targetLoad, selectionSource: decision.selectionSource });
      append({ type: "preload-settled", activeSecond: 0, operation, outcome: "committed" });
      queue = queue.filter((id) => id !== targetId);
      append({ type: "queue-committed", activeSecond: 0, revision: ++queueRevision, trackOrdinals: queue.map((id) => ordinals.get(id)!) });
      continue;
    }
    if (decision.kind === "wait-cue") {
      const remaining = Math.max(0, (source.durationSeconds - sourcePosition) / sourcePlaybackRate);
      const templateRemaining = decision.plan.template === "phrase-blend" ? 30 : decision.plan.template === "downbeat-cut" ? 20 : 3.75;
      const templateLead = decision.plan.template === "phrase-blend" ? 8 : decision.plan.template === "downbeat-cut" ? 6 : Number.POSITIVE_INFINITY;
      const advanceSeconds = Math.max(0.05, remaining - templateRemaining, decision.plan.schedule.startTime - now - templateLead);
      advance(advanceSeconds);
      continue;
    }
    if (decision.kind === "arm" && targetId && targetLoad) {
      const horizonRemaining = clockSnapshot().remainingSeconds;
      const requiredSeconds = Math.max(0, decision.plan.schedule.startTime - now) + decision.plan.schedule.durationSeconds;
      if (requiredSeconds > horizonRemaining + 1e-9) {
        advance(horizonRemaining);
        stopReason = "observation-horizon";
        break;
      }
      const operation = ++nextOperation;
      const transition = ++nextTransition;
      append({ type: "arm-started", activeSecond: 0, operation, origin: "autopilot" });
      append({ type: "arm-settled", activeSecond: 0, operation, outcome: "scheduled" });
      append({ type: "transition-scheduled", activeSecond: 0, transition, sourceTrackOrdinal: ordinals.get(sourceId)!, sourceLoadOrdinal: sourceLoad, targetTrackOrdinal: ordinals.get(targetId)!, targetLoadOrdinal: targetLoad, ownership: "autopilot", template: decision.plan.template as keyof typeof transitionTemplates });
      transitionTemplates[decision.plan.template as keyof typeof transitionTemplates] += 1;
      activeTransitionKey = decision.transitionKey;
      const lead = Math.max(0, decision.plan.schedule.startTime - now);
      advance(lead);
      const rescue = rescueByAttempt.get(transition);
      const transitionDuration = decision.plan.schedule.durationSeconds;
      if (rescue) {
        advance(transitionDuration * rescue.progress);
        const rescueDecision = decideRescueTransition({ id: transition, source: sourceDeck, target: targetDeck, startTime: now - transitionDuration * rescue.progress, endTime: now - transitionDuration * rescue.progress + transitionDuration }, now);
        const kept = rescueDecision.keep === sourceDeck ? "source" : "target";
        append({ type: "transition-rescued", activeSecond: 0, transition, kept });
        append({ type: "session-paused", activeSecond: 0, reason: "rescue" });
        clock = pausePartySessionClock(clock, now);
        rescueEvents.push(Object.freeze({ transitionAttempt: transition, kept, progress: rescueDecision.progress }));
        if (kept === "target") {
          sourceDeck = targetDeck;
          sourceId = targetId;
          sourceLoad = targetLoad;
          sourcePlaybackRate = decision.plan.targetPlaybackRate;
          sourcePosition = decision.plan.schedule.targetCueSeconds + transitionDuration * rescue.progress * sourcePlaybackRate;
          playedTrackIds.push(sourceId);
        }
        targetId = null;
        targetLoad = null;
        activeTransitionKey = null;
        stopReason = "rescue-paused";
        break;
      }
      const rendered = advance(transitionDuration);
      if (rendered + 1e-9 < transitionDuration) {
        stopReason = "observation-horizon";
        break;
      }
      append({ type: "transition-completed", activeSecond: 0, transition, targetTrackOrdinal: ordinals.get(targetId)!, targetLoadOrdinal: targetLoad });
      sourceDeck = targetDeck;
      sourceId = targetId;
      sourceLoad = targetLoad;
      sourcePlaybackRate = decision.plan.targetPlaybackRate;
      sourcePosition = decision.plan.schedule.targetCueSeconds + transitionDuration * sourcePlaybackRate;
      playedTrackIds.push(sourceId);
      targetId = null;
      targetLoad = null;
      activeTransitionKey = null;
      continue;
    }
    if (decision.kind === "declare-final") {
      append({ type: "final-declared", activeSecond: 0, deck: sourceDeck, trackOrdinal: ordinals.get(sourceId)!, loadOrdinal: sourceLoad });
      const remaining = Math.max(0, (source.durationSeconds - sourcePosition) / sourcePlaybackRate);
      const rendered = advance(remaining);
      if (rendered + 1e-9 < remaining) {
        stopReason = "observation-horizon";
        break;
      }
      append({ type: "deck-ended", activeSecond: 0, deck: sourceDeck, trackOrdinal: ordinals.get(sourceId)!, loadOrdinal: sourceLoad });
      append({ type: "session-ended", activeSecond: 0, reason: "final-track-ended" });
      stopReason = "crate-exhausted";
      break;
    }
    errors.push(`unexpected coordinator decision: ${decision.kind}`);
    break;
  }

  const evaluation = evaluatePartyAutopilotTrace(recorder.snapshot());
  const repeatTrackIds = repeated(playedTrackIds);
  if (repeatTrackIds.length) errors.push("track repeated");
  if (evaluation.status === "invalid") errors.push(...evaluation.failureCodes);
  return Object.freeze({
    schemaVersion: PARTY_AUTOPILOT_SOAK_SCHEMA_VERSION,
    completed: stopReason === "observation-horizon" && errors.length === 0,
    stopReason,
    evidenceScope: "shared Autopilot coordinator and state invariants only; not audio continuity, musical quality, decode, or speaker output",
    observationHorizonSeconds: options.sessionDurationSeconds,
    elapsedActiveSeconds: clockSnapshot().elapsedActiveSeconds,
    playedTrackIds: Object.freeze(playedTrackIds),
    repeatTrackIds: Object.freeze(repeatTrackIds),
    transitionAttempts: nextTransition,
    successfulHandoffs: evaluation.counters.transitionsCompleted,
    rescueEvents: Object.freeze(rescueEvents),
    transitionTemplates: Object.freeze(transitionTemplates),
    evaluation,
    errors: Object.freeze(errors)
  });
};
