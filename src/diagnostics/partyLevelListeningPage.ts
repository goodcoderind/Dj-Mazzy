import { AnalysisClient } from "../analysis/AnalysisClient";
import { normalizeProgramLevel, type ProgramLevelAnalysis } from "../analysis/programLevel";
import { AudioEngine } from "../audio/AudioEngine";
import { MASTER_DSP_V1 } from "../audio/masterDsp";
import type { PreMasterStereoPreview } from "./transitionRehearsal";
import { evaluatePrivateListeningHealth, type ListeningHealthBaseline } from "./keyLockListeningEvidence";
import {
  buildPartyLevelListeningCandidate,
  PARTY_LEVEL_LISTENING_TARGETS,
  type PartyLevelListeningCandidate,
  type PartyLevelListeningTarget
} from "./partyLevelListening";

type TrackSide = "a" | "b";
type Rating = "even" | "a-louder" | "b-louder" | "too-loud" | "too-quiet" | "unsure";
type PreparedTrack = Readonly<{ excerpt: AudioBuffer; level: ProgramLevelAnalysis }>;

const fileA = document.querySelector<HTMLInputElement>("#file-a")!;
const fileB = document.querySelector<HTMLInputElement>("#file-b")!;
const prepareButton = document.querySelector<HTMLButtonElement>("#prepare")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const targetSelect = document.querySelector<HTMLSelectElement>("#target")!;
const prepareStatus = document.querySelector<HTMLElement>("#prepare-status")!;
const candidateStatus = document.querySelector<HTMLElement>("#candidate")!;
const listenStatus = document.querySelector<HTMLElement>("#listen-status")!;
const summary = document.querySelector<HTMLElement>("#summary")!;
const clearSongsButton = document.querySelector<HTMLButtonElement>("#clear-songs")!;
const discardFeedbackButton = document.querySelector<HTMLButtonElement>("#discard-feedback")!;
const listenButtons = [...document.querySelectorAll<HTMLButtonElement>("button.listen")];
const ratingButtons = [...document.querySelectorAll<HTMLButtonElement>("button.rating")];

let context: AudioContext | null = null;
let engine: AudioEngine | null = null;
let analysisClient: AnalysisClient | null = null;
let preparedTracks: Readonly<Record<TrackSide, PreparedTrack>> | null = null;
let activePreviewCancel: (() => void) | null = null;
let activeGeneration = 0;
let busy = false;
let playing = false;
let ratingReadyTarget: PartyLevelListeningTarget | null = null;
let activeHealthBaseline: ListeningHealthBaseline | null = null;
let activeHealthStartedAt: number | null = null;

const heard = new Map<PartyLevelListeningTarget, Set<TrackSide>>(
  PARTY_LEVEL_LISTENING_TARGETS.map((target) => [target, new Set<TrackSide>()])
);
const emptyRatings = () => ({ even: 0, "a-louder": 0, "b-louder": 0, "too-loud": 0, "too-quiet": 0, unsure: 0 });
const ratings: Record<PartyLevelListeningTarget, Record<Rating, number>> = {
  [-16]: emptyRatings(),
  [-14]: emptyRatings(),
  [-12]: emptyRatings()
};

const selectedTarget = () => Number(targetSelect.value) as PartyLevelListeningTarget;

const candidateFor = (target = selectedTarget()): PartyLevelListeningCandidate | null =>
  preparedTracks
    ? buildPartyLevelListeningCandidate(preparedTracks.a.level, preparedTracks.b.level, target)
    : null;

const updateSummary = () => {
  summary.textContent = JSON.stringify({
    schemaVersion: "party-level-private-listening/v1",
    status: "human-judgment-only",
    privacy: "tab-memory aggregate counts only; no audio, filenames, measurements, timestamps, persistence, upload, or export",
    evidenceScope: "subjective two-track target comparison; not calibration approval or output-device proof",
    ratings
  }, null, 2);
};

