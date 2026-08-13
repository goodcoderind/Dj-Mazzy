export const KEY_LOCK_CROSSFADE_REPORT_SCHEMA = "key-lock-crossfade-smoke/v4" as const;

export type KeyLockCrossfadeMode = "quick-20s" | "sustained-1m";

export type KeyLockCrossfadeHealthDelta = Readonly<{
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
}>;

export type KeyLockCrossfadeEvidence = Readonly<{
  mode: KeyLockCrossfadeMode;
  transitionCount: number;
  scheduledIds: readonly number[];
  completedIds: readonly number[];
  completionLatenessSeconds: readonly number[];
  expectedActiveSeconds: number;
  sampleRate: number;
  contextStates: readonly AudioContextState[];
  sourceBackendReady: boolean;
  targetBackendReady: boolean;
  activeCrossfadeRemaining: boolean;
  aborted: boolean;
  health: KeyLockCrossfadeHealthDelta;
}>;

const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const integerNonnegative = (value: number) => Number.isInteger(value) && value >= 0;

export const evaluateKeyLockCrossfadeEvidence = (evidence: KeyLockCrossfadeEvidence) => {
  const failures: string[] = [];
  const health = evidence.health;
  const countFields = [
    health.renderedFrames,
    health.expectedActiveFrames,
    health.silentFrames,
    health.renderQuanta,
    health.nonFiniteSamples,
    health.clippedSamples,
    health.processorErrors,
    health.reports
  ];
  if (!Number.isInteger(evidence.transitionCount) || evidence.transitionCount < 1 ||
    !Number.isFinite(evidence.sampleRate) || evidence.sampleRate <= 0 ||
    !Number.isFinite(evidence.expectedActiveSeconds) || evidence.expectedActiveSeconds <= 0 ||
    countFields.some((value) => !integerNonnegative(value)) ||
    !finiteNonnegative(health.peak) || !finiteNonnegative(health.longestUnexpectedSilentSeconds) ||
    evidence.completionLatenessSeconds.some((value) => !finiteNonnegative(value))) {
    failures.push("malformed-evidence");
  }
  const modeMinimums = evidence.mode === "quick-20s"
    ? { transitions: 12, activeSeconds: 19 }
    : evidence.mode === "sustained-1m"
      ? { transitions: 37, activeSeconds: 60 }
      : null;
  if (!modeMinimums || evidence.transitionCount < modeMinimums.transitions ||
    evidence.expectedActiveSeconds < modeMinimums.activeSeconds) failures.push("mode-coverage");
  const expectedIds = Array.from({ length: evidence.transitionCount }, (_, index) => index + 1);
  if (evidence.scheduledIds.length !== evidence.transitionCount ||
    evidence.scheduledIds.some((id, index) => id !== expectedIds[index])) failures.push("schedule-ownership");
  if (evidence.completedIds.length !== evidence.transitionCount ||
    evidence.completedIds.some((id, index) => id !== evidence.scheduledIds[index])) failures.push("completion-ownership");
  if (evidence.completionLatenessSeconds.length !== evidence.transitionCount ||
    evidence.completionLatenessSeconds.some((seconds) => seconds > 1)) failures.push("completion-late");
  const minimumExpectedFrames = Math.floor(evidence.expectedActiveSeconds * evidence.sampleRate * 0.95);
  const promisedMinimumFrames = modeMinimums
    ? Math.floor(modeMinimums.activeSeconds * evidence.sampleRate) - 128
    : Number.POSITIVE_INFINITY;
  const maximumExpectedFrames = Math.ceil((evidence.expectedActiveSeconds + 0.25) * evidence.sampleRate);
  const maximumRenderedFrames = Math.ceil((evidence.expectedActiveSeconds + 1.5) * evidence.sampleRate);
  if (health.expectedActiveFrames < Math.max(minimumExpectedFrames, promisedMinimumFrames) ||
    health.expectedActiveFrames > maximumExpectedFrames ||
    health.renderedFrames < health.expectedActiveFrames || health.renderedFrames > maximumRenderedFrames ||
    health.reports < Math.max(1, Math.floor(evidence.expectedActiveSeconds) - 1) ||
    health.reports > Math.ceil(evidence.expectedActiveSeconds) + 2) failures.push("health-coverage");
  if (health.expectedActiveFrames > health.renderedFrames || health.silentFrames > health.expectedActiveFrames ||
    health.renderQuanta * 128 !== health.renderedFrames) failures.push("health-inconsistent");
  if (health.processorErrors !== 0 || health.nonFiniteSamples !== 0 || health.clippedSamples !== 0 ||
    health.peak <= 0.001 || health.longestUnexpectedSilentSeconds > 0.1) failures.push("render-health");
  const firstRunning = evidence.contextStates.indexOf("running");
  if (firstRunning < 0 || evidence.contextStates.slice(firstRunning).some((state) => state !== "running")) {
    failures.push("context-interrupted");
  }
  if (!evidence.sourceBackendReady || !evidence.targetBackendReady || evidence.activeCrossfadeRemaining) {
    failures.push("runtime-state");
  }
  if (evidence.aborted) failures.push("aborted");
  return Object.freeze({ passed: failures.length === 0, failures: Object.freeze(failures) });
};
