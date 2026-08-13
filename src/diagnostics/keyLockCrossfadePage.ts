import { AudioEngine } from "../audio/AudioEngine";
import { DeckEngine } from "../audio/DeckEngine";
import { createSignalsmithPreparedKeyLockSource } from "../audio/signalsmithPreparedKeyLockSource";
import { evaluateKeyLockCrossfadeEvidence, KEY_LOCK_CROSSFADE_REPORT_SCHEMA } from "./keyLockCrossfadeReport";

const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const statusNode = document.querySelector<HTMLElement>("#status")!;
const resultNode = document.querySelector<HTMLElement>("#result")!;
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
let runGeneration = 0;
let cancelActive: (() => Promise<void>) | null = null;

const createFixture = (context: AudioContext, carrier: number) => {
  const seconds = 45;
  const buffer = context.createBuffer(2, context.sampleRate * seconds, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    const frequency = carrier + channel * 110;
    for (let index = 0; index < data.length; index += 1) {
      data[index] = Math.sin(2 * Math.PI * frequency * index / context.sampleRate) * 0.025;
    }
  }
  return buffer;
};

runButton.addEventListener("click", async () => {
  const generation = ++runGeneration;
  runButton.disabled = true;
  stopButton.disabled = false;
  statusNode.setAttribute("aria-busy", "true");
  statusNode.textContent = "Running two simultaneous key-lock decks…";
  resultNode.textContent = "No report yet.";
  let context: AudioContext | null = null;
  let engine: AudioEngine | null = null;
  let source: DeckEngine | null = null;
  let target: DeckEngine | null = null;
  let activeScheduleId: number | null = null;
  let completionCancel: (() => void) | null = null;
  let completionWaitCancel: (() => void) | null = null;
  let aborted = false;
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = () => cleanupPromise ??= (async () => {
    completionWaitCancel?.();
    completionWaitCancel = null;
    completionCancel?.();
    completionCancel = null;
    if (engine && activeScheduleId !== null) engine.cancelCrossfade(activeScheduleId);
    activeScheduleId = null;
    engine?.setExpectedOutputActive(false);
    source?.eject();
    target?.eject();
    await Promise.all([source?.awaitKeyLockCleanupForDiagnostic(), target?.awaitKeyLockCleanupForDiagnostic()]);
    engine?.disposeAudioHealthMonitoring();
    await context?.close();
  })();
  cancelActive = async () => {
    if (generation !== runGeneration) return;
    aborted = true;
    runGeneration += 1;
    await cleanup();
  };
  try {
    context = new AudioContext({ sampleRate: 48_000 });
    await context.resume();
    engine = new AudioEngine(context);
    if (!await engine.enableAudioHealthMonitoring()) throw new Error("Audio health observer is unavailable");
    source = new DeckEngine(engine, "a", createSignalsmithPreparedKeyLockSource);
    target = new DeckEngine(engine, "b", createSignalsmithPreparedKeyLockSource);
    source.loadBuffer(createFixture(context, 330), "synthetic-source");
    target.loadBuffer(createFixture(context, 550), "synthetic-target");
    if (!(await Promise.all([source.prepareKeyLock(), target.prepareKeyLock()])).every(Boolean)) {
      throw new Error("Both key-lock processors were not prepared");
    }
    const sourceState = source.getKeyLockState();
    const targetState = target.getKeyLockState();
    if (sourceState.status !== "ready" || targetState.status !== "ready") throw new Error("Prepared state was lost");
    const latency = Math.max(sourceState.latencySeconds, targetState.latencySeconds);
    const playbackStart = context.currentTime + latency + 0.15;
    engine.setDeckGain("a", 1);
    engine.setDeckGain("b", 0);
    const started = await Promise.all([
      source.playPreparedKeyLockForDiagnostic(sourceState.loadKey, 2, 0.94, playbackStart),
      target.playPreparedKeyLockForDiagnostic(targetState.loadKey, 3, 1.06, playbackStart)
    ]);
    if (!started.every(Boolean)) throw new Error("Both prepared decks did not start");
    await wait(Math.max(0, playbackStart - context.currentTime + 0.05) * 1000);
    if (generation !== runGeneration) return;
    if (!await engine.resetAudioHealthMonitoringForDiagnostic()) throw new Error("Audio health interval could not start");
    const baseline = engine.getAudioHealthSnapshot();
    engine.setExpectedOutputActive(true);
    const transitionCount = 12;
    let completedTransitions = 0;
    const scheduledIds: number[] = [];
    const completedIds: number[] = [];
    const completionLatenessSeconds: number[] = [];
    const expectedActiveStart = context.currentTime;
    for (let index = 0; index < transitionCount; index += 1) {
      if (generation !== runGeneration) return;
      const sourceChannel = index % 2 === 0 ? "a" : "b";
      const targetChannel = sourceChannel === "a" ? "b" : "a";
      const schedule = engine.scheduleCrossfade(sourceChannel, targetChannel, context.currentTime + 0.15, 1.5);
      activeScheduleId = schedule.id;
      scheduledIds.push(schedule.id);
      const completionOwned = await new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          completionCancel?.();
          completionCancel = null;
          completionWaitCancel = null;
          reject(new Error("Crossfade completion timed out"));
        }, 4_000);
        completionWaitCancel = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          completionCancel?.();
          completionCancel = null;
          completionWaitCancel = null;
          resolve(false);
        };
        completionCancel = engine!.onCrossfadeComplete(schedule.id, () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          completionCancel = null;
          completionWaitCancel = null;
          completionLatenessSeconds.push(Math.max(0, context!.currentTime - schedule.endTime));
          const owned = engine!.finishCrossfade(schedule.id);
          if (owned) completedIds.push(schedule.id);
          activeScheduleId = null;
          resolve(owned);
        });
      });
      if (generation !== runGeneration) return;
      if (!completionOwned || engine.getActiveCrossfade() !== null) {
        throw new Error("Crossfade completion ownership was lost");
      }
      completedTransitions += 1;
    }
    await wait(250);
    if (generation !== runGeneration || context.state !== "running") return;
    const expectedActiveSeconds = context.currentTime - expectedActiveStart;
    engine.setExpectedOutputActive(false);
    await wait(1100);
    if (generation !== runGeneration || context.state !== "running") return;
    const totals = engine.getAudioHealthSnapshot();
    const health = {
      renderedFrames: totals.renderedFrames - baseline.renderedFrames,
      expectedActiveFrames: totals.expectedActiveFrames - baseline.expectedActiveFrames,
      silentFrames: totals.silentFrames - baseline.silentFrames,
      renderQuanta: totals.renderQuanta - baseline.renderQuanta,
      nonFiniteSamples: totals.nonFiniteSamples - baseline.nonFiniteSamples,
      clippedSamples: totals.clippedSamples - baseline.clippedSamples,
      processorErrors: totals.processorErrors - baseline.processorErrors,
      peak: totals.peak,
      longestUnexpectedSilentSeconds: totals.longestUnexpectedSilentSeconds,
      reports: totals.reports - baseline.reports
    };
    const evaluation = evaluateKeyLockCrossfadeEvidence({
      transitionCount,
      scheduledIds,
      completedIds,
      completionLatenessSeconds,
      expectedActiveSeconds,
      sampleRate: context.sampleRate,
      contextStates: totals.contextStates,
      sourceBackendReady: source.getActivePlaybackBackend() === "signalsmith",
      targetBackendReady: target.getActivePlaybackBackend() === "signalsmith",
      activeCrossfadeRemaining: engine.getActiveCrossfade() !== null,
      aborted,
      health
    });
    const report = {
      schemaVersion: KEY_LOCK_CROSSFADE_REPORT_SCHEMA,
      scope: "synthetic two-deck prepared playback, repeated equal-power crossfades, and post-limiter render health only",
      ...evaluation,
      transitionCount,
      completedTransitions,
      rates: { source: 0.94, target: 1.06 },
      schedule: { durationSeconds: 1.5 },
      health
    };
    if (generation !== runGeneration) return;
    resultNode.textContent = JSON.stringify(report, null, 2);
    statusNode.textContent = evaluation.passed
      ? "Two-deck render-path check passed. This is not production approval."
      : "Two-deck render-path check failed safely. Key lock remains unavailable.";
  } catch (error) {
    if (generation !== runGeneration) return;
    statusNode.textContent = "Two-deck render-path check failed safely. Key lock remains unavailable.";
    resultNode.textContent = `Check failed safely: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    if (generation === runGeneration) {
      cancelActive = null;
      stopButton.disabled = true;
    }
    if (generation === runGeneration) await cleanup();
    if (generation !== runGeneration) return;
    statusNode.removeAttribute("aria-busy");
    runButton.disabled = false;
    stopButton.disabled = true;
  }
});

stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  statusNode.textContent = "Stopping the local check…";
  const operation = cancelActive;
  cancelActive = null;
  void operation?.().catch(() => undefined).finally(() => {
    statusNode.removeAttribute("aria-busy");
    statusNode.textContent = "Check stopped. No release evidence was recorded.";
    runButton.disabled = false;
  });
});

window.addEventListener("pagehide", () => { void cancelActive?.().catch(() => undefined); });
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  window.location.reload();
});