const updateCandidate = () => {
  const candidate = candidateFor();
  if (!candidate) {
    candidateStatus.textContent = "Prepare songs to see bounded trim estimates.";
    candidateStatus.className = "muted";
    return;
  }
  const track = (label: string, value: PartyLevelListeningCandidate["trackA"]) =>
    `${label}: trim ${value.trimDb >= 0 ? "+" : ""}${value.trimDb.toFixed(1)} dB · predicted ${value.predictedIntegratedLufs.toFixed(1)} LUFS · estimated peak ${value.predictedEstimatedTruePeakDbtp.toFixed(1)} dBTP`;
  candidateStatus.textContent = `${track("A", candidate.trackA)}. ${track("B", candidate.trackB)}.${candidate.warning === "none" ? "" : " One or both tracks cannot reach this target inside Mazzy’s trim/peak bounds, so this pair cannot produce a target rating."}`;
  candidateStatus.className = candidate.warning === "none" ? "muted" : "warning";
};

const updateControls = () => {
  const ready = preparedTracks !== null;
  fileA.disabled = busy || playing;
  fileB.disabled = busy || playing;
  prepareButton.disabled = busy || playing;
  targetSelect.disabled = !ready || busy || playing;
  listenButtons.forEach((button) => { button.disabled = !ready || busy || playing; });
  stopButton.disabled = !busy && !playing;
  clearSongsButton.disabled = !ready || busy || playing;
  const canRate = ratingReadyTarget === selectedTarget() && !busy && !playing;
  ratingButtons.forEach((button) => { button.disabled = !canRate; });
};

const cancelCurrentOperation = (message: string) => {
  activeGeneration += 1;
  analysisClient?.dispose();
  analysisClient = null;
  activePreviewCancel?.();
  activePreviewCancel = null;
  engine?.setExpectedOutputActive(false);
  activeHealthBaseline = null;
  activeHealthStartedAt = null;
  busy = false;
  playing = false;
  ratingReadyTarget = null;
  listenStatus.textContent = message;
  updateControls();
};

const createExcerpt = (decoded: AudioBuffer, seconds = 8) => {
  const frameCount = Math.round(decoded.sampleRate * seconds);
  if (decoded.length < frameCount || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) {
    throw new RangeError("A comparison track must contain at least 8 seconds of mono or stereo audio");
  }
  const startFrame = Math.min(Math.floor(decoded.length / 3), decoded.length - frameCount);
  const excerpt = context!.createBuffer(2, frameCount, decoded.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const source = decoded.getChannelData(Math.min(channel, decoded.numberOfChannels - 1));
    excerpt.copyToChannel(new Float32Array(source.subarray(startFrame, startFrame + frameCount)), channel);
  }
  return excerpt;
};

const prepareTrack = async (file: File, generation: number): Promise<PreparedTrack> => {
  if (!context || !analysisClient) throw new Error("The local analysis path is unavailable");
  const bytes = await file.arrayBuffer();
  if (generation !== activeGeneration) throw new DOMException("Cancelled", "AbortError");
  const decoded = await context.decodeAudioData(bytes);
  if (generation !== activeGeneration) throw new DOMException("Cancelled", "AbortError");
  const result = await analysisClient.analyzeAudioBuffer(decoded);
  if (generation !== activeGeneration) throw new DOMException("Cancelled", "AbortError");
  const level = normalizeProgramLevel(result.programLevel);
  if (!level || level.measurement.status !== "measured") {
    throw new Error("This track does not have a usable local level measurement");
  }
  return Object.freeze({ excerpt: createExcerpt(decoded), level });
};

const ensureAudio = async () => {
  if (!context || context.state === "closed") {
    context = new AudioContext();
    engine = new AudioEngine(context);
    context.addEventListener("statechange", () => {
      if ((busy || playing) && context?.state !== "running") {
        cancelCurrentOperation("Browser audio was interrupted. This comparison was not accepted.");
      }
    });
  }
  await engine!.resume();
  if (context.state !== "running" || !await engine!.enableAudioHealthMonitoring()) {
    throw new Error("Protected browser audio monitoring is unavailable");
  }
};

