import type { AudioEngine, DeckChannel } from "./AudioEngine";
import { createDeckDspChain } from "./deckDspChain";
import {
  PREPARED_KEY_LOCK_PROCESSOR,
  runtimeKeyLockLoadKey,
  type DeckKeyLockState,
  type PreparedKeyLockFactory,
  type PreparedKeyLockSource
} from "./keyLockPreparedSource";

export type DeckStatus =
  | "idle"
  | "preparing"
  | "ready"
  | "scheduled"
  | "playing"
  | "paused"
  | "ended"
  | "recoverable-error";

export type DeckSnapshot = Readonly<{
  channel: DeckChannel;
  status: DeckStatus;
  trackId: string | null;
  durationSeconds: number;
  positionSeconds: number;
  playbackRate: number;
  scheduledStartTime: number | null;
  error: string | null;
}>;

type PlaybackRateAutomation = {
  startTime: number;
  endTime: number;
  startRate: number;
  targetRate: number;
  startPosition: number;
};

type DeckListener = (snapshot: DeckSnapshot) => void;

const clampPlaybackRate = (value: number) => Math.max(0.5, Math.min(1.5, value));
const clampEqGain = (value: number) => Math.max(-12, Math.min(12, value));
const dbToGain = (db: number) => 10 ** (db / 20);

export class DeckEngine {
  private readonly lowFilter: BiquadFilterNode;
  private readonly midFilter: BiquadFilterNode;
  private readonly highFilter: BiquadFilterNode;
  private readonly transitionFilter: BiquadFilterNode;
  private readonly trackTrim: GainNode;
  private readonly transportGate: GainNode;
  private readonly listeners = new Set<DeckListener>();

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private preparedCompletion: OscillatorNode | null = null;
  private activePlaybackBackend: "native" | "signalsmith" | null = null;
  private preparedStopPending: Promise<void> | null = null;
  private keyLockCleanupPending: Promise<void> = Promise.resolve();
  private readonly preparedStopOperations = new WeakMap<PreparedKeyLockSource, Promise<void>>();
  private readonly preparedDisposals = new WeakMap<PreparedKeyLockSource, Promise<void>>();
  private status: DeckStatus = "idle";
  private trackId: string | null = null;
  private startTime = 0;
  private startOffset = 0;
  private playbackRate = 1;
  private rateAutomation: PlaybackRateAutomation | null = null;
  private error: string | null = null;
  private runtimeLoadRevision = 0;
  private preparedKeyLock: PreparedKeyLockSource | null = null;
  private keyLockPreparation: Promise<boolean> | null = null;
  private keyLockAttempt = 0;
  private keyLockState: DeckKeyLockState = Object.freeze({ status: "unavailable", loadKey: null });

  constructor(
    private readonly audioEngine: AudioEngine,
    readonly channel: DeckChannel,
    private readonly keyLockFactory: PreparedKeyLockFactory | null = null
  ) {
    const context = audioEngine.context;
    const chain = createDeckDspChain(context, audioEngine.getDeckInput(channel));
    this.lowFilter = chain.nodes.low;
    this.midFilter = chain.nodes.mid;
    this.highFilter = chain.nodes.high;
    this.transitionFilter = chain.nodes.transitionFilter;
    this.trackTrim = chain.nodes.trim;
    this.transportGate = context.createGain();
    this.transportGate.gain.value = 0;
    this.transportGate.connect(chain.input);
  }

  subscribe(listener: DeckListener) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private emit() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private derivedStatus(now = this.audioEngine.clock.now()): DeckStatus {
    if (this.status === "scheduled" && now >= this.startTime) {
      return "playing";
    }
    return this.status;
  }

  getSnapshot(): DeckSnapshot {
    const now = this.audioEngine.clock.now();
    return Object.freeze({
      channel: this.channel,
      status: this.derivedStatus(now),
      trackId: this.trackId,
      durationSeconds: this.buffer?.duration ?? 0,
      positionSeconds: this.getPosition(now),
      playbackRate: this.getPlaybackRate(now),
      scheduledStartTime: this.status === "scheduled" ? this.startTime : null,
      error: this.error
    });
  }

  isReady() {
    return this.buffer !== null && this.status !== "preparing" && this.status !== "recoverable-error";
  }

  getDecodedBufferForRehearsal() {
    return this.buffer;
  }

