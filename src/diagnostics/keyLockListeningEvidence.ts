import type { AudioHealthSnapshot } from "../audio/AudioEngine";

export type ListeningHealthBaseline = Pick<AudioHealthSnapshot,
  "renderedFrames" | "expectedActiveFrames" | "silentFrames" | "renderQuanta" |
  "nonFiniteSamples" | "clippedSamples" | "processorErrors" | "reports">;

export const evaluatePrivateListeningHealth = (
  baseline: ListeningHealthBaseline,
  current: AudioHealthSnapshot,
  expectedActiveSeconds: number,
  handoffOwnershipRequired: boolean,
  handoffCompletedOwned: boolean
) => {
  const delta = {
    renderedFrames: current.renderedFrames - baseline.renderedFrames,
    expectedActiveFrames: current.expectedActiveFrames - baseline.expectedActiveFrames,
    silentFrames: current.silentFrames - baseline.silentFrames,
    renderQuanta: current.renderQuanta - baseline.renderQuanta,
    nonFiniteSamples: current.nonFiniteSamples - baseline.nonFiniteSamples,
    clippedSamples: current.clippedSamples - baseline.clippedSamples,
    processorErrors: current.processorErrors - baseline.processorErrors,
    reports: current.reports - baseline.reports
  };
  const expectedFrames = expectedActiveSeconds * current.sampleRate;
  const frameSlack = current.sampleRate * 0.3;
  const countersValid = Object.values(delta).every((value) => Number.isSafeInteger(value) && value >= 0);
  const passed = Number.isFinite(expectedActiveSeconds) && expectedActiveSeconds >= 8 && countersValid &&
    delta.expectedActiveFrames >= expectedFrames - frameSlack &&
    delta.expectedActiveFrames <= expectedFrames + frameSlack &&
    delta.renderedFrames >= delta.expectedActiveFrames &&
    delta.renderedFrames <= delta.expectedActiveFrames + current.sampleRate * 1.5 &&
    delta.renderQuanta * 128 === delta.renderedFrames &&
    delta.reports >= Math.max(1, Math.floor(expectedActiveSeconds) - 1) &&
    delta.silentFrames <= current.sampleRate * 0.1 &&
    delta.nonFiniteSamples === 0 && delta.clippedSamples === 0 && delta.processorErrors === 0 &&
    current.peak > 0.001 && current.longestUnexpectedSilentSeconds <= 0.1 &&
    current.contextStates.at(-1) === "running" &&
    (!handoffOwnershipRequired || handoffCompletedOwned);
  return Object.freeze({ passed, delta: Object.freeze(delta) });
};
