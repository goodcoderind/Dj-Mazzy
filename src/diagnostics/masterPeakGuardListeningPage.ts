import { MASTER_DSP_V1 } from "../audio/masterDsp";
import type { PreMasterStereoPreview } from "./transitionRehearsal";
import { renderMasterPeakGuardListeningComparison } from "./masterPeakGuardCandidate";
import { MasterPeakGuardAuditionEngine } from "./masterPeakGuardAuditionEngine";
import {
  MASTER_PEAK_GUARD_BLIND_BLOCK_SIZE,
  assessMasterPeakGuardListeningEligibility,
  buildMasterPeakGuardAuditionPair,
  buildMasterPeakGuardListeningSummary,
  buildMasterPeakGuardTrialPlan,
  emptyMasterPeakGuardListeningCounts,
  evaluateMasterPeakGuardAuditionHealth,
  mapMasterPeakGuardRating,
  type MasterPeakGuardArtifactReason,
  type MasterPeakGuardBlindLabel,
  type MasterPeakGuardHealthBaseline,
  type MasterPeakGuardListeningCounts,
  type MasterPeakGuardListeningRating,
  type MasterPeakGuardRejectionReason,
  type MasterPeakGuardTrialPlan,
  type MasterPeakGuardVariant
} from "./masterPeakGuardListening";

type PreparedComparison = Readonly<{
  plan: MasterPeakGuardTrialPlan;
  previews: Readonly<Record<MasterPeakGuardBlindLabel, Readonly<{
    sampleRate: number;
    channels: readonly [Float32Array, Float32Array];
  }>>>;
}>;

const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const prepareButton = document.querySelector<HTMLButtonElement>("#prepare")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const prepareStatus = document.querySelector<HTMLElement>("#prepare-status")!;
const listenStatus = document.querySelector<HTMLElement>("#listen-status")!;
const errorStatus = document.querySelector<HTMLElement>("#error-status")!;
const summary = document.querySelector<HTMLElement>("#summary")!;
const main = document.querySelector<HTMLElement>("main")!;
const ratingGroup = document.querySelector<HTMLElement>("#rating-group")!;
const clearSongButton = document.querySelector<HTMLButtonElement>("#clear-song")!;
const discardFeedbackButton = document.querySelector<HTMLButtonElement>("#discard-feedback")!;
const listenButtons = [...document.querySelectorAll<HTMLButtonElement>("button.listen")];
const ratingButtons = [...document.querySelectorAll<HTMLButtonElement>("button.rating")];
const artifactInputs = [...document.querySelectorAll<HTMLInputElement>("input[data-artifact]")];

let context: AudioContext | null = null;
let engine: MasterPeakGuardAuditionEngine | null = null;
let prepared: PreparedComparison | null = null;
let activePreviewCancel: (() => void) | null = null;
let activeGeneration = 0;
let preparing = false;
let preparationAttemptPending = false;
let preparationCancellationRequested = false;
let startingPlayback = false;
let finalizingPlayback = false;
let playing = false;
let ratingReady = false;
let blockClosed = false;
let activeHealthBaseline: MasterPeakGuardHealthBaseline | null = null;
let activeHealthStartedAt: number | null = null;
const heard = new Set<MasterPeakGuardBlindLabel>();
let counts: MasterPeakGuardListeningCounts = emptyMasterPeakGuardListeningCounts();

const randomByte = () => {
  const value = new Uint8Array(1);
  crypto.getRandomValues(value);
  return value[0];
};
let initialCandidateFirst = (randomByte() & 1) === 1;
let controlVariant: MasterPeakGuardVariant = (randomByte() & 1) === 1
  ? "peak-guard-candidate"
  : "current-master";

const isBusy = () => preparing || startingPlayback || finalizingPlayback || playing;
const recordedJudgmentCount = () => counts["current-master-cleaner"] +
  counts["peak-guard-candidate-cleaner"] + counts["no-difference"] +
  counts["both-rough"] + counts.unsure + counts.controlNoDifference +
  counts.controlBothRough + counts.controlUnsure + counts.controlDifferenceReported;

