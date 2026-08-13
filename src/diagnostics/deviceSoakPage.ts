import { AudioEngine, type CrossfadeSchedule, type DeckChannel } from "../audio/AudioEngine";
import { buildDeviceSoakReport, type DeviceSoakMode } from "./deviceSoakReport";

const modeSelect = document.querySelector<HTMLSelectElement>("#mode");
const startButton = document.querySelector<HTMLButtonElement>("#start");
const stopButton = document.querySelector<HTMLButtonElement>("#stop");
const progress = document.querySelector<HTMLProgressElement>("#progress");
const status = document.querySelector<HTMLElement>("#status");
const announcer = document.querySelector<HTMLElement>("#announcer");
const reportElement = document.querySelector<HTMLElement>("#report");
if (!modeSelect || !startButton || !stopButton || !progress || !status || !announcer || !reportElement) {
  throw new Error("Device soak page is incomplete");
}

const durations: Record<DeviceSoakMode, number> = {
  "smoke-1m": 60,
  "smoke-15m": 15 * 60,
  "acceptance-2h": 2 * 60 * 60,
  "endurance-4h": 4 * 60 * 60
};

let activeCancel: (() => void) | null = null;

const createContinuousBuffer = (context: AudioContext, frequency: number) => {
  const seconds = 12;
  const buffer = context.createBuffer(2, context.sampleRate * seconds, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = 0.08 * Math.sin(2 * Math.PI * (frequency + channel * 37) * index / context.sampleRate);
    }
  }
  return buffer;
};

