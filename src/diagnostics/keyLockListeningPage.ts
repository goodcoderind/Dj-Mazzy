import { AudioEngine } from "../audio/AudioEngine";
import { DeckEngine } from "../audio/DeckEngine";
import { createSignalsmithPreparedKeyLockSource } from "../audio/signalsmithPreparedKeyLockSource";
import { planPrivateExcerpt } from "./keyLockListening";
import { evaluatePrivateListeningHealth, type ListeningHealthBaseline } from "./keyLockListeningEvidence";

type Mode = "original" | "slow" | "fast" | "handoff";
type Rating = "clean" | "artifacts" | "unsure";

const fileA = document.querySelector<HTMLInputElement>("#file-a")!;
const fileB = document.querySelector<HTMLInputElement>("#file-b")!;
const prepareButton = document.querySelector<HTMLButtonElement>("#prepare")!;
const prepareStatus = document.querySelector<HTMLElement>("#prepare-status")!;
const listenStatus = document.querySelector<HTMLElement>("#listen-status")!;
const summaryNode = document.querySelector<HTMLElement>("#summary")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const discardButton = document.querySelector<HTMLButtonElement>("#discard")!;
const listenButtons = [...document.querySelectorAll<HTMLButtonElement>("button.listen")];
const ratingButtons = [...document.querySelectorAll<HTMLButtonElement>("button.rating")];

let context: AudioContext | null = null;
let engine: AudioEngine | null = null;
let excerpts: readonly [AudioBuffer, AudioBuffer] | null = null;
let activeDecks: DeckEngine[] = [];
let activeMode: Mode | null = null;
let completedMode: Exclude<Mode, "original"> | null = null;
let runGeneration = 0;
let activeCrossfadeId: number | null = null;
let activeCrossfadeCompletionCancel: (() => void) | null = null;
let activeTrialSubscriptions: Array<() => void> = [];
let operationBusy = false;
let diagnosticDeckA: DeckEngine | null = null;
let diagnosticDeckB: DeckEngine | null = null;
let trialHealthBaseline: ListeningHealthBaseline | null = null;
let trialHealthStartSeconds: number | null = null;
let handoffCompletedOwned = false;
const ratings: Record<Exclude<Mode, "original">, Record<Rating, number>> = {
  slow: { clean: 0, artifacts: 0, unsure: 0 },
  fast: { clean: 0, artifacts: 0, unsure: 0 },
  handoff: { clean: 0, artifacts: 0, unsure: 0 }
};

const setListeningEnabled = (enabled: boolean) => {
  for (const button of listenButtons) button.disabled = !enabled;
};

const setMutationLocked = (locked: boolean) => {
  operationBusy = locked;
  setListeningEnabled(!locked && excerpts !== null);
  prepareButton.disabled = locked;
  fileA.disabled = locked;
  fileB.disabled = locked;
  discardButton.disabled = locked;
  ratingButtons.forEach((button) => { button.disabled = true; });
};

const updateSummary = () => {
  summaryNode.textContent = JSON.stringify({
    schemaVersion: "key-lock-private-listening/v1",
    privacy: "tab memory only; no filenames, timestamps, audio, persistence, or upload",
    ratings
  }, null, 2);
};

const stopActive = async (message = "Audio stopped.", owner = ++runGeneration) => {
  engine?.setExpectedOutputActive(false);
  activeCrossfadeCompletionCancel?.();
  activeCrossfadeCompletionCancel = null;
  if (engine && activeCrossfadeId !== null) engine.cancelCrossfade(activeCrossfadeId);
  activeCrossfadeId = null;
  for (const unsubscribe of activeTrialSubscriptions.splice(0)) unsubscribe();
  const decks = activeDecks;
  activeDecks = [];
  for (const deck of decks) deck.eject();
  await Promise.all(decks.map((deck) => deck.awaitKeyLockCleanupForDiagnostic()));
  if (owner === runGeneration) {
    activeMode = null;
    completedMode = null;
    trialHealthBaseline = null;
    trialHealthStartSeconds = null;
    handoffCompletedOwned = false;
    stopButton.disabled = true;
    ratingButtons.forEach((button) => { button.disabled = true; });
    listenStatus.textContent = message;
  }
};