const updateSummary = () => {
  summary.textContent = JSON.stringify(buildMasterPeakGuardListeningSummary(counts, blockClosed), null, 2);
};

const updateControls = () => {
  const busy = isBusy();
  const ready = prepared !== null;
  fileInput.disabled = busy || blockClosed || ready;
  prepareButton.disabled = busy || blockClosed || ready;
  listenButtons.forEach((button) => {
    const label = button.dataset.label as MasterPeakGuardBlindLabel;
    const correctTurn = heard.size === 0 ? label === "a" : heard.has("a") && label === "b";
    button.disabled = !ready || busy || heard.has(label) || !correctTurn;
  });
  ratingButtons.forEach((button) => { button.disabled = !ratingReady || busy; });
  artifactInputs.forEach((input) => { input.disabled = !ratingReady || busy; });
  stopButton.disabled = (!preparing && !startingPlayback && !playing) || finalizingPlayback ||
    (preparing && preparationCancellationRequested);
  clearSongButton.disabled = !ready || busy;
  main.setAttribute("aria-busy", String(preparing || startingPlayback || finalizingPlayback));
};

const clearRatingAuthority = () => {
  ratingReady = false;
  heard.clear();
  for (const input of artifactInputs) input.checked = false;
};

const cancelCurrentOperation = (message: string) => {
  const abortedPreparation = preparationAttemptPending;
  const abortedEligible = prepared !== null;
  if (preparing) preparationCancellationRequested = true;
  activeGeneration += 1;
  activePreviewCancel?.();
  activePreviewCancel = null;
  try { engine?.setExpectedOutputActive(false); } catch { /* Best-effort diagnostic cleanup. */ }
  activeHealthBaseline = null;
  activeHealthStartedAt = null;
  playing = false;
  clearRatingAuthority();
  fileInput.value = "";
  if (abortedPreparation) {
    counts.preparationAborted += 1;
    preparationAttemptPending = false;
  }
  if (abortedEligible) {
    counts.pendingEligible -= 1;
    counts.eligibleAbortedOrUnhealthy += 1;
    prepared = null;
  }
  if (abortedEligible) {
    prepareStatus.textContent = "The stopped trial was released from memory. Choose a song to prepare a new trial.";
  } else if (abortedPreparation) {
    prepareStatus.textContent = "Preparation stopped; no comparison was retained.";
  }
  listenStatus.textContent = message;
  errorStatus.textContent = "";
  updateSummary();
  updateControls();
};

const ensureAudio = async () => {
  if (!context || context.state === "closed") {
    const ownedContext = new AudioContext();
    context = ownedContext;
    engine = new MasterPeakGuardAuditionEngine(ownedContext);
    ownedContext.addEventListener("statechange", () => {
      if (ownedContext === context && (isBusy() || heard.size > 0 || ratingReady) &&
        ownedContext.state !== "running") {
        cancelCurrentOperation("Browser audio was interrupted. This comparison was not accepted.");
      }
    });
  }
  await engine!.resume();
  if (context.state !== "running" || !await engine!.enableHealthMonitoring()) {
    throw new Error("Protected browser audio monitoring is unavailable");
  }
};

const createBoundedOverlapPreview = (decoded: AudioBuffer): PreMasterStereoPreview => {
  const durationSeconds = 10;
  const frameCount = Math.round(decoded.sampleRate * durationSeconds);
  if (decoded.length < frameCount || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) {
    throw new RangeError("A comparison track must contain at least ten seconds of mono or stereo audio");
  }
  const startFrame = Math.min(Math.floor(decoded.length / 3), decoded.length - frameCount);
  const fadeFrames = Math.round(decoded.sampleRate * 0.05);
  // Bounded adversarial construction: two perfectly correlated copies at the
  // equal-power midpoint, each using the +3 dB trim parameter limit. The live
  // trim policy and no-repeat rule make this stricter than a reachable party.
  const overlapGain = 2 * Math.SQRT1_2 * 10 ** (3 / 20);
  const channels = [0, 1].map((channel) => {
    const source = decoded.getChannelData(Math.min(channel, decoded.numberOfChannels - 1));
    return Float32Array.from({ length: frameCount }, (_, frame) => {
      const fadeIn = Math.min(1, frame / Math.max(1, fadeFrames));
      const fadeOut = Math.min(1, (frameCount - 1 - frame) / Math.max(1, fadeFrames));
      return source[startFrame + frame] * Math.min(fadeIn, fadeOut) * overlapGain;
    });
  }) as [Float32Array, Float32Array];
  return Object.freeze({
    kind: "pre-master-stereo/v1",
    requiredMasterVersion: MASTER_DSP_V1.version,
    sampleRate: decoded.sampleRate,
    channels: Object.freeze(channels) as readonly [Float32Array, Float32Array]
  });
};

