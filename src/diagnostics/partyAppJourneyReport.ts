import type { AudioHealthSnapshot } from "../audio/AudioEngine";

export const PARTY_APP_JOURNEY_REPORT_VERSION = "party-app-journey-report/v1" as const;

export type PartyAppJourneyFailure =
  | "import-count"
  | "hydration-count"
  | "stored-count"
  | "first-start-count"
  | "target-start-count"
  | "transition-count"
  | "transition-owner-count"
  | "transition-template"
  | "transition-completion"
  | "terminal-trace"
  | "queue-not-empty"
  | "autopilot-still-active"
  | "checkpoint-not-cleared"
  | "deck-still-active"
  | "crossfade-still-active"
  | "recovery-visible"
  | "focus-flow"
  | "stop-unavailable"
  | "context-interrupted"
  | "audio-health-unavailable"
  | "audio-health-incomplete"
  | "audio-health-error"
  | "output-silent"
  | "unexpected-silence"
  | "non-finite-output"
  | "clipped-output"
  | "external-network"
  | "uncaught-error"
  | "page-hidden"
  | "timed-out"
  | "aborted";

export type PartyAppJourneyReportInput = Readonly<{
  buildContract: "mazzy-app-basic/v1";
  runnerContract: "party-app-browser-runner/v1";
  fixtureContract: "generated-stereo-wav/v1";
  scenario: "three-track-safe-fade";
  importedTracks: number;
  hydratedTracks: number;
  storedTracksAfter: number;
  immediateDeckStarts: number;
  scheduledTargetStarts: number;
  scheduledTransitions: number;
  uniqueTransitionOwners: number;
  completedTransitions: number;
  cancelledTransitions: number;
  transitionOwnershipFailures: number;
  nativeTransitionSourceCompletions: number;
  nativeTransitionDispatches: number;
  recoveredTransitionDispatches: number;
  crossfadeSentinelDispatches: number;
  safeFadeTransitions: number;
  nonSafeFadeTransitions: number;
  maximumCompletionLatenessSeconds: number;
  maximumCompletionEarlinessSeconds: number;
  terminalTracePassed: boolean;
  queueTracksAfter: number;
  autoPilotActiveAfter: boolean;
  checkpointStatusAfter: "cleared" | "claimed" | "available" | "invalidated" | "missing" | "malformed";
  activeDecksAfter: number;
  activeCrossfadeAfter: boolean;
  recoveryUiVisibleAfter: boolean;
  importFocusRestored: boolean;
  firstSongPlayFocused: boolean;
  readinessFocused: boolean;
  stopControlReadyAfter: boolean;
  contextInterruptions: number;
  health: AudioHealthSnapshot | null;
  externalRequests: number;
  uncaughtErrors: number;
  unhandledRejections: number;
  pageStayedVisible: boolean;
  timedOut: boolean;
  aborted: boolean;
}>;

const INPUT_KEYS = [
  "buildContract", "runnerContract", "fixtureContract", "scenario", "importedTracks",
  "hydratedTracks", "storedTracksAfter", "immediateDeckStarts", "scheduledTargetStarts",
  "scheduledTransitions", "uniqueTransitionOwners", "completedTransitions",
  "cancelledTransitions", "transitionOwnershipFailures", "nativeTransitionSourceCompletions",
  "nativeTransitionDispatches", "recoveredTransitionDispatches", "crossfadeSentinelDispatches",
  "safeFadeTransitions", "nonSafeFadeTransitions", "maximumCompletionLatenessSeconds",
  "maximumCompletionEarlinessSeconds", "terminalTracePassed",
  "queueTracksAfter", "autoPilotActiveAfter", "checkpointStatusAfter", "activeDecksAfter",
  "activeCrossfadeAfter", "recoveryUiVisibleAfter", "importFocusRestored",
  "firstSongPlayFocused", "readinessFocused", "stopControlReadyAfter", "contextInterruptions",
  "health", "externalRequests", "uncaughtErrors", "unhandledRejections", "pageStayedVisible",
  "timedOut", "aborted"
] as const;

