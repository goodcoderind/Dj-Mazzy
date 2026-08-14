export const PARTY_AUTOPILOT_TRACE_SCHEMA_VERSION = "party-autopilot-trace/v10" as const;
export const PARTY_AUTOPILOT_EVALUATION_SCHEMA_VERSION = "party-autopilot-evaluation/v10" as const;

export type PartyDeck = "a" | "b";
export type PartyTrackOrdinal = number;
export type PartyLoadOrdinal = number;

type EventBase = Readonly<{
  sequence: number;
  activeSecond: number;
}>;

export type PartyAutopilotEvent = EventBase & (
  | Readonly<{ type: "session-started" | "session-resumed" }>
  | Readonly<{ type: "session-paused"; reason: "host-control" | "host-request" | "stop-all-sound" | "rescue" | "source-stopped" | "preload-timeout" | "preload-runway" | "transition-arm" | "transition-completion" | "coordinator-failure" | "deck-completion" }>
  | Readonly<{ type: "queue-committed"; revision: number; trackOrdinals: readonly PartyTrackOrdinal[] }>
  | Readonly<{ type: "track-played"; trackOrdinal: PartyTrackOrdinal; loadOrdinal: PartyLoadOrdinal; cause: "host" | "transition" | "rescue" }>
  | Readonly<{ type: "preload-started"; operation: number; generation: number; deck: PartyDeck; trackOrdinal: PartyTrackOrdinal; loadOrdinal: PartyLoadOrdinal; selectionSource: "queue" | "library" }>
  | Readonly<{ type: "preload-settled"; operation: number; outcome: "committed" | "failed" | "unplayable" | "timed-out" | "superseded" | "discarded" }>
  | Readonly<{ type: "track-playability-restored"; trackOrdinal: PartyTrackOrdinal }>
  | Readonly<{ type: "arm-started"; operation: number; origin: "autopilot" | "host" }>
  | Readonly<{ type: "arm-settled"; operation: number; outcome: "scheduled" | "cancelled" | "failed" | "timed-out"; pauseRequired: boolean }>
  | Readonly<{ type: "transition-scheduled"; transition: number; sourceTrackOrdinal: PartyTrackOrdinal; sourceLoadOrdinal: PartyLoadOrdinal; targetTrackOrdinal: PartyTrackOrdinal; targetLoadOrdinal: PartyLoadOrdinal; ownership: "autopilot" | "host"; template: "safe-fade" | "filtered-fade" | "downbeat-cut" | "phrase-blend" }>
  | Readonly<{ type: "transition-completed"; transition: number; targetTrackOrdinal: PartyTrackOrdinal; targetLoadOrdinal: PartyLoadOrdinal; settledBy: "primary" | "watchdog"; completionOutcome: "on-time" | "late" | "cleanup-degraded" | "late-cleanup-degraded"; pauseRequired: boolean }>
  | Readonly<{ type: "transition-completion-failed"; transition: number; reason: "ownership-lost"; pauseRequired: true }>
  | Readonly<{ type: "transition-rescued"; transition: number; kept: "source" | "target" }>
  | Readonly<{ type: "transition-cancelled"; transition: number; reason: "stop-all-sound"; targetPreserved: boolean }>
  | Readonly<{ type: "coordinator-failed"; operation: number; phase: "decision" | "preload" | "arm" | "transition-watchdog"; pauseRequired: true }>
  | Readonly<{ type: "final-declared"; deck: PartyDeck; trackOrdinal: PartyTrackOrdinal; loadOrdinal: PartyLoadOrdinal }>
  | Readonly<{ type: "final-revoked" }>
  | Readonly<{ type: "deck-ended"; deck: PartyDeck; trackOrdinal: PartyTrackOrdinal; loadOrdinal: PartyLoadOrdinal; settledBy: "source-onended" | "audio-clock" | "reconcile"; outcome: "on-time" | "recovered" | "late" }>
  | Readonly<{ type: "deck-completion-failed"; deck: PartyDeck; trackOrdinal: PartyTrackOrdinal; loadOrdinal: PartyLoadOrdinal; settledBy: "source-onended"; reason: "premature"; pauseRequired: true }>
  | Readonly<{ type: "session-ended"; reason: "final-track-ended" | "host-ended" }>
);

export type PartyAutopilotTrace = Readonly<{
  schemaVersion: typeof PARTY_AUTOPILOT_TRACE_SCHEMA_VERSION;
  recorderContract: "bounded-tab-memory/v1";
  privacy: "session-local ordinals only; no song metadata, wall time, audio, or upload";
  evidenceScope: "Autopilot state invariants only; not audio continuity, musical quality, or speaker output";
  overflow: boolean;
  interrupted: boolean;
  events: readonly PartyAutopilotEvent[];
}>;

