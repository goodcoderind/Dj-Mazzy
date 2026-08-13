import { MASTER_DSP_V1 } from "../audio/masterDsp";
import { TRANSITION_DSP_VERSION, type TransitionDspV2 } from "../audio/transitionDsp";
import { TRANSITION_PLAN_SCHEMA_VERSION } from "../domain/versions";
import { renderTransitionRehearsal } from "./transitionRehearsal";

type Check = Readonly<{ name: string; passed: boolean; evidence: string }>;

const runButton = document.querySelector<HTMLButtonElement>("#run");
const status = document.querySelector<HTMLElement>("#status");
const results = document.querySelector<HTMLTableSectionElement>("#results");
const summary = document.querySelector<HTMLElement>("#summary");
if (!runButton || !status || !results || !summary) throw new Error("Diagnostic page is incomplete");

const sampleRate = 48_000;
const durationSeconds = 5;
const createBuffer = (left: (time: number) => number, right: (time: number) => number) => {
  const context = new OfflineAudioContext(2, sampleRate * durationSeconds, sampleRate);
  const buffer = context.createBuffer(2, sampleRate * durationSeconds, sampleRate);
  for (let index = 0; index < buffer.length; index += 1) {
    const time = index / sampleRate;
    buffer.getChannelData(0)[index] = left(time);
    buffer.getChannelData(1)[index] = right(time);
  }
  return buffer;
};

const dsp = (trimDb = 0): TransitionDspV2 => Object.freeze({
  schemaVersion: TRANSITION_DSP_VERSION,
  planSchemaVersion: TRANSITION_PLAN_SCHEMA_VERSION,
  template: "safe-fade",
  durationSeconds: 1,
  targetCueSeconds: 0.5,
  source: Object.freeze({
    playbackRate: 1.25,
    trimDb,
    gainCurve: Object.freeze([1, 0]),
    initialEqDb: Object.freeze({ low: 0, mid: 0, high: 0 }),
    eqRamps: Object.freeze([]),
    filterSweep: null
  }),
  target: Object.freeze({
    playbackRate: 1,
    trimDb: 0,
    gainCurve: Object.freeze([0, 1]),
    initialEqDb: Object.freeze({ low: 0, mid: 0, high: 0 }),
    eqRamps: Object.freeze([]),
    filterSweep: null
  }),
  outputStage: "pre-master",
  requiredMasterVersion: MASTER_DSP_V1.version
});

const filteredDsp = (): TransitionDspV2 => Object.freeze({
  ...dsp(),
  template: "filtered-fade",
  source: Object.freeze({
    ...dsp().source,
    playbackRate: 1,
    filterSweep: Object.freeze({ startOffsetSeconds: 0, durationSeconds: 1, fromHz: 20_000, toHz: 420 })
  })
});

const unfilteredComparisonDsp = (): TransitionDspV2 => Object.freeze({
  ...filteredDsp(),
  template: "safe-fade",
  source: Object.freeze({ ...filteredDsp().source, filterSweep: null })
});

const rms = (samples: Float32Array, startSeconds: number, endSeconds: number) => {
  const start = Math.floor(startSeconds * sampleRate);
  const end = Math.min(samples.length, Math.floor(endSeconds * sampleRate));
  let power = 0;
  for (let index = start; index < end; index += 1) power += samples[index] ** 2;
  return Math.sqrt(power / Math.max(1, end - start));
};

const maxDifference = (left: Float32Array, right: Float32Array) => {
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  return maximum;
};

const peakInWindow = (samples: Float32Array, expectedFrame: number, radiusFrames = 24) => {
  const start = Math.max(0, expectedFrame - radiusFrames);
  const end = Math.min(samples.length, expectedFrame + radiusFrames + 1);
  let frame = start;
  let amplitude = 0;
  for (let index = start; index < end; index += 1) {
    const candidate = Math.abs(samples[index]);
    if (candidate > amplitude) {
      amplitude = candidate;
      frame = index;
    }
  }
  return { frame, amplitude };
};

const createImpulseBuffer = (channel: 0 | 1, impulseSeconds: number) => createBuffer(
  (time) => channel === 0 && Math.round(time * sampleRate) === Math.round(impulseSeconds * sampleRate) ? 0.8 : 0,
  (time) => channel === 1 && Math.round(time * sampleRate) === Math.round(impulseSeconds * sampleRate) ? 0.8 : 0
);

