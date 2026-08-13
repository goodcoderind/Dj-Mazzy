import type { AudioHealthSnapshot } from "../audio/AudioEngine";

export const DEVICE_SOAK_REPORT_VERSION = "device-soak-report/v4" as const;

export type DeviceSoakMode = "smoke-1m" | "smoke-15m" | "acceptance-2h" | "endurance-4h";

export type DeviceSoakInput = Readonly<{
  buildContract: string;
  runnerContract: "mazzy-device-soak-runner/v3";
  mode: DeviceSoakMode;
  requestedDurationSeconds: number;
  wallElapsedSeconds: number;
  audioElapsedSeconds: number;
  scheduledTransitions: number;
  completedTransitions: number;
  cancelledTransitions: number;
  transitionOwnershipFailures: number;
  maximumCompletionLatenessSeconds: number;
  uncaughtErrors: number;
  unhandledRejections: number;
  health: AudioHealthSnapshot;
  pageStayedVisible: boolean;
  aborted: boolean;
}>;

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;
const nonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
const modeDurations: Record<DeviceSoakMode, number> = {
  "smoke-1m": 60,
  "smoke-15m": 900,
  "acceptance-2h": 7_200,
  "endurance-4h": 14_400
};
const contextStates = new Set(["suspended", "running", "closed", "interrupted"]);

