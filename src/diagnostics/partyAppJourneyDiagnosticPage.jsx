import React from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import AppFatalBoundary from "../AppFatalBoundary";
import "../App.css";
import { getAudioEngine } from "../audioContext";
import { loadLibraryRecoveryBundle } from "../libraryDb";
import { MAZZY_ROOT_ERROR_OPTIONS } from "../reactRootErrorOptions";
import { buildPartyAppJourneyReport } from "./partyAppJourneyReport";

const statusElement = document.querySelector("#party-app-journey-status");
const startButton = document.querySelector("#party-app-journey-start");
const reportElement = document.querySelector("#party-app-journey-report");
const rootElement = document.querySelector("#root");
if (!statusElement || !startButton || !reportElement || !rootElement) {
  throw new Error("The full App journey page is incomplete");
}

const SESSION_KEY = "mazzy-party-app-journey/v1";
const engine = getAudioEngine();
let appRoot = null;
let cleanupPromise = null;
const playbackCompletionUnsubscribes = [];
const deckPlayRestores = [];
const tracker = {
  phase: "checking",
  started: false,
  finishing: false,
  finished: false,
  importedTracks: 0,
  hydratedTracks: 0,
  importFocusRestored: false,
  firstSongPlayFocused: false,
  readinessFocused: false,
  immediateDeckStarts: 0,
  scheduledTargetStarts: 0,
  scheduled: new Map(),
  completed: new Set(),
  cancelled: new Set(),
  templates: new Map(),
  transitionOwnershipFailures: 0,
  maximumCompletionLatenessSeconds: 0,
  maximumCompletionEarlinessSeconds: 0,
  nativeTransitionSourceCompletions: 0,
  nativeTransitionDispatches: 0,
  recoveredTransitionDispatches: 0,
  crossfadeSentinelDispatches: 0,
  contextInterruptions: 0,
  externalRequests: 0,
  uncaughtErrors: 0,
  unhandledRejections: 0,
  pageStayedVisible: document.visibilityState === "visible",
  timeoutId: 0,
  importCheckPending: false
};

const safeSessionEvidence = () => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (!parsed || parsed.version !== 1 || parsed.importedTracks !== 3 ||
      typeof parsed.importFocusRestored !== "boolean" ||
      Object.keys(parsed).sort().join("|") !== ["importFocusRestored", "importedTracks", "version"].sort().join("|")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const activeElementContains = (text) =>
  document.activeElement instanceof HTMLElement && document.activeElement.textContent?.includes(text);

const captureTransitionTemplate = (scheduleId, attempt = 0) => {
  if (!tracker.started || tracker.templates.has(scheduleId)) return;
  const inspector = document.querySelector(".transition-inspector");
  if (inspector?.classList.contains("safe")) tracker.templates.set(scheduleId, "safe-fade");
  else if (inspector?.classList.contains("filtered")) tracker.templates.set(scheduleId, "filtered-fade");
  else if (inspector?.classList.contains("handoff")) tracker.templates.set(scheduleId, "downbeat-cut");
  else if (inspector?.classList.contains("phrase")) tracker.templates.set(scheduleId, "phrase-blend");
  else if (attempt < 20) window.setTimeout(() => captureTransitionTemplate(scheduleId, attempt + 1), 25);
};

for (const channel of ["a", "b"]) {
  const deck = engine.getDeck(channel);
  const unsubscribe = deck.subscribePlaybackCompletion((event) => {
    const schedule = engine.getActiveCrossfade();
    if (tracker.started && event.settledBy === "source-onended" && event.outcome === "on-time" &&
      schedule?.source === channel) {
      tracker.nativeTransitionSourceCompletions += 1;
    }
  });
  if (typeof unsubscribe === "function") playbackCompletionUnsubscribes.push(unsubscribe);
  const originalPlay = deck.play.bind(deck);
  deckPlayRestores.push(() => { deck.play = originalPlay; });
  deck.play = (...args) => {
    const requestedStart = Number(args[1]);
    const immediate = !Number.isFinite(requestedStart) ||
      requestedStart - engine.clock.now() <= 0.04;
    const scheduledStart = originalPlay(...args);
    if (tracker.started) {
      if (immediate) tracker.immediateDeckStarts += 1;
      else tracker.scheduledTargetStarts += 1;
      if (tracker.immediateDeckStarts + tracker.scheduledTargetStarts === 1) {
        engine.setExpectedOutputActive(true);
      }
    }
    return scheduledStart;
  };
}

const originalScheduleCrossfade = engine.scheduleCrossfade.bind(engine);
engine.scheduleCrossfade = (...args) => {
  const schedule = originalScheduleCrossfade(...args);
  if (tracker.started) {
    tracker.scheduled.set(schedule.id, schedule);
    window.setTimeout(() => captureTransitionTemplate(schedule.id), 0);
  }
  return schedule;
};

const originalFinishCrossfade = engine.finishCrossfade.bind(engine);
engine.finishCrossfade = (scheduleId) => {
  try {
    const completed = originalFinishCrossfade(scheduleId);
    if (tracker.started) {
      if (completed) {
        tracker.completed.add(scheduleId);
        const schedule = tracker.scheduled.get(scheduleId);
        if (schedule) {
          const timingDelta = engine.clock.now() - schedule.endTime;
          tracker.maximumCompletionLatenessSeconds = Math.max(
            tracker.maximumCompletionLatenessSeconds,
            Math.max(0, timingDelta)
          );
          tracker.maximumCompletionEarlinessSeconds = Math.max(
            tracker.maximumCompletionEarlinessSeconds,
            Math.max(0, -timingDelta)
          );
        }
      } else {
        tracker.transitionOwnershipFailures += 1;
      }
    }
    return completed;
  } catch (error) {
    if (tracker.started) tracker.transitionOwnershipFailures += 1;
    throw error;
  }
};

const originalCancelCrossfade = engine.cancelCrossfade.bind(engine);
engine.cancelCrossfade = (scheduleId, ...args) => {
  const cancelled = originalCancelCrossfade(scheduleId, ...args);
  if (tracker.started && cancelled) tracker.cancelled.add(scheduleId);
  return cancelled;
};

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  try {
    const value = typeof input === "string" || input instanceof URL ? input : input.url;
    if (new URL(value, location.href).origin !== location.origin) tracker.externalRequests += 1;
  } catch {
    tracker.externalRequests += 1;
  }
  return originalFetch(input, init);
};