const createExcerpt = (decoded: AudioBuffer, output: AudioContext, seconds = 12) => {
  const { frameCount, startFrame: start } = planPrivateExcerpt(decoded.length, output.sampleRate, seconds);
  const channels = Math.min(2, decoded.numberOfChannels);
  const excerpt = output.createBuffer(2, frameCount, output.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const source = decoded.getChannelData(Math.min(channel, channels - 1));
    excerpt.copyToChannel(source.subarray(start, start + frameCount), channel);
  }
  return excerpt;
};

const decodePrivateExcerpt = async (file: File, output: AudioContext) => {
  const bytes = await file.arrayBuffer();
  const decoded = await output.decodeAudioData(bytes);
  return createExcerpt(decoded, output);
};

prepareButton.addEventListener("click", async () => {
  const first = fileA.files?.[0];
  const second = fileB.files?.[0];
  if (!first || !second) {
    prepareStatus.textContent = "Choose both songs first.";
    return;
  }
  if (operationBusy) return;
  const preparationGeneration = ++runGeneration;
  setMutationLocked(true);
  prepareStatus.textContent = "Preparing two private excerpts locally…";
  try {
    await stopActive("Preparing new excerpts…", preparationGeneration);
    if (preparationGeneration !== runGeneration) return;
    if (!context || context.state === "closed") {
      context = new AudioContext();
      await context.resume();
      engine = new AudioEngine(context);
      await engine.enableAudioHealthMonitoring();
      diagnosticDeckA = new DeckEngine(engine, "a", createSignalsmithPreparedKeyLockSource);
      diagnosticDeckB = new DeckEngine(engine, "b", createSignalsmithPreparedKeyLockSource);
      context.addEventListener("statechange", () => {
        if (activeMode && !operationBusy && context?.state !== "running") {
          const owner = ++runGeneration;
          setMutationLocked(true);
          void stopActive("Audio was interrupted, so this check was not rated.", owner).finally(() => {
            if (owner === runGeneration) setMutationLocked(false);
          });
        }
      });
    }
    excerpts = await Promise.all([
      decodePrivateExcerpt(first, context),
      decodePrivateExcerpt(second, context)
    ]) as [AudioBuffer, AudioBuffer];
    if (preparationGeneration !== runGeneration) throw new DOMException("Preparation was cancelled", "AbortError");
    fileA.value = "";
    fileB.value = "";
    setListeningEnabled(true);
    prepareStatus.textContent = "Two anonymous excerpts are ready in memory. Filenames were discarded.";
    listenStatus.textContent = "Choose a listening check.";
  } catch (error) {
    if (preparationGeneration !== runGeneration) return;
    excerpts = null;
    prepareStatus.textContent = "Could not read one of these songs. Try another local audio file.";
  } finally {
    if (preparationGeneration === runGeneration) setMutationLocked(false);
  }
});

const playNative = async (buffer: AudioBuffer, generation: number) => {
  if (!engine || !context || !diagnosticDeckA) return false;
  const deck = diagnosticDeckA;
  activeDecks = [deck];
  deck.loadBuffer(buffer, null);
  engine.setDeckGain("a", 1);
  deck.play(0, context.currentTime + 0.08);
  if (generation !== runGeneration) return false;
  return true;
};

const playKeyLocked = async (buffer: AudioBuffer, rate: 0.94 | 1.06, generation: number) => {
  if (!engine || !context || !diagnosticDeckA) return false;
  const deck = diagnosticDeckA;
  activeDecks = [deck];
  deck.loadBuffer(buffer, null);
  if (!await deck.prepareKeyLock() || generation !== runGeneration) return false;
  const state = deck.getKeyLockState();
  if (state.status !== "ready") return false;
  engine.setDeckGain("a", 1);
  return deck.playPreparedKeyLockForDiagnostic(
    state.loadKey,
    0,
    rate,
    context.currentTime + state.latencySeconds + 0.12
  );
};