  getKeyLockState(): DeckKeyLockState {
    return this.keyLockState;
  }

  getActivePlaybackBackend() {
    return this.activePlaybackBackend;
  }

  prepareKeyLock(): Promise<boolean> {
    if (!this.buffer) return Promise.resolve(false);
    if (this.keyLockState.status === "ready") return Promise.resolve(true);
    if (this.keyLockPreparation) return this.keyLockPreparation;
    const revision = this.runtimeLoadRevision;
    const loadKey = runtimeKeyLockLoadKey(this.channel, revision);
    const buffer = this.buffer;
    const attempt = ++this.keyLockAttempt;
    if (!this.keyLockFactory) {
      this.keyLockState = Object.freeze({ status: "failed", loadKey, reason: "unsupported" });
      this.emit();
      return Promise.resolve(false);
    }
    this.keyLockState = Object.freeze({ status: "preparing", loadKey });
    this.emit();
    let processorFailed = false;
    let operation: Promise<boolean>;
    operation = this.keyLockFactory(this.audioEngine.context, buffer, () => {
      processorFailed = true;
      if (this.runtimeLoadRevision !== revision || this.keyLockAttempt !== attempt) return;
      if (this.activePlaybackBackend === "signalsmith") {
        this.startOffset = this.getPosition();
        this.stopSource();
        this.status = "paused";
      }
      this.trackKeyLockCleanup(this.disposePreparedKeyLock());
      this.keyLockState = Object.freeze({ status: "failed", loadKey, reason: "processor" });
      this.emit();
    }).then(async (prepared) => {
      const validPrepared = prepared.processor === PREPARED_KEY_LOCK_PROCESSOR &&
        Number.isFinite(prepared.latencySeconds) && prepared.latencySeconds >= 0 && prepared.latencySeconds <= 1 &&
        prepared.minimumRate === 0.94 && prepared.maximumRate === 1.06;
      if (processorFailed || this.runtimeLoadRevision !== revision || this.buffer !== buffer || !validPrepared) {
        await prepared.dispose().catch(() => undefined);
        if (!processorFailed && this.runtimeLoadRevision === revision && this.buffer === buffer) {
          this.keyLockState = Object.freeze({ status: "failed", loadKey, reason: "initialization" });
          this.emit();
        }
        return false;
      }
      await this.disposePreparedKeyLock();
      if (processorFailed || this.runtimeLoadRevision !== revision || this.buffer !== buffer ||
        this.keyLockAttempt !== attempt || this.keyLockPreparation !== operation) {
        await prepared.dispose().catch(() => undefined);
        return false;
      }
      try {
        prepared.connect(this.transportGate);
      } catch {
        await this.disposePreparedHandle(prepared);
        this.keyLockState = Object.freeze({ status: "failed", loadKey, reason: "initialization" });
        this.emit();
        return false;
      }
      this.preparedKeyLock = prepared;
      this.keyLockState = Object.freeze({
        status: "ready",
        loadKey,
        processor: prepared.processor,
        latencySeconds: prepared.latencySeconds,
        minimumRate: prepared.minimumRate,
        maximumRate: prepared.maximumRate
      });
      this.emit();
      return true;
    }).catch((error) => {
      if (!processorFailed && this.runtimeLoadRevision === revision && this.buffer === buffer && this.keyLockAttempt === attempt) {
        const reason = error instanceof Error && /timed out/i.test(error.message) ? "timeout" : "initialization";
        this.keyLockState = Object.freeze({ status: "failed", loadKey, reason });
        this.emit();
      }
      return false;
    }).finally(() => {
      if (this.keyLockPreparation === operation) this.keyLockPreparation = null;
    });
    this.keyLockPreparation = operation;
    return operation;
  }

  isActive() {
    const status = this.derivedStatus();
    return status === "scheduled" || status === "playing";
  }