const postMasterPreview = (
  channels: readonly [Float32Array, Float32Array],
  sampleRate: number
): Readonly<{ sampleRate: number; channels: readonly [Float32Array, Float32Array] }> => Object.freeze({
  sampleRate,
  channels
});

prepareButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file || isBusy() || blockClosed) {
    if (!file) prepareStatus.textContent = "Choose one local song first.";
    return;
  }
  const generation = ++activeGeneration;
  preparing = true;
  preparationAttemptPending = true;
  preparationCancellationRequested = false;
  prepared = null;
  clearRatingAuthority();
  counts.attempted += 1;
  updateControls();
  prepareStatus.textContent = "Reading, decoding, and rendering one bounded blinded trial locally…";
  listenStatus.textContent = "Cancel remains available; another preparation cannot start until cleanup finishes.";
  errorStatus.textContent = "";
  let rejectionReason: MasterPeakGuardRejectionReason = "audio-initialization";
  try {
    await ensureAudio();
    if (generation !== activeGeneration || !context) return;
    rejectionReason = "file-read-or-decode";
    const bytes = await file.arrayBuffer();
    if (generation !== activeGeneration) return;
    const decoded = await context.decodeAudioData(bytes);
    if (generation !== activeGeneration) return;
    rejectionReason = "preview-construction";
    const boundedOverlap = createBoundedOverlapPreview(decoded);
    const trialOrdinal = recordedJudgmentCount() + 1;
    rejectionReason = "paired-render";
    const comparison = await renderMasterPeakGuardListeningComparison(boundedOverlap, trialOrdinal);
    if (generation !== activeGeneration) return;
    const eligibility = assessMasterPeakGuardListeningEligibility(comparison);
    if (!eligibility.eligible) {
      rejectionReason = eligibility.reason;
      throw new Error(eligibility.reason);
    }
    rejectionReason = "level-match-or-native-rate";
    const audition = buildMasterPeakGuardAuditionPair(comparison);
    if (generation !== activeGeneration) return;
    if (audition.sampleRate !== context.sampleRate) throw new Error("native-rate-mismatch");
    const plan = buildMasterPeakGuardTrialPlan(trialOrdinal, initialCandidateFirst, controlVariant);
    const variantPreviews = Object.freeze({
      "current-master": postMasterPreview(audition.currentMaster, audition.sampleRate),
      "peak-guard-candidate": postMasterPreview(audition.peakGuardCandidate, audition.sampleRate)
    });
    prepared = Object.freeze({
      plan,
      previews: Object.freeze({
        a: variantPreviews[plan.order.a],
        b: variantPreviews[plan.order.b]
      })
    });
    preparationAttemptPending = false;
    counts.technicallyEligible += 1;
    counts.pendingEligible += 1;
    fileInput.value = "";
    prepareStatus.textContent = "Two anonymous, attenuation-matched ten-second renders are ready. Mazzy stopped retaining references to the file, full decode, and unmatched renders.";
    listenStatus.textContent = "Listen to Version 1 and Version 2 before recording one judgment.";
  } catch (error) {
    if (generation !== activeGeneration) return;
    preparationAttemptPending = false;
    counts.technicallyRejected += 1;
    counts.rejectionReasons[rejectionReason] += 1;
    prepared = null;
    fileInput.value = "";
    prepareStatus.textContent = "No private comparison is ready.";
    const reason = error instanceof Error ? error.message : "comparison-failed";
    errorStatus.textContent = reason === "current-master-not-overloaded"
      ? "This bounded adversarial overlap did not overload Mazzy’s current master. Nothing was amplified further; try another dynamic song."
      : "Could not create an eligible bounded comparison. Try another dynamic mono/stereo song at least ten seconds long.";
    listenStatus.textContent = "No rating was accepted.";
  } finally {
    preparing = false;
    preparationCancellationRequested = false;
    updateSummary();
    updateControls();
  }
});