export type PartyAutopilotFailureCode =
  | "malformed-event"
  | "trace-overflow"
  | "trace-interrupted"
  | "sequence-gap"
  | "active-time-regressed"
  | "empty-trace"
  | "invalid-session-lifecycle"
  | "queue-revision-regressed"
  | "overlapping-preload"
  | "preload-owner-mismatch"
  | "preload-not-settled-before-pause"
  | "unplayable-track-retried"
  | "timed-out-track-retried"
  | "preload-timeout-not-paused"
  | "unexpected-preload-timeout-pause"
  | "arm-failure-not-paused"
  | "unexpected-arm-failure-pause"
  | "overlapping-arm"
  | "arm-owner-mismatch"
  | "overlapping-transition"
  | "transition-owner-mismatch"
  | "transition-source-mismatch"
  | "transition-completion-not-paused"
  | "transition-completion-unresolved"
  | "coordinator-failure-not-paused"
  | "deck-completion-not-paused"
  | "deck-completion-owner-mismatch"
  | "duplicate-deck-completion"
  | "rescue-not-paused"
  | "stop-all-sound-not-paused"
  | "uncommitted-autopilot-target"
  | "queue-evidence-missing"
  | "queued-target-not-consumed"
  | "track-repeated"
  | "final-owner-mismatch"
  | "session-ended-with-open-operation"
  | "session-ended-without-final";

export type PartyAutopilotEvaluation = Readonly<{
  schemaVersion: typeof PARTY_AUTOPILOT_EVALUATION_SCHEMA_VERSION;
  status: "valid-in-progress" | "valid-terminal" | "invalid";
  failureCodes: readonly PartyAutopilotFailureCode[];
  counters: Readonly<{
    playedTracks: number;
    preloadsCommitted: number;
    preloadsTimedOut: number;
    armFailures: number;
    armTimeouts: number;
    transitionsCompleted: number;
    transitionsRescued: number;
    transitionsCancelled: number;
    transitionCompletionRecoveries: number;
    lateTransitionCompletions: number;
    transitionCompletionFailures: number;
    transitionCompletionCleanupFailures: number;
    coordinatorFailures: number;
    deckCompletionRecoveries: number;
    lateDeckCompletions: number;
    deckCompletionFailures: number;
    pauses: number;
  }>;
}>;

type WithoutSequence<Event> = Event extends unknown ? Omit<Event, "sequence"> : never;
export type PartyAutopilotEventInput = WithoutSequence<PartyAutopilotEvent>;

export type PartyAutopilotTraceRecorder = Readonly<{
  append: (event: PartyAutopilotEventInput) => boolean;
  markInterrupted: () => void;
  snapshot: () => PartyAutopilotTrace;
}>;

