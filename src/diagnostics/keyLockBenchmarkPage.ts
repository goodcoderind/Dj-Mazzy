import { EXPERIMENTAL_KEY_LOCK_CONTRACT } from "../experimental/keyLockRuntime";
import { AudioEngine } from "../audio/AudioEngine";
import { DeckEngine } from "../audio/DeckEngine";
import { createSignalsmithPreparedKeyLockSource } from "../audio/signalsmithPreparedKeyLockSource";
import { evaluateKeyLockSmoke, KEY_LOCK_SMOKE_SCHEMA_VERSION } from "./keyLockSmoke";
import { carrierProminenceDb, estimateCarrierFrequency, estimatePulseRate, stereoLeakageDb } from "./keyLockMeasurement";

const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const statusNode = document.querySelector<HTMLElement>("#status")!;
const resultNode = document.querySelector<HTMLElement>("#result")!;
const rates = [0.94, 1, 1.06] as const;
const SOURCE_FREQUENCY_HZ = 440;
const SOURCE_PULSE_HZ = 16;
const requestedSampleRate = Number(new URLSearchParams(window.location.search).get("sampleRate") ?? 48_000);
const SAMPLE_RATE = requestedSampleRate === 44_100 ? 44_100 : 48_000;


const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const ONSET_PROCESSOR = "mazzy-key-lock-onset-v1";
const ONSET_WORKLET_SOURCE = `
class MazzyKeyLockOnset extends AudioWorkletProcessor {
  constructor() {
    super();
    this.arm = null;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === 'arm' && Number.isInteger(data.id) && Number.isInteger(data.expectedFrame)) {
        this.arm = { id: data.id, expectedFrame: data.expectedFrame, threshold: data.threshold,
          preStartPeak: [0, 0], firstFrame: [null, null], nonFinite: [0, 0], maxPeak: [0, 0], onsetSent: false };
        this.port.postMessage({ type: 'armed', id: data.id, armFrame: currentFrame });
      } else if (data && data.type === 'finalize' && this.arm && data.id === this.arm.id) {
        this.port.postMessage({ type: 'summary', id: this.arm.id,
          nonFinite: this.arm.nonFinite, maxPeak: this.arm.maxPeak });
        this.arm = null;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[channel] || input[0];
      if (source) output[channel].set(source);
    }
    const arm = this.arm;
    if (!arm) return true;
    const frames = input[0]?.length || 128;
    for (let offset = 0; offset < frames; offset += 1) {
      const absoluteFrame = currentFrame + offset;
      for (let channel = 0; channel < 2; channel += 1) {
        const sample = input[channel]?.[offset];
        if (sample != null && !Number.isFinite(sample)) { arm.nonFinite[channel] += 1; continue; }
        const peak = Math.abs(sample ?? 0);
        arm.maxPeak[channel] = Math.max(arm.maxPeak[channel], peak);
        if (absoluteFrame < arm.expectedFrame) arm.preStartPeak[channel] = Math.max(arm.preStartPeak[channel], peak);
        else if (arm.firstFrame[channel] === null && peak > arm.threshold) arm.firstFrame[channel] = absoluteFrame;
      }
      if (!arm.onsetSent && arm.firstFrame[0] !== null && arm.firstFrame[1] !== null) {
        this.port.postMessage({ type: 'onset', id: arm.id, firstFrame: arm.firstFrame,
          preStartPeak: arm.preStartPeak, nonFinite: arm.nonFinite });
        arm.onsetSent = true;
      }
    }
    return true;
  }
}
registerProcessor('${ONSET_PROCESSOR}', MazzyKeyLockOnset);`;
let abortRequested = false;
let cancelActiveRun: (() => void) | null = null;

stopButton.addEventListener("click", () => {
  if (!cancelActiveRun) return;
  abortRequested = true;
  cancelActiveRun?.();
  stopButton.disabled = true;
  statusNode.textContent = "Stopping the local check…";
});

