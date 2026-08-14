import { createEqualPowerCurves } from "../planning/transitionMath";
import { DeckEngine } from "./DeckEngine";
import { TransportClock } from "./TransportClock";
import { configureMasterDspNodes, MASTER_DSP_V1 } from "./masterDsp";
import type { PreMasterStereoPreview } from "../diagnostics/transitionRehearsal";

export type DeckChannel = "a" | "b";

export type CrossfadeSchedule = Readonly<{
  id: number;
  source: DeckChannel;
  target: DeckChannel;
  startTime: number;
  endTime: number;
}>;

type CrossfadeCompletion = { source: OscillatorNode };

export type MasterMeterReading = {
  peak: number;
  rms: number;
  peakDb: number;
  limiterReductionDb: number;
};

export type AudioHealthSnapshot = Readonly<{
  schemaVersion: "audio-health/v2";
  supported: boolean;
  expectedOutputActive: boolean;
  sampleRate: number;
  renderedFrames: number;
  expectedActiveFrames: number;
  silentFrames: number;
  renderQuanta: number;
  nonFiniteSamples: number;
  clippedSamples: number;
  processorErrors: number;
  peak: number;
  longestUnexpectedSilentSeconds: number;
  reports: number;
  contextStates: readonly AudioContextState[];
}>;

export type AuditionClick = {
  audioTime: number;
  downbeat: boolean;
};

export type MasterDiagnosticTap = Readonly<{
  analyser: AnalyserNode;
  dispose: () => void;
}>;

export type MasterDiagnosticStereoTap = Readonly<{
  analysers: readonly [AnalyserNode, AnalyserNode];
  dispose: () => void;
}>;

export type MasterDiagnosticNodeTap = Readonly<{
  dispose: () => void;
}>;

export const DEFAULT_MASTER_HEADROOM_DB = MASTER_DSP_V1.headroomDb;
export const DEFAULT_LIMITER_THRESHOLD_DB = MASTER_DSP_V1.limiter.thresholdDb;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const requirePositiveFinite = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
};

export class AudioEngine {
  readonly clock: TransportClock;
  readonly decks: Record<DeckChannel, DeckEngine>;

  private readonly masterGain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly masterMeter: AnalyserNode;
  private readonly deckGains: Record<DeckChannel, GainNode>;
  private readonly meterSamples: Float32Array<ArrayBuffer>;
  private activeCrossfade: CrossfadeSchedule | null = null;
  private readonly crossfadeCompletions = new Map<number, CrossfadeCompletion>();
  private nextScheduleId = 1;
  private audioHealthNode: AudioWorkletNode | null = null;
  private audioHealthSink: GainNode | null = null;
  private audioHealthExpectedActive = false;
  private audioHealthTotals = {
    renderedFrames: 0,
    expectedActiveFrames: 0,
    silentFrames: 0,
    renderQuanta: 0,
    nonFiniteSamples: 0,
    clippedSamples: 0,
    processorErrors: 0,
    peak: 0,
    longestUnexpectedSilentSeconds: 0,
    reports: 0
  };
  private readonly audioContextStates: AudioContextState[] = [];
  private nextAudioHealthResetToken = 1;
  private readonly audioHealthResetWaiters = new Map<number, (acknowledged: boolean) => void>();

  constructor(readonly context: AudioContext) {
    this.clock = new TransportClock(context);

    this.masterGain = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    configureMasterDspNodes(this.masterGain, this.limiter);

    this.masterMeter = context.createAnalyser();
    this.masterMeter.fftSize = 2048;
    this.masterMeter.smoothingTimeConstant = 0.65;
    this.meterSamples = new Float32Array(this.masterMeter.fftSize);

    const deckA = context.createGain();
    const deckB = context.createGain();
    deckA.gain.value = 0;
    deckB.gain.value = 0;
    deckA.connect(this.masterGain);
    deckB.connect(this.masterGain);
    this.deckGains = { a: deckA, b: deckB };

    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.masterMeter);
    this.masterMeter.connect(context.destination);
    this.audioContextStates.push(context.state);
    context.addEventListener?.("statechange", () => {
      const state = context.state;
      if (this.audioContextStates.at(-1) !== state) this.audioContextStates.push(state);
    });