const projectEvent = (event: PartyAutopilotEventInput, sequence: number): PartyAutopilotEvent | null => {
  if (!event || typeof event !== "object" || !Number.isInteger(event.activeSecond) || event.activeSecond < 0) return null;
  const base = { sequence, activeSecond: event.activeSecond };
  switch (event.type) {
    case "session-started":
    case "session-resumed":
    case "final-revoked":
      return Object.freeze({ ...base, type: event.type });
    case "session-paused":
      if (!["host-control", "host-request", "stop-all-sound", "rescue", "source-stopped", "preload-timeout", "preload-runway", "transition-arm", "transition-completion", "coordinator-failure", "deck-completion"].includes(event.reason)) return null;
      return Object.freeze({ ...base, type: event.type, reason: event.reason });
    case "queue-committed":
      if (!isPositiveInteger(event.revision) || !Array.isArray(event.trackOrdinals) ||
        !event.trackOrdinals.every(isPositiveInteger)) return null;
      return Object.freeze({ ...base, type: event.type, revision: event.revision, trackOrdinals: Object.freeze([...event.trackOrdinals]) });
    case "track-played":
      if (!isPositiveInteger(event.trackOrdinal) || !isPositiveInteger(event.loadOrdinal) ||
        !["host", "transition", "rescue"].includes(event.cause)) return null;
      return Object.freeze({ ...base, type: event.type, trackOrdinal: event.trackOrdinal, loadOrdinal: event.loadOrdinal, cause: event.cause });
    case "preload-started":
      if (!isPositiveInteger(event.operation) || !isPositiveInteger(event.generation) ||
        !["a", "b"].includes(event.deck) || !isPositiveInteger(event.trackOrdinal) ||
        !isPositiveInteger(event.loadOrdinal) || !["queue", "library"].includes(event.selectionSource)) return null;
      return Object.freeze({ ...base, type: event.type, operation: event.operation, generation: event.generation, deck: event.deck, trackOrdinal: event.trackOrdinal, loadOrdinal: event.loadOrdinal, selectionSource: event.selectionSource });
    case "preload-settled":
      if (!isPositiveInteger(event.operation) || !["committed", "failed", "unplayable", "timed-out", "superseded", "discarded"].includes(event.outcome)) return null;
      return Object.freeze({ ...base, type: event.type, operation: event.operation, outcome: event.outcome });
    case "track-playability-restored":
      if (!isPositiveInteger(event.trackOrdinal)) return null;
      return Object.freeze({ ...base, type: event.type, trackOrdinal: event.trackOrdinal });
    case "arm-started":
      if (!isPositiveInteger(event.operation) || !["autopilot", "host"].includes(event.origin)) return null;
      return Object.freeze({ ...base, type: event.type, operation: event.operation, origin: event.origin });
    case "arm-settled":
      if (!isPositiveInteger(event.operation) || !["scheduled", "cancelled", "failed", "timed-out"].includes(event.outcome) ||
        typeof event.pauseRequired !== "boolean" ||
        (["scheduled", "cancelled"].includes(event.outcome) && event.pauseRequired)) return null;
      return Object.freeze({ ...base, type: event.type, operation: event.operation, outcome: event.outcome, pauseRequired: event.pauseRequired });
    case "transition-scheduled":
      if (!isPositiveInteger(event.transition) || !isPositiveInteger(event.sourceTrackOrdinal) ||
        !isPositiveInteger(event.sourceLoadOrdinal) || !isPositiveInteger(event.targetTrackOrdinal) ||
        !isPositiveInteger(event.targetLoadOrdinal) || !["autopilot", "host"].includes(event.ownership) ||
        !["safe-fade", "filtered-fade", "downbeat-cut", "phrase-blend"].includes(event.template)) return null;
      return Object.freeze({ ...base, type: event.type, transition: event.transition, sourceTrackOrdinal: event.sourceTrackOrdinal, sourceLoadOrdinal: event.sourceLoadOrdinal, targetTrackOrdinal: event.targetTrackOrdinal, targetLoadOrdinal: event.targetLoadOrdinal, ownership: event.ownership, template: event.template });
    case "transition-completed":
      if (!isPositiveInteger(event.transition) || !isPositiveInteger(event.targetTrackOrdinal) ||
        !isPositiveInteger(event.targetLoadOrdinal) || !["primary", "watchdog"].includes(event.settledBy) ||
        !["on-time", "late", "cleanup-degraded", "late-cleanup-degraded"].includes(event.completionOutcome) ||
        typeof event.pauseRequired !== "boolean" ||
        event.pauseRequired !== (event.completionOutcome !== "on-time")) return null;
      return Object.freeze({ ...base, type: event.type, transition: event.transition, targetTrackOrdinal: event.targetTrackOrdinal, targetLoadOrdinal: event.targetLoadOrdinal, settledBy: event.settledBy, completionOutcome: event.completionOutcome, pauseRequired: event.pauseRequired });
    case "transition-completion-failed":
      if (!isPositiveInteger(event.transition) || event.reason !== "ownership-lost" || event.pauseRequired !== true) return null;
      return Object.freeze({ ...base, type: event.type, transition: event.transition, reason: event.reason, pauseRequired: true });
    case "transition-rescued":
      if (!isPositiveInteger(event.transition) || !["source", "target"].includes(event.kept)) return null;
      return Object.freeze({ ...base, type: event.type, transition: event.transition, kept: event.kept });
    case "transition-cancelled":
      if (!isPositiveInteger(event.transition) || event.reason !== "stop-all-sound" || typeof event.targetPreserved !== "boolean") return null;
      return Object.freeze({ ...base, type: event.type, transition: event.transition, reason: event.reason, targetPreserved: event.targetPreserved });
    case "coordinator-failed":
      if (!isPositiveInteger(event.operation) ||
        !["decision", "preload", "arm", "transition-watchdog"].includes(event.phase) ||
        event.pauseRequired !== true) return null;
      return Object.freeze({ ...base, type: event.type, operation: event.operation, phase: event.phase, pauseRequired: true });
    case "final-declared":
      if (!["a", "b"].includes(event.deck) || !isPositiveInteger(event.trackOrdinal) ||
        !isPositiveInteger(event.loadOrdinal)) return null;
      return Object.freeze({ ...base, type: event.type, deck: event.deck, trackOrdinal: event.trackOrdinal, loadOrdinal: event.loadOrdinal });
    case "deck-ended":
      if (!["a", "b"].includes(event.deck) || !isPositiveInteger(event.trackOrdinal) ||
        !isPositiveInteger(event.loadOrdinal) || !["source-onended", "audio-clock", "reconcile"].includes(event.settledBy) ||
        !["on-time", "recovered", "late"].includes(event.outcome) ||
        (event.settledBy === "source-onended") !== (["on-time", "late"].includes(event.outcome))) return null;
      return Object.freeze({ ...base, type: event.type, deck: event.deck, trackOrdinal: event.trackOrdinal, loadOrdinal: event.loadOrdinal, settledBy: event.settledBy, outcome: event.outcome });
    case "deck-completion-failed":
      if (!["a", "b"].includes(event.deck) || !isPositiveInteger(event.trackOrdinal) ||
        !isPositiveInteger(event.loadOrdinal) || event.settledBy !== "source-onended" ||
        event.reason !== "premature" || event.pauseRequired !== true) return null;
      return Object.freeze({ ...base, type: event.type, deck: event.deck, trackOrdinal: event.trackOrdinal, loadOrdinal: event.loadOrdinal, settledBy: "source-onended", reason: "premature", pauseRequired: true });
    case "session-ended":
      if (!["final-track-ended", "host-ended"].includes(event.reason)) return null;
      return Object.freeze({ ...base, type: event.type, reason: event.reason });
    default:
      return null;
  }
};