const finishPlayback = async (generation: number, label: MasterPeakGuardBlindLabel, duration: number) => {
  if (generation !== activeGeneration || !engine || !context) return;
  activePreviewCancel = null;
  engine.setExpectedOutputActive(false);
  playing = false;
  finalizingPlayback = true;
  updateControls();
  const endedAt = context.currentTime;
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    if (generation !== activeGeneration || !activeHealthBaseline || activeHealthStartedAt == null) return;
    const evaluation = evaluateMasterPeakGuardAuditionHealth(
      activeHealthBaseline,
      engine.getHealthSnapshot(),
      duration,
      endedAt - activeHealthStartedAt
    );
    activeHealthBaseline = null;
    activeHealthStartedAt = null;
    if (evaluation.passed && context.state === "running") {
      heard.add(label);
      ratingReady = heard.size === 2;
      listenStatus.textContent = ratingReady
        ? "Both anonymous versions completed with valid browser-audio evidence. Record one judgment."
        : `Version ${label === "a" ? "1" : "2"} completed. Listen to the other version.`;
      if (ratingReady) ratingGroup.focus();
    } else {
      if (prepared) {
        counts.pendingEligible -= 1;
        counts.eligibleAbortedOrUnhealthy += 1;
        prepared = null;
      }
      prepareStatus.textContent = "The unhealthy trial was released from memory. Choose a song to prepare a new trial.";
      clearRatingAuthority();
      listenStatus.textContent = "The browser-audio check was incomplete or unhealthy, so this trial cannot support a judgment.";
    }
  } finally {
    finalizingPlayback = false;
    updateSummary();
    updateControls();
  }
};

for (const button of listenButtons) {
  button.addEventListener("click", async () => {
    if (!prepared || !engine || !context || isBusy()) return;
    const label = button.dataset.label as MasterPeakGuardBlindLabel;
    const generation = ++activeGeneration;
    startingPlayback = true;
    ratingReady = false;
    for (const input of artifactInputs) input.checked = false;
    updateControls();
    listenStatus.textContent = `Starting anonymous Version ${label === "a" ? "1" : "2"}…`;
    errorStatus.textContent = "";
    try {
      await engine.resume();
      if (generation !== activeGeneration || context.state !== "running") throw new Error("Audio did not resume");
      if (!await engine.resetHealthMonitoring() || generation !== activeGeneration) {
        throw new Error("Audio monitoring did not reset");
      }
      const snapshot = engine.getHealthSnapshot();
      activeHealthBaseline = Object.freeze({
        snapshot,
        contextStateCount: snapshot.contextStates.length
      });
      activeHealthStartedAt = context.currentTime;
      const preview = prepared.previews[label];
      const duration = preview.channels[0].length / preview.sampleRate;
      engine.setExpectedOutputActive(true);
      playing = true;
      activePreviewCancel = engine.play(
        preview.channels,
        preview.sampleRate,
        () => { void finishPlayback(generation, label, duration); }
      );
      listenStatus.textContent = `Playing anonymous Version ${label === "a" ? "1" : "2"}…`;
    } catch {
      if (generation !== activeGeneration) return;
      try { engine.setExpectedOutputActive(false); } catch { /* Best-effort cleanup. */ }
      activeHealthBaseline = null;
      activeHealthStartedAt = null;
      playing = false;
      clearRatingAuthority();
      if (prepared) {
        counts.pendingEligible -= 1;
        counts.eligibleAbortedOrUnhealthy += 1;
        prepared = null;
      }
      prepareStatus.textContent = "The failed trial was released from memory. Choose a song to prepare a new trial.";
      errorStatus.textContent = "Playback failed safely. This trial cannot support a judgment.";
    } finally {
      startingPlayback = false;
      updateSummary();
      updateControls();
    }
  });
}