export const buildDeviceSoakReport = (input: DeviceSoakInput) => {
  if (input.buildContract !== "mazzy-audio-engine/v2" || input.runnerContract !== "mazzy-device-soak-runner/v3") {
    throw new RangeError("Device soak evidence requires an allowlisted build contract");
  }
  if (![input.requestedDurationSeconds, input.wallElapsedSeconds, input.audioElapsedSeconds,
    input.scheduledTransitions, input.completedTransitions, input.cancelledTransitions,
    input.transitionOwnershipFailures,
    input.maximumCompletionLatenessSeconds, input.uncaughtErrors, input.unhandledRejections]
    .every(finiteNonNegative) || input.requestedDurationSeconds <= 0) {
    throw new RangeError("Device soak evidence must be finite and non-negative");
  }
  if (input.requestedDurationSeconds !== modeDurations[input.mode]) {
    throw new RangeError("Device soak mode must use its canonical wall-clock duration");
  }
  if (![input.scheduledTransitions, input.completedTransitions, input.cancelledTransitions,
    input.transitionOwnershipFailures,
    input.uncaughtErrors, input.unhandledRejections].every(nonNegativeInteger)) {
    throw new RangeError("Device soak counters must be non-negative integers");
  }
  const healthNumbers = [input.health.sampleRate, input.health.renderedFrames, input.health.expectedActiveFrames,
    input.health.silentFrames, input.health.renderQuanta, input.health.nonFiniteSamples,
    input.health.clippedSamples, input.health.processorErrors, input.health.peak,
    input.health.longestUnexpectedSilentSeconds, input.health.reports];
  if (typeof input.pageStayedVisible !== "boolean" || typeof input.aborted !== "boolean" ||
    typeof input.health.supported !== "boolean" || typeof input.health.expectedOutputActive !== "boolean" ||
    input.health.schemaVersion !== "audio-health/v2" ||
    !healthNumbers.every(finiteNonNegative) || input.health.sampleRate <= 0 ||
    ![input.health.renderedFrames, input.health.expectedActiveFrames, input.health.silentFrames,
      input.health.renderQuanta, input.health.nonFiniteSamples, input.health.clippedSamples,
      input.health.processorErrors, input.health.reports].every(nonNegativeInteger) ||
    !Array.isArray(input.health.contextStates) || !input.health.contextStates.length ||
    !input.health.contextStates.every((state) => contextStates.has(state))) {
    throw new RangeError("Device soak audio-health evidence is malformed");
  }
  const failureCodes: string[] = [];
  const warningCodes: string[] = [];
  if (input.wallElapsedSeconds + 0.1 < input.requestedDurationSeconds) failureCodes.push("wall-duration-short");
  if (input.audioElapsedSeconds + 0.1 < input.requestedDurationSeconds) failureCodes.push("audio-duration-short");
  // Web Audio runs from the output device's sample clock, not performance.now().
  // Permit at most 500 ppm of bounded clock-rate drift on long runs while
  // retaining the one-second floor that covers timer/quantum boundaries on
  // short diagnostics. Context-state and render-coverage checks independently
  // fail actual suspension or missing output.
  const wallAudioClockDivergenceSeconds = Math.abs(input.wallElapsedSeconds - input.audioElapsedSeconds);
  const maximumClockDivergenceSeconds = Math.max(1, input.requestedDurationSeconds * 0.0005);
  if (wallAudioClockDivergenceSeconds > maximumClockDivergenceSeconds) {
    failureCodes.push("wall-audio-clock-diverged");
  }
  if (input.uncaughtErrors) failureCodes.push("uncaught-error");
  if (input.unhandledRejections) failureCodes.push("unhandled-rejection");
  if (input.aborted) failureCodes.push("run-aborted");
  if (input.scheduledTransitions !== input.completedTransitions + input.cancelledTransitions) {
    failureCodes.push("orphan-transition");
  }
  if (input.transitionOwnershipFailures) failureCodes.push("transition-ownership-lost");
  if (!input.health.supported) failureCodes.push("audio-health-unavailable");
  if (input.health.processorErrors) failureCodes.push("audio-health-processor-error");
  if (input.health.nonFiniteSamples) failureCodes.push("non-finite-audio");
  if (input.health.clippedSamples || input.health.peak > 1) failureCodes.push("post-limiter-clipping");
  if (input.health.longestUnexpectedSilentSeconds > 0.1) failureCodes.push("unexpected-audio-gap");
  const expectedFrames = input.audioElapsedSeconds * input.health.sampleRate;
  const coverageSlackFrames = input.health.sampleRate * 0.25;
  const flushAllowanceFrames = input.health.sampleRate * 1.5;
  if (input.health.renderedFrames + coverageSlackFrames < expectedFrames ||
    input.health.renderedFrames > expectedFrames + flushAllowanceFrames ||
    input.health.expectedActiveFrames + coverageSlackFrames < expectedFrames ||
    input.health.expectedActiveFrames > expectedFrames + coverageSlackFrames) {
    failureCodes.push("audio-health-coverage-incomplete");
  }
  if (input.health.expectedActiveFrames > input.health.renderedFrames ||
    input.health.silentFrames > input.health.expectedActiveFrames ||
    input.health.renderQuanta * 128 !== input.health.renderedFrames) {
    failureCodes.push("audio-health-counters-inconsistent");
  }
  const firstRunningIndex = input.health.contextStates.indexOf("running");
  if (firstRunningIndex < 0 || input.health.contextStates.includes("interrupted") ||
    input.health.contextStates.includes("closed") ||
    input.health.contextStates.slice(firstRunningIndex + 1).some((state) => state === "suspended")) {
    failureCodes.push("audio-context-interrupted");
  }
  if (input.scheduledTransitions < Math.floor(input.requestedDurationSeconds / 10)) {
    failureCodes.push("too-few-transitions");
  }
  if (input.completedTransitions < Math.floor(input.requestedDurationSeconds / 10)) {
    failureCodes.push("too-few-completed-transitions");
  }
  if (input.maximumCompletionLatenessSeconds > 0.5) failureCodes.push("completion-late");
  else if (input.maximumCompletionLatenessSeconds > 0.1) warningCodes.push("completion-latency-elevated");
  if (!input.pageStayedVisible) failureCodes.push("page-not-always-visible");

  return Object.freeze({
    schemaVersion: DEVICE_SOAK_REPORT_VERSION,
    buildContract: input.buildContract,
    runnerContract: input.runnerContract,
    mode: input.mode,
    requestedDurationSeconds: Math.round(input.requestedDurationSeconds),
    wallElapsedSeconds: Math.round(input.wallElapsedSeconds * 10) / 10,
    audioElapsedSeconds: Math.round(input.audioElapsedSeconds * 10) / 10,
    wallAudioClockDivergenceMs: Math.round(wallAudioClockDivergenceSeconds * 1_000),
    maximumClockDivergenceMs: Math.round(maximumClockDivergenceSeconds * 1_000),
    scheduledTransitions: input.scheduledTransitions,
    completedTransitions: input.completedTransitions,
    cancelledTransitions: input.cancelledTransitions,
    transitionOwnershipFailures: input.transitionOwnershipFailures,
    maximumCompletionLatenessMs: Math.round(input.maximumCompletionLatenessSeconds * 1_000),
    audioHealth: Object.freeze({
      supported: input.health.supported,
      sampleRate: input.health.sampleRate,
      renderedFrames: input.health.renderedFrames,
      expectedActiveFrames: input.health.expectedActiveFrames,
      silentFrames: input.health.silentFrames,
      renderQuanta: input.health.renderQuanta,
      nonFiniteSamples: input.health.nonFiniteSamples,
      clippedSamples: input.health.clippedSamples,
      processorErrors: input.health.processorErrors,
      peak: Math.round(input.health.peak * 1_000_000) / 1_000_000,
      longestUnexpectedSilentMs: Math.round(input.health.longestUnexpectedSilentSeconds * 1_000),
      reports: input.health.reports,
      contextStates: Object.freeze([...input.health.contextStates])
    }),
    failureCodes: Object.freeze(failureCodes),
    warningCodes: Object.freeze(warningCodes),
    passed: failureCodes.length === 0,
    releaseGatePassed: input.mode === "acceptance-2h" && failureCodes.length === 0,
    evidenceScope: "Synthetic post-limiter Web Audio render-path continuity; not speaker, output-device, decoder, analysis, or full Party Autopilot proof.",
    privacy: "No audio, filenames, paths, track identifiers, exact timestamps, or device identifiers are included."
  });
};