const resourceObserver = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    try {
      if (new URL(entry.name).origin !== location.origin) tracker.externalRequests += 1;
    } catch {
      tracker.externalRequests += 1;
    }
  }
});
resourceObserver?.observe({ type: "resource", buffered: true });

const onError = () => { tracker.uncaughtErrors += 1; };
const onUnhandledRejection = () => { tracker.unhandledRejections += 1; };
const onVisibilityChange = () => {
  if (document.visibilityState !== "visible") tracker.pageStayedVisible = false;
};
const onContextStateChange = () => {
  if (tracker.started && !tracker.finishing && engine.context.state !== "running") {
    tracker.contextInterruptions += 1;
  }
};
const onFocusIn = (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches(".party-mode-flow button") && target.textContent?.includes("PLAY FIRST SONG")) {
    tracker.firstSongPlayFocused = true;
  }
  if (target.matches(".party-mode-readiness") && target.querySelector("#party-readiness-title")) {
    tracker.readinessFocused = true;
  }
};
const onNativeTransitionDispatch = () => { if (tracker.started) tracker.nativeTransitionDispatches += 1; };
const onRecoveredTransitionDispatch = () => { if (tracker.started) tracker.recoveredTransitionDispatches += 1; };
const onCrossfadeSentinelDispatch = () => { if (tracker.started) tracker.crossfadeSentinelDispatches += 1; };
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onUnhandledRejection);
document.addEventListener("visibilitychange", onVisibilityChange);
engine.context.addEventListener?.("statechange", onContextStateChange);
document.addEventListener("focusin", onFocusIn);
window.addEventListener("mazzy:party-app-journey-native-transition-dispatch", onNativeTransitionDispatch);
window.addEventListener("mazzy:party-app-journey-recovered-transition-dispatch", onRecoveredTransitionDispatch);
window.addEventListener("mazzy:party-app-journey-crossfade-sentinel-dispatch", onCrossfadeSentinelDispatch);

const checkpointStatus = (record) => {
  if (record == null) return "missing";
  return ["cleared", "claimed", "available", "invalidated"].includes(record.recordStatus)
    ? record.recordStatus
    : "malformed";
};

const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const stopControlReady = () => {
  const button = [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes("STOP ALL SOUND"));
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  return button.getBoundingClientRect().height >= 44;
};

