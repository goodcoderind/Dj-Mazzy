import type { AudioEngine, DeckChannel } from "./AudioEngine";
import { createDeckDspChain } from "./deckDspChain";
import {
  PREPARED_KEY_LOCK_PROCESSOR,
  runtimeKeyLockLoadKey,
  type DeckKeyLockState,
  type PreparedKeyLockFactory,
  type PreparedKeyLockSource
} from "./keyLockPreparedSource";
import {
  createDeckPlaybackCompletionLease,
  deriveConstantRatePlaybackEndTime,
  deriveRampedPlaybackEndTime,
  inspectDeckPlaybackCompletion,
  ownsDeckPlaybackCompletionLease,
  type DeckPlaybackCompletionLease,
  type DeckPlaybackCompletionSignal
} from "../planning/deckPlaybackCompletionOwnership";

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
  completionSettledBy: DeckPlaybackCompletionSignal | null;
  completionIntent: "natural" | "scheduled-stop" | null;
  completionOperation: number | null;
  completionLoadRevision: number | null;
  error: string | null;
}>;

export type DeckPlaybackCompletionEvent = Readonly<{
  channel: DeckChannel;
  trackId: string | null;
  operation: number;
  loadRevision: number;
  settledBy: DeckPlaybackCompletionSignal;
  outcome: "on-time" | "recovered" | "late" | "premature";
}>;

type PlaybackRateSegment = {
  startTime: number;
  endTime: number;
  startRate: number;
  targetRate: number;
  startPosition: number;
};

type DeckListener = (snapshot: DeckSnapshot) => void;
type DeckPlaybackCompletionListener = (event: DeckPlaybackCompletionEvent) => void;

