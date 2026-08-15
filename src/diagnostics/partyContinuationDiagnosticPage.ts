import { AudioEngine, type AudioHealthSnapshot } from "../audio/AudioEngine";
import { runPartyCommittedTargetAudioTransaction, type PartyCommittedTargetAudioResult } from "../audio/partyCommittedTargetContinuationAudio";
import { decidePartyDeckCompletion, type PartyDeckCompletionDecision, type PartyDeckCompletionEvent } from "../planning/partyDeckCompletionIngestion";
import { decidePartyCommittedTargetContinuation, type PartyCommittedTargetContinuationDecision } from "../planning/partyCommittedTargetContinuation";
import { buildPartyContinuationBrowserReport } from "./partyContinuationBrowserReport";

const runButton = document.querySelector<HTMLButtonElement>("#run");
const stopButton = document.querySelector<HTMLButtonElement>("#stop");
const status = document.querySelector<HTMLElement>("#status");
const reportNode = document.querySelector<HTMLElement>("#report");
if (!runButton || !stopButton || !status || !reportNode) throw new Error("Diagnostic page is incomplete");

let currentGeneration = 0;
let currentCleanup: (() => Promise<void>) | null = null;
let currentAbortController: AbortController | null = null;
let uncaughtErrors = 0;
let unhandledRejections = 0;
window.addEventListener("error", () => { uncaughtErrors += 1; });
window.addEventListener("unhandledrejection", () => { unhandledRejections += 1; });

const abortableDelay = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new Error("Diagnostic was stopped"));
    return;
  }
  const timeout = window.setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  const onAbort = () => {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    reject(new Error("Diagnostic was stopped"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
});

const syntheticBuffer = (context: AudioContext, durationSeconds: number, frequencies: readonly [number, number]) => {
  const frames = Math.round(context.sampleRate * durationSeconds);
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  const fadeFrames = Math.max(1, Math.round(context.sampleRate * 0.012));
  for (let channel = 0; channel < 2; channel += 1) {
    const output = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame += 1) {
      const edge = Math.min(1, frame / fadeFrames, (frames - 1 - frame) / fadeFrames);
      output[frame] = 0.16 * edge * Math.sin(2 * Math.PI * frequencies[channel] * frame / context.sampleRate);
    }
  }
  return buffer;
};