const cleanupJourneyPage = () => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    tracker.started = false;
    window.clearTimeout(tracker.timeoutId);
    mutationObserver.disconnect();
    resourceObserver?.disconnect();
    for (const unsubscribe of playbackCompletionUnsubscribes.splice(0)) {
      try { unsubscribe(); } catch { /* Keep teardown independent. */ }
    }
    for (const restore of deckPlayRestores.splice(0)) restore();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    engine.context.removeEventListener?.("statechange", onContextStateChange);
    document.removeEventListener("focusin", onFocusIn);
    window.removeEventListener("mazzy:party-app-journey-native-transition-dispatch", onNativeTransitionDispatch);
    window.removeEventListener("mazzy:party-app-journey-recovered-transition-dispatch", onRecoveredTransitionDispatch);
    window.removeEventListener("mazzy:party-app-journey-crossfade-sentinel-dispatch", onCrossfadeSentinelDispatch);
    globalThis.fetch = originalFetch;
    engine.scheduleCrossfade = originalScheduleCrossfade;
    engine.finishCrossfade = originalFinishCrossfade;
    engine.cancelCrossfade = originalCancelCrossfade;
    try { appRoot?.unmount(); } catch { /* Audio shutdown remains independent. */ }
    appRoot = null;
    try { engine.setExpectedOutputActive(false); } catch { /* Continue to the latched shutdown. */ }
    try { engine.shutdownForFatalHostError(); } catch { /* Context closure remains independent. */ }
    try { engine.disposeAudioHealthMonitoring(); } catch { /* Monitoring is no longer authoritative. */ }
    if (engine.context.state !== "closed") {
      try { await engine.context.close(); } catch {
        try { await engine.context.suspend(); } catch { /* Page teardown is complete even if the browser refuses. */ }
      }
    }
  })();
  return cleanupPromise;
};

const finishJourney = async ({ timedOut = false, aborted = false } = {}) => {
  if (!tracker.started || tracker.finishing || tracker.finished) return;
  tracker.finishing = true;
  window.clearTimeout(tracker.timeoutId);
  if (timedOut || aborted) {
    await cleanupJourneyPage();
  } else {
    engine.setExpectedOutputActive(false);
    statusElement.textContent = "Checking terminal audio and browser-storage ownership…";
    await sleep(1_250);
  }

  let bundle = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { bundle = await loadLibraryRecoveryBundle(); } catch { bundle = null; }
    if (bundle?.checkpointRecord?.recordStatus === "cleared") break;
    await sleep(100);
  }
  const evidence = safeSessionEvidence();
  const health = engine.getAudioHealthSnapshot();
  const safeFadeTransitions = [...tracker.templates.values()].filter((value) => value === "safe-fade").length;
  const report = buildPartyAppJourneyReport({
    buildContract: "mazzy-app-basic/v1",
    runnerContract: "party-app-browser-runner/v1",
    fixtureContract: "generated-stereo-wav/v1",
    scenario: "three-track-safe-fade",
    importedTracks: evidence?.importedTracks ?? 0,
    hydratedTracks: tracker.hydratedTracks,
    storedTracksAfter: Array.isArray(bundle?.tracks) ? bundle.tracks.length : 0,
    immediateDeckStarts: tracker.immediateDeckStarts,
    scheduledTargetStarts: tracker.scheduledTargetStarts,
    scheduledTransitions: tracker.scheduled.size,
    uniqueTransitionOwners: new Set(tracker.scheduled.keys()).size,
    completedTransitions: tracker.completed.size,
    cancelledTransitions: tracker.cancelled.size,
    transitionOwnershipFailures: tracker.transitionOwnershipFailures,
    nativeTransitionSourceCompletions: tracker.nativeTransitionSourceCompletions,
    nativeTransitionDispatches: tracker.nativeTransitionDispatches,
    recoveredTransitionDispatches: tracker.recoveredTransitionDispatches,
    crossfadeSentinelDispatches: tracker.crossfadeSentinelDispatches,
    safeFadeTransitions,
    nonSafeFadeTransitions: tracker.scheduled.size - safeFadeTransitions,
    maximumCompletionLatenessSeconds: tracker.maximumCompletionLatenessSeconds,
    maximumCompletionEarlinessSeconds: tracker.maximumCompletionEarlinessSeconds,
    terminalTracePassed: document.body.textContent?.includes("PRIVATE ACTIVITY CHECK · SESSION STATE PASSED") === true,
    queueTracksAfter: document.querySelectorAll(".queue-item").length,
    autoPilotActiveAfter: [...document.querySelectorAll(".party-mode-flow button")]
      .some((button) => button.textContent?.includes("PAUSE AUTOPILOT")),
    checkpointStatusAfter: checkpointStatus(bundle?.checkpointRecord),
    activeDecksAfter: ["a", "b"].filter((channel) => engine.getDeck(channel).isActive()).length,
    activeCrossfadeAfter: engine.getActiveCrossfade() !== null,
    recoveryUiVisibleAfter: document.querySelector("[role='alert'], .fatal-host-recovery") !== null,
    importFocusRestored: evidence?.importFocusRestored === true,
    firstSongPlayFocused: tracker.firstSongPlayFocused,
    readinessFocused: tracker.readinessFocused,
    stopControlReadyAfter: stopControlReady(),
    contextInterruptions: tracker.contextInterruptions,
    health,
    externalRequests: tracker.externalRequests,
    uncaughtErrors: tracker.uncaughtErrors,
    unhandledRejections: tracker.unhandledRejections,
    pageStayedVisible: tracker.pageStayedVisible,
    timedOut,
    aborted
  });
  tracker.finished = true;
  tracker.finishing = false;
  reportElement.textContent = JSON.stringify(report, null, 2);
  statusElement.textContent = report.passed
    ? "The generated-audio full App Party journey passed."
    : `The full App Party journey failed: ${report.failureCodes.join(", ")}.`;
  await cleanupJourneyPage();
};