type NativeCompletionRuntime = {
  lease: DeckPlaybackCompletionLease;
  source: AudioBufferSourceNode;
  deadlineCancel: (() => void) | null;
  wakeTimer: ReturnType<typeof setTimeout> | null;
};

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
  private readonly playbackCompletionListeners = new Set<DeckPlaybackCompletionListener>();

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
  private trackTrimDb = 0;
  private rateTimeline: PlaybackRateSegment[] = [];
  private error: string | null = null;
  private runtimeLoadRevision = 0;
  private transportRevision = 0;
  private ratePlanRevision = 0;
  private playbackCompletionOperation = 0;
  private sourceId = 0;
  private nativeCompletion: NativeCompletionRuntime | null = null;
  private completionSettledBy: DeckPlaybackCompletionSignal | null = null;
  private completionIntent: "natural" | "scheduled-stop" | null = null;
  private completionOperation: number | null = null;
  private completionLoadRevision: number | null = null;
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
    try { listener(this.getSnapshot()); } catch { /* Observers cannot revoke audio ownership. */ }
    return () => this.listeners.delete(listener);
  }

  subscribePlaybackCompletion(listener: DeckPlaybackCompletionListener) {
    this.playbackCompletionListeners.add(listener);
    return () => this.playbackCompletionListeners.delete(listener);
  }

  private emit() {
    let snapshot: DeckSnapshot;
    try { snapshot = this.getSnapshot(); } catch { return; }
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* Observers cannot revoke audio ownership. */ }
    }
  }

  private emitPlaybackCompletion(event: DeckPlaybackCompletionEvent) {
    for (const listener of this.playbackCompletionListeners) {
      try { listener(event); } catch { /* One observer cannot revoke transport ownership. */ }
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
      completionSettledBy: this.completionSettledBy,
      completionIntent: this.completionIntent,
      completionOperation: this.completionOperation,
      completionLoadRevision: this.completionLoadRevision,
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

  hasNativePlaybackCompletionAuthority() {
    const runtime = this.nativeCompletion;
    return Boolean(runtime && this.source === runtime.source && this.activePlaybackBackend === "native" &&
      ownsDeckPlaybackCompletionLease(this.nativeCompletion?.lease, runtime.lease));
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
    if (this.audioEngine.isFatalHostLocked()) return false;
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
    this.rateTimeline = [];
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
    this.setTrackTrimDb(0);
    this.startOffset = 0;
    this.playbackRate = 1;
    this.rateTimeline = [];
    this.error = null;
    this.completionSettledBy = null;
    this.completionIntent = null;
    this.completionOperation = null;
    this.completionLoadRevision = null;
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
    this.rateTimeline = [];
    this.error = null;
    this.completionSettledBy = null;
    this.completionIntent = null;
    this.completionOperation = null;
    this.completionLoadRevision = null;
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
    if (this.audioEngine.isFatalHostLocked()) {
      throw new Error("audio starts are locked after a fatal host error");
    }
    if (!this.buffer) {
      throw new Error("cannot play before a track is prepared");
    }
    if (this.preparedStopPending || this.activePlaybackBackend === "signalsmith") {
      throw new Error("cannot start native playback while key-lock playback is stopping");
    }

    const context = this.audioEngine.context;
    let startTime = this.audioEngine.clock.resolveScheduleTime(when);
    const maxOffset = Math.max(this.buffer.duration - 0.01, 0);
    const requestedOffset =
      offsetSeconds ?? (this.status === "ended" ? 0 : this.getPosition());
    const safeOffset = Math.max(0, Math.min(requestedOffset, maxOffset));
    this.stopSource();

    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.transportGate);

    // Rebase an immediate start after source construction. Web Audio does not
    // retroactively consume media when start(when) receives a time that became
    // past during synchronous setup.
    const gateNow = this.audioEngine.clock.now();
    startTime = Math.max(startTime, gateNow);

    this.source = source;
    this.activePlaybackBackend = "native";
    this.transportRevision += 1;
    this.ratePlanRevision += 1;
    this.sourceId += 1;
    this.startTime = startTime;
    this.startOffset = safeOffset;
    this.rateTimeline = [{
      startTime,
      endTime: Number.POSITIVE_INFINITY,
      startRate: this.playbackRate,
      targetRate: this.playbackRate,
      startPosition: safeOffset
    }];
    this.error = null;
    this.completionSettledBy = null;
    this.completionIntent = null;
    this.completionOperation = null;
    this.completionLoadRevision = null;
    this.status = startTime > this.audioEngine.clock.now() ? "scheduled" : "playing";
    const expectedEndTime = deriveConstantRatePlaybackEndTime({
      startTimeSeconds: startTime,
      startOffsetSeconds: safeOffset,
      durationSeconds: this.buffer.duration,
      playbackRate: this.playbackRate
    });
    const completionRuntime = this.installNativeCompletion(
      source,
      expectedEndTime,
      this.buffer.duration,
      "natural",
      false
    );
    try {
      // Commit the mute/open automation before starting the one-shot source and
      // before any watchdog adapter can block. A source must never consume its
      // whole interval behind a still-muted transport gate.
      this.transportGate.gain.cancelScheduledValues(gateNow);
      this.transportGate.gain.setValueAtTime(0, gateNow);
      this.transportGate.gain.setValueAtTime(1, startTime);
      source.start(startTime, safeOffset);
    } catch (error) {
      this.revokeNativeCompletion();
      this.source = null;
      this.activePlaybackBackend = null;
      this.status = "ready";
      try { this.muteTransportGate(this.audioEngine.clock.now()); }
      catch { try { this.transportGate.gain.value = 0; } catch { /* Source ownership is revoked. */ } }
      try { source.disconnect(); } catch { /* The failed source owns no transport. */ }
      throw error;
    }
    this.armNativeCompletionWatchdog(completionRuntime);
    this.emit();
    return startTime;
  }

  pause() {
    if (!this.source && this.activePlaybackBackend !== "signalsmith") {
      return false;
    }
    try { this.startOffset = this.getPosition(); } catch { /* Preserve the last known offset. */ }
    this.stopSource();
    this.rateTimeline = [];
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
    this.reconcilePlaybackCompletion();
    if (!this.source || !this.buffer) {
      return false;
    }
    const scheduled = this.audioEngine.clock.resolveScheduleTime(when);
    const currentCompletion = this.nativeCompletion?.lease;
    if (!currentCompletion || currentCompletion.intent !== "natural" ||
      scheduled >= currentCompletion.expectedEndTimeSeconds - 1e-9) {
      return false;
    }
    const naturalEnd = currentCompletion.expectedEndTimeSeconds;
    const effectiveEnd = Math.max(this.startTime, Math.min(
      scheduled,
      naturalEnd
    ));
    const endPosition = this.getPosition(effectiveEnd);
    this.ratePlanRevision += 1;
    this.installNativeCompletion(this.source, effectiveEnd, endPosition, "scheduled-stop");
    try {
      this.source.stop(effectiveEnd);
    } catch {
      this.ratePlanRevision += 1;
      this.installNativeCompletion(this.source, naturalEnd, this.buffer.duration, "natural");
      return false;
    }
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
    this.rateTimeline = [];
    this.error = null;
    this.completionSettledBy = null;
    this.completionIntent = null;
    this.completionOperation = null;
    this.completionLoadRevision = null;
    this.status = "idle";
    this.emit();
  }

  shutdownForHostTeardown() {
    const ownedAudio = Boolean(this.source || this.activePlaybackBackend === "signalsmith");
    if (!ownedAudio) return false;
    try { this.startOffset = this.getPosition(); } catch { /* Preserve the last known offset. */ }
    this.stopSource();
    this.rateTimeline = [];
    this.status = this.buffer ? "paused" : "idle";
    return true;
  }

  setPlaybackRate(value: number) {
    if (!Number.isFinite(value)) {
      throw new RangeError("playback rate must be finite");
    }
    this.reconcilePlaybackCompletion();
    const safeRate = clampPlaybackRate(value);
    const position = this.getPosition();
    const wasActive = this.isActive();
    const restartTime = this.status === "scheduled" ? this.startTime : this.audioEngine.clock.now();
    this.playbackRate = safeRate;
    this.rateTimeline = [];
    if (wasActive) {
      this.play(position, restartTime);
    } else {
      this.startOffset = position;
      this.emit();
    }
    return safeRate;
  }

  schedulePlaybackRateRamp(targetRate: number, startTime: number, durationSeconds: number) {
    this.reconcilePlaybackCompletion();
    if (!this.source || !this.nativeCompletion || this.nativeCompletion.lease.intent !== "natural") {
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
    const now = this.audioEngine.clock.now();
    if (this.rateTimeline.some((segment) => Number.isFinite(segment.endTime) &&
      segment.endTime > now + 1e-9 && scheduledStart > segment.startTime + 1e-9 &&
      scheduledStart <= segment.endTime + 1e-9)) {
      // cancelScheduledValues cannot preserve the already-defined slope of an
      // overlapping linear ramp. Fail closed rather than let media position
      // and the natural-completion deadline diverge from rendered audio.
      return false;
    }
    if (this.nativeCompletion &&
      scheduledStart >= this.nativeCompletion.lease.expectedEndTimeSeconds - 1e-9) {
      return false;
    }
    const startRate = this.getPlaybackRate(scheduledStart);
    const startPosition = this.getPosition(scheduledStart);
    this.source.playbackRate.cancelScheduledValues(scheduledStart);
    this.source.playbackRate.setValueAtTime(startRate, scheduledStart);
    this.source.playbackRate.linearRampToValueAtTime(safeTarget, scheduledStart + durationSeconds);
    const rampEnd = scheduledStart + durationSeconds;
    const truncated = this.rateTimeline.flatMap((segment) => {
      if (segment.startTime >= scheduledStart) return [];
      if (segment.endTime <= scheduledStart) return [segment];
      return [{ ...segment, endTime: scheduledStart, targetRate: startRate }];
    });
    const rampDistance = (startRate + safeTarget) * 0.5 * durationSeconds;
    this.rateTimeline = [
      ...truncated,
      {
        startTime: scheduledStart,
        endTime: rampEnd,
        startRate,
        targetRate: safeTarget,
        startPosition
      },
      {
        startTime: rampEnd,
        endTime: Number.POSITIVE_INFINITY,
        startRate: safeTarget,
        targetRate: safeTarget,
        startPosition: startPosition + rampDistance
      }
    ];
    this.playbackRate = safeTarget;
    this.ratePlanRevision += 1;
    this.installNativeCompletion(
      this.source,
      deriveRampedPlaybackEndTime({
        durationSeconds: this.buffer?.duration ?? 0,
        rampStartTimeSeconds: scheduledStart,
        rampStartPositionSeconds: startPosition,
        rampDurationSeconds: durationSeconds,
        startRate,
        targetRate: safeTarget
      }),
      this.buffer?.duration ?? 0,
      "natural"
    );
    this.emit();
    return true;
  }

  reconcilePlaybackCompletion(nowSeconds?: number) {
    const runtime = this.nativeCompletion;
    if (!runtime) return false;
    if (nowSeconds != null && (!Number.isFinite(nowSeconds) || nowSeconds < 0)) return false;
    let authoritativeNow: number;
    try { authoritativeNow = this.audioEngine.clock.now(); }
    catch { return false; }
    return this.settleNativeCompletion(
      runtime,
      "reconcile",
      nowSeconds == null ? authoritativeNow : Math.min(nowSeconds, authoritativeNow)
    );
  }

  getPlaybackRate(atTime = this.audioEngine.clock.now()) {
    if (!this.rateTimeline.length) return this.playbackRate;
    const segment = [...this.rateTimeline].reverse().find((entry) => atTime >= entry.startTime) ??
      this.rateTimeline[0];
    if (!Number.isFinite(segment.endTime) || atTime >= segment.endTime) return segment.targetRate;
    if (atTime <= segment.startTime) return segment.startRate;
    const progress = (atTime - segment.startTime) / (segment.endTime - segment.startTime);
    return segment.startRate + (segment.targetRate - segment.startRate) * progress;
  }

  getPosition(atTime = this.audioEngine.clock.now()) {
    if (!this.buffer || (!this.source && this.activePlaybackBackend !== "signalsmith")) {
      return this.startOffset;
    }
    if (atTime <= this.startTime) {
      return this.startOffset;
    }

    const segment = [...this.rateTimeline].reverse().find((entry) => atTime >= entry.startTime);
    let position: number;
    if (!segment) {
      position = this.startOffset + (atTime - this.startTime) * this.playbackRate;
    } else {
      const elapsed = Math.max(0, Math.min(atTime, segment.endTime) - segment.startTime);
      if (!Number.isFinite(segment.endTime) || segment.startRate === segment.targetRate) {
        position = segment.startPosition + elapsed * segment.startRate;
      } else {
        const duration = segment.endTime - segment.startTime;
        const slope = (segment.targetRate - segment.startRate) / duration;
        position = segment.startPosition + segment.startRate * elapsed + 0.5 * slope * elapsed * elapsed;
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
    this.trackTrimDb = safeDb;
    return safeDb;
  }

  getTrackTrimDb() {
    return this.trackTrimDb;
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
    // Revoke every natural/scheduled completion owner before any fallible clock,
    // AudioParam, stop, disconnect, or processor cleanup operation.
    this.revokeNativeCompletion();
    const source = this.source;
    this.source = null;
    const preparedWasActive = this.activePlaybackBackend === "signalsmith";
    this.activePlaybackBackend = null;
    const completion = this.preparedCompletion;
    this.preparedCompletion = null;
    let now = 0;
    try { now = Number(this.audioEngine.context.currentTime); } catch { /* Use zero as the final fallback. */ }
    try { now = this.audioEngine.clock.now(); } catch { /* Use the frozen context time below. */ }
    if (!Number.isFinite(now) || now < 0) now = 0;
    try {
      this.muteTransportGate(now);
    } catch {
      try { this.transportGate.gain.value = 0; } catch { /* Authority is already revoked. */ }
    }
    if (completion) {
      completion.onended = null;
      try { completion.stop(); } catch { /* already ended */ }
      try { completion.disconnect(); } catch { /* prepared authority is already revoked */ }
    }
    const prepared = this.preparedKeyLock;
    if (preparedWasActive && prepared) {
      try { void this.stopPreparedHandle(prepared, now); }
      catch { void this.disposePreparedHandle(prepared); }
    }
    if (!source) return;
    try {
      source.stop();
    } catch {
      // A one-shot source may already have ended.
    }
    try { source.disconnect(); } catch { /* Transport authority is already revoked. */ }
  }

  private installNativeCompletion(
    source: AudioBufferSourceNode,
    expectedEndTimeSeconds: number,
    endPositionSeconds: number,
    intent: "natural" | "scheduled-stop",
    armWatchdog = true
  ) {
    const buffer = this.buffer;
    if (!buffer || this.source !== source || this.activePlaybackBackend !== "native") {
      throw new Error("native completion requires the exact active source");
    }
    this.revokeNativeCompletion();
    const lease = createDeckPlaybackCompletionLease({
      operation: ++this.playbackCompletionOperation,
      channel: this.channel,
      loadRevision: this.runtimeLoadRevision,
      transportRevision: this.transportRevision,
      ratePlanRevision: this.ratePlanRevision,
      sourceId: this.sourceId,
      trackId: this.trackId,
      intent,
      startTimeSeconds: this.startTime,
      startOffsetSeconds: this.startOffset,
      durationSeconds: buffer.duration,
      endPositionSeconds,
      expectedEndTimeSeconds
    });
    const runtime: NativeCompletionRuntime = {
      lease,
      source,
      deadlineCancel: null,
      wakeTimer: null
    };
    this.nativeCompletion = runtime;
    source.onended = () => { this.settleNativeCompletion(runtime, "source-onended"); };
    if (armWatchdog) this.armNativeCompletionWatchdog(runtime);
    return runtime;
  }

  private armNativeCompletionWatchdog(runtime: NativeCompletionRuntime) {
    if (!ownsDeckPlaybackCompletionLease(this.nativeCompletion?.lease, runtime.lease)) return;
    try {
      runtime.deadlineCancel = this.audioEngine.onAudioClockDeadline(
        runtime.lease.watchdogTimeSeconds,
        () => { this.settleNativeCompletion(runtime, "audio-clock"); }
      );
    } catch {
      runtime.deadlineCancel = null;
      // The source is already started for new playback. The independent
      // bounded wake (and explicit coordinator reconcile) owns recovery.
    }
    this.scheduleNativeCompletionWake(runtime);
  }

  private revokeNativeCompletion() {
    const runtime = this.nativeCompletion;
    if (!runtime) return false;
    this.nativeCompletion = null;
    try { runtime.source.onended = null; } catch { /* Exact authority is already revoked. */ }
    const cancel = runtime.deadlineCancel;
    runtime.deadlineCancel = null;
    if (runtime.wakeTimer != null) globalThis.clearTimeout(runtime.wakeTimer);
    runtime.wakeTimer = null;
    try { cancel?.(); } catch { /* Exact completion authority is already revoked. */ }
    return true;
  }

  private scheduleNativeCompletionWake(runtime: NativeCompletionRuntime) {
    if (!ownsDeckPlaybackCompletionLease(this.nativeCompletion?.lease, runtime.lease)) return;
    if (runtime.wakeTimer != null) globalThis.clearTimeout(runtime.wakeTimer);
    let remainingMs = 250;
    try {
      remainingMs = this.audioEngine.context.state === "running"
        ? Math.max(25, (runtime.lease.watchdogTimeSeconds - this.audioEngine.clock.now()) * 1_000)
        : 250;
    } catch { /* Retry as a bounded wake; the audio clock remains authoritative. */ }
    runtime.wakeTimer = globalThis.setTimeout(() => {
      runtime.wakeTimer = null;
      if (!this.settleNativeCompletion(runtime, "reconcile")) {
        this.scheduleNativeCompletionWake(runtime);
      }
    }, remainingMs);
    (runtime.wakeTimer as unknown as { unref?: () => void }).unref?.();
  }

  private settleNativeCompletion(
    runtime: NativeCompletionRuntime,
    signal: DeckPlaybackCompletionSignal,
    observedNowSeconds?: number
  ) {
    const sourceSignal = signal === "source-onended";
    if (!sourceSignal && this.audioEngine.context.state !== "running") return false;
    let now: number;
    try { now = observedNowSeconds ?? this.audioEngine.clock.now(); }
    catch {
      if (!sourceSignal) return false;
      now = runtime.lease.intent === "scheduled-stop"
        ? runtime.lease.expectedEndTimeSeconds
        : runtime.lease.startTimeSeconds;
    }
    const ownershipNow = sourceSignal
      ? now + 128 / this.audioEngine.context.sampleRate
      : now;
    const state = inspectDeckPlaybackCompletion({
      current: this.nativeCompletion?.lease ?? null,
      expected: runtime.lease,
      nowSeconds: ownershipNow,
      loadRevision: this.runtimeLoadRevision,
      transportRevision: this.transportRevision,
      sourceId: this.sourceId,
      trackId: this.trackId,
      sourcePresent: this.source === runtime.source && this.activePlaybackBackend === "native",
      signal
    });
    const naturalSourceWhileStopped = sourceSignal && runtime.lease.intent === "natural" &&
      this.audioEngine.context.state !== "running";
    if ((state === "waiting" || naturalSourceWhileStopped) && sourceSignal &&
      ownsDeckPlaybackCompletionLease(this.nativeCompletion?.lease, runtime.lease)) {
      // The exact native source ended before its integrated media-time
      // boundary. It is no longer audible, so waiting and later relabelling it
      // as natural EOF would be false. Revoke it into a recoverable stopped
      // state; App may then pause unattended authority explicitly.
      this.nativeCompletion = null;
      runtime.source.onended = null;
      const cancelEarly = runtime.deadlineCancel;
      runtime.deadlineCancel = null;
      if (runtime.wakeTimer != null) globalThis.clearTimeout(runtime.wakeTimer);
      runtime.wakeTimer = null;
      try { cancelEarly?.(); } catch { /* Exact authority is already revoked. */ }
      try { this.muteTransportGate(now); } catch { /* Source already stopped. */ }
      try { runtime.source.disconnect(); } catch { /* Source already stopped. */ }
      if (this.source !== runtime.source) return false;
      this.startOffset = this.getPosition(now);
      this.source = null;
      this.activePlaybackBackend = null;
      this.rateTimeline = [];
      this.completionSettledBy = signal;
      this.completionIntent = runtime.lease.intent;
      this.completionOperation = runtime.lease.operation;
      this.completionLoadRevision = runtime.lease.loadRevision;
      this.error = "Playback ended before its verified audio-clock boundary.";
      this.status = "recoverable-error";
      this.emit();
      this.emitPlaybackCompletion(Object.freeze({
        channel: this.channel,
        trackId: runtime.lease.trackId,
        operation: runtime.lease.operation,
        loadRevision: runtime.lease.loadRevision,
        settledBy: signal,
        outcome: "premature"
      }));
      return true;
    }
    if (state !== "ready") return false;
    if (!ownsDeckPlaybackCompletionLease(this.nativeCompletion?.lease, runtime.lease)) return false;
    this.nativeCompletion = null;
    runtime.source.onended = null;
    const cancel = runtime.deadlineCancel;
    runtime.deadlineCancel = null;
    if (runtime.wakeTimer != null) globalThis.clearTimeout(runtime.wakeTimer);
    runtime.wakeTimer = null;
    try { cancel?.(); } catch { /* Exact completion authority is already revoked. */ }
    try { this.muteTransportGate(now); } catch { /* The source has already completed. */ }
    try { runtime.source.disconnect(); } catch { /* The one-shot source has ended. */ }
    if (this.source !== runtime.source) return false;
    this.source = null;
    this.activePlaybackBackend = null;
    this.startOffset = runtime.lease.endPositionSeconds;
    this.rateTimeline = [];
    this.completionSettledBy = signal;
    this.completionIntent = runtime.lease.intent;
    this.completionOperation = runtime.lease.operation;
    this.completionLoadRevision = runtime.lease.loadRevision;
    this.status = runtime.lease.intent === "natural" ? "ended" : "paused";
    this.emit();
    if (runtime.lease.intent === "natural") {
      this.emitPlaybackCompletion(Object.freeze({
        channel: this.channel,
        trackId: runtime.lease.trackId,
        operation: runtime.lease.operation,
        loadRevision: runtime.lease.loadRevision,
        settledBy: signal,
        outcome: signal === "source-onended"
          ? (now > runtime.lease.watchdogTimeSeconds ? "late" : "on-time")
          : "recovered"
      }));
    }
    return true;
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