const run = async () => {
  const checks: Check[] = [];
  const tone = (frequency: number) => (time: number) => 0.2 * Math.sin(2 * Math.PI * frequency * time);
  const options = { sourceCueSeconds: 2, preRollSeconds: 1, postRollSeconds: 1, outputSampleRate: sampleRate };
  // The source begins at track time 0.75s and runs at 1.25x, so its 1.375s
  // impulse must land at output time 0.5s. The target begins at its 0.5s cue
  // at output time 1s, so its 1.0s impulse must land at output time 1.5s.
  const sourceImpulse = createImpulseBuffer(0, 1.375);
  const targetImpulse = createImpulseBuffer(1, 1);
  const first = await renderTransitionRehearsal(sourceImpulse, targetImpulse, dsp(), options);
  const second = await renderTransitionRehearsal(sourceImpulse, targetImpulse, dsp(), options);
  const sourceExpectedFrame = Math.round(0.5 * sampleRate);
  const targetExpectedFrame = Math.round(1.5 * sampleRate);
  const sourcePeak = peakInWindow(first.preview.channels[0], sourceExpectedFrame);
  const targetPeak = peakInWindow(first.preview.channels[1], targetExpectedFrame);
  const sourceCrossTalk = peakInWindow(first.preview.channels[1], sourceExpectedFrame).amplitude;
  const targetCrossTalk = peakInWindow(first.preview.channels[0], targetExpectedFrame).amplitude;

  checks.push({
    name: "Source cue, 1.25× rate, and left-channel isolation",
    passed: sourcePeak.amplitude > 0.05 && Math.abs(sourcePeak.frame - sourceExpectedFrame) <= 2 && sourceCrossTalk <= 1e-7,
    evidence: `peak frame ${sourcePeak.frame} (expected ${sourceExpectedFrame} ±2) · opposite channel ${sourceCrossTalk.toExponential(2)}`
  });
  checks.push({
    name: "Target cue and right-channel isolation",
    passed: targetPeak.amplitude > 0.05 && Math.abs(targetPeak.frame - targetExpectedFrame) <= 2 && targetCrossTalk <= 1e-7,
    evidence: `peak frame ${targetPeak.frame} (expected ${targetExpectedFrame} ±2) · opposite channel ${targetCrossTalk.toExponential(2)}`
  });

  const sourceTone = createBuffer(tone(440), () => 0);
  const targetTone = createBuffer(() => 0, tone(660));
  const continuous = await renderTransitionRehearsal(sourceTone, targetTone, dsp(), options);
  const leftEnergy = rms(continuous.preview.channels[0], 0.2, 0.7);
  const rightEnergy = rms(continuous.preview.channels[1], 1.3, 1.8);
  checks.push({
    name: "Combined-stereo transition continuity",
    passed: leftEnergy > 0.05 && rightEnergy > 0.03 && !continuous.quality.reasons.some((reason) => reason.includes("silence gap")),
    evidence: continuous.quality.reasons.length ? continuous.quality.reasons.join(" ") : `left RMS ${leftEnergy.toFixed(4)} · right RMS ${rightEnergy.toFixed(4)} · no combined-stereo gap`
  });
  const difference = Math.max(
    maxDifference(first.preview.channels[0], second.preview.channels[0]),
    maxDifference(first.preview.channels[1], second.preview.channels[1])
  );
  checks.push({ name: "Repeat-render determinism", passed: difference <= 1e-7, evidence: `maximum sample difference ${difference.toExponential(2)}` });

  const trimmed = await renderTransitionRehearsal(sourceTone, targetTone, dsp(-6), options);
  const trimRatio = rms(trimmed.preview.channels[0], 0.2, 0.7) / leftEnergy;
  checks.push({ name: "−6 dB source trim", passed: Math.abs(trimRatio - 10 ** (-6 / 20)) <= 0.015, evidence: `measured amplitude ratio ${trimRatio.toFixed(4)}` });

  const filterSource = createBuffer(tone(3_000), () => 0);
  const unfiltered = await renderTransitionRehearsal(filterSource, targetTone, unfilteredComparisonDsp(), options);
  const filtered = await renderTransitionRehearsal(filterSource, targetTone, filteredDsp(), options);
  const unfilteredEarly = rms(unfiltered.preview.channels[0], 1.02, 1.12);
  const unfilteredLate = rms(unfiltered.preview.channels[0], 1.82, 1.92);
  const filteredEarly = rms(filtered.preview.channels[0], 1.02, 1.12);
  const filteredLate = rms(filtered.preview.channels[0], 1.82, 1.92);
  const earlyFilterRatio = filteredEarly / Math.max(unfilteredEarly, 1e-9);
  const lateFilterRatio = filteredLate / Math.max(unfilteredLate, 1e-9);
  checks.push({
    name: "Filtered Fade audibly removes outgoing high frequencies",
    passed: unfilteredEarly > 0.005 && unfilteredLate > 0.005 && earlyFilterRatio >= 0.8 && lateFilterRatio < 0.35 && filtered.quality.passed,
    evidence: `filtered/reference RMS ratio: early ${earlyFilterRatio.toFixed(3)} · late ${lateFilterRatio.toFixed(3)}`
  });

  results.replaceChildren(...checks.map((check) => {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const outcome = document.createElement("td");
    const evidence = document.createElement("td");
    name.textContent = check.name;
    outcome.textContent = check.passed ? "PASS" : "FAIL";
    outcome.className = check.passed ? "pass" : "fail";
    evidence.textContent = check.evidence;
    row.append(name, outcome, evidence);
    return row;
  }));
  const report = Object.freeze({
    schemaVersion: "transition-rehearsal-browser-check/v3",
    sampleRate,
    passed: checks.every((check) => check.passed),
    checks
  });
  status.textContent = report.passed ? "All local Web Audio checks passed." : "One or more local Web Audio checks failed.";
  summary.textContent = JSON.stringify(report, null, 2);
};

runButton.addEventListener("click", () => {
  runButton.disabled = true;
  status.textContent = "Rendering synthetic stereo transitions locally…";
  void run().catch((error) => {
    status.textContent = "The browser audio diagnostic failed to complete.";
    summary.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  }).finally(() => { runButton.disabled = false; });
});