  /**
   * Isolated diagnostic playback. It is intentionally not called by React,
   * Auto Mix, sync, or the transition planner.
   */
  async playPreparedKeyLockForDiagnostic(
    loadKey: string,
    offsetSeconds: number,
    rate: number,
    when: number
  ) {
    const prepared = this.preparedKeyLock;
    const state = this.keyLockState;
    const buffer = this.buffer;
    if (!prepared || this.preparedStopPending || this.activePlaybackBackend !== null || this.source ||
      !buffer || state.status !== "ready" || state.loadKey !== loadKey) return false;
    if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0 || offsetSeconds >= buffer.duration ||
      !Number.isFinite(rate) || rate < prepared.minimumRate || rate > prepared.maximumRate ||
      !Number.isFinite(when)) return false;
    const context = this.audioEngine.context;
    const now = this.audioEngine.clock.now();
    const renderGuard = 2 * 128 / context.sampleRate + 0.01;
    const requiredLead = prepared.latencySeconds + renderGuard + 0.02;
    if (when - now < requiredLead) return false;
    const revision = this.runtimeLoadRevision;
    const attempt = this.keyLockAttempt;
    this.muteTransportGate(now);
    try {
      await prepared.start({ outputTime: when, inputSeconds: offsetSeconds, rate });
    } catch (error) {
      await this.stopPreparedHandle(prepared, this.audioEngine.clock.now());
      if (this.preparedKeyLock === prepared) {
        this.preparedKeyLock = null;
        this.keyLockState = Object.freeze({
          status: "failed",
          loadKey,
          reason: error instanceof Error && /timed out/i.test(error.message) ? "timeout" : "processor"
        });
        this.trackKeyLockCleanup(this.disposePreparedHandle(prepared));
        this.emit();
      }
      return false;
    }
    const stillCurrent = this.preparedKeyLock === prepared && this.buffer === buffer &&
      this.runtimeLoadRevision === revision && this.keyLockAttempt === attempt &&
      this.keyLockState.status === "ready" && this.keyLockState.loadKey === loadKey;
    if (!stillCurrent || when - this.audioEngine.clock.now() < renderGuard) {
      await this.stopPreparedHandle(prepared, this.audioEngine.clock.now());
      return false;
    }
    this.startTime = when;
    this.startOffset = offsetSeconds;
    this.playbackRate = rate;
    this.rateAutomation = null;
    this.error = null;
    this.activePlaybackBackend = "signalsmith";
    this.status = "scheduled";
    this.transportGate.gain.setValueAtTime(1, when);
    const endTime = when + (buffer.duration - offsetSeconds) / rate;
    this.transportGate.gain.setValueAtTime(0, endTime);
    const completion = context.createOscillator();
    completion.onended = () => {
      if (this.preparedCompletion !== completion || this.activePlaybackBackend !== "signalsmith") return;
      this.preparedCompletion = null;
      this.activePlaybackBackend = null;
      this.startOffset = buffer.duration;
      this.status = "ended";
      completion.disconnect();
      void this.stopPreparedHandle(prepared, endTime);
      this.emit();
    };
    completion.start(endTime);
    completion.stop(endTime + 0.001);
    this.preparedCompletion = completion;
    this.emit();
    return true;
  }

  beginPreparing(trackId: string | null) {
    this.stopSource();
    this.invalidateRuntimeLoad(null);
    this.buffer = null;
    this.trackId = trackId;
    this.startOffset = 0;
    this.playbackRate = 1;
    this.rateAutomation = null;
    this.error = null;
    this.status = "preparing";
    this.emit();
  }

  loadBuffer(buffer: AudioBuffer, trackId: string | null = this.trackId) {
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new RangeError("decoded audio buffer must have a positive duration");
    }
    this.stopSource();
    this.invalidateRuntimeLoad(buffer);
    this.buffer = buffer;
    this.trackId = trackId;
    this.startOffset = 0;
    this.playbackRate = 1;
    this.rateAutomation = null;
    this.error = null;
    this.status = "ready";
    this.emit();
  }

  fail(error: unknown) {
    this.stopSource();
    this.invalidateRuntimeLoad(null);
    this.error = error instanceof Error ? error.message : String(error);
    this.status = "recoverable-error";
    this.emit();
  }

  recover() {
    if (this.status !== "recoverable-error") {
      return false;
    }
    this.error = null;
    this.status = this.buffer ? "ready" : "idle";
    this.emit();
    return true;
  }

  play(offsetSeconds?: number, when = this.audioEngine.clock.now()) {
    if (!this.buffer) {
      throw new Error("cannot play before a track is prepared");
    }
    if (this.preparedStopPending || this.activePlaybackBackend === "signalsmith") {
      throw new Error("cannot start native playback while key-lock playback is stopping");
    }

    const context = this.audioEngine.context;
    const startTime = this.audioEngine.clock.resolveScheduleTime(when);
    const maxOffset = Math.max(this.buffer.duration - 0.01, 0);
    const requestedOffset =
      offsetSeconds ?? (this.status === "ended" ? 0 : this.getPosition());
    const safeOffset = Math.max(0, Math.min(requestedOffset, maxOffset));
    this.stopSource();

    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.transportGate);
    source.onended = () => {
      if (this.source !== source) {
        return;
      }
      this.startOffset = this.getPosition();
      this.source = null;
      this.activePlaybackBackend = null;
      this.rateAutomation = null;
      this.status = "ended";
      this.emit();
    };

    this.source = source;
    this.activePlaybackBackend = "native";
    this.startTime = startTime;
    this.startOffset = safeOffset;
    this.rateAutomation = null;
    this.error = null;
    this.status = startTime > this.audioEngine.clock.now() ? "scheduled" : "playing";
    source.start(startTime, safeOffset);
    this.transportGate.gain.cancelScheduledValues(this.audioEngine.clock.now());
    this.transportGate.gain.setValueAtTime(0, this.audioEngine.clock.now());
    this.transportGate.gain.setValueAtTime(1, startTime);
    this.emit();
    return startTime;
  }

  pause() {
    if (!this.source && this.activePlaybackBackend !== "signalsmith") {
      return false;
    }
    this.startOffset = this.getPosition();
    this.stopSource();
    this.rateAutomation = null;
    this.status = "paused";
    this.emit();
    return true;
  }

  stopAt(when: number) {
    if (this.activePlaybackBackend === "signalsmith") {
      // Prepared scheduled-stop ownership is deliberately not exposed until it
      // has an audio-clock completion sentinel and exact state transition.
      return false;
    }
    if (!this.source) {
      return false;
    }
    const scheduled = this.audioEngine.clock.resolveScheduleTime(when);
    this.source.stop(scheduled);
    return true;
  }

  seek(seconds: number) {
    if (!this.buffer || !Number.isFinite(seconds)) {
      return false;
    }
    const maxOffset = Math.max(this.buffer.duration - 0.01, 0);
    const safeOffset = Math.max(0, Math.min(seconds, maxOffset));
    if (this.isActive()) {
      this.play(safeOffset);
    } else {
      this.startOffset = safeOffset;
      this.status = "paused";
      this.emit();
    }
    return true;
  }

  eject() {
    this.stopSource();
    this.invalidateRuntimeLoad(null);
    this.buffer = null;
    this.trackId = null;
    this.startOffset = 0;
    this.playbackRate = 1;
    this.rateAutomation = null;
    this.error = null;
    this.status = "idle";
    this.emit();
  }

  setPlaybackRate(value: number) {
    if (!Number.isFinite(value)) {
      throw new RangeError("playback rate must be finite");
    }
    const safeRate = clampPlaybackRate(value);
    const position = this.getPosition();
    const wasActive = this.isActive();
    const restartTime = this.status === "scheduled" ? this.startTime : this.audioEngine.clock.now();
    this.playbackRate = safeRate;
    this.rateAutomation = null;
    if (wasActive) {
      this.play(position, restartTime);
    } else {
      this.startOffset = position;
      this.emit();
    }
    return safeRate;
  }

  schedulePlaybackRateRamp(targetRate: number, startTime: number, durationSeconds: number) {
    if (!this.source) {
      return false;
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new RangeError("durationSeconds must be positive and finite");
    }
    const safeTarget = clampPlaybackRate(targetRate);
    const scheduledStart = Math.max(
      this.startTime,
      this.audioEngine.clock.resolveScheduleTime(startTime)
    );
    const startRate = this.getPlaybackRate(scheduledStart);
    const startPosition = this.getPosition(scheduledStart);
    this.source.playbackRate.cancelScheduledValues(scheduledStart);
    this.source.playbackRate.setValueAtTime(startRate, scheduledStart);
    this.source.playbackRate.linearRampToValueAtTime(safeTarget, scheduledStart + durationSeconds);
    this.rateAutomation = {
      startTime: scheduledStart,
      endTime: scheduledStart + durationSeconds,
      startRate,
      targetRate: safeTarget,
      startPosition
    };
    this.playbackRate = safeTarget;
    this.emit();
    return true;
  }

  getPlaybackRate(atTime = this.audioEngine.clock.now()) {
    const automation = this.rateAutomation;
    if (!automation || atTime >= automation.endTime) {
      return this.playbackRate;
    }
    if (atTime <= automation.startTime) {
      return automation.startRate;
    }
    const progress = (atTime - automation.startTime) / (automation.endTime - automation.startTime);
    return automation.startRate + (automation.targetRate - automation.startRate) * progress;
  }

  getPosition(atTime = this.audioEngine.clock.now()) {
    if (!this.buffer || (!this.source && this.activePlaybackBackend !== "signalsmith")) {
      return this.startOffset;
    }
    if (atTime <= this.startTime) {
      return this.startOffset;
    }

    const automation = this.rateAutomation;
    let position: number;
    if (!automation || atTime <= automation.startTime) {
      position = this.startOffset + (atTime - this.startTime) * (automation?.startRate ?? this.playbackRate);
    } else {
      const rampDuration = automation.endTime - automation.startTime;
      const elapsedRamp = Math.min(atTime, automation.endTime) - automation.startTime;
      const rateSlope = (automation.targetRate - automation.startRate) / rampDuration;
      position =
        automation.startPosition +
        automation.startRate * elapsedRamp +
        0.5 * rateSlope * elapsedRamp * elapsedRamp;
      if (atTime > automation.endTime) {
        position += (atTime - automation.endTime) * automation.targetRate;
      }
    }
    return Math.max(0, Math.min(position, this.buffer.duration));
  }

  getTransportAnchorTime() {
    return this.startTime - this.startOffset / Math.max(this.getPlaybackRate(this.startTime), 0.001);
  }

  setEqBandGain(band: "low" | "mid" | "high", value: number) {
    const safeValue = clampEqGain(value);
    const param = this.getEqParam(band);
    const now = this.audioEngine.clock.now();
    param.cancelScheduledValues(now);
    param.setValueAtTime(safeValue, now);
    return safeValue;
  }

  setTrackTrimDb(value: number) {
    if (!Number.isFinite(value)) throw new RangeError("track trim must be finite");
    const safeDb = Math.max(-6, Math.min(3, value));
    const now = this.audioEngine.clock.now();
    this.trackTrim.gain.cancelScheduledValues(now);
    this.trackTrim.gain.setValueAtTime(dbToGain(safeDb), now);
    return safeDb;
  }

  getTrackTrimDb() {
    return 20 * Math.log10(Math.max(this.trackTrim.gain.value, 1e-6));
  }

  getEqSnapshot() {
    return Object.freeze({
      low: this.lowFilter.gain.value,
      mid: this.midFilter.gain.value,
      high: this.highFilter.gain.value
    });
  }

  getFilterCutoff() {
    return this.transitionFilter.frequency.value;
  }

  setFilterCutoff(value: number) {
    if (!Number.isFinite(value)) throw new RangeError("filter cutoff must be finite");
    const safeValue = Math.max(200, Math.min(20_000, value));
    const now = this.audioEngine.clock.now();
    this.transitionFilter.frequency.cancelScheduledValues(now);
    this.transitionFilter.frequency.setValueAtTime(safeValue, now);
    return safeValue;
  }

  scheduleFilterSweep(fromHz: number, toHz: number, startTime: number, durationSeconds: number) {
    if (![fromHz, toHz, startTime, durationSeconds].every(Number.isFinite) || durationSeconds <= 0) {
      throw new RangeError("filter sweep values must be finite with a positive duration");
    }
    const scheduledStart = this.audioEngine.clock.resolveScheduleTime(startTime);
    const param = this.transitionFilter.frequency;
    const safeFrom = Math.max(200, Math.min(20_000, fromHz));
    const safeTo = Math.max(200, Math.min(20_000, toHz));
    param.cancelScheduledValues(scheduledStart);
    param.setValueAtTime(safeFrom, scheduledStart);
    param.exponentialRampToValueAtTime(safeTo, scheduledStart + durationSeconds);
    return scheduledStart;
  }

  scheduleEqBandRamp(
    band: "low" | "mid" | "high",
    fromDb: number,
    toDb: number,
    startTime: number,
    durationSeconds: number
  ) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new RangeError("durationSeconds must be positive and finite");
    }
    const scheduledStart = this.audioEngine.clock.resolveScheduleTime(startTime);
    const param = this.getEqParam(band);
    param.cancelScheduledValues(scheduledStart);
    param.setValueAtTime(clampEqGain(fromDb), scheduledStart);
    param.linearRampToValueAtTime(clampEqGain(toDb), scheduledStart + durationSeconds);
    return scheduledStart;
  }

  private getEqParam(band: "low" | "mid" | "high") {
    if (band === "low") return this.lowFilter.gain;
    if (band === "mid") return this.midFilter.gain;
    return this.highFilter.gain;
  }

  private stopSource() {
    const now = this.audioEngine.clock.now();
    this.muteTransportGate(now);
    const source = this.source;
    this.source = null;
    const preparedWasActive = this.activePlaybackBackend === "signalsmith";
    this.activePlaybackBackend = null;
    const completion = this.preparedCompletion;
    this.preparedCompletion = null;
    if (completion) {
      completion.onended = null;
      try { completion.stop(); } catch { /* already ended */ }
      completion.disconnect();
    }
    if (preparedWasActive && this.preparedKeyLock) {
      void this.stopPreparedHandle(this.preparedKeyLock, now);
    }
    if (!source) return;
    try {
      source.stop();
    } catch {
      // A one-shot source may already have ended.
    }
    source.disconnect();
  }

  private invalidateRuntimeLoad(nextBuffer: AudioBuffer | null) {
    this.runtimeLoadRevision += 1;
    this.keyLockAttempt += 1;
    const preparation = this.keyLockPreparation;
    if (preparation) this.trackKeyLockCleanup(preparation.then(() => undefined, () => undefined));
    this.trackKeyLockCleanup(this.disposePreparedKeyLock());
    this.keyLockPreparation = null;
    this.keyLockState = Object.freeze({
      status: "unavailable",
      loadKey: nextBuffer ? runtimeKeyLockLoadKey(this.channel, this.runtimeLoadRevision) : null
    });
  }

  private async disposePreparedKeyLock() {
    const prepared = this.preparedKeyLock;
    this.preparedKeyLock = null;
    if (!prepared) return;
    const stop = this.preparedStopOperations.get(prepared);
    if (stop) await stop;
    await this.disposePreparedHandle(prepared);
  }

  private muteTransportGate(now = this.audioEngine.clock.now()) {
    this.transportGate.gain.cancelScheduledValues(now);
    this.transportGate.gain.setValueAtTime(0, now);
  }

  private stopPreparedHandle(prepared: PreparedKeyLockSource, when: number) {
    const existing = this.preparedStopOperations.get(prepared);
    if (existing) return existing;
    this.muteTransportGate();
    let operation: Promise<void>;
    operation = prepared.stop(when).catch(async () => {
      if (this.preparedKeyLock === prepared) {
        const loadKey = this.keyLockState.loadKey;
        this.preparedKeyLock = null;
        this.activePlaybackBackend = null;
        this.keyLockState = loadKey
          ? Object.freeze({ status: "failed", loadKey, reason: "processor" })
          : Object.freeze({ status: "unavailable", loadKey: null });
        this.emit();
      }
      await this.disposePreparedHandle(prepared);
    }).finally(() => {
      this.preparedStopOperations.delete(prepared);
      if (this.preparedStopPending === operation) this.preparedStopPending = null;
    });
    this.preparedStopOperations.set(prepared, operation);
    this.preparedStopPending = operation;
    return operation;
  }

  private disposePreparedHandle(prepared: PreparedKeyLockSource) {
    const existing = this.preparedDisposals.get(prepared);
    if (existing) return existing;
    const operation = prepared.dispose().catch(() => undefined);
    this.preparedDisposals.set(prepared, operation);
    return operation;
  }

  private trackKeyLockCleanup(cleanup: Promise<void>) {
    const prior = this.keyLockCleanupPending;
    this.keyLockCleanupPending = Promise.all([prior, cleanup]).then(() => undefined);
  }

  /** Diagnostic-only bounded teardown; not transition authority. */
  async awaitKeyLockCleanupForDiagnostic() {
    await this.keyLockPreparation?.catch(() => false);
    await this.preparedStopPending;
    await this.keyLockCleanupPending;
  }
}