const playHandoff = async (buffers: readonly [AudioBuffer, AudioBuffer], generation: number) => {
  if (!engine || !context || !diagnosticDeckA || !diagnosticDeckB) return false;
  const source = diagnosticDeckA;
  const target = diagnosticDeckB;
  activeDecks = [source, target];
  source.loadBuffer(buffers[0], null);
  target.loadBuffer(buffers[1], null);
  const prepared = await Promise.all([source.prepareKeyLock(), target.prepareKeyLock()]);
  if (!prepared.every(Boolean) || generation !== runGeneration) return false;
  const sourceState = source.getKeyLockState();
  const targetState = target.getKeyLockState();
  if (sourceState.status !== "ready" || targetState.status !== "ready") return false;
  const start = context.currentTime + Math.max(sourceState.latencySeconds, targetState.latencySeconds) + 0.15;
  engine.setDeckGain("a", 1);
  engine.setDeckGain("b", 0);
  const started = await Promise.all([
    source.playPreparedKeyLockForDiagnostic(sourceState.loadKey, 0, 0.94, start),
    target.playPreparedKeyLockForDiagnostic(targetState.loadKey, 0, 1.06, start)
  ]);
  if (!started.every(Boolean) || generation !== runGeneration) return false;
  const schedule = engine.scheduleCrossfade("a", "b", start + 3, 5);
  activeCrossfadeId = schedule.id;
  activeCrossfadeCompletionCancel = engine.onCrossfadeComplete(schedule.id, () => {
    if (generation !== runGeneration || !engine) return;
    if (!engine.finishCrossfade(schedule.id)) return;
    handoffCompletedOwned = true;
    activeCrossfadeId = null;
    activeCrossfadeCompletionCancel = null;
    source.pause();
  });
  return true;
};

const finishTrial = async (mode: Mode, generation: number) => {
  if (generation !== runGeneration || operationBusy) return;
  setMutationLocked(true);
  stopButton.disabled = true;
  engine?.setExpectedOutputActive(false);
  const healthEndSeconds = context?.currentTime ?? Number.NaN;
  activeCrossfadeCompletionCancel?.();
  activeCrossfadeCompletionCancel = null;
  if (engine && activeCrossfadeId !== null) engine.finishCrossfade(activeCrossfadeId);
  activeCrossfadeId = null;
  for (const unsubscribe of activeTrialSubscriptions.splice(0)) unsubscribe();
  const decks = activeDecks;
  activeDecks = [];
  await Promise.all(decks.map((deck) => deck.awaitKeyLockCleanupForDiagnostic()));
  const preparedHealthy = mode === "original" || decks.every((deck) => deck.getKeyLockState().status === "ready");
  await new Promise((resolve) => window.setTimeout(resolve, 1_100));
  const health = engine?.getAudioHealthSnapshot();
  const healthEvaluation = health && trialHealthBaseline && trialHealthStartSeconds !== null
    ? evaluatePrivateListeningHealth(
      trialHealthBaseline,
      health,
      healthEndSeconds - trialHealthStartSeconds,
      mode === "handoff",
      handoffCompletedOwned
    )
    : null;
  const healthy = context?.state === "running" && health?.supported === true && healthEvaluation?.passed === true;
  for (const deck of decks) deck.eject();
  await Promise.all(decks.map((deck) => deck.awaitKeyLockCleanupForDiagnostic()));
  if (generation !== runGeneration) return;
  activeMode = null;
  trialHealthBaseline = null;
  trialHealthStartSeconds = null;
  handoffCompletedOwned = false;
  stopButton.disabled = true;
  completedMode = healthy && preparedHealthy && mode !== "original" ? mode : null;
  setMutationLocked(false);
  ratingButtons.forEach((button) => { button.disabled = completedMode === null; });
  listenStatus.textContent = healthy && preparedHealthy
    ? mode === "original"
      ? "Original reference finished. Choose a key-lock check next."
      : "Listening check finished without a detected playback failure. What did you hear?"
    : "The listening check was interrupted or unhealthy, so it cannot be rated.";
};

const observeTrialCompletion = (mode: Mode, generation: number) => {
  const terminalDeck = mode === "handoff" ? diagnosticDeckB : diagnosticDeckA;
  if (!terminalDeck) return;
  let sawActive = false;
  const observe = (deck: DeckEngine, terminal: boolean) => deck.subscribe((snapshot) => {
    if (generation !== runGeneration) return;
    if (snapshot.status === "scheduled" || snapshot.status === "playing") sawActive = true;
    if (terminal && sawActive && snapshot.status === "ended") void finishTrial(mode, generation);
    const expectedSourcePause = mode === "handoff" && !terminal && snapshot.status === "paused" && activeCrossfadeId === null;
    if (sawActive && !expectedSourcePause &&
      (snapshot.status === "paused" || snapshot.status === "recoverable-error" || snapshot.status === "idle")) {
      const owner = ++runGeneration;
      setMutationLocked(true);
      void stopActive("The listening check stopped unexpectedly, so it cannot be rated.", owner).finally(() => {
        if (owner === runGeneration) setMutationLocked(false);
      });
    }
  });
  activeTrialSubscriptions.push(observe(terminalDeck, true));
  if (mode === "handoff" && diagnosticDeckA) {
    activeTrialSubscriptions.push(observe(diagnosticDeckA, false));
  }
};