const HEALTH_KEYS = [
  "schemaVersion", "supported", "expectedOutputActive", "sampleRate", "renderedFrames",
  "expectedActiveFrames", "silentFrames", "renderQuanta", "nonFiniteSamples", "clippedSamples",
  "processorErrors", "peak", "longestUnexpectedSilentSeconds", "reports", "contextStates"
] as const;

const exactKeys = (value: object, expected: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
};
const MAX_JOURNEY_COUNTER = 1_000_000;
const MAX_JOURNEY_SECONDS = 120;
const MAX_HEALTH_FRAMES = 48_000 * MAX_JOURNEY_SECONDS;
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) &&
  Number(value) >= 0 && Number(value) <= MAX_JOURNEY_COUNTER;
const healthCount = (value: unknown): value is number => Number.isSafeInteger(value) &&
  Number(value) >= 0 && Number(value) <= MAX_HEALTH_FRAMES;
const finiteNonnegative = (value: unknown): value is number => Number.isFinite(value) && Number(value) >= 0;
const boolean = (value: unknown): value is boolean => typeof value === "boolean";
const allowedCheckpoint = new Set(["cleared", "claimed", "available", "invalidated", "missing", "malformed"]);
const allowedContextState = new Set(["suspended", "running", "closed", "interrupted"]);

const validateHealth = (health: AudioHealthSnapshot | null) => {
  if (health === null) return;
  if (!health || typeof health !== "object" || !exactKeys(health, HEALTH_KEYS) ||
    health.schemaVersion !== "audio-health/v2" || !boolean(health.supported) ||
    !boolean(health.expectedOutputActive) || !finiteNonnegative(health.sampleRate) ||
    health.sampleRate !== 48_000 ||
    ![health.renderedFrames, health.expectedActiveFrames, health.silentFrames, health.renderQuanta,
      health.nonFiniteSamples, health.clippedSamples, health.processorErrors, health.reports].every(healthCount) ||
    health.renderedFrames > MAX_HEALTH_FRAMES || health.expectedActiveFrames > MAX_HEALTH_FRAMES ||
    health.silentFrames > MAX_HEALTH_FRAMES || health.renderQuanta > MAX_HEALTH_FRAMES / 128 ||
    health.reports > 200 || !finiteNonnegative(health.peak) || health.peak > 2 ||
    !finiteNonnegative(health.longestUnexpectedSilentSeconds) ||
    health.longestUnexpectedSilentSeconds > MAX_JOURNEY_SECONDS ||
    !Array.isArray(health.contextStates) || !health.contextStates.length || health.contextStates.length > 16 ||
    !health.contextStates.every((state) => allowedContextState.has(state))) {
    throw new RangeError("full-App audio-health evidence is malformed");
  }
};