prepareButton.addEventListener("click", async () => {
  const first = fileA.files?.[0];
  const second = fileB.files?.[0];
  if (!first || !second || busy || playing) {
    prepareStatus.textContent = first && second ? prepareStatus.textContent : "Choose both local songs first.";
    return;
  }
  const generation = ++activeGeneration;
  busy = true;
  ratingReadyTarget = null;
  updateControls();
  prepareStatus.textContent = "Reading, decoding, and measuring two songs locally…";
  listenStatus.textContent = "Preparation can be cancelled at any time.";
  try {
    await ensureAudio();
    if (generation !== activeGeneration) return;
    analysisClient?.dispose();
    analysisClient = new AnalysisClient();
    // The worker is serial, so decode/analyze sequentially as well. This keeps
    // two full decoded songs from being retained at once; only the first
    // anonymous eight-second excerpt survives while the second song is read.
    const a = await prepareTrack(first, generation);
    const b = await prepareTrack(second, generation);
    if (generation !== activeGeneration) return;
    analysisClient.dispose();
    analysisClient = null;
    preparedTracks = Object.freeze({ a, b });
    for (const target of PARTY_LEVEL_LISTENING_TARGETS) heard.get(target)!.clear();
    fileA.value = "";
    fileB.value = "";
    prepareStatus.textContent = "Two anonymous excerpts are ready in this tab. Filenames and full decoded songs were discarded.";
    listenStatus.textContent = "Choose a target, then listen to both excerpts.";
    updateCandidate();
  } catch {
    if (generation !== activeGeneration) return;
    analysisClient?.dispose();
    analysisClient = null;
    preparedTracks = null;
    prepareStatus.textContent = "Could not prepare both songs. Use mono/stereo audio files at least 8 seconds long, then try again.";
    listenStatus.textContent = "No private comparison is ready.";
    updateCandidate();
  } finally {
    if (generation === activeGeneration) {
      busy = false;
      updateControls();
    }
  }
});

const previewFor = (track: PreparedTrack, trimDb: number): PreMasterStereoPreview => {
  const gain = 10 ** (trimDb / 20);
  const left = Float32Array.from(track.excerpt.getChannelData(0), (sample) => sample * gain);
  const right = Float32Array.from(track.excerpt.getChannelData(1), (sample) => sample * gain);
  return Object.freeze({
    kind: "pre-master-stereo/v1",
    requiredMasterVersion: MASTER_DSP_V1.version,
    sampleRate: track.excerpt.sampleRate,
    channels: Object.freeze([left, right]) as readonly [Float32Array, Float32Array]
  });
};

const finishPlayback = async (
  generation: number,
  target: PartyLevelListeningTarget,
  side: TrackSide
) => {
  if (generation !== activeGeneration || !engine || !context) return;
  activePreviewCancel = null;
  engine.setExpectedOutputActive(false);
  playing = false;
  busy = true;
  updateControls();
  const endedAt = context.currentTime;
  await new Promise((resolve) => window.setTimeout(resolve, 1_100));
  if (generation !== activeGeneration || !activeHealthBaseline || activeHealthStartedAt == null) return;
  const health = engine.getAudioHealthSnapshot();
  const evaluation = evaluatePrivateListeningHealth(
    activeHealthBaseline,
    health,
    endedAt - activeHealthStartedAt,
    false,
    false
  );
  activeHealthBaseline = null;
  activeHealthStartedAt = null;
  busy = false;
  if (evaluation.passed && context.state === "running") {
    heard.get(target)!.add(side);
    const targetWasReached = candidateFor(target)?.warning === "none";
    ratingReadyTarget = targetWasReached && heard.get(target)!.size === 2 ? target : null;
    listenStatus.textContent = ratingReadyTarget === target
      ? `Both anonymous excerpts completed cleanly at ${target} LUFS. Record what you heard.`
      : targetWasReached
        ? `Track ${side.toUpperCase()} completed cleanly. Listen to the other track at the same target.`
        : "Playback completed cleanly, but this pair cannot reach the selected target inside Mazzy’s bounds and cannot support a rating.";
  } else {
    ratingReadyTarget = null;
    listenStatus.textContent = "The browser-audio check was incomplete or unhealthy, so this playback cannot support a rating.";
  }
  updateControls();
};