runButton.addEventListener("click", async () => {
  abortRequested = false;
  runButton.disabled = true;
  stopButton.disabled = false;
  statusNode.setAttribute("aria-busy", "true");
  statusNode.textContent = "Running the local key-lock smoke check…";
  resultNode.textContent = "No report yet.";
  let context: AudioContext | null = null;
  let engine: AudioEngine | null = null;
  let tap: ReturnType<AudioEngine["createDiagnosticMasterTap"]> | null = null;
  let onsetTap: ReturnType<AudioEngine["connectDiagnosticMasterNode"]> | null = null;
  let onsetNode: AudioWorkletNode | null = null;
  let onsetModuleUrl: string | null = null;
  let currentDeck: DeckEngine | null = null;
  type OnsetObservation = Readonly<{
    firstFrame: readonly [number, number];
    preStartPeak: readonly [number, number];
    nonFinite: readonly [number, number];
  }>;
  const onsetWaiters = new Map<number, Readonly<{
    resolve: (value: OnsetObservation) => void;
    reject: (reason: Error) => void;
    timer: number;
  }>>();
  const armWaiters = new Map<number, Readonly<{
    resolve: (armFrame: number) => void;
    reject: (reason: Error) => void;
    timer: number;
  }>>();
  type CellSummary = Readonly<{ nonFinite: readonly [number, number]; maxPeak: readonly [number, number] }>;
  const summaryWaiters = new Map<number, Readonly<{
    resolve: (summary: CellSummary) => void;
    reject: (reason: Error) => void;
    timer: number;
  }>>();
  const assertNotAborted = () => {
    if (abortRequested) throw new DOMException("The check was stopped", "AbortError");
  };
  const settlePendingOnsets = (reason: Error) => {
    for (const waiter of onsetWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    onsetWaiters.clear();
    for (const waiter of armWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    armWaiters.clear();
    for (const waiter of summaryWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    summaryWaiters.clear();
  };
  cancelActiveRun = () => {
    settlePendingOnsets(new DOMException("The check was stopped", "AbortError"));
    currentDeck?.eject();
  };
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    await context.resume();
    assertNotAborted();
    const seconds = 12;
    const buffer = context.createBuffer(2, context.sampleRate * seconds, context.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        const pulse = Math.sin(2 * Math.PI * SOURCE_PULSE_HZ * index / context.sampleRate) >= 0 ? 1 : 0.25;
        const frequency = channel === 0 ? SOURCE_FREQUENCY_HZ : 660;
        data[index] = Math.sin(2 * Math.PI * frequency * index / context.sampleRate) * 0.03 * pulse;
      }
    }
    engine = new AudioEngine(context);
    engine.setDeckGain("a", 1);
    onsetModuleUrl = URL.createObjectURL(new Blob([ONSET_WORKLET_SOURCE], { type: "text/javascript" }));
    await context.audioWorklet.addModule(onsetModuleUrl);
    assertNotAborted();
    onsetNode = new AudioWorkletNode(context, ONSET_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    onsetTap = engine.connectDiagnosticMasterNode(onsetNode);
    let nextOnsetId = 1;
    onsetNode.port.onmessage = (event) => {
      const value = event.data as { type?: unknown; id?: unknown; armFrame?: unknown;
        firstFrame?: unknown; preStartPeak?: unknown; nonFinite?: unknown; maxPeak?: unknown };
      if (!Number.isInteger(value?.id)) return;
      if (value.type === "armed" && Number.isInteger(value.armFrame)) {
        const armWaiter = armWaiters.get(value.id as number);
        if (!armWaiter) return;
        armWaiters.delete(value.id as number);
        window.clearTimeout(armWaiter.timer);
        armWaiter.resolve(value.armFrame as number);
        return;
      }
      const validPair = (pair: unknown, integer = false) => Array.isArray(pair) && pair.length === 2 &&
        pair.every((entry) => integer ? Number.isInteger(entry) : Number.isFinite(entry));
      if (value.type === "summary" && validPair(value.nonFinite, true) && validPair(value.maxPeak)) {
        const summaryWaiter = summaryWaiters.get(value.id as number);
        if (!summaryWaiter) return;
        summaryWaiters.delete(value.id as number);
        window.clearTimeout(summaryWaiter.timer);
        summaryWaiter.resolve({ nonFinite: value.nonFinite as [number, number], maxPeak: value.maxPeak as [number, number] });
        return;
      }
      if (value.type !== "onset" || !validPair(value.firstFrame, true) ||
        !validPair(value.preStartPeak) || !validPair(value.nonFinite, true)) return;
      const waiter = onsetWaiters.get(value.id as number);
      if (!waiter) return;
      onsetWaiters.delete(value.id as number);
      window.clearTimeout(waiter.timer);
      waiter.resolve({ firstFrame: value.firstFrame as [number, number],
        preStartPeak: value.preStartPeak as [number, number], nonFinite: value.nonFinite as [number, number] });
    };
    const stereoTap = engine.createDiagnosticStereoMasterTap(32_768);
    tap = { analyser: stereoTap.analysers[0], dispose: stereoTap.dispose };
    const [leftAnalyser, rightAnalyser] = stereoTap.analysers;
    const measurements = [];
    let measuredLatencySeconds = 0;
    for (let index = 0; index < rates.length; index += 1) {
      if (index > 0) {
        // Keep the next observation window distinct from the prior worklet's
        // acknowledged stop/dispose boundary.
        await wait(120);
        assertNotAborted();
      }
      const rate = rates[index];
      const deck = new DeckEngine(engine, "a", createSignalsmithPreparedKeyLockSource);
      currentDeck = deck;
      deck.loadBuffer(buffer, `synthetic-${index}`);
      const prepared = await deck.prepareKeyLock();
      assertNotAborted();
      if (!prepared) throw new Error("Deck key-lock preparation failed");
      const state = deck.getKeyLockState();
      if (state.status !== "ready") throw new Error("Deck key-lock state was not ready");
      measuredLatencySeconds = Math.max(measuredLatencySeconds, state.latencySeconds);
      const onsetId = nextOnsetId++;
      const armResult = new Promise<number>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (!armWaiters.delete(onsetId)) return;
          reject(new Error("Protected-master observer did not acknowledge arming"));
        }, 1_000);
        armWaiters.set(onsetId, { resolve, reject, timer });
      });
      const start = context.currentTime + state.latencySeconds + 0.12;
      const expectedOnsetFrame = Math.round(start * context.sampleRate);
      const onsetResult = new Promise<OnsetObservation>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          const waiter = onsetWaiters.get(onsetId);
          if (!waiter) return;
          onsetWaiters.delete(onsetId);
          reject(new Error("Protected-master onset was not observed"));
        }, 2_000);
        onsetWaiters.set(onsetId, { resolve, reject, timer });
      });
      // Attach a rejection handler before any later await can cancel this
      // deferred; the same promise is still awaited below for normal control.
      void onsetResult.catch(() => undefined);
      onsetNode.port.postMessage({ type: "arm", id: onsetId, expectedFrame: expectedOnsetFrame, threshold: 0.001 });
      const armFrame = await armResult;
      assertNotAborted();
      const started = await deck.playPreparedKeyLockForDiagnostic(state.loadKey, index * 3, rate, start);
      assertNotAborted();
      if (!started) {
        settlePendingOnsets(new Error("Deck key-lock start was rejected safely"));
        throw new Error("Deck key-lock start was rejected safely");
      }
      const onset = await onsetResult;
      await wait((start - context.currentTime + 1.2) * 1000);
      if (abortRequested) throw new DOMException("The check was stopped", "AbortError");
      const cellSummaryResult = new Promise<CellSummary>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (!summaryWaiters.delete(onsetId)) return;
          reject(new Error("Protected-master cell summary was not observed"));
        }, 1_000);
        summaryWaiters.set(onsetId, { resolve, reject, timer });
      });
      onsetNode.port.postMessage({ type: "finalize", id: onsetId });
      const cellSummary = await cellSummaryResult;
      const stateBeforeCapture = deck.getKeyLockState();
      if (stateBeforeCapture.status !== "ready" || stateBeforeCapture.loadKey !== state.loadKey ||
        deck.getActivePlaybackBackend() !== "signalsmith") {
        throw new Error("Deck key-lock processor was not healthy before capture");
      }
      const samples = new Float32Array(leftAnalyser.fftSize);
      const rightSamples = new Float32Array(rightAnalyser.fftSize);
      leftAnalyser.getFloatTimeDomainData(samples);
      rightAnalyser.getFloatTimeDomainData(rightSamples);
      const stateAfterCapture = deck.getKeyLockState();
      if (stateAfterCapture.status !== "ready" || stateAfterCapture.loadKey !== state.loadKey ||
        deck.getActivePlaybackBackend() !== "signalsmith") {
        throw new Error("Deck key-lock processor was not healthy after capture");
      }
      const frequencyHz = estimateCarrierFrequency(samples, context.sampleRate, SOURCE_FREQUENCY_HZ);
      const centsError = 1200 * Math.log2(frequencyHz / SOURCE_FREQUENCY_HZ);
      const rightFrequencyHz = estimateCarrierFrequency(rightSamples, context.sampleRate, 660);
      const rightCentsError = 1200 * Math.log2(rightFrequencyHz / 660);
      const measuredStereoLeakageDb = stereoLeakageDb(samples, rightSamples, context.sampleRate);
      const pulseRateHz = estimatePulseRate(samples, context.sampleRate);
      const rightPulseRateHz = estimatePulseRate(rightSamples, context.sampleRate);
      const expectedPulseRateHz = SOURCE_PULSE_HZ * rate;
      const tempoErrorPercent = Math.abs(pulseRateHz - expectedPulseRateHz) / expectedPulseRateHz * 100;
      const rightTempoErrorPercent = Math.abs(rightPulseRateHz - expectedPulseRateHz) / expectedPulseRateHz * 100;
      const leftOnsetErrorMs = (onset.firstFrame[0] - expectedOnsetFrame) / context.sampleRate * 1000;
      const rightOnsetErrorMs = (onset.firstFrame[1] - expectedOnsetFrame) / context.sampleRate * 1000;
      const armedLeadMs = (expectedOnsetFrame - armFrame) / context.sampleRate * 1000;
      const finite = samples.every(Number.isFinite);
      const leftPeak = cellSummary.maxPeak[0];
      const rightPeak = cellSummary.maxPeak[1];
      const channelBalanceDb = 20 * Math.log10(Math.max(leftPeak, 1e-12) / Math.max(rightPeak, 1e-12));
      const leftCarrierProminenceDb = carrierProminenceDb(samples, context.sampleRate, SOURCE_FREQUENCY_HZ);
      const rightCarrierProminenceDb = carrierProminenceDb(rightSamples, context.sampleRate, 660);
      measurements.push({ rate, frequencyHz, centsError, rightFrequencyHz, rightCentsError,
        stereoLeakageDb: measuredStereoLeakageDb, pulseRateHz, rightPulseRateHz, expectedPulseRateHz, tempoErrorPercent, rightTempoErrorPercent,
        leftOnsetErrorMs, rightOnsetErrorMs,
        leftPreStartPeak: onset.preStartPeak[0], rightPreStartPeak: onset.preStartPeak[1], armedLeadMs,
        finite: finite && rightSamples.every(Number.isFinite) &&
          cellSummary.nonFinite[0] === 0 && cellSummary.nonFinite[1] === 0,
        leftPeak, rightPeak, channelBalanceDb, leftCarrierProminenceDb, rightCarrierProminenceDb });
      deck.eject();
      await deck.awaitKeyLockCleanupForDiagnostic();
      currentDeck = null;
    }
    const evaluation = evaluateKeyLockSmoke(context.sampleRate, measurements);
    const passed = evaluation.passed;
    resultNode.textContent = JSON.stringify({
      schemaVersion: KEY_LOCK_SMOKE_SCHEMA_VERSION,
      contract: EXPERIMENTAL_KEY_LOCK_CONTRACT,
      runtimePath: "DeckEngine.playPreparedKeyLockForDiagnostic",
      configuration: { preset: "cheaper", channels: 2, rates },
      scope: "synthetic stereo pitch/tempo/separation and protected-master onset smoke check only; not production approval, musical-quality, or speaker-output evidence",
      sampleRate: context.sampleRate,
      latencySeconds: measuredLatencySeconds,
      passed,
      failureCodes: evaluation.failureCodes,
      measurements
    }, null, 2);
    statusNode.textContent = passed
      ? "Local synthetic pitch and tempo smoke check passed. This is not production approval."
      : "Local synthetic pitch and tempo smoke check failed safely. Key lock remains unavailable.";
  } catch (error) {
    const stopped = error instanceof DOMException && error.name === "AbortError";
    statusNode.textContent = stopped
      ? "Local check stopped. Key lock remains unavailable."
      : "Local synthetic pitch and tempo smoke check failed safely. Key lock remains unavailable.";
    resultNode.textContent = `Check ${stopped ? "stopped" : "failed safely"}: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    cancelActiveRun = null;
    stopButton.disabled = true;
    settlePendingOnsets(new Error("Key-lock diagnostic ended"));
    currentDeck?.eject();
    await currentDeck?.awaitKeyLockCleanupForDiagnostic();
    onsetTap?.dispose();
    if (onsetNode) {
      onsetNode.port.onmessage = null;
      onsetNode.port.close();
      onsetNode.disconnect();
    }
    if (onsetModuleUrl) URL.revokeObjectURL(onsetModuleUrl);
    tap?.dispose();
    await context?.close();
    statusNode.removeAttribute("aria-busy");
    runButton.disabled = false;
    stopButton.disabled = true;
  }
});
