import {
  decideAutoPilotSessionTick,
  type AutoPilotDeck,
  type AutoPilotPreloadLease,
  type AutoPilotSessionTrack
} from "../planning/autoPilotSessionDecision";
import { PARTY_ENERGY_CURVES } from "../planning/energyProfiles";
import { decideRescueTransition } from "../planning/rescueTransition";
import { createPartySessionClock, partySessionClockSnapshot, pausePartySessionClock, startPartySessionClock } from "../planning/PartySessionClock";
import type { TransitionTrack } from "../planning/TransitionPlanner";
import type { KeyLockCapability } from "../domain/keyLockCapability";
import { createPartyAutopilotTraceRecorder, evaluatePartyAutopilotTrace, type PartyAutopilotEvaluation } from "./partyAutopilotTrace";
import {
  createAutoPilotArmLease,
  decideAutoPilotArmFailure,
  deriveAutoPilotArmDeadline,
  inspectAutoPilotArmLease
} from "../planning/autoPilotArmOwnership";
import {
  createAutoPilotTransitionCompletionLease,
  inspectAutoPilotTransitionCompletion
} from "../planning/autoPilotTransitionCompletionOwnership";
import {
  createDeckPlaybackCompletionLease,
  inspectDeckPlaybackCompletion
} from "../planning/deckPlaybackCompletionOwnership";

export const PARTY_AUTOPILOT_SOAK_SCHEMA_VERSION = "party-autopilot-coordinator-soak/v9" as const;

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
  /** Synthetic load failures, consumed once per listed track in this run. */
  unplayableTrackIds?: readonly string[];
  /** Synthetic preloads that never settle until the production lease expires. */
  neverSettlingPreloadTrackIds?: readonly string[];
  /** Ordered synthetic arm outcomes. Unspecified attempts schedule successfully. */
  armOutcomes?: readonly ("failed" | "timed-out" | "scheduled")[];
  /** Synthetic audio-clock settlement delays for the matching arm attempt. */
  armSettlementDelaysSeconds?: readonly number[];
  /** Synthetic pair replacements before settlement, consumed by attempt ordinal. */
  supersededArmAttempts?: readonly number[];
  /** Transition attempts whose primary completion signal is deliberately dropped. */
  missingPrimaryCompletionAttempts?: readonly number[];
  /** Audio-clock delay after the scheduled end before a primary completion signal. */
  transitionCompletionDelaysSeconds?: readonly number[];
  /** Transition attempts whose exact target load is replaced before completion settles. */
  supersededCompletionAttempts?: readonly number[];
  /** One synthetic coordinator tick that fails before mutating its decision. */
  coordinatorFailureIteration?: number;
  /** Exact final-deck completion signal; non-primary values model a lost source callback. */
  finalDeckCompletionSignal?: "source-onended" | "audio-clock" | "reconcile";
}>;

export type SimulatedPartyRescueEvent = Readonly<{
  transitionAttempt: number;
  kept: "source" | "target";
  progress: number;
}>;