for (const button of listenButtons) {
  button.addEventListener("click", async () => {
    if (!excerpts || !engine || !context || operationBusy) return;
    const mode = button.dataset.mode as Mode;
    const generation = ++runGeneration;
    setMutationLocked(true);
    stopButton.disabled = false;
    listenStatus.textContent = mode === "handoff" ? "Playing the two-song handoff…" : `Playing ${button.textContent?.toLowerCase()}…`;
    try {
      await stopActive("Starting the selected check…", generation);
      if (generation !== runGeneration) return;
      stopButton.disabled = false;
      await engine.resume();
      if (generation !== runGeneration || context.state !== "running") {
        throw new Error("Audio context is not running");
      }
      const started = mode === "original"
        ? await playNative(excerpts[0], generation)
        : mode === "slow"
          ? await playKeyLocked(excerpts[0], 0.94, generation)
          : mode === "fast"
            ? await playKeyLocked(excerpts[0], 1.06, generation)
            : await playHandoff(excerpts, generation);
      if (!started || generation !== runGeneration || context.state !== "running") {
        throw new Error("Listening playback did not start cleanly");
      }
      const currentContext = context;
      const scheduledStart = activeDecks[0]?.getSnapshot().scheduledStartTime ?? currentContext.currentTime;
      await new Promise((resolve) => window.setTimeout(resolve,
        Math.max(0, scheduledStart - currentContext.currentTime + 0.02) * 1_000));
      if (generation !== runGeneration || currentContext.state !== "running") throw new Error("Listening playback was interrupted");
      if (!await engine.resetAudioHealthMonitoringForDiagnostic() || generation !== runGeneration) {
        throw new Error("Audio health interval could not start");
      }
      const health = engine.getAudioHealthSnapshot();
      trialHealthBaseline = {
        renderedFrames: health.renderedFrames,
        expectedActiveFrames: health.expectedActiveFrames,
        silentFrames: health.silentFrames,
        renderQuanta: health.renderQuanta,
        nonFiniteSamples: health.nonFiniteSamples,
        clippedSamples: health.clippedSamples,
        processorErrors: health.processorErrors,
        reports: health.reports
      };
      trialHealthStartSeconds = currentContext.currentTime;
      handoffCompletedOwned = false;
      engine.setExpectedOutputActive(true);
      activeMode = mode;
      completedMode = null;
      stopButton.disabled = false;
      listenStatus.textContent = mode === "handoff"
        ? "Playing the full two-song handoff…"
        : `Playing ${button.textContent?.toLowerCase()}…`;
      observeTrialCompletion(mode, generation);
    } catch {
      if (generation === runGeneration) {
        await stopActive("This listening check failed safely. Key lock remains unavailable.", generation);
      }
    } finally {
      if (generation === runGeneration) setMutationLocked(false);
    }
  });
}

stopButton.addEventListener("click", () => {
  const owner = ++runGeneration;
  setMutationLocked(true);
  void stopActive("Audio stopped.", owner).finally(() => {
    if (owner === runGeneration) setMutationLocked(false);
  });
});

for (const button of ratingButtons) {
  button.addEventListener("click", () => {
    if (!completedMode || operationBusy) return;
    ratings[completedMode][button.dataset.rating as Rating] += 1;
    completedMode = null;
    updateSummary();
    ratingButtons.forEach((rating) => { rating.disabled = true; });
    listenStatus.textContent = "Feedback recorded in this tab only.";
  });
}

discardButton.addEventListener("click", () => {
  for (const mode of ["slow", "fast", "handoff"] as const) {
    ratings[mode] = { clean: 0, artifacts: 0, unsure: 0 };
  }
  updateSummary();
  listenStatus.textContent = "This tab’s feedback was discarded.";
});

window.addEventListener("pagehide", () => {
  const owner = ++runGeneration;
  setMutationLocked(true);
  void stopActive("Audio stopped.", owner).finally(async () => {
    engine?.disposeAudioHealthMonitoring();
    await context?.close();
  });
  excerpts = null;
  fileA.value = "";
  fileB.value = "";
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  window.location.reload();
});