const checkImportComplete = async () => {
  if (tracker.phase !== "import" || tracker.importCheckPending || tracker.finished) return;
  if (document.querySelectorAll(".library-row").length !== 3 ||
    document.querySelector(".party-mode-readiness[aria-busy='true']")) return;
  tracker.importCheckPending = true;
  await sleep(120);
  let bundle = null;
  try { bundle = await loadLibraryRecoveryBundle(); } catch { /* Keep waiting. */ }
  if (bundle?.tracks?.length === 3) {
    tracker.importedTracks = 3;
    tracker.importFocusRestored = activeElementContains("IMPORT MUSIC");
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 1,
      importedTracks: 3,
      importFocusRestored: tracker.importFocusRestored
    }));
    statusElement.textContent = "IMPORT COMMITTED · hard reload this diagnostic page to prove Blob hydration.";
  }
  tracker.importCheckPending = false;
};

const maybeFinishJourney = () => {
  if (tracker.started && !tracker.finishing &&
    document.body.textContent?.includes("PRIVATE ACTIVITY CHECK · SESSION STATE PASSED")) {
    void finishJourney();
  }
  void checkImportComplete();
};

const mutationObserver = new MutationObserver(maybeFinishJourney);
mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

startButton.addEventListener("click", async () => {
  if (tracker.phase !== "ready" || tracker.started) return;
  startButton.disabled = true;
  statusElement.textContent = "Starting the aggregate post-master observer…";
  try {
    await engine.resume();
    if (!await engine.enableAudioHealthMonitoring() ||
      !await engine.resetAudioHealthMonitoringForDiagnostic()) {
      throw new Error("audio health unavailable");
    }
    tracker.started = true;
    tracker.phase = "running";
    engine.setExpectedOutputActive(false);
    tracker.timeoutId = window.setTimeout(() => void finishJourney({ timedOut: true }), 90_000);
    statusElement.textContent = "JOURNEY ARMED · use the real Party controls below.";
  } catch {
    tracker.started = true;
    tracker.phase = "running";
    void finishJourney({ aborted: true });
  }
});

window.addEventListener("pagehide", () => {
  void cleanupJourneyPage();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

appRoot = createRoot(rootElement, MAZZY_ROOT_ERROR_OPTIONS);
appRoot.render(
  <AppFatalBoundary>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </AppFatalBoundary>
);

const initialize = async () => {
  const evidence = safeSessionEvidence();
  let bundle = null;
  try { bundle = await loadLibraryRecoveryBundle(); } catch { /* Fixed status below. */ }
  const stored = Array.isArray(bundle?.tracks) ? bundle.tracks.length : -1;
  if (!evidence && stored === 0) {
    tracker.phase = "import";
    statusElement.textContent = "EMPTY DISPOSABLE PROFILE · import exactly three generated WAV files through Mazzy.";
    return;
  }
  if (evidence && stored === 3) {
    tracker.phase = "hydrating";
    const waitForHydration = async () => {
      if (document.querySelectorAll(".library-row").length === 3 &&
        !document.body.textContent?.includes("OPENING SAVED LOCAL MUSIC")) {
        tracker.hydratedTracks = 3;
        tracker.phase = "ready";
        statusElement.textContent = "HYDRATION CONFIRMED · arm evidence, then run the Party journey.";
        startButton.disabled = false;
        return;
      }
      if (tracker.phase === "hydrating") window.setTimeout(waitForHydration, 50);
    };
    void waitForHydration();
    return;
  }
  tracker.phase = "invalid";
  statusElement.textContent = "This profile is not an empty or exact three-fixture journey profile. Use a fresh browser profile.";
};

void initialize();