export type PartyAutopilotSoakResult = Readonly<{
  schemaVersion: typeof PARTY_AUTOPILOT_SOAK_SCHEMA_VERSION;
  completed: boolean;
  stopReason: "observation-horizon" | "crate-exhausted" | "rescue-paused" | "preload-timeout-paused" | "preload-runway-paused" | "transition-arm-paused" | "transition-completion-paused" | "coordinator-failure-paused" | "invalid";
  evidenceScope: "shared Autopilot coordinator and state invariants only; not audio continuity, musical quality, decode, or speaker output";
  observationHorizonSeconds: number;
  elapsedActiveSeconds: number;
  playedTrackIds: readonly string[];
  repeatTrackIds: readonly string[];
  transitionAttempts: number;
  successfulHandoffs: number;
  rescueEvents: readonly SimulatedPartyRescueEvent[];
  transitionTemplates: Readonly<Record<"safe-fade" | "filtered-fade" | "downbeat-cut" | "phrase-blend", number>>;
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
  if (options.coordinatorFailureIteration != null &&
    (!Number.isSafeInteger(options.coordinatorFailureIteration) || options.coordinatorFailureIteration < 1)) {
    throw new RangeError("coordinatorFailureIteration must be a positive safe integer");
  }
  if (options.finalDeckCompletionSignal != null &&
    !["source-onended", "audio-clock", "reconcile"].includes(options.finalDeckCompletionSignal)) {
    throw new RangeError("finalDeckCompletionSignal must be allowlisted");
  }
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
  for (const outcome of options.armOutcomes ?? []) {
    if (!["failed", "timed-out", "scheduled"].includes(outcome)) {
      throw new RangeError("armOutcomes must contain only allowlisted outcomes");
    }
  }
  for (const delay of options.armSettlementDelaysSeconds ?? []) {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError("armSettlementDelaysSeconds must be finite and non-negative");
    }
  }
  const supersededAttempts = new Set<number>();
  for (const attempt of options.supersededArmAttempts ?? []) {
    if (!Number.isSafeInteger(attempt) || attempt < 1 || supersededAttempts.has(attempt)) {
      throw new RangeError("supersededArmAttempts must contain unique positive integers");
    }
    supersededAttempts.add(attempt);
  }
  for (const delay of options.transitionCompletionDelaysSeconds ?? []) {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError("transitionCompletionDelaysSeconds must be finite and non-negative");
    }
  }
  for (const [name, attempts] of [
    ["missingPrimaryCompletionAttempts", options.missingPrimaryCompletionAttempts ?? []],
    ["supersededCompletionAttempts", options.supersededCompletionAttempts ?? []]
  ] as const) {
    const seen = new Set<number>();
    for (const attempt of attempts) {
      if (!Number.isSafeInteger(attempt) || attempt < 1 || seen.has(attempt)) {
        throw new RangeError(`${name} must contain unique positive integers`);
      }
      seen.add(attempt);
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
  const transitionTemplates = { "safe-fade": 0, "filtered-fade": 0, "downbeat-cut": 0, "phrase-blend": 0 };
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
  let armAttempts = 0;
  let consecutiveArmFailures = 0;
  let activeTransitionKey: string | null = null;
  let preloadLease: AutoPilotPreloadLease | null = null;
  const unavailableTrackIds = new Set<string>();
  const syntheticUnplayableIds = new Set(options.unplayableTrackIds ?? []);
  const syntheticNeverSettlingIds = new Set(options.neverSettlingPreloadTrackIds ?? []);
  const syntheticSupersededArmAttempts = new Set(options.supersededArmAttempts ?? []);
  const syntheticMissingPrimaryCompletionAttempts = new Set(options.missingPrimaryCompletionAttempts ?? []);
  const syntheticSupersededCompletionAttempts = new Set(options.supersededCompletionAttempts ?? []);
  let consecutivePreloadTimeouts = 0;
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
    if (iteration + 1 === options.coordinatorFailureIteration) {
      append({
        type: "coordinator-failed",
        activeSecond: 0,
        operation: iteration + 1,
        phase: "decision",
        pauseRequired: true
      });
      append({ type: "session-paused", activeSecond: 0, reason: "coordinator-failure" });
      clock = pausePartySessionClock(clock, now);
      stopReason = "coordinator-failure-paused";
      break;
    }
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
      unavailableTrackIds: [...unavailableTrackIds],
      includeRestOfLibrary: options.includeRestOfLibrary ?? true,
      energyCurve: PARTY_ENERGY_CURVES.build,
      sessionProgress: clockSnapshot().energyProgress,
      preloadLease,
      activeTransitionKey,
      keyLockCapability: options.keyLockCapability ?? null
    });

    if (decision.kind === "wait-preload") {
      const untilDeadline = Math.max(0, decision.lease.deadlineSeconds - now);
      const rendered = advance(untilDeadline);
      if (rendered + 1e-9 < untilDeadline) {
        stopReason = "observation-horizon";
        break;
      }
      continue;
    }
    if (decision.kind === "expire-preload") {
      append({ type: "preload-settled", activeSecond: 0, operation: decision.lease.operation, outcome: "timed-out" });
      unavailableTrackIds.add(decision.lease.trackId);
      targetId = null;
      targetLoad = null;
      preloadLease = null;
      consecutivePreloadTimeouts += 1;
      if (consecutivePreloadTimeouts >= 2) {
        append({ type: "session-paused", activeSecond: 0, reason: "preload-timeout" });
        clock = pausePartySessionClock(clock, now);
        stopReason = "preload-timeout-paused";
        break;
      }
      continue;
    }
    if (decision.kind === "pause-preload-runway") {
      append({ type: "session-paused", activeSecond: 0, reason: "preload-runway" });
      clock = pausePartySessionClock(clock, now);
      stopReason = "preload-runway-paused";
      break;
    }

    if (decision.kind === "preload") {
      const requestedId = decision.trackId;
      targetId = requestedId;
      targetLoad = ++nextLoad;
      const operation = ++nextOperation;
      append({ type: "preload-started", activeSecond: 0, operation, generation: operation, deck: targetDeck, trackOrdinal: ordinals.get(targetId)!, loadOrdinal: targetLoad, selectionSource: decision.selectionSource });
      if (syntheticNeverSettlingIds.delete(requestedId)) {
        preloadLease = Object.freeze({
          operation,
          generation: operation,
          deck: targetDeck,
          trackId: requestedId,
          loadOrdinal: targetLoad,
          sourceTrackId: sourceId,
          sourceLoadKey: `${ordinals.get(sourceId)}:${sourceLoad}`,
          startedAtSeconds: now,
          deadlineSeconds: decision.preloadDeadlineSeconds
        });
        continue;
      }
      if (syntheticUnplayableIds.delete(requestedId)) {
        append({ type: "preload-settled", activeSecond: 0, operation, outcome: "unplayable" });
        unavailableTrackIds.add(requestedId);
        consecutivePreloadTimeouts = 0;
        targetId = null;
        targetLoad = null;
        continue;
      }
      append({ type: "preload-settled", activeSecond: 0, operation, outcome: "committed" });
      consecutivePreloadTimeouts = 0;
      queue = queue.filter((id) => id !== targetId);
      append({ type: "queue-committed", activeSecond: 0, revision: ++queueRevision, trackOrdinals: queue.map((id) => ordinals.get(id)!) });
      continue;
    }
    if (decision.kind === "wait-cue") {
      const remaining = Math.max(0, (source.durationSeconds - sourcePosition) / sourcePlaybackRate);
      const templateRemaining = decision.plan.template === "phrase-blend" ? 30 : decision.plan.template === "downbeat-cut" ? 20 : decision.plan.template === "filtered-fade" ? 6 : 3.75;
      const templateLead = decision.plan.template === "phrase-blend" ? 8 : decision.plan.template === "downbeat-cut" ? 6 : decision.plan.template === "filtered-fade" ? 0.5 : Number.POSITIVE_INFINITY;
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
      armAttempts += 1;
      append({ type: "arm-started", activeSecond: 0, operation, origin: "autopilot" });
      const minimumArmLeadSeconds = decision.plan.template === "downbeat-cut" ? 0.12 : 0.08;
      const deadline = deriveAutoPilotArmDeadline({
        nowSeconds: now,
        scheduledStartSeconds: decision.plan.schedule.startTime,
        minimumArmLeadSeconds
      });
      const sourceLoadKey = `${ordinals.get(sourceId)}:${sourceLoad}`;
      const targetLoadKey = `${ordinals.get(targetId)}:${targetLoad}`;
      const armLease = deadline == null ? null : createAutoPilotArmLease({
        operation,
        generation: operation,
        transitionKey: `${sourceLoadKey}->${targetLoadKey}`,
        sourceDeck,
        targetDeck,
        sourceTrackId: sourceId,
        targetTrackId: targetId,
        sourceLoadKey,
        targetLoadKey,
        startedAtSeconds: now,
        deadlineSeconds: deadline
      });
      const requestedArmOutcome = options.armOutcomes?.[armAttempts - 1] ?? "scheduled";
      const settlementDelay = requestedArmOutcome === "timed-out" && deadline != null
        ? Math.max(0, deadline - now)
        : Math.max(0, options.armSettlementDelaysSeconds?.[armAttempts - 1] ?? 0);
      if (settlementDelay) advance(settlementDelay);
      const leaseState = armLease ? inspectAutoPilotArmLease({
        current: armLease,
        expected: armLease,
        nowSeconds: now,
        pair: {
          sourceDeck,
          targetDeck,
          sourceTrackId: sourceId,
          targetTrackId: targetId,
          sourceLoadKey,
          targetLoadKey: syntheticSupersededArmAttempts.delete(armAttempts) ? `${targetLoadKey}:replacement` : targetLoadKey
        }
      }) : "expired";
      if (leaseState === "superseded") {
        append({ type: "arm-settled", activeSecond: 0, operation, outcome: "cancelled", pauseRequired: false });
        continue;
      }
      const armOutcome = leaseState === "expired" ? "timed-out" : requestedArmOutcome;
      if (armOutcome !== "scheduled") {
        consecutiveArmFailures += 1;
        const sourceRemainingSeconds = Math.max(0, (source.durationSeconds - sourcePosition) / sourcePlaybackRate);
        const pauseRequired = decideAutoPilotArmFailure({ consecutiveFailures: consecutiveArmFailures, sourceRemainingSeconds }) === "pause";
        append({ type: "arm-settled", activeSecond: 0, operation, outcome: armOutcome, pauseRequired });
        if (pauseRequired) {
          append({ type: "session-paused", activeSecond: 0, reason: "transition-arm" });
          clock = pausePartySessionClock(clock, now);
          stopReason = "transition-arm-paused";
          break;
        }
        continue;
      }
      consecutiveArmFailures = 0;
      const transition = ++nextTransition;
      append({ type: "arm-settled", activeSecond: 0, operation, outcome: "scheduled", pauseRequired: false });
      append({ type: "transition-scheduled", activeSecond: 0, transition, sourceTrackOrdinal: ordinals.get(sourceId)!, sourceLoadOrdinal: sourceLoad, targetTrackOrdinal: ordinals.get(targetId)!, targetLoadOrdinal: targetLoad, ownership: "autopilot", template: decision.plan.template as keyof typeof transitionTemplates });
      transitionTemplates[decision.plan.template as keyof typeof transitionTemplates] += 1;
      activeTransitionKey = decision.transitionKey;
      const completionStartTime = decision.plan.schedule.startTime;
      const transitionDuration = decision.plan.schedule.durationSeconds;
      const completionLease = createAutoPilotTransitionCompletionLease({
        operation,
        generation: operation,
        scheduleId: transition,
        transitionKey: `${sourceLoadKey}->${targetLoadKey}`,
        sourceDeck,
        targetDeck,
        sourceTrackId: sourceId,
        targetTrackId: targetId,
        sourceLoadKey,
        targetLoadKey,
        registeredAtSeconds: now,
        startTimeSeconds: completionStartTime,
        endTimeSeconds: completionStartTime + transitionDuration
      });
      const lead = Math.max(0, decision.plan.schedule.startTime - now);
      advance(lead);
      const rescue = rescueByAttempt.get(transition);
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
      const missingPrimary = syntheticMissingPrimaryCompletionAttempts.delete(transition);
      const completionDelay = missingPrimary
        ? 0.5
        : options.transitionCompletionDelaysSeconds?.[transition - 1] ?? 0;
      if (completionDelay) {
        const delayed = advance(completionDelay);
        if (delayed + 1e-9 < completionDelay) {
          stopReason = "observation-horizon";
          break;
        }
      }
      const completionState = inspectAutoPilotTransitionCompletion({
        current: completionLease,
        expected: completionLease,
        nowSeconds: now,
        engineSchedule: {
          id: transition,
          source: sourceDeck,
          target: targetDeck,
          startTime: completionStartTime,
          endTime: completionStartTime + transitionDuration
        },
        pair: {
          sourceDeck,
          targetDeck,
          sourceTrackId: sourceId,
          targetTrackId: targetId,
          sourceLoadKey,
          targetLoadKey: syntheticSupersededCompletionAttempts.delete(transition)
            ? `${targetLoadKey}:replacement`
            : targetLoadKey,
          targetPlaying: true
        },
        signal: missingPrimary ? "watchdog" : "primary",
        contextRunning: true,
        playbackLocked: false
      });
      if (completionState === "ownership-lost" || completionState === "superseded") {
        append({ type: "transition-completion-failed", activeSecond: 0, transition, reason: "ownership-lost", pauseRequired: true });
        append({ type: "session-paused", activeSecond: 0, reason: "transition-completion" });
        append({ type: "transition-cancelled", activeSecond: 0, transition, reason: "stop-all-sound", targetPreserved: false });
        clock = pausePartySessionClock(clock, now);
        activeTransitionKey = null;
        stopReason = "transition-completion-paused";
        break;
      }
      if (completionState === "waiting") {
        errors.push("transition completion settled before its owned audio-clock boundary");
        break;
      }
      const completionPauseRequired = completionState === "late-ready";
      append({
        type: "transition-completed",
        activeSecond: 0,
        transition,
        targetTrackOrdinal: ordinals.get(targetId)!,
        targetLoadOrdinal: targetLoad,
        settledBy: missingPrimary ? "watchdog" : "primary",
        completionOutcome: completionPauseRequired ? "late" : "on-time",
        pauseRequired: completionPauseRequired
      });
      sourceDeck = targetDeck;
      sourceId = targetId;
      sourceLoad = targetLoad;
      sourcePlaybackRate = decision.plan.targetPlaybackRate;
      sourcePosition = decision.plan.schedule.targetCueSeconds + (transitionDuration + completionDelay) * sourcePlaybackRate;
      playedTrackIds.push(sourceId);
      targetId = null;
      targetLoad = null;
      activeTransitionKey = null;
      if (completionPauseRequired) {
        append({ type: "session-paused", activeSecond: 0, reason: "transition-completion" });
        clock = pausePartySessionClock(clock, now);
        stopReason = "transition-completion-paused";
        break;
      }
      continue;
    }
    if (decision.kind === "declare-final") {
      append({ type: "final-declared", activeSecond: 0, deck: sourceDeck, trackOrdinal: ordinals.get(sourceId)!, loadOrdinal: sourceLoad });
      const remaining = Math.max(0, (source.durationSeconds - sourcePosition) / sourcePlaybackRate);
      const completionSignal = options.finalDeckCompletionSignal ?? "source-onended";
      const expectedEndTimeSeconds = now + remaining;
      const completionLease = createDeckPlaybackCompletionLease({
        operation: 1,
        channel: sourceDeck,
        loadRevision: sourceLoad,
        transportRevision: sourceLoad,
        ratePlanRevision: sourceLoad,
        sourceId: sourceLoad,
        trackId: sourceId,
        intent: "natural",
        startTimeSeconds: now,
        startOffsetSeconds: sourcePosition,
        durationSeconds: source.durationSeconds,
        endPositionSeconds: source.durationSeconds,
        expectedEndTimeSeconds
      });
      const rendered = advance(remaining);
      if (rendered + 1e-9 < remaining) {
        stopReason = "observation-horizon";
        break;
      }
      if (completionSignal !== "source-onended") {
        const grace = completionLease.watchdogTimeSeconds - now;
        const graceRendered = advance(grace);
        if (graceRendered + 1e-9 < grace) {
          stopReason = "observation-horizon";
          break;
        }
      }
      const completionState = inspectDeckPlaybackCompletion({
        current: completionLease,
        expected: completionLease,
        nowSeconds: now,
        loadRevision: sourceLoad,
        transportRevision: sourceLoad,
        sourceId: sourceLoad,
        trackId: sourceId,
        sourcePresent: true,
        signal: completionSignal
      });
      if (completionState !== "ready") {
        errors.push(`final deck completion did not settle: ${completionState}`);
        break;
      }
      append({
        type: "deck-ended",
        activeSecond: 0,
        deck: sourceDeck,
        trackOrdinal: ordinals.get(sourceId)!,
        loadOrdinal: sourceLoad,
        settledBy: completionSignal,
        outcome: completionSignal === "source-onended" ? "on-time" : "recovered"
      });
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
    transitionAttempts: armAttempts,
    successfulHandoffs: evaluation.counters.transitionsCompleted,
    rescueEvents: Object.freeze(rescueEvents),
    transitionTemplates: Object.freeze(transitionTemplates),
    evaluation,
    errors: Object.freeze(errors)
  });
};