export const createPartyAutopilotTraceRecorder = (maximumEvents = 4_096): PartyAutopilotTraceRecorder => {
  if (!Number.isInteger(maximumEvents) || maximumEvents < 1) {
    throw new RangeError("maximumEvents must be a positive integer");
  }
  const events: PartyAutopilotEvent[] = [];
  let overflow = false;
  let interrupted = false;
  return Object.freeze({
    append: (event: PartyAutopilotEventInput) => {
      try {
        if (overflow || events.length >= maximumEvents) {
          overflow = true;
          return false;
        }
        const projected = projectEvent(event, events.length + 1);
        if (!projected) {
          interrupted = true;
          return false;
        }
        events.push(projected);
        return true;
      } catch {
        interrupted = true;
        return false;
      }
    },
    markInterrupted: () => { interrupted = true; },
    snapshot: () => Object.freeze({
      schemaVersion: PARTY_AUTOPILOT_TRACE_SCHEMA_VERSION,
      recorderContract: "bounded-tab-memory/v1",
      privacy: "session-local ordinals only; no song metadata, wall time, audio, or upload",
      evidenceScope: "Autopilot state invariants only; not audio continuity, musical quality, or speaker output",
      overflow,
      interrupted,
      events: Object.freeze([...events])
    })
  });
};

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;
const loadKey = (track: number, load: number) => `${track}:${load}`;