    this.decks = {
      a: new DeckEngine(this, "a"),
      b: new DeckEngine(this, "b")
    };
  }

  async resume() {
    if (this.context.state === "closed") {
      throw new Error("AudioContext is closed");
    }
    if (this.context.state === "suspended" || this.context.state === "interrupted") {
      await this.context.resume();
    }
    if (this.context.state !== "running") throw new Error("AudioContext did not resume");
  }

  async enableAudioHealthMonitoring() {
    if (this.audioHealthNode) return true;
    if (!this.context.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
    await this.context.audioWorklet.addModule(new URL("./audioHealth.worklet.js", import.meta.url));
    const node = new AudioWorkletNode(this.context, "mazzy-audio-health-v2", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    const sink = this.context.createGain();
    sink.gain.value = 0;
    node.port.onmessage = (event) => {
      const report = event.data;
      if (report?.type === "reset-ack" && Number.isSafeInteger(report.token)) {
        const settle = this.audioHealthResetWaiters.get(report.token);
        if (settle) {
          settle(true);
        }
        return;
      }
      if (report?.type !== "health") return;
      const counters = [report.frames, report.expectedActiveFrames, report.silentFrames, report.renderQuanta,
        report.nonFiniteSamples, report.clippedSamples, report.longestSilentFrames];
      if (!counters.every((value) => Number.isSafeInteger(value) && value >= 0) ||
        !Number.isFinite(report.peak) || report.peak < 0 ||
        !Number.isFinite(report.sampleRate) || report.sampleRate !== this.context.sampleRate) {
        this.audioHealthTotals.processorErrors += 1;
        return;
      }
      this.audioHealthTotals.renderedFrames += report.frames;
      this.audioHealthTotals.expectedActiveFrames += report.expectedActiveFrames;
      this.audioHealthTotals.silentFrames += report.silentFrames;
      this.audioHealthTotals.renderQuanta += report.renderQuanta;
      this.audioHealthTotals.nonFiniteSamples += report.nonFiniteSamples;
      this.audioHealthTotals.clippedSamples += report.clippedSamples;
      this.audioHealthTotals.peak = Math.max(this.audioHealthTotals.peak, report.peak);
      this.audioHealthTotals.longestUnexpectedSilentSeconds = Math.max(
        this.audioHealthTotals.longestUnexpectedSilentSeconds,
        report.longestSilentFrames / report.sampleRate
      );
      this.audioHealthTotals.reports += 1;
    };
    node.onprocessorerror = () => {
      this.audioHealthTotals.processorErrors += 1;
      for (const settle of this.audioHealthResetWaiters.values()) settle(false);
      this.audioHealthResetWaiters.clear();
    };
    this.masterMeter.connect(node);
    node.connect(sink);
    sink.connect(this.context.destination);
    this.audioHealthNode = node;
    this.audioHealthSink = sink;
    this.setExpectedOutputActive(this.audioHealthExpectedActive);
    return true;
  }

  setExpectedOutputActive(active: boolean) {
    this.audioHealthExpectedActive = active === true;
    this.audioHealthNode?.port.postMessage({ type: "expected-active", value: this.audioHealthExpectedActive });
  }

  /** Diagnostic-only interval boundary. It never carries audio or track metadata. */
  async resetAudioHealthMonitoringForDiagnostic(timeoutMs = 1_000) {
    if (!this.audioHealthNode || this.audioHealthExpectedActive || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return false;
    }
    const token = this.nextAudioHealthResetToken++;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (acknowledged: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.audioHealthResetWaiters.delete(token);
        if (acknowledged) this.audioHealthTotals = this.emptyAudioHealthTotals();
        resolve(acknowledged);
      };
      const timeout = window.setTimeout(() => finish(false), timeoutMs);
      this.audioHealthResetWaiters.set(token, finish);
      this.audioHealthNode!.port.postMessage({ type: "reset", token });
    });
  }

  getAudioHealthSnapshot(): AudioHealthSnapshot {
    return Object.freeze({
      schemaVersion: "audio-health/v2",
      supported: this.audioHealthNode !== null,
      expectedOutputActive: this.audioHealthExpectedActive,
      sampleRate: this.context.sampleRate,
      ...this.audioHealthTotals,
      contextStates: Object.freeze([...this.audioContextStates])
    });
  }

  disposeAudioHealthMonitoring() {
    this.setExpectedOutputActive(false);
    if (this.audioHealthNode) this.masterMeter.disconnect(this.audioHealthNode);
    this.audioHealthNode?.disconnect();
    this.audioHealthSink?.disconnect();
    this.audioHealthNode = null;
    this.audioHealthSink = null;
    for (const settle of this.audioHealthResetWaiters.values()) settle(false);
    this.audioHealthResetWaiters.clear();
  }

  private emptyAudioHealthTotals() {
    return {
      renderedFrames: 0,
      expectedActiveFrames: 0,
      silentFrames: 0,
      renderQuanta: 0,
      nonFiniteSamples: 0,
      clippedSamples: 0,
      processorErrors: 0,
      peak: 0,
      longestUnexpectedSilentSeconds: 0,
      reports: 0
    };
  }

  getDeckInput(channel: DeckChannel): AudioNode {
    return this.deckGains[channel];
  }

  getDeck(channel: DeckChannel) {
    return this.decks[channel];
  }

  getDeckGain(channel: DeckChannel) {
    return this.deckGains[channel].gain.value;
  }

  setDeckGain(channel: DeckChannel, value: number) {
    if (!Number.isFinite(value)) {
      throw new RangeError("deck gain must be finite");
    }
    const gain = this.deckGains[channel].gain;
    const now = this.clock.now();
    const safeValue = clamp01(value);
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(safeValue, now);
    return safeValue;
  }

  scheduleDeckGainCurve(
    channel: DeckChannel,
    curve: Float32Array,
    startTime: number,
    durationSeconds: number
  ) {
    if (curve.length < 2) {
      throw new RangeError("gain curve requires at least two points");
    }
    requirePositiveFinite(durationSeconds, "durationSeconds");
    const scheduledStart = this.clock.resolveScheduleTime(startTime);
    const immutableCurve = new Float32Array(curve);
    const gain = this.deckGains[channel].gain;
    gain.cancelScheduledValues(scheduledStart);
    gain.setValueCurveAtTime(immutableCurve, scheduledStart, durationSeconds);
    return scheduledStart;
  }

  scheduleCrossfade(
    source: DeckChannel,
    target: DeckChannel,
    startTime: number,
    durationSeconds: number,
    curves = createEqualPowerCurves(),
    authority?: () => boolean
  ): CrossfadeSchedule {
    if (source === target) {
      throw new RangeError("crossfade source and target must be different decks");
    }
    requirePositiveFinite(durationSeconds, "durationSeconds");

    const scheduledStart = this.clock.resolveScheduleTime(startTime);
    if (authority && !authority()) {
      throw new Error("crossfade scheduling authority expired");
    }
    if (this.activeCrossfade) {
      throw new Error("another crossfade is already active");
    }

    this.scheduleDeckGainCurve(source, curves.source, scheduledStart, durationSeconds);
    this.scheduleDeckGainCurve(target, curves.target, scheduledStart, durationSeconds);

    const schedule = Object.freeze({
      id: this.nextScheduleId,
      source,
      target,
      startTime: scheduledStart,
      endTime: scheduledStart + durationSeconds
    });
    this.nextScheduleId += 1;
    this.activeCrossfade = schedule;
    return schedule;
  }

  getActiveCrossfade() {
    return this.activeCrossfade;
  }

  finishCrossfade(scheduleId: number) {
    if (this.activeCrossfade?.id === scheduleId) {
      let cleanupError: unknown = null;
      const completion = this.crossfadeCompletions.get(scheduleId);
      if (completion) {
        try {
          completion.source.onended = null;
          try { completion.source.stop(); } catch { /* Already ended. */ }
          completion.source.disconnect();
        } catch (error) {
          cleanupError = error;
        } finally {
          this.crossfadeCompletions.delete(scheduleId);
        }
      }
      this.activeCrossfade = null;
      if (cleanupError) throw cleanupError;
      return true;
    }
    return false;
  }

  cancelCrossfade(scheduleId: number, sourceGain = 1, targetGain = 0) {
    if (this.activeCrossfade?.id !== scheduleId) return false;
    const schedule = this.activeCrossfade;
    let cleanupError: unknown = null;
    const completion = this.crossfadeCompletions.get(scheduleId);
    if (completion) {
      try {
        completion.source.onended = null;
        try { completion.source.stop(); } catch { /* Already ended. */ }
        completion.source.disconnect();
      } catch (error) {
        cleanupError = error;
      } finally {
        this.crossfadeCompletions.delete(scheduleId);
      }
    }
    const now = this.clock.now();
    const sourceParam = this.deckGains[schedule.source].gain;
    const targetParam = this.deckGains[schedule.target].gain;
    const rescueRampSeconds = 0.03;
    const settleParam = (param: AudioParam, target: number) => {
      const current = clamp01(param.value);
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(now);
      } else {
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
      param.linearRampToValueAtTime(clamp01(target), now + rescueRampSeconds);
    };
    try {
      settleParam(sourceParam, sourceGain);
      settleParam(targetParam, targetGain);
    } finally {
      this.activeCrossfade = null;
    }
    if (cleanupError) throw cleanupError;
    return true;
  }

  onCrossfadeComplete(scheduleId: number, callback: () => void) {
    if (this.activeCrossfade?.id !== scheduleId) {
      throw new Error("crossfade completion owner is not active");
    }
    if (this.crossfadeCompletions.has(scheduleId)) {
      throw new Error("crossfade completion observer already exists");
    }
    const schedule = this.activeCrossfade;
    const source = this.context.createOscillator();
    let completed = false;
    source.onended = () => {
      if (completed) return;
      completed = true;
      try { source.disconnect(); } catch { /* Completion authority must still settle. */ }
      this.crossfadeCompletions.delete(scheduleId);
      callback();
    };
    source.start(schedule.endTime);
    source.stop(schedule.endTime + 0.001);
    this.crossfadeCompletions.set(scheduleId, { source });
    return () => {
      if (completed) return;
      completed = true;
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      try {
        source.disconnect();
      } finally {
        this.crossfadeCompletions.delete(scheduleId);
      }
    };
  }

  onAudioClockDeadline(deadlineSeconds: number, callback: () => void) {
    if (!Number.isFinite(deadlineSeconds) || deadlineSeconds < this.clock.now()) {
      throw new RangeError("audio-clock deadline must be finite and not in the past");
    }
    const source = this.context.createOscillator();
    let settled = false;
    source.onended = () => {
      if (settled) return;
      settled = true;
      try { source.disconnect(); } catch { /* Deadline authority must still settle. */ }
      callback();
    };
    source.start(deadlineSeconds);
    source.stop(deadlineSeconds + 0.001);
    return () => {
      if (settled) return;
      settled = true;
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect();
    };
  }

  setMasterGainDb(db: number) {
    if (!Number.isFinite(db)) {
      throw new RangeError("master gain must be finite");
    }
    const safeDb = Math.max(-60, Math.min(0, db));
    const now = this.clock.now();
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(dbToGain(safeDb), now);
    return safeDb;
  }

  readMasterMeter(): MasterMeterReading {
    this.masterMeter.getFloatTimeDomainData(this.meterSamples);
    let peak = 0;
    let sumSquares = 0;
    for (const sample of this.meterSamples) {
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / this.meterSamples.length);
    return {
      peak,
      rms,
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      limiterReductionDb: this.limiter.reduction
    };
  }

  createDiagnosticMasterTap(fftSize = 32_768): MasterDiagnosticTap {
    if (!Number.isInteger(fftSize) || fftSize < 32 || fftSize > 32_768 || (fftSize & (fftSize - 1)) !== 0) {
      throw new RangeError("diagnostic FFT size must be a power of two from 32 to 32768");
    }
    const analyser = this.context.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    const silentSink = this.context.createGain();
    silentSink.gain.value = 0;
    this.masterMeter.connect(analyser);
    analyser.connect(silentSink);
    silentSink.connect(this.context.destination);
    let disposed = false;
    return Object.freeze({
      analyser,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.masterMeter.disconnect(analyser);
        analyser.disconnect();
        silentSink.disconnect();
      }
    });
  }

  createDiagnosticStereoMasterTap(fftSize = 32_768): MasterDiagnosticStereoTap {
    if (!Number.isInteger(fftSize) || fftSize < 32 || fftSize > 32_768 || (fftSize & (fftSize - 1)) !== 0) {
      throw new RangeError("diagnostic FFT size must be a power of two from 32 to 32768");
    }
    const splitter = this.context.createChannelSplitter(2);
    const left = this.context.createAnalyser();
    const right = this.context.createAnalyser();
    left.fftSize = fftSize;
    right.fftSize = fftSize;
    left.smoothingTimeConstant = 0;
    right.smoothingTimeConstant = 0;
    const silentSink = this.context.createGain();
    silentSink.gain.value = 0;
    this.masterMeter.connect(splitter);
    splitter.connect(left, 0, 0);
    splitter.connect(right, 1, 0);
    left.connect(silentSink);
    right.connect(silentSink);
    silentSink.connect(this.context.destination);
    let disposed = false;
    return Object.freeze({
      analysers: Object.freeze([left, right]) as readonly [AnalyserNode, AnalyserNode],
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.masterMeter.disconnect(splitter);
        splitter.disconnect();
        left.disconnect();
        right.disconnect();
        silentSink.disconnect();
      }
    });
  }

  /** Connects a diagnostics-only observer after the protected master path. */
  connectDiagnosticMasterNode(node: AudioNode): MasterDiagnosticNodeTap {
    const silentSink = this.context.createGain();
    silentSink.gain.value = 0;
    this.masterMeter.connect(node);
    node.connect(silentSink);
    silentSink.connect(this.context.destination);
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.masterMeter.disconnect(node);
        node.disconnect();
        silentSink.disconnect();
      }
    });
  }

  playProtectedPreview(preview: PreMasterStereoPreview, onEnded?: () => void) {
    requirePositiveFinite(preview.sampleRate, "sampleRate");
    const [left, right] = preview.channels;
    if (preview.kind !== "pre-master-stereo/v1" || preview.requiredMasterVersion !== MASTER_DSP_V1.version ||
      left.length < 2 || left.length !== right.length ||
      left.some((sample) => !Number.isFinite(sample)) || right.some((sample) => !Number.isFinite(sample))) {
      throw new RangeError("preview must contain finite equal-length stereo audio");
    }
    const buffer = this.context.createBuffer(2, left.length, preview.sampleRate);
    buffer.copyToChannel(new Float32Array(left), 0);
    buffer.copyToChannel(new Float32Array(right), 1);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);
    let ended = false;
    source.onended = () => {
      if (ended) return;
      ended = true;
      source.disconnect();
      onEnded?.();
    };
    source.start(this.clock.now());
    return () => {
      try {
        source.stop();
      } catch {
        // Preview may already have ended.
      }
      if (!ended) {
        ended = true;
        source.disconnect();
      }
    };
  }

  scheduleAuditionClicks(clicks: AuditionClick[]) {
    const scheduled: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
    for (const click of clicks) {
      if (!Number.isFinite(click.audioTime)) continue;
      const startTime = this.clock.resolveScheduleTime(click.audioTime);
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      // A short square pulse remains audible over full-range music much better
      // than the former low-level sine. It bypasses music headroom but still
      // enters the master limiter/meter, so the cue is clear and peak-protected.
      oscillator.type = "square";
      oscillator.frequency.value = click.downbeat ? 1760 : 1120;
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(click.downbeat ? 0.32 : 0.22, startTime + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.06);
      oscillator.connect(gain);
      gain.connect(this.limiter);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(startTime);
      oscillator.stop(startTime + 0.065);
      scheduled.push({ oscillator, gain });
    }
    return () => {
      const now = this.clock.now();
      for (const node of scheduled) {
        try {
          node.oscillator.stop(now);
        } catch {
          // The click may already have ended.
        }
        node.oscillator.disconnect();
        node.gain.disconnect();
      }
    };
  }
}
