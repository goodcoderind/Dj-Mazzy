import type { AudioHealthSnapshot } from "../audio/AudioEngine";
import type { PartyCommittedTargetAudioResult } from "../audio/partyCommittedTargetContinuationAudio";
import type { PartyDeckCompletionDecision, PartyDeckCompletionEvent } from "../planning/partyDeckCompletionIngestion";
import type { PartyCommittedTargetContinuationDecision } from "../planning/partyCommittedTargetContinuation";

export const PARTY_CONTINUATION_BROWSER_REPORT_VERSION =
  "party-continuation-browser-report/v1" as const;

export type PartyContinuationBrowserFailure =
  | "native-completion-count"
  | "session-ingestion"
  | "committed-target-decision"
  | "audio-transaction"
  | "target-start-count"
  | "target-offset"
  | "gain-ramp"
  | "scheduled-gap"
  | "source-still-active"
  | "target-not-active"
  | "target-owner-missing"
  | "target-gain"
  | "context-not-running"
  | "audio-health-unsupported"
  | "audio-health-error"
  | "output-silent"
  | "unexpected-silence"
  | "non-finite-output"
  | "clipped-output"
  | "uncaught-error"
  | "aborted";

export type PartyContinuationBrowserReportInput = Readonly<{
  completion: PartyDeckCompletionEvent | null;
  completionCount: number;
  ingestion: PartyDeckCompletionDecision | null;
  continuation: PartyCommittedTargetContinuationDecision | null;
  audioTransaction: PartyCommittedTargetAudioResult | null;
  targetStartCount: number;
  targetOffsetSeconds: number | null;
  gainRampDurationSeconds: number | null;
  scheduledAudioClockGapSeconds: number | null;
  sourceActiveAfter: boolean;
  targetActiveAfter: boolean;
  targetPlaybackBackend: "native" | "signalsmith" | null;
  targetStatusAfter: string | null;
  targetIdentityMatchedAfter: boolean;
  targetCompletionOwnerInstalled: boolean;
  targetGainAfter: number | null;
  contextStateAtStart: AudioContextState;
  contextStateAtEnd: AudioContextState;
  health: AudioHealthSnapshot | null;
  uncaughtErrors: number;
  unhandledRejections: number;
  aborted: boolean;
}>;

export type PartyContinuationBrowserReport = Readonly<{
  schemaVersion: typeof PARTY_CONTINUATION_BROWSER_REPORT_VERSION;
  runnerVersion: "party-continuation-browser-runner/v1";
  evidenceScope: "synthetic-browser-state-and-audio-ownership";
  privacy: "aggregate-enums-and-metrics-only-no-media-or-track-metadata";
  passed: boolean;
  failureCodes: readonly PartyContinuationBrowserFailure[];
  completion: Readonly<{
    settledBy: PartyDeckCompletionEvent["settledBy"] | null;
    outcome: PartyDeckCompletionEvent["outcome"] | null;
    count: number;
  }>;
  decisions: Readonly<{
    ingestion: PartyDeckCompletionDecision["kind"] | null;
    continuation: PartyCommittedTargetContinuationDecision["kind"] | null;
    audioTransaction: PartyCommittedTargetAudioResult["status"] | null;
  }>;
  targetStartCount: number;
  targetOffsetSeconds: number | null;
  gainRampDurationSeconds: number | null;
  scheduledAudioClockGapSeconds: number | null;
  sourceActiveAfter: boolean;
  targetActiveAfter: boolean;
  targetCompletionOwnerInstalled: boolean;
  targetGainAfter: number | null;
  health: Readonly<{
    supported: boolean;
    sampleRate: number;
    renderedFrames: number;
    expectedActiveFrames: number;
    silentFrames: number;
    renderQuanta: number;
    nonFiniteSamples: number;
    clippedSamples: number;
    processorErrors: number;
    peak: number;
    longestUnexpectedSilentSeconds: number;
    reports: number;
  }> | null;
  targetOwner: Readonly<{
    backend: "native" | "signalsmith" | null;
    status: "ready" | "scheduled" | "playing" | "paused" | "ended" | "recoverable-error" | null;
    identityMatched: boolean;
    completionAuthorityOwned: boolean;
  }>;
}>;

const nonnegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const finiteOrNull = (value: unknown): value is number | null =>
  value === null || Number.isFinite(value);

const allowlisted = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  typeof value === "string" && values.includes(value as T) ? value as T : null;

export const buildPartyContinuationBrowserReport = (
  input: PartyContinuationBrowserReportInput
): PartyContinuationBrowserReport => {
  if (!nonnegativeSafeInteger(input.completionCount) ||
    !nonnegativeSafeInteger(input.targetStartCount) ||
    !nonnegativeSafeInteger(input.uncaughtErrors) ||
    !nonnegativeSafeInteger(input.unhandledRejections) ||
    !finiteOrNull(input.targetOffsetSeconds) ||
    !finiteOrNull(input.gainRampDurationSeconds) || !finiteOrNull(input.scheduledAudioClockGapSeconds) ||
    !finiteOrNull(input.targetGainAfter)) {
    throw new RangeError("browser continuation evidence must use finite metrics and safe counters");
  }
  const failures: PartyContinuationBrowserFailure[] = [];
  const completionSettledBy = allowlisted(input.completion?.settledBy,
    ["source-onended", "audio-clock", "reconcile"] as const);
  const completionOutcome = allowlisted(input.completion?.outcome,
    ["on-time", "recovered", "late", "premature"] as const);
  const ingestionKind = allowlisted(input.ingestion?.kind,
    ["ignore-stale", "finish-final", "pause-premature", "pause-unexpected-source", "lock-transition", "pause-conflict"] as const);
  const continuationKind = allowlisted(input.continuation?.kind,
    ["start-committed-target", "pause-source-stopped"] as const);
  const audioTransactionStatus = allowlisted(input.audioTransaction?.status, ["scheduled", "failed"] as const);
  const targetBackend = allowlisted(input.targetPlaybackBackend, ["native", "signalsmith"] as const);
  const targetStatus = allowlisted(input.targetStatusAfter,
    ["ready", "scheduled", "playing", "paused", "ended", "recoverable-error"] as const);
  if (input.completionCount !== 1 || completionSettledBy !== "source-onended" ||
    completionOutcome !== "on-time") failures.push("native-completion-count");
  if (input.ingestion?.version !== "party-deck-completion-ingestion/v1" ||
    input.ingestion.kind !== "pause-unexpected-source" ||
    input.ingestion.reason !== "non-final-source-ended") failures.push("session-ingestion");
  if (input.continuation?.version !== "party-committed-target-continuation/v1" ||
    input.continuation.kind !== "start-committed-target" ||
    input.continuation.reason !== "exact-committed-target") failures.push("committed-target-decision");
  if (input.audioTransaction?.version !== "party-committed-target-audio-transaction/v1" ||
    input.audioTransaction.status !== "scheduled" || input.audioTransaction.reason !== "scheduled" ||
    input.audioTransaction.cleanupConfirmed !== true ||
    !Number.isFinite(input.audioTransaction.scheduledStart) ||
    !Number.isFinite(input.audioTransaction.priorGain)) failures.push("audio-transaction");
  if (input.targetStartCount !== 1) failures.push("target-start-count");
  if (input.targetOffsetSeconds !== 0) failures.push("target-offset");
  if (input.gainRampDurationSeconds == null ||
    Math.abs(input.gainRampDurationSeconds - 0.08) > 1e-6) failures.push("gain-ramp");
  if (input.scheduledAudioClockGapSeconds == null || input.scheduledAudioClockGapSeconds < 0 ||
    input.scheduledAudioClockGapSeconds > 0.2) {
    failures.push("scheduled-gap");
  }
  if (input.sourceActiveAfter) failures.push("source-still-active");
  if (!input.targetActiveAfter) failures.push("target-not-active");
  if (!input.targetCompletionOwnerInstalled || targetBackend !== "native" ||
    !["scheduled", "playing"].includes(targetStatus ?? "") ||
    !input.targetIdentityMatchedAfter) failures.push("target-owner-missing");
  if (input.targetGainAfter == null || input.targetGainAfter < 0.99 || input.targetGainAfter > 1) {
    failures.push("target-gain");
  }
  if (input.contextStateAtStart !== "running" || input.contextStateAtEnd !== "running") {
    failures.push("context-not-running");
  }
  const health = input.health;
  if (!health?.supported) failures.push("audio-health-unsupported");
  const firstRunningState = health?.contextStates.indexOf("running") ?? -1;
  const contextInterrupted = firstRunningState < 0 ||
    health!.contextStates.slice(firstRunningState).some((state) => state !== "running");
  const validHealthCounters = Boolean(health && [health.renderedFrames, health.expectedActiveFrames,
    health.silentFrames, health.renderQuanta, health.nonFiniteSamples, health.clippedSamples,
    health.processorErrors, health.reports].every(nonnegativeSafeInteger) &&
    Number.isFinite(health.sampleRate) && health.sampleRate >= 8_000 &&
    health.sampleRate <= 192_000 && health.renderedFrames >= Math.floor(health.sampleRate * 0.9) &&
    health.expectedActiveFrames >= Math.floor(health.sampleRate * 0.9) &&
    health.expectedActiveFrames <= health.renderedFrames && health.silentFrames <= health.expectedActiveFrames &&
    health.renderQuanta > 0 && health.renderedFrames === health.renderQuanta * 128);
  if (!health || health.expectedOutputActive || health.processorErrors > 0 || health.reports < 1 ||
    !validHealthCounters || contextInterrupted) {
    failures.push("audio-health-error");
  }
  if (!health || health.nonFiniteSamples > 0 || !Number.isFinite(health.peak)) {
    failures.push("non-finite-output");
  }
  if (!health || health.clippedSamples > 0 || health.peak >= 1) failures.push("clipped-output");
  if (!health || health.peak <= 0.001 || health.silentFrames >= health.expectedActiveFrames) {
    failures.push("output-silent");
  }
  if (!health || health.longestUnexpectedSilentSeconds > 0.1) failures.push("unexpected-silence");
  if (input.uncaughtErrors > 0 || input.unhandledRejections > 0) failures.push("uncaught-error");
  if (input.aborted) failures.push("aborted");

  return Object.freeze({
    schemaVersion: PARTY_CONTINUATION_BROWSER_REPORT_VERSION,
    runnerVersion: "party-continuation-browser-runner/v1",
    evidenceScope: "synthetic-browser-state-and-audio-ownership",
    privacy: "aggregate-enums-and-metrics-only-no-media-or-track-metadata",
    passed: failures.length === 0,
    failureCodes: Object.freeze(failures),
    completion: Object.freeze({
      settledBy: completionSettledBy,
      outcome: completionOutcome,
      count: input.completionCount
    }),
    decisions: Object.freeze({
      ingestion: ingestionKind,
      continuation: continuationKind,
      audioTransaction: audioTransactionStatus
    }),
    targetStartCount: input.targetStartCount,
    targetOffsetSeconds: input.targetOffsetSeconds,
    gainRampDurationSeconds: input.gainRampDurationSeconds,
    scheduledAudioClockGapSeconds: input.scheduledAudioClockGapSeconds,
    sourceActiveAfter: input.sourceActiveAfter,
    targetActiveAfter: input.targetActiveAfter,
    targetCompletionOwnerInstalled: input.targetCompletionOwnerInstalled,
    targetGainAfter: input.targetGainAfter,
    health: health ? Object.freeze({
      supported: health.supported,
      sampleRate: health.sampleRate,
      renderedFrames: health.renderedFrames,
      expectedActiveFrames: health.expectedActiveFrames,
      silentFrames: health.silentFrames,
      renderQuanta: health.renderQuanta,
      nonFiniteSamples: health.nonFiniteSamples,
      clippedSamples: health.clippedSamples,
      processorErrors: health.processorErrors,
      peak: health.peak,
      longestUnexpectedSilentSeconds: health.longestUnexpectedSilentSeconds,
      reports: health.reports
    }) : null,
    targetOwner: Object.freeze({
      backend: targetBackend,
      status: targetStatus,
      identityMatched: input.targetIdentityMatchedAfter,
      completionAuthorityOwned: input.targetCompletionOwnerInstalled
    })
  });
};