export const buildPartyAppJourneyReport = (
  input: PartyAppJourneyReportInput
) => {
  if (!input || typeof input !== "object" || !exactKeys(input, INPUT_KEYS) ||
    input.buildContract !== "mazzy-app-basic/v1" ||
    input.runnerContract !== "party-app-browser-runner/v1" ||
    input.fixtureContract !== "generated-stereo-wav/v1" ||
    input.scenario !== "three-track-safe-fade") {
    throw new RangeError("full-App journey evidence requires the exact allowlisted contract");
  }
  const counts = [input.importedTracks, input.hydratedTracks, input.storedTracksAfter,
    input.immediateDeckStarts, input.scheduledTargetStarts, input.scheduledTransitions,
    input.uniqueTransitionOwners, input.completedTransitions, input.cancelledTransitions,
    input.transitionOwnershipFailures, input.nativeTransitionSourceCompletions,
    input.nativeTransitionDispatches, input.recoveredTransitionDispatches,
    input.crossfadeSentinelDispatches,
    input.safeFadeTransitions, input.nonSafeFadeTransitions,
    input.queueTracksAfter, input.activeDecksAfter, input.contextInterruptions,
    input.externalRequests, input.uncaughtErrors, input.unhandledRejections];
  const booleans = [input.terminalTracePassed, input.autoPilotActiveAfter,
    input.activeCrossfadeAfter, input.recoveryUiVisibleAfter, input.importFocusRestored,
    input.firstSongPlayFocused, input.readinessFocused, input.stopControlReadyAfter,
    input.pageStayedVisible, input.timedOut, input.aborted];
  if (!counts.every(safeCount) || !booleans.every(boolean) ||
    !finiteNonnegative(input.maximumCompletionLatenessSeconds) ||
    input.maximumCompletionLatenessSeconds > MAX_JOURNEY_SECONDS ||
    !finiteNonnegative(input.maximumCompletionEarlinessSeconds) ||
    input.maximumCompletionEarlinessSeconds > MAX_JOURNEY_SECONDS ||
    !allowedCheckpoint.has(input.checkpointStatusAfter)) {
    throw new RangeError("full-App journey evidence must use safe counters, booleans, and enums");
  }
  validateHealth(input.health);

  const failures: PartyAppJourneyFailure[] = [];
  if (input.importedTracks !== 3) failures.push("import-count");
  if (input.hydratedTracks !== 3) failures.push("hydration-count");
  if (input.storedTracksAfter !== 3) failures.push("stored-count");
  if (input.immediateDeckStarts !== 1) failures.push("first-start-count");
  if (input.scheduledTargetStarts !== 2) failures.push("target-start-count");
  if (input.scheduledTransitions !== 2 || input.completedTransitions !== 2 ||
    input.cancelledTransitions !== 0) failures.push("transition-count");
  if (input.uniqueTransitionOwners !== 2) failures.push("transition-owner-count");
  if (input.nativeTransitionSourceCompletions !== 2 || input.nativeTransitionDispatches !== 2 ||
    input.recoveredTransitionDispatches !== 0 || input.crossfadeSentinelDispatches !== 0) {
    failures.push("transition-completion");
  }
  if (input.safeFadeTransitions !== 2 || input.nonSafeFadeTransitions !== 0) {
    failures.push("transition-template");
  }
  if (input.transitionOwnershipFailures !== 0 || input.maximumCompletionLatenessSeconds > 0.1 ||
    input.maximumCompletionEarlinessSeconds > 0.01) {
    failures.push("transition-completion");
  }
  if (!input.terminalTracePassed) failures.push("terminal-trace");
  if (input.queueTracksAfter !== 0) failures.push("queue-not-empty");
  if (input.autoPilotActiveAfter) failures.push("autopilot-still-active");
  if (input.checkpointStatusAfter !== "cleared") failures.push("checkpoint-not-cleared");
  if (input.activeDecksAfter !== 0) failures.push("deck-still-active");
  if (input.activeCrossfadeAfter) failures.push("crossfade-still-active");
  if (input.recoveryUiVisibleAfter) failures.push("recovery-visible");
  if (!input.importFocusRestored || !input.firstSongPlayFocused || !input.readinessFocused) {
    failures.push("focus-flow");
  }
  if (!input.stopControlReadyAfter) failures.push("stop-unavailable");
  const firstRunningState = input.health?.contextStates.indexOf("running") ?? -1;
  const contextWasContinuous = firstRunningState >= 0 &&
    input.health!.contextStates.slice(firstRunningState).every((state) => state === "running");
  if (input.contextInterruptions !== 0 || !contextWasContinuous) failures.push("context-interrupted");

  const health = input.health;
  if (!health?.supported) failures.push("audio-health-unavailable");
  const healthCountersConsistent = Boolean(health &&
    health.renderedFrames === health.renderQuanta * 128 &&
    health.expectedActiveFrames <= health.renderedFrames &&
    health.silentFrames <= health.expectedActiveFrames &&
    health.expectedActiveFrames >= health.sampleRate * 18 &&
    health.reports >= 1 && !health.expectedOutputActive);
  if (!healthCountersConsistent) failures.push("audio-health-incomplete");
  if (!health || health.processorErrors > 0) failures.push("audio-health-error");
  if (!health || health.peak <= 0.001 || health.silentFrames >= health.expectedActiveFrames) {
    failures.push("output-silent");
  }
  if (!health || health.longestUnexpectedSilentSeconds > 0.1) failures.push("unexpected-silence");
  if (!health || health.nonFiniteSamples > 0 || !Number.isFinite(health.peak)) {
    failures.push("non-finite-output");
  }
  if (!health || health.clippedSamples > 0 || health.peak >= 1) failures.push("clipped-output");
  if (input.externalRequests > 0) failures.push("external-network");
  if (input.uncaughtErrors > 0 || input.unhandledRejections > 0) failures.push("uncaught-error");
  if (!input.pageStayedVisible) failures.push("page-hidden");
  if (input.timedOut) failures.push("timed-out");
  if (input.aborted) failures.push("aborted");

  return Object.freeze({
    schemaVersion: PARTY_APP_JOURNEY_REPORT_VERSION,
    runnerContract: input.runnerContract,
    buildContract: input.buildContract,
    fixtureContract: input.fixtureContract,
    scenario: input.scenario,
    counts: Object.freeze({
      importedTracks: input.importedTracks,
      hydratedTracks: input.hydratedTracks,
      storedTracksAfter: input.storedTracksAfter,
      immediateDeckStarts: input.immediateDeckStarts,
      scheduledTargetStarts: input.scheduledTargetStarts,
      scheduledTransitions: input.scheduledTransitions,
      completedTransitions: input.completedTransitions,
      nativeTransitionSourceCompletions: input.nativeTransitionSourceCompletions,
      nativeTransitionDispatches: input.nativeTransitionDispatches,
      recoveredTransitionDispatches: input.recoveredTransitionDispatches,
      crossfadeSentinelDispatches: input.crossfadeSentinelDispatches,
      safeFadeTransitions: input.safeFadeTransitions
    }),
    completion: Object.freeze({
      uniqueTransitionOwners: input.uniqueTransitionOwners,
      cancelledTransitions: input.cancelledTransitions,
      ownershipFailures: input.transitionOwnershipFailures,
      maximumLatenessMs: Math.round(input.maximumCompletionLatenessSeconds * 1_000),
      maximumEarlinessMs: Math.round(input.maximumCompletionEarlinessSeconds * 1_000)
    }),
    terminal: Object.freeze({
      tracePassed: input.terminalTracePassed,
      queueTracks: input.queueTracksAfter,
      autoPilotActive: input.autoPilotActiveAfter,
      checkpointStatus: input.checkpointStatusAfter,
      activeDecks: input.activeDecksAfter,
      activeCrossfade: input.activeCrossfadeAfter,
      recoveryUiVisible: input.recoveryUiVisibleAfter,
      stopControlReady: input.stopControlReadyAfter
    }),
    focus: Object.freeze({
      importRestored: input.importFocusRestored,
      firstSongPlay: input.firstSongPlayFocused,
      readiness: input.readinessFocused
    }),
    audioHealth: health ? Object.freeze({
      supported: health.supported,
      renderedFrames: health.renderedFrames,
      expectedActiveFrames: health.expectedActiveFrames,
      silentFrames: health.silentFrames,
      renderQuanta: health.renderQuanta,
      nonFiniteSamples: health.nonFiniteSamples,
      clippedSamples: health.clippedSamples,
      processorErrors: health.processorErrors,
      peak: Math.round(health.peak * 1_000_000) / 1_000_000,
      longestUnexpectedSilentMs: Math.round(health.longestUnexpectedSilentSeconds * 1_000),
      reports: health.reports
    }) : null,
    browser: Object.freeze({
      contextInterruptions: input.contextInterruptions,
      externalRequests: input.externalRequests,
      uncaughtErrors: input.uncaughtErrors,
      unhandledRejections: input.unhandledRejections,
      pageStayedVisible: input.pageStayedVisible
    }),
    failureCodes: Object.freeze(failures),
    passed: failures.length === 0,
    evidenceScope: "Generated-WAV full React App import, hydration, local decode, Autopilot state/audio composition, and terminal cleanup; not music quality, codec breadth, physical speakers, process death, or endurance.",
    privacy: "Fixed enums, booleans, capped counters, and bounded 48 kHz audio-health aggregates only; no audio, names, paths, IDs, hashes, timestamps, raw error text, user agent, or device identifiers."
  });
};