export const evaluatePartyAutopilotTrace = (trace: PartyAutopilotTrace): PartyAutopilotEvaluation => {
  const failures = new Set<PartyAutopilotFailureCode>();
  if (trace.schemaVersion !== PARTY_AUTOPILOT_TRACE_SCHEMA_VERSION || !Array.isArray(trace.events)) {
    failures.add("malformed-event");
  }
  if (trace.overflow) failures.add("trace-overflow");
  if (trace.interrupted) failures.add("trace-interrupted");

  let running = false;
  let started = false;
  let ended = false;
  let previousActiveSecond = -1;
  let queueRevision = -1;
  let queueEvidenceSeen = false;
  let queuedCommittedTarget: number | null = null;
  let activePreload: Extract<PartyAutopilotEvent, { type: "preload-started" }> | null = null;
  let committedPreload: Extract<PartyAutopilotEvent, { type: "preload-started" }> | null = null;
  let activeArm: Extract<PartyAutopilotEvent, { type: "arm-started" }> | null = null;
  let scheduledArmOrigin: "autopilot" | "host" | null = null;
  let activeTransition: Extract<PartyAutopilotEvent, { type: "transition-scheduled" }> | null = null;
  let finalOwner: Extract<PartyAutopilotEvent, { type: "final-declared" }> | null = null;
  let matchingFinalEndObserved = false;
  let rescuePauseRequired = false;
  let stopAllSoundPauseRequired = false;
  let transitionCompletionPauseRequired = false;
  let transitionCompletionRecoveryRequired = false;
  let coordinatorFailurePauseRequired = false;
  let deckCompletionPauseRequired = false;
  let finalSessionEndRequired = false;
  const playedLoads = new Set<string>();
  const completedDeckLoads = new Set<string>();
  const playedTracks = new Set<number>();
  const unplayableTracks = new Set<number>();
  const timedOutTracks = new Set<number>();
  let currentPlayedOwner: { trackOrdinal: number; loadOrdinal: number } | null = null;
  let preloadsCommitted = 0;
  let preloadsTimedOut = 0;
  let consecutivePreloadTimeouts = 0;
  let preloadTimeoutPauseRequired = false;
  let consecutiveArmFailures = 0;
  let armFailurePauseRequired = false;
  let armFailures = 0;
  let armTimeouts = 0;
  let transitionsCompleted = 0;
  let transitionsRescued = 0;
  let transitionsCancelled = 0;
  let transitionCompletionRecoveries = 0;
  let lateTransitionCompletions = 0;
  let transitionCompletionFailures = 0;
  let transitionCompletionCleanupFailures = 0;
  let coordinatorFailures = 0;
  let deckCompletionRecoveries = 0;
  let lateDeckCompletions = 0;
  let deckCompletionFailures = 0;
  let pauses = 0;

  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index];
    if (preloadTimeoutPauseRequired &&
      !(event?.type === "session-paused" && event.reason === "preload-timeout")) {
      failures.add("preload-timeout-not-paused");
      preloadTimeoutPauseRequired = false;
    }
    if (armFailurePauseRequired &&
      !(event?.type === "session-paused" && event.reason === "transition-arm")) {
      failures.add("arm-failure-not-paused");
      armFailurePauseRequired = false;
    }
    if (stopAllSoundPauseRequired &&
      !(event?.type === "session-paused" && event.reason === "stop-all-sound")) {
      failures.add("stop-all-sound-not-paused");
      stopAllSoundPauseRequired = false;
    }
    if (transitionCompletionPauseRequired &&
      !(event?.type === "session-paused" && event.reason === "transition-completion")) {
      failures.add("transition-completion-not-paused");
      transitionCompletionPauseRequired = false;
    }
    const coordinatorRecoveryPause = coordinatorFailurePauseRequired &&
      event?.type === "session-paused" && event.reason === "coordinator-failure";
    const deckRecoveryPause = deckCompletionPauseRequired &&
      event?.type === "session-paused" && event.reason === "deck-completion";
    if (transitionCompletionRecoveryRequired && !transitionCompletionPauseRequired &&
      !coordinatorRecoveryPause && !deckRecoveryPause &&
      event?.type !== "transition-rescued" && event?.type !== "transition-cancelled") {
      failures.add("transition-completion-unresolved");
      transitionCompletionRecoveryRequired = false;
    }
    if (coordinatorFailurePauseRequired &&
      !(event?.type === "session-paused" && event.reason === "coordinator-failure")) {
      failures.add("coordinator-failure-not-paused");
      coordinatorFailurePauseRequired = false;
    }
    if (deckCompletionPauseRequired &&
      !(event?.type === "session-paused" && event.reason === "deck-completion")) {
      failures.add("deck-completion-not-paused");
      deckCompletionPauseRequired = false;
    }
    if (finalSessionEndRequired &&
      !(event?.type === "session-ended" && event.reason === "final-track-ended")) {
      failures.add("session-ended-without-final");
      finalSessionEndRequired = false;
    }
    if (ended) failures.add("invalid-session-lifecycle");
    if (!event || event.sequence !== index + 1) failures.add("sequence-gap");
    if (!Number.isInteger(event?.activeSecond) || event.activeSecond < 0) failures.add("malformed-event");
    else if (event.activeSecond < previousActiveSecond) failures.add("active-time-regressed");
    else previousActiveSecond = event.activeSecond;
    if (!event || typeof event.type !== "string") {
      failures.add("malformed-event");
      continue;
    }

    switch (event.type) {
      case "session-started":
        if (started || ended) failures.add("invalid-session-lifecycle");
        started = true;
        running = true;
        break;
      case "session-resumed":
        if (!started || running || ended || transitionCompletionRecoveryRequired) failures.add("invalid-session-lifecycle");
        if (activePreload) failures.add("preload-not-settled-before-pause");
        running = true;
        consecutivePreloadTimeouts = 0;
        consecutiveArmFailures = 0;
        break;
      case "session-paused":
        if (!started || !running || ended) failures.add("invalid-session-lifecycle");
        if (activePreload) failures.add("preload-not-settled-before-pause");
        if (rescuePauseRequired && event.reason !== "rescue") failures.add("rescue-not-paused");
        rescuePauseRequired = false;
        if (event.reason === "stop-all-sound") {
          stopAllSoundPauseRequired = false;
        }
        if (event.reason === "preload-timeout") {
          if (consecutivePreloadTimeouts < 2) failures.add("unexpected-preload-timeout-pause");
          preloadTimeoutPauseRequired = false;
        }
        if (event.reason === "transition-arm") {
          if (!armFailurePauseRequired) failures.add("unexpected-arm-failure-pause");
          armFailurePauseRequired = false;
        }
        if (event.reason === "transition-completion") {
          if (!transitionCompletionPauseRequired) failures.add("transition-completion-not-paused");
          transitionCompletionPauseRequired = false;
        }
        if (event.reason === "coordinator-failure") {
          if (!coordinatorFailurePauseRequired) failures.add("coordinator-failure-not-paused");
          coordinatorFailurePauseRequired = false;
        }
        if (event.reason === "deck-completion") {
          if (!deckCompletionPauseRequired) failures.add("deck-completion-not-paused");
          deckCompletionPauseRequired = false;
        }
        running = false;
        pauses += 1;
        break;
      case "queue-committed":
        if (!started || ended) failures.add("invalid-session-lifecycle");
        if (!Number.isInteger(event.revision) || event.revision <= queueRevision ||
          !Array.isArray(event.trackOrdinals) || !event.trackOrdinals.every(isPositiveInteger)) {
          failures.add("queue-revision-regressed");
        }
        queueRevision = Math.max(queueRevision, event.revision);
        queueEvidenceSeen = true;
        if (queuedCommittedTarget != null && !event.trackOrdinals.includes(queuedCommittedTarget)) {
          queuedCommittedTarget = null;
        }
        break;
      case "track-played": {
        if (!started || ended) failures.add("invalid-session-lifecycle");
        if (!isPositiveInteger(event.trackOrdinal) || !isPositiveInteger(event.loadOrdinal)) {
          failures.add("malformed-event");
          break;
        }
        const key = loadKey(event.trackOrdinal, event.loadOrdinal);
        if (playedTracks.has(event.trackOrdinal) || playedLoads.has(key)) failures.add("track-repeated");
        playedTracks.add(event.trackOrdinal);
        playedLoads.add(key);
        currentPlayedOwner = { trackOrdinal: event.trackOrdinal, loadOrdinal: event.loadOrdinal };
        break;
      }
      case "preload-started":
        if (!started || !running || ended) failures.add("invalid-session-lifecycle");
        if (activePreload) failures.add("overlapping-preload");
        if (!isPositiveInteger(event.operation) || !isPositiveInteger(event.generation) ||
          !isPositiveInteger(event.trackOrdinal) || !isPositiveInteger(event.loadOrdinal) ||
          !["queue", "library"].includes(event.selectionSource)) {
          failures.add("malformed-event");
        }
        if (!queueEvidenceSeen) failures.add("queue-evidence-missing");
        if (unplayableTracks.has(event.trackOrdinal)) failures.add("unplayable-track-retried");
        if (timedOutTracks.has(event.trackOrdinal)) failures.add("timed-out-track-retried");
        activePreload = event;
        break;
      case "preload-settled":
        if (!started || ended) failures.add("invalid-session-lifecycle");
        if (!activePreload || activePreload.operation !== event.operation) {
          failures.add("preload-owner-mismatch");
        } else {
          if (event.outcome === "committed") {
            committedPreload = activePreload;
            if (activePreload.selectionSource === "queue") queuedCommittedTarget = activePreload.trackOrdinal;
            preloadsCommitted += 1;
            consecutivePreloadTimeouts = 0;
          } else if (event.outcome === "unplayable") {
            unplayableTracks.add(activePreload.trackOrdinal);
            consecutivePreloadTimeouts = 0;
          } else if (event.outcome === "timed-out") {
            timedOutTracks.add(activePreload.trackOrdinal);
            preloadsTimedOut += 1;
            consecutivePreloadTimeouts += 1;
            if (consecutivePreloadTimeouts >= 2) preloadTimeoutPauseRequired = true;
          } else {
            consecutivePreloadTimeouts = 0;
          }
          activePreload = null;
        }
        break;
      case "track-playability-restored":
        if (!started || ended || !isPositiveInteger(event.trackOrdinal)) failures.add("invalid-session-lifecycle");
        else {
          unplayableTracks.delete(event.trackOrdinal);
          timedOutTracks.delete(event.trackOrdinal);
          consecutivePreloadTimeouts = 0;
        }
        break;
      case "arm-started":
        if (!started || !running || ended) failures.add("invalid-session-lifecycle");
        if (activeArm) failures.add("overlapping-arm");
        if (!isPositiveInteger(event.operation) || !["autopilot", "host"].includes(event.origin)) {
          failures.add("malformed-event");
        }
        activeArm = event;
        break;
      case "arm-settled":
        if (!started || ended) failures.add("invalid-session-lifecycle");
        if (!activeArm || activeArm.operation !== event.operation) failures.add("arm-owner-mismatch");
        else {
          if (activeArm.origin === "host" && event.pauseRequired) failures.add("unexpected-arm-failure-pause");
          scheduledArmOrigin = event.outcome === "scheduled" ? activeArm.origin : null;
          if (activeArm.origin === "autopilot" && ["failed", "timed-out"].includes(event.outcome)) {
            consecutiveArmFailures += 1;
            armFailures += 1;
            if (event.outcome === "timed-out") armTimeouts += 1;
            if (event.pauseRequired) armFailurePauseRequired = true;
            if (consecutiveArmFailures >= 2 && !event.pauseRequired) failures.add("arm-failure-not-paused");
          } else if (event.outcome === "scheduled") {
            consecutiveArmFailures = 0;
          }
          activeArm = null;
        }
        break;
      case "transition-scheduled":
        if (!started || !running || ended) failures.add("invalid-session-lifecycle");
        if (activeTransition) failures.add("overlapping-transition");
        if (!scheduledArmOrigin) failures.add("arm-owner-mismatch");
        scheduledArmOrigin = null;
        if (!isPositiveInteger(event.transition) || !isPositiveInteger(event.sourceTrackOrdinal) ||
          !isPositiveInteger(event.sourceLoadOrdinal) || !isPositiveInteger(event.targetTrackOrdinal) ||
          !isPositiveInteger(event.targetLoadOrdinal) ||
          !["autopilot", "host"].includes(event.ownership) ||
          !["safe-fade", "filtered-fade", "downbeat-cut", "phrase-blend"].includes(event.template)) {
          failures.add("malformed-event");
        }
        if (playedTracks.has(event.targetTrackOrdinal)) failures.add("track-repeated");
        if (!currentPlayedOwner || currentPlayedOwner.trackOrdinal !== event.sourceTrackOrdinal ||
          currentPlayedOwner.loadOrdinal !== event.sourceLoadOrdinal) failures.add("transition-source-mismatch");
        if (event.ownership === "autopilot" &&
          (!committedPreload || committedPreload.trackOrdinal !== event.targetTrackOrdinal ||
            committedPreload.loadOrdinal !== event.targetLoadOrdinal)) {
          failures.add("uncommitted-autopilot-target");
        }
        if (event.ownership === "autopilot" && queuedCommittedTarget != null) {
          failures.add("queued-target-not-consumed");
        }
        activeTransition = event;
        break;
      case "transition-completed":
        if (!started || ended) failures.add("invalid-session-lifecycle");
        if (!isPositiveInteger(event.transition) || !isPositiveInteger(event.targetTrackOrdinal) ||
          !isPositiveInteger(event.targetLoadOrdinal) || !["primary", "watchdog"].includes(event.settledBy) ||
          !["on-time", "late", "cleanup-degraded", "late-cleanup-degraded"].includes(event.completionOutcome) ||
          typeof event.pauseRequired !== "boolean" ||
          event.pauseRequired !== (event.completionOutcome !== "on-time")) failures.add("malformed-event");
        if (!activeTransition || activeTransition.transition !== event.transition ||
          activeTransition.targetTrackOrdinal !== event.targetTrackOrdinal ||
          activeTransition.targetLoadOrdinal !== event.targetLoadOrdinal) {
          failures.add("transition-owner-mismatch");
        } else {
          if (playedTracks.has(event.targetTrackOrdinal)) failures.add("track-repeated");
          playedTracks.add(event.targetTrackOrdinal);
          playedLoads.add(loadKey(event.targetTrackOrdinal, event.targetLoadOrdinal));
          currentPlayedOwner = { trackOrdinal: event.targetTrackOrdinal, loadOrdinal: event.targetLoadOrdinal };
          activeTransition = null;
          committedPreload = null;
          transitionsCompleted += 1;
          if (event.settledBy === "watchdog") transitionCompletionRecoveries += 1;
          if (event.pauseRequired) {
            transitionCompletionPauseRequired = true;
            if (event.completionOutcome === "late" || event.completionOutcome === "late-cleanup-degraded") {
              lateTransitionCompletions += 1;
            }
            if (event.completionOutcome === "cleanup-degraded" || event.completionOutcome === "late-cleanup-degraded") {
              transitionCompletionCleanupFailures += 1;
            }
          }
        }
        break;
      case "transition-completion-failed":
        if (!started || ended || event.reason !== "ownership-lost" || event.pauseRequired !== true) {
          failures.add("malformed-event");
        }
        if (!activeTransition || activeTransition.transition !== event.transition) {
          failures.add("transition-owner-mismatch");
        } else {
          transitionCompletionPauseRequired = true;
          transitionCompletionRecoveryRequired = true;
          transitionCompletionFailures += 1;
        }
        break;
      case "transition-rescued":
        if (!started || ended || (!running && !transitionCompletionRecoveryRequired)) failures.add("invalid-session-lifecycle");
        if (!isPositiveInteger(event.transition) || !["source", "target"].includes(event.kept)) {
          failures.add("malformed-event");
        }
        if (!activeTransition || activeTransition.transition !== event.transition) {
          failures.add("transition-owner-mismatch");
        } else {
          if (event.kept === "target") {
            if (playedTracks.has(activeTransition.targetTrackOrdinal)) failures.add("track-repeated");
            playedTracks.add(activeTransition.targetTrackOrdinal);
            playedLoads.add(loadKey(activeTransition.targetTrackOrdinal, activeTransition.targetLoadOrdinal));
            currentPlayedOwner = {
              trackOrdinal: activeTransition.targetTrackOrdinal,
              loadOrdinal: activeTransition.targetLoadOrdinal
            };
          }
          activeTransition = null;
          committedPreload = null;
          transitionsRescued += 1;
          if (transitionCompletionRecoveryRequired) {
            transitionCompletionRecoveryRequired = false;
          } else {
            rescuePauseRequired = true;
          }
        }
        break;
      case "transition-cancelled":
        if (!started || ended || (!running && !transitionCompletionRecoveryRequired) || event.reason !== "stop-all-sound" || typeof event.targetPreserved !== "boolean") {
          failures.add("invalid-session-lifecycle");
        }
        if (!activeTransition || activeTransition.transition !== event.transition) {
          failures.add("transition-owner-mismatch");
        } else {
          // STOP ALL SOUND preserves the committed target only while its exact
          // track/load identity still owns the target deck.
          activeTransition = null;
          if (!event.targetPreserved) committedPreload = null;
          transitionsCancelled += 1;
          if (transitionCompletionRecoveryRequired) {
            transitionCompletionRecoveryRequired = false;
          } else {
            stopAllSoundPauseRequired = true;
          }
        }
        break;
      case "coordinator-failed":
        if (!started || !running || ended || !isPositiveInteger(event.operation) ||
          !["decision", "preload", "arm", "transition-watchdog"].includes(event.phase) ||
          event.pauseRequired !== true) {
          failures.add("malformed-event");
        } else {
          if (activePreload) failures.add("preload-owner-mismatch");
          if (activeArm || scheduledArmOrigin) failures.add("arm-owner-mismatch");
          if (activeTransition) transitionCompletionRecoveryRequired = true;
          coordinatorFailurePauseRequired = true;
          coordinatorFailures += 1;
        }
        break;
      case "final-declared":
        if (!started || !running || ended) failures.add("invalid-session-lifecycle");
        if (!["a", "b"].includes(event.deck) || !isPositiveInteger(event.trackOrdinal) ||
          !isPositiveInteger(event.loadOrdinal)) failures.add("malformed-event");
        if (!currentPlayedOwner || currentPlayedOwner.trackOrdinal !== event.trackOrdinal ||
          currentPlayedOwner.loadOrdinal !== event.loadOrdinal) failures.add("final-owner-mismatch");
        finalOwner = event;
        matchingFinalEndObserved = false;
        break;
      case "final-revoked":
        if (!started || ended) failures.add("invalid-session-lifecycle");
        finalOwner = null;
        matchingFinalEndObserved = false;
        break;
      case "deck-ended":
        if (!started || !running || ended) failures.add("invalid-session-lifecycle");
        if (!["a", "b"].includes(event.deck) || !isPositiveInteger(event.trackOrdinal) ||
          !isPositiveInteger(event.loadOrdinal) || !["source-onended", "audio-clock", "reconcile"].includes(event.settledBy) ||
          !["on-time", "recovered", "late"].includes(event.outcome) ||
          (event.settledBy === "source-onended") !== (["on-time", "late"].includes(event.outcome))) failures.add("malformed-event");
        if (completedDeckLoads.has(loadKey(event.trackOrdinal, event.loadOrdinal))) {
          failures.add("duplicate-deck-completion");
        } else {
          completedDeckLoads.add(loadKey(event.trackOrdinal, event.loadOrdinal));
        }
        if (event.settledBy !== "source-onended") deckCompletionRecoveries += 1;
        if (event.outcome === "late") lateDeckCompletions += 1;
        if (!currentPlayedOwner || currentPlayedOwner.trackOrdinal !== event.trackOrdinal ||
          currentPlayedOwner.loadOrdinal !== event.loadOrdinal) {
          failures.add("deck-completion-owner-mismatch");
        }
        if (finalOwner && (finalOwner.deck !== event.deck || finalOwner.trackOrdinal !== event.trackOrdinal ||
          finalOwner.loadOrdinal !== event.loadOrdinal)) failures.add("final-owner-mismatch");
        else if (finalOwner) {
          matchingFinalEndObserved = true;
          finalSessionEndRequired = true;
        }
        break;
      case "deck-completion-failed":
        if (!started || !running || ended || !["a", "b"].includes(event.deck) ||
          !isPositiveInteger(event.trackOrdinal) || !isPositiveInteger(event.loadOrdinal) ||
          event.settledBy !== "source-onended" || event.reason !== "premature" ||
          event.pauseRequired !== true) failures.add("malformed-event");
        if ((!currentPlayedOwner || currentPlayedOwner.trackOrdinal !== event.trackOrdinal ||
          currentPlayedOwner.loadOrdinal !== event.loadOrdinal) &&
          (!activeTransition || ![
            loadKey(activeTransition.sourceTrackOrdinal, activeTransition.sourceLoadOrdinal),
            loadKey(activeTransition.targetTrackOrdinal, activeTransition.targetLoadOrdinal)
          ].includes(loadKey(event.trackOrdinal, event.loadOrdinal)))) {
          failures.add("deck-completion-owner-mismatch");
        }
        if (activeTransition) transitionCompletionRecoveryRequired = true;
        deckCompletionPauseRequired = true;
        deckCompletionFailures += 1;
        break;
      case "session-ended":
        if (!["final-track-ended", "host-ended"].includes(event.reason)) failures.add("malformed-event");
        if (!started || ended) failures.add("invalid-session-lifecycle");
        if (event.reason === "final-track-ended" && (!finalOwner || !matchingFinalEndObserved)) {
          failures.add("session-ended-without-final");
        }
        if (activePreload || committedPreload || activeArm || scheduledArmOrigin || activeTransition) {
          failures.add("session-ended-with-open-operation");
        }
        ended = true;
        running = false;
        finalSessionEndRequired = false;
        break;
      default:
        failures.add("malformed-event");
    }
  }

  if (!trace.events.length) failures.add("empty-trace");
  if (!started && trace.events.length) failures.add("invalid-session-lifecycle");
  if (rescuePauseRequired) failures.add("rescue-not-paused");
  if (stopAllSoundPauseRequired) failures.add("stop-all-sound-not-paused");
  if (transitionCompletionPauseRequired) failures.add("transition-completion-not-paused");
  if (transitionCompletionRecoveryRequired) failures.add("transition-completion-unresolved");
  if (coordinatorFailurePauseRequired) failures.add("coordinator-failure-not-paused");
  if (deckCompletionPauseRequired) failures.add("deck-completion-not-paused");
  if (finalSessionEndRequired) failures.add("session-ended-without-final");
  if (preloadTimeoutPauseRequired) failures.add("preload-timeout-not-paused");
  if (armFailurePauseRequired) failures.add("arm-failure-not-paused");
  const status = failures.size
    ? "invalid"
    : ended
      ? "valid-terminal"
      : "valid-in-progress";
  return Object.freeze({
    schemaVersion: PARTY_AUTOPILOT_EVALUATION_SCHEMA_VERSION,
    status,
    failureCodes: Object.freeze([...failures]),
    counters: Object.freeze({
      playedTracks: playedTracks.size,
      preloadsCommitted,
      preloadsTimedOut,
      armFailures,
      armTimeouts,
      transitionsCompleted,
      transitionsRescued,
      transitionsCancelled,
      transitionCompletionRecoveries,
      lateTransitionCompletions,
      transitionCompletionFailures,
      transitionCompletionCleanupFailures,
      coordinatorFailures,
      deckCompletionRecoveries,
      lateDeckCompletions,
      deckCompletionFailures,
      pauses
    })
  });
};