const runDeviceSoak = async (mode: DeviceSoakMode) => {
  const requestedDurationSeconds = durations[mode];
  const context = new AudioContext({ latencyHint: "playback" });
  let engine: AudioEngine | null = null;
  let buffers: AudioBuffer[] = [];
  let wallStart = performance.now();
  let audioStart = 0;
  let activeDeck: DeckChannel = "a";
  let nextBuffer = 0;
  let scheduledTransitions = 0;
  let completedTransitions = 0;
  let cancelledTransitions = 0;
  let maximumCompletionLatenessSeconds = 0;
  let uncaughtErrors = 0;
  let unhandledRejections = 0;
  let pageStayedVisible = document.visibilityState === "visible";
  let stopped = false;
  let transitionCancel: (() => void) | null = null;
  let timer = 0;
  let currentSchedule: CrossfadeSchedule | null = null;
  let nextTransitionAudioTime = 0;
  let lastAnnouncementBucket = -1;
  let finish: ((aborted: boolean) => Promise<void>) | null = null;
  let cancelRequestedDuringSetup = false;
  activeCancel = () => {
    if (finish) void finish(true);
    else cancelRequestedDuringSetup = true;
  };
  stopButton.disabled = false;

  const onError = () => { uncaughtErrors += 1; };
  const onRejection = () => { unhandledRejections += 1; };
  const onVisibility = () => { if (document.visibilityState !== "visible") pageStayedVisible = false; };
  const cleanup = async () => {
    window.clearInterval(timer);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("visibilitychange", onVisibility);
    if (engine) {
      try { engine.setExpectedOutputActive(false); } catch { /* Best-effort cleanup. */ }
      try { engine.getDeck("a").eject(); } catch { /* Best-effort cleanup. */ }
      try { engine.getDeck("b").eject(); } catch { /* Best-effort cleanup. */ }
      try { engine.disposeAudioHealthMonitoring(); } catch { /* Best-effort cleanup. */ }
    }
    if (context.state !== "closed") await context.close().catch(() => undefined);
  };

  try {
    engine = new AudioEngine(context);
    await engine.resume();
    // Generate the deterministic stimulus before monitoring starts so slow
    // allocation cannot be mistaken for missing render coverage.
    buffers = [createContinuousBuffer(context, 220), createContinuousBuffer(context, 277)];
    const healthSupported = await engine.enableAudioHealthMonitoring();
    if (!healthSupported) throw new Error("This browser cannot run the audio-health monitor required by the check.");
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (cancelRequestedDuringSetup) {
    await cleanup();
    throw new Error("The local device check was cancelled during setup.");
  }
  const activeEngine = engine;
  wallStart = performance.now();
  audioStart = activeEngine.clock.now();
  nextTransitionAudioTime = audioStart + 6;
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("visibilitychange", onVisibility);

  const loadAndPlay = (deck: DeckChannel, when: number) => {
    const instance = activeEngine.getDeck(deck);
    instance.loadBuffer(buffers[nextBuffer % buffers.length], null);
    nextBuffer += 1;
    instance.play(0, when);
  };
  try {
    activeEngine.setDeckGain("a", 1);
    activeEngine.setDeckGain("b", 0);
    loadAndPlay("a", activeEngine.clock.now() + 0.05);
    activeEngine.setExpectedOutputActive(true);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const scheduleNext = () => {
    if (stopped) return;
    const source = activeDeck;
    const target = source === "a" ? "b" : "a";
    const startTime = activeEngine.clock.now() + 0.2;
    loadAndPlay(target, startTime);
    currentSchedule = activeEngine.scheduleCrossfade(source, target, startTime, 1.5);
    scheduledTransitions += 1;
    transitionCancel = activeEngine.onCrossfadeComplete(currentSchedule.id, () => {
      if (!currentSchedule) return;
      maximumCompletionLatenessSeconds = Math.max(
        maximumCompletionLatenessSeconds,
        Math.max(0, activeEngine.clock.now() - currentSchedule.endTime)
      );
      activeEngine.finishCrossfade(currentSchedule.id);
      activeEngine.getDeck(source).pause();
      activeEngine.getDeck(source).eject();
      completedTransitions += 1;
      activeDeck = target;
      currentSchedule = null;
      transitionCancel = null;
      nextTransitionAudioTime = activeEngine.clock.now() + 6;
    });
  };

  finish = async (aborted: boolean) => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(timer);
    const wallElapsedSeconds = (performance.now() - wallStart) / 1_000;
    const audioElapsedSeconds = activeEngine.clock.now() - audioStart;
    try {
      if (currentSchedule) {
        transitionCancel?.();
        if (activeEngine.cancelCrossfade(currentSchedule.id, activeDeck === currentSchedule.source ? 1 : 0,
          activeDeck === currentSchedule.target ? 1 : 0)) cancelledTransitions += 1;
      }
      activeEngine.setExpectedOutputActive(false);
      await new Promise((resolve) => window.setTimeout(resolve, 1_050));
      const report = buildDeviceSoakReport({
        buildContract: "mazzy-audio-engine/v1",
        runnerContract: "mazzy-device-soak-runner/v2",
        mode,
        requestedDurationSeconds,
        wallElapsedSeconds,
        audioElapsedSeconds,
        scheduledTransitions,
        completedTransitions,
        cancelledTransitions,
        maximumCompletionLatenessSeconds,
        uncaughtErrors,
        unhandledRejections,
        health: activeEngine.getAudioHealthSnapshot(),
        pageStayedVisible,
        aborted
      });
      reportElement.textContent = JSON.stringify(report, null, 2);
      status.textContent = report.releaseGatePassed
        ? "The two-hour audio-engine gate passed."
        : mode === "endurance-4h" && report.passed
          ? "The four-hour audio-engine endurance check passed; it does not replace the dedicated two-hour release check."
        : report.passed
          ? "The short audio-engine diagnostic passed; this is not the two-hour release gate."
          : `The audio-engine check failed: ${report.failureCodes.join(", ")}.`;
      announcer.textContent = status.textContent;
    } catch (error) {
      status.textContent = "The audio-engine check could not produce valid evidence.";
      announcer.textContent = status.textContent;
      reportElement.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
    } finally {
      await cleanup();
      startButton.disabled = false;
      stopButton.disabled = true;
      modeSelect.disabled = false;
      activeCancel = null;
      startButton.focus();
    }
  };

  timer = window.setInterval(() => {
    const wallElapsedSeconds = (performance.now() - wallStart) / 1_000;
    const remaining = requestedDurationSeconds - wallElapsedSeconds;
    progress.value = Math.min(1, wallElapsedSeconds / requestedDurationSeconds);
    status.textContent = `${Math.max(0, Math.ceil(remaining))} seconds remaining · ${completedTransitions} transitions completed.`;
    const announcementBucket = Math.floor(wallElapsedSeconds / 30);
    if (announcementBucket !== lastAnnouncementBucket) {
      lastAnnouncementBucket = announcementBucket;
      announcer.textContent = status.textContent;
    }
    if (!currentSchedule && activeEngine.clock.now() >= nextTransitionAudioTime) {
      try {
        scheduleNext();
      } catch {
        uncaughtErrors += 1;
        void finish?.(false);
        return;
      }
    }
    if (wallElapsedSeconds >= requestedDurationSeconds) void finish(false);
  }, 200);
};

startButton.addEventListener("click", () => {
  if (activeCancel) return;
  startButton.disabled = true;
  stopButton.disabled = true;
  modeSelect.disabled = true;
  progress.value = 0;
  status.textContent = "Starting the local audio-engine check…";
  announcer.textContent = status.textContent;
  reportElement.textContent = "Running…";
  void runDeviceSoak(modeSelect.value as DeviceSoakMode).catch((error) => {
    status.textContent = "The local device check could not start.";
    reportElement.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
    startButton.disabled = false;
    stopButton.disabled = true;
    modeSelect.disabled = false;
    activeCancel = null;
    startButton.focus();
  });
});

stopButton.addEventListener("click", () => activeCancel?.());
window.addEventListener("pagehide", () => activeCancel?.(), { once: true });