const run = async () => {
  const generation = ++currentGeneration;
  const abortController = new AbortController();
  currentAbortController = abortController;
  runButton.disabled = true;
  stopButton.disabled = false;
  status.className = "";
  status.textContent = "Starting the synthetic source. A quiet two-tone check will play.";
  reportNode.textContent = "Running…";
  const errorBaseline = uncaughtErrors;
  const rejectionBaseline = unhandledRejections;
  const context = new AudioContext({ latencyHint: "interactive" });
  const engine = new AudioEngine(context);
  const source = engine.getDeck("a");
  const target = engine.getDeck("b");
  let cleanupPromise: Promise<void> | null = null;
  let interval = 0;
  let unsubscribe: () => void = () => undefined;
  let resolveCompletion: ((event: PartyDeckCompletionEvent) => void) | null = null;
  const completionPromise = new Promise<PartyDeckCompletionEvent>((resolve) => { resolveCompletion = resolve; });
  let completionCount = 0;
  let completion: PartyDeckCompletionEvent | null = null;
  let ingestion: PartyDeckCompletionDecision | null = null;
  let continuation: PartyCommittedTargetContinuationDecision | null = null;
  let audioTransaction: PartyCommittedTargetAudioResult | null = null;
  let targetStartCount = 0;
  let targetOffsetSeconds: number | null = null;
  let rampDurationSeconds: number | null = null;
  let sourceExpectedEnd = 0;
  let gapSeconds: number | null = null;
  let contextStateAtStart: AudioContextState = context.state;
  let health: AudioHealthSnapshot | null = null;

  const assertCurrent = () => {
    if (abortController.signal.aborted || generation !== currentGeneration ||
      currentAbortController !== abortController) throw new Error("Diagnostic was stopped");
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (interval) window.clearInterval(interval);
      unsubscribe();
      try { source.shutdownForHostTeardown(); } catch { /* Audio authority is still revoked below. */ }
      try { target.shutdownForHostTeardown(); } catch { /* Audio authority is still revoked below. */ }
      try { source.eject(); } catch { /* Diagnostic cleanup is best effort. */ }
      try { target.eject(); } catch { /* Diagnostic cleanup is best effort. */ }
      try { engine.setExpectedOutputActive(false); } catch { /* Monitoring is optional during cleanup. */ }
      try { engine.disposeAudioHealthMonitoring(); } catch { /* Context closure is authoritative. */ }
      try { await context.close(); } catch { /* Already closed. */ }
    })();
    return cleanupPromise;
  };
  currentCleanup = cleanup;

  try {
    await engine.resume();
    assertCurrent();
    contextStateAtStart = context.state;
    if (!await engine.enableAudioHealthMonitoring()) throw new Error("Audio health monitoring is unavailable");
    assertCurrent();
    if (!await engine.resetAudioHealthMonitoringForDiagnostic()) throw new Error("Audio health reset was not acknowledged");
    assertCurrent();
    source.loadBuffer(syntheticBuffer(context, 0.55, [220, 331]), "synthetic-source");
    assertCurrent();
    target.loadBuffer(syntheticBuffer(context, 2, [440, 557]), "synthetic-target");
    assertCurrent();
    engine.setDeckGain("a", 1);
    engine.setDeckGain("b", 0);
    assertCurrent();
    unsubscribe = source.subscribePlaybackCompletion((event) => {
      completionCount += 1;
      completion = event;
      resolveCompletion?.(event);
      resolveCompletion = null;
    });
    interval = window.setInterval(() => {
      try { source.reconcilePlaybackCompletion(); } catch { /* The typed event will expose failure. */ }
      try { target.reconcilePlaybackCompletion(); } catch { /* The typed event will expose failure. */ }
    }, 20);
    engine.setExpectedOutputActive(true);
    assertCurrent();
    const sourceStart = source.play(0, engine.clock.now() + 0.08);
    sourceExpectedEnd = sourceStart + 0.55;
    const event = await Promise.race([
      completionPromise,
      abortableDelay(3_000, abortController.signal).then(() => {
        throw new Error("Native completion timed out");
      })
    ]);
    if (generation !== currentGeneration) throw new Error("Diagnostic was stopped");
    const sourceSnapshot = source.getSnapshot();
    ingestion = decidePartyDeckCompletion({
      callbackDeck: "a",
      event,
      snapshot: sourceSnapshot,
      partyLoad: { trackId: "synthetic-source", trackOrdinal: 1, loadOrdinal: 1 },
      masterDeck: "a",
      autoPilotOwned: true,
      traceRunning: false,
      finalOwner: null,
      activeTransition: null,
      armOwned: false,
      preloadOwned: false
    });
    const targetSnapshot = target.getSnapshot();
    const targetLoad = { trackId: "synthetic-target", trackOrdinal: 2, loadOrdinal: 2 } as const;
    continuation = decidePartyCommittedTargetContinuation({
      sourceDeck: "a",
      targetDeck: "b",
      autoPilotOwned: true,
      contextState: context.state,
      playbackLocked: false,
      conflictingOwner: false,
      targetSnapshot: {
        channel: "b",
        trackId: targetSnapshot.trackId,
        status: targetSnapshot.status,
        ready: target.isReady(),
        playing: target.isActive(),
        playbackRate: targetSnapshot.playbackRate
      },
      targetPartyLoad: targetLoad,
      committedTarget: targetLoad
    });
    let owned = ingestion.kind === "pause-unexpected-source" &&
      continuation.kind === "start-committed-target";
    audioTransaction = runPartyCommittedTargetAudioTransaction({
      sampleRate: context.sampleRate,
      now: () => engine.clock.now(),
      authority: () => owned && generation === currentGeneration && context.state === "running",
      revokeAuthority: () => { owned = false; },
      getSnapshot: () => target.getSnapshot(),
      isActive: () => target.isActive(),
      isExactTarget: (snapshot) => snapshot?.trackId === "synthetic-target",
      getGain: () => engine.getDeckGain("b"),
      setGain: (gain) => { engine.setDeckGain("b", gain); },
      playReadyAtIfRunning: (startTime, offsetSeconds, authority) => {
        if (!authority() || context.state !== "running" || !target.isReady() || target.isActive()) return null;
        targetStartCount += 1;
        targetOffsetSeconds = offsetSeconds;
        const scheduledStart = target.play(offsetSeconds, startTime);
        return { scheduledStart, snapshot: target.getSnapshot() };
      },
      scheduleGainCurve: (curve, startTime, durationSeconds, authority) => {
        rampDurationSeconds = durationSeconds;
        return engine.scheduleDeckGainCurve("b", curve, startTime, durationSeconds, authority);
      },
      pause: () => target.pause()
    });
    gapSeconds = audioTransaction.scheduledStart == null
      ? null
      : Math.max(0, audioTransaction.scheduledStart - sourceExpectedEnd);
    await abortableDelay(750, abortController.signal);
    engine.setExpectedOutputActive(false);
    await abortableDelay(350, abortController.signal);
    health = engine.getAudioHealthSnapshot();
    const targetAfter = target.getSnapshot();
    const report = buildPartyContinuationBrowserReport({
      completion,
      completionCount,
      ingestion,
      continuation,
      audioTransaction,
      targetStartCount,
      targetOffsetSeconds,
      gainRampDurationSeconds: rampDurationSeconds,
      scheduledAudioClockGapSeconds: gapSeconds,
      sourceActiveAfter: source.isActive(),
      targetActiveAfter: target.isActive(),
      targetPlaybackBackend: target.getActivePlaybackBackend(),
      targetStatusAfter: targetAfter.status,
      targetIdentityMatchedAfter: targetAfter.trackId === "synthetic-target",
      targetCompletionOwnerInstalled: target.hasNativePlaybackCompletionAuthority() &&
        ["scheduled", "playing"].includes(targetAfter.status),
      targetGainAfter: engine.getDeckGain("b"),
      contextStateAtStart,
      contextStateAtEnd: context.state,
      health,
      uncaughtErrors: uncaughtErrors - errorBaseline,
      unhandledRejections: unhandledRejections - rejectionBaseline,
      aborted: false
    });
    if (abortController.signal.aborted || generation !== currentGeneration ||
      currentAbortController !== abortController) throw new Error("Diagnostic was stopped");
    reportNode.textContent = JSON.stringify(report, null, 2);
    status.className = report.passed ? "pass" : "fail";
    status.textContent = report.passed
      ? `PASS · exact committed target started once · scheduled EOF-to-start gap ${report.scheduledAudioClockGapSeconds?.toFixed(3)} s`
      : `NEEDS ATTENTION · ${report.failureCodes.join(", ")}`;
  } catch {
    const aborted = abortController.signal.aborted || generation !== currentGeneration;
    if (currentAbortController === abortController) {
      status.className = aborted ? "" : "fail";
      status.textContent = aborted ? "Stopped. No diagnostic audio remains." : "Diagnostic could not complete.";
      reportNode.textContent = JSON.stringify({
        schemaVersion: "party-continuation-browser-runner-error/v1",
        runnerVersion: "party-continuation-browser-runner/v1",
        evidenceScope: "synthetic-browser-state-and-audio-ownership",
        privacy: "aggregate-enums-only-no-media-or-track-metadata",
        outcome: aborted ? "aborted" : "failed",
        failureCodes: [aborted ? "aborted" : "uncaught-error"]
      }, null, 2);
    }
  } finally {
    await cleanup();
    if (currentAbortController === abortController) {
      currentAbortController = null;
      if (currentCleanup === cleanup) currentCleanup = null;
      runButton.disabled = false;
      stopButton.disabled = true;
      if (abortController.signal.aborted) runButton.focus();
    }
  }
};

runButton.addEventListener("click", () => { void run(); });
stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  status.className = "";
  status.textContent = "Stopping synthetic audio…";
  currentAbortController?.abort();
  void currentCleanup?.();
});

window.addEventListener("pagehide", () => {
  currentGeneration += 1;
  currentAbortController?.abort();
  void currentCleanup?.();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