for (const button of listenButtons) {
  button.addEventListener("click", async () => {
    if (!preparedTracks || !engine || !context || busy || playing) return;
    const side = button.dataset.track as TrackSide;
    const target = selectedTarget();
    const candidate = candidateFor(target);
    if (!candidate) return;
    const generation = ++activeGeneration;
    busy = true;
    ratingReadyTarget = null;
    updateControls();
    listenStatus.textContent = `Starting anonymous track ${side.toUpperCase()} at ${target} LUFS…`;
    try {
      await engine.resume();
      if (generation !== activeGeneration || context.state !== "running") throw new Error("Audio did not resume");
      if (!await engine.resetAudioHealthMonitoringForDiagnostic() || generation !== activeGeneration) {
        throw new Error("Audio monitoring did not reset");
      }
      const health = engine.getAudioHealthSnapshot();
      activeHealthBaseline = {
        renderedFrames: health.renderedFrames,
        expectedActiveFrames: health.expectedActiveFrames,
        silentFrames: health.silentFrames,
        renderQuanta: health.renderQuanta,
        nonFiniteSamples: health.nonFiniteSamples,
        clippedSamples: health.clippedSamples,
        processorErrors: health.processorErrors,
        reports: health.reports
      };
      activeHealthStartedAt = context.currentTime;
      engine.setExpectedOutputActive(true);
      const trackCandidate = side === "a" ? candidate.trackA : candidate.trackB;
      playing = true;
      busy = false;
      activePreviewCancel = engine.playProtectedPreview(
        previewFor(preparedTracks[side], trackCandidate.trimDb),
        () => { void finishPlayback(generation, target, side); }
      );
      listenStatus.textContent = `Playing anonymous track ${side.toUpperCase()} at ${target} LUFS…`;
      updateControls();
    } catch {
      if (generation !== activeGeneration) return;
      engine.setExpectedOutputActive(false);
      activeHealthBaseline = null;
      activeHealthStartedAt = null;
      busy = false;
      playing = false;
      listenStatus.textContent = "Playback failed safely. This attempt cannot support a rating.";
      updateControls();
    }
  });
}

targetSelect.addEventListener("change", () => {
  ratingReadyTarget = heard.get(selectedTarget())!.size === 2 && candidateFor()?.warning === "none"
    ? selectedTarget()
    : null;
  updateCandidate();
  listenStatus.textContent = `Candidate ${selectedTarget()} LUFS selected. Listen to both excerpts before rating.`;
  updateControls();
});

stopButton.addEventListener("click", () => {
  cancelCurrentOperation("Preparation or audio stopped. No rating was accepted.");
});

for (const button of ratingButtons) {
  button.addEventListener("click", () => {
    const target = selectedTarget();
    if (ratingReadyTarget !== target || busy || playing) return;
    ratings[target][button.dataset.rating as Rating] += 1;
    ratingReadyTarget = null;
    heard.get(target)!.clear();
    updateSummary();
    listenStatus.textContent = "Private judgment recorded as an aggregate count in this tab only.";
    updateControls();
  });
}

clearSongsButton.addEventListener("click", () => {
  if (busy || playing) return;
  preparedTracks = null;
  ratingReadyTarget = null;
  for (const target of PARTY_LEVEL_LISTENING_TARGETS) heard.get(target)!.clear();
  fileA.value = "";
  fileB.value = "";
  prepareStatus.textContent = "Private excerpts and measurements cleared.";
  listenStatus.textContent = "Choose two songs to prepare another comparison.";
  updateCandidate();
  updateControls();
});

discardFeedbackButton.addEventListener("click", () => {
  for (const target of PARTY_LEVEL_LISTENING_TARGETS) ratings[target] = emptyRatings();
  updateSummary();
  listenStatus.textContent = "This tab’s aggregate judgments were discarded.";
});

window.addEventListener("pagehide", () => {
  cancelCurrentOperation("Audio stopped.");
  preparedTracks = null;
  fileA.value = "";
  fileB.value = "";
  engine?.disposeAudioHealthMonitoring();
  void context?.close();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

updateSummary();
updateControls();