stopButton.addEventListener("click", () => {
  cancelCurrentOperation("Preparation or audio stopped. Prepare a new trial before rating.");
});

for (const button of ratingButtons) {
  button.addEventListener("click", () => {
    if (!prepared || !ratingReady || isBusy()) return;
    const result = mapMasterPeakGuardRating(
      button.dataset.rating as MasterPeakGuardListeningRating,
      prepared.plan
    );
    if (result === "control-no-difference") counts.controlNoDifference += 1;
    else if (result === "control-both-rough") counts.controlBothRough += 1;
    else if (result === "control-unsure") counts.controlUnsure += 1;
    else if (result === "control-difference-reported") counts.controlDifferenceReported += 1;
    else counts[result] += 1;
    for (const input of artifactInputs) {
      if (input.checked) counts.artifactReasons[input.dataset.artifact as MasterPeakGuardArtifactReason] += 1;
    }
    counts.healthyCompletedPairs += 1;
    counts.pendingEligible -= 1;
    if (prepared.plan.kind === "aa-control") counts.controlsCompleted += 1;
    else if (prepared.plan.order.a === "peak-guard-candidate") counts.candidateFirstCompleted += 1;
    else counts.currentFirstCompleted += 1;
    prepared = null;
    clearRatingAuthority();
    blockClosed = recordedJudgmentCount() >= MASTER_PEAK_GUARD_BLIND_BLOCK_SIZE;
    prepareStatus.textContent = "The rated trial was released from memory. Choose a song to prepare the next trial.";
    updateSummary();
    if (blockClosed) {
      listenStatus.textContent = "The eight-trial blinded block is closed. Aggregate outcomes are now visible; discard them to begin a newly randomized block.";
    } else {
      listenStatus.textContent = "One private blinded judgment was recorded. Choose a song to prepare the next immutable trial.";
      prepareButton.focus();
    }
    updateControls();
  });
}

clearSongButton.addEventListener("click", () => {
  if (isBusy()) return;
  if (prepared) {
    counts.pendingEligible -= 1;
    counts.eligibleAbortedOrUnhealthy += 1;
  }
  prepared = null;
  clearRatingAuthority();
  fileInput.value = "";
  prepareStatus.textContent = "Private renders cleared; Mazzy stopped retaining their references.";
  listenStatus.textContent = "Choose another song to prepare a new blinded trial.";
  updateSummary();
  updateControls();
});

discardFeedbackButton.addEventListener("click", () => {
  if (isBusy()) return;
  counts = emptyMasterPeakGuardListeningCounts();
  prepared = null;
  blockClosed = false;
  clearRatingAuthority();
  initialCandidateFirst = (randomByte() & 1) === 1;
  controlVariant = (randomByte() & 1) === 1 ? "peak-guard-candidate" : "current-master";
  updateSummary();
  listenStatus.textContent = "This tab’s aggregate judgments were discarded. A new blinded block is ready.";
  prepareButton.focus();
  updateControls();
});

const cancelForEnvironment = (message: string) => {
  if (isBusy() || heard.size > 0 || ratingReady) cancelCurrentOperation(message);
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") cancelForEnvironment("The page was hidden, so the active trial was invalidated.");
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  cancelForEnvironment("The available media devices changed, so the active trial was invalidated.");
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (preparing || startingPlayback || playing)) {
    event.preventDefault();
    cancelCurrentOperation("Preparation or audio stopped. Prepare a new trial before rating.");
  }
});
window.addEventListener("beforeunload", (event) => {
  if (!isBusy()) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pagehide", () => {
  cancelCurrentOperation("Audio stopped.");
  prepared = null;
  fileInput.value = "";
  engine?.dispose();
  void context?.close().catch(() => undefined);
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

updateSummary();
updateControls();
