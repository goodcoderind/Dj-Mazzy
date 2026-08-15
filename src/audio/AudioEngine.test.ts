import { describe, expect, it } from "vitest";
import {
  AudioEngine,
  DEFAULT_LIMITER_THRESHOLD_DB,
  DEFAULT_MASTER_HEADROOM_DB
} from "./AudioEngine";
import { MASTER_DSP_V1 } from "./masterDsp";
import { DeckEngine } from "./DeckEngine";
import type { PreparedKeyLockSource } from "./keyLockPreparedSource";

class FakeAudioParam {
  value: number;
  events: Array<{ type: string; time: number; value?: number; duration?: number; curve?: Float32Array }> = [];

  constructor(value = 0) {
    this.value = value;
  }

  cancelScheduledValues(time: number) {
    this.events.push({ type: "cancel", time });
  }

  cancelAndHoldAtTime(time: number) {
    this.events.push({ type: "hold", time });
  }

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "value", value, time });
  }

  setValueCurveAtTime(curve: Float32Array, time: number, duration: number) {
    this.value = curve[curve.length - 1];
    this.events.push({ type: "curve", curve: new Float32Array(curve), time, duration });
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "ramp", value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "ramp", value, time });
  }
}

class FakeAudioNode {
  connections: FakeAudioNode[] = [];

  connect(target: FakeAudioNode) {
    this.connections.push(target);
    return target;
  }


  disconnect() {}
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam(1);
}

class FakeBiquadNode extends FakeAudioNode {
  type: BiquadFilterType = "lowpass";
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  gain = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  playbackRate = new FakeAudioParam(1);
  onended: (() => void) | null = null;
  startCalls: Array<{ when: number; offset: number }> = [];
  stopCalls: Array<number | undefined> = [];

  start(when = 0, offset = 0) {
    this.startCalls.push({ when, offset });
  }

  stop(when?: number) {
    this.stopCalls.push(when);
  }

  disconnect() {}
}

class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = "sine";
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  startCalls: number[] = [];
  stopCalls: number[] = [];

  start(when = 0) { this.startCalls.push(when); }
  stop(when = 0) { this.stopCalls.push(when); }
  disconnect() {}
}

class FakeCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam();
  knee = new FakeAudioParam();
  ratio = new FakeAudioParam();
  attack = new FakeAudioParam();
  release = new FakeAudioParam();
  reduction = -2.5;
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 8;
  smoothingTimeConstant = 0;
  samples = new Float32Array([0.5, -0.5, 0.25, -0.25, 0, 0, 0, 0]);

  getFloatTimeDomainData(target: Float32Array) {
    target.set(this.samples.subarray(0, target.length));
  }
}

class FakeAudioContext {
  currentTime = 10;
  sampleRate = 48_000;
  state: AudioContextState = "suspended";
  destination = new FakeAudioNode();
  gains: FakeGainNode[] = [];
  compressor = new FakeCompressorNode();
  analyser = new FakeAnalyserNode();
  filters: FakeBiquadNode[] = [];
  sources: FakeBufferSourceNode[] = [];
  createdBufferChannels: Float32Array[][] = [];
  oscillators: FakeOscillatorNode[] = [];
  createBuffer(channels: number, length: number, sampleRate: number) {
    const channelData = Array.from({ length: channels }, () => new Float32Array(length));
    this.createdBufferChannels.push(channelData);
    return {
      duration: length / sampleRate,
      copyToChannel: (samples: Float32Array, channel = 0) => channelData[channel].set(samples)
    } as unknown as AudioBuffer;
  }

  createGain() {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createDynamicsCompressor() {
    return this.compressor;
  }

  createBiquadFilter() {
    const node = new FakeBiquadNode();
    this.filters.push(node);
    return node;
  }

  createBufferSource() {
    const node = new FakeBufferSourceNode();
    this.sources.push(node);
    return node;
  }

  createOscillator() {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  createAnalyser() {
    return this.analyser;
  }

  async resume() {
    this.state = "running";
  }
}

const createEngine = () => {
  const context = new FakeAudioContext();
  return {
    context,
    engine: new AudioEngine(context as unknown as AudioContext)
  };
};

describe("AudioEngine", () => {
  it("builds one protected master graph shared by both decks", () => {
    const { context, engine } = createEngine();
    const [master, deckA, deckB] = context.gains;

    expect(deckA.connections).toEqual([master]);
    expect(deckB.connections).toEqual([master]);
    expect(master.connections).toEqual([context.compressor]);
    expect(context.compressor.connections).toEqual([context.gains[3]]);
    expect(context.gains[3].connections).toEqual([context.analyser]);
    expect(context.analyser.connections).toEqual([context.destination]);
    expect(20 * Math.log10(master.gain.value)).toBeCloseTo(DEFAULT_MASTER_HEADROOM_DB);
    expect(context.compressor.threshold.value).toBe(DEFAULT_LIMITER_THRESHOLD_DB);
    expect(engine.getDeckGain("a")).toBe(0);
    expect(engine.getDeckGain("b")).toBe(0);
  });

  it("resumes a suspended context and clamps manual gain", async () => {
    const { context, engine } = createEngine();
    await engine.resume();
    expect(context.state).toBe("running");
    expect(engine.setDeckGain("a", 1.5)).toBe(1);
    expect(engine.getDeckGain("a")).toBe(1);
  });

  it("holds recovered output silent until an exact running-context release", async () => {
    const { context, engine } = createEngine();
    const master = context.gains[0];
    const outputHold = context.gains[3];
    engine.setMasterGainDb(-9);
    expect(engine.holdOutputForHostAudioRecovery()).toBe(true);
    expect(outputHold.gain.value).toBe(0);
    expect(engine.isOutputHeldForHostAudioRecovery()).toBe(true);
    engine.setMasterGainDb(-3);
    expect(master.gain.value).toBeCloseTo(10 ** (-3 / 20));
    expect(outputHold.gain.value).toBe(0);
    expect(engine.releaseOutputAfterHostAudioRecovery()).toBe(false);
    await engine.resume();
    expect(engine.releaseOutputAfterHostAudioRecovery()).toBe(true);
    expect(outputHold.gain.value).toBe(1);
    expect(engine.isOutputHeldForHostAudioRecovery()).toBe(false);
    expect(engine.releaseOutputAfterHostAudioRecovery()).toBe(false);
  });

  it("does not claim a host recovery hold when its output AudioParam fails", () => {
    const { context, engine } = createEngine();
    context.gains[3].gain.setValueAtTime = () => { throw new Error("private output failure"); };
    expect(() => engine.holdOutputForHostAudioRecovery()).toThrow();
    expect(engine.isOutputHeldForHostAudioRecovery()).toBe(false);
  });

  it("does not claim a host recovery hold without a zero-gain observation", () => {
    const { context, engine } = createEngine();
    context.gains[3].gain.setValueAtTime = () => undefined;
    expect(engine.holdOutputForHostAudioRecovery()).toBe(false);
    expect(engine.isOutputHeldForHostAudioRecovery()).toBe(false);
  });

  it("refuses to release recovered output while an auxiliary source is still owned", async () => {
    const { context, engine } = createEngine();
    await engine.resume();
    expect(engine.holdOutputForHostAudioRecovery()).toBe(true);
    const cancelClicks = engine.scheduleAuditionClicks([{ audioTime: 1, downbeat: false }]);
    expect(engine.hostAudioRecoveryOutputReleaseIsSafe()).toBe(false);
    expect(engine.releaseOutputAfterHostAudioRecovery()).toBe(false);
    expect(engine.isOutputHeldForHostAudioRecovery()).toBe(true);
    cancelClicks();
    expect(engine.hostAudioRecoveryOutputReleaseIsSafe()).toBe(true);
    expect(engine.releaseOutputAfterHostAudioRecovery()).toBe(true);
  });

  it("keeps per-track level trim separate from crossfader gain", () => {
    const { context, engine } = createEngine();
    const deckA = engine.getDeck("a");
    expect(deckA.setTrackTrimDb(8)).toBe(3);
    expect(deckA.getTrackTrimDb()).toBe(3);
    expect(context.gains[4].gain.value).toBeCloseTo(10 ** (3 / 20));
    expect(engine.getDeckGain("a")).toBe(0);
    deckA.beginPreparing("next-track");
    expect(deckA.getTrackTrimDb()).toBe(0);
    expect(context.gains[4].gain.value).toBe(1);
  });

  it("schedules an immutable equal-power crossfade on the audio clock", () => {
    const { context, engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 12, 8);
    const sourceCurveEvent = context.gains[1].gain.events.at(-1);
    const targetCurveEvent = context.gains[2].gain.events.at(-1);

    expect(schedule).toEqual({ id: 1, source: "a", target: "b", startTime: 12, endTime: 20 });
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(sourceCurveEvent?.type).toBe("curve");
    expect(sourceCurveEvent?.curve?.[0]).toBeCloseTo(1);
    expect(sourceCurveEvent?.curve?.at(-1)).toBeCloseTo(0, 5);
    expect(targetCurveEvent?.curve?.[0]).toBeCloseTo(0);
    expect(targetCurveEvent?.curve?.at(-1)).toBeCloseTo(1);
    expect(engine.getActiveCrossfade()).toBe(schedule);
    expect(engine.finishCrossfade(schedule.id)).toBe(true);
    expect(engine.getActiveCrossfade()).toBeNull();
  });

  it("clamps late automation to the current audio time", () => {
    const { engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 5, 4);
    expect(schedule.startTime).toBe(10);
    expect(schedule.endTime).toBe(14);
  });

  it("reports deterministic peak and RMS readings", () => {
    const { engine } = createEngine();
    const meter = engine.readMasterMeter();
    expect(meter.peak).toBe(0.5);
    expect(meter.rms).toBeCloseTo(Math.sqrt(0.625 / 2048));
    expect(meter.peakDb).toBeCloseTo(-6.0206, 3);
    expect(meter.limiterReductionDb).toBe(-2.5);
  });

  it("rejects overlapping crossfade schedules", () => {
    const { engine } = createEngine();
    engine.scheduleCrossfade("a", "b", 12, 8);
    expect(() => engine.scheduleCrossfade("b", "a", 14, 8)).toThrow(
      "another crossfade is already active"
    );
  });

  it("does not replace an overdue crossfade until its owner explicitly settles", () => {
    const { context, engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 12, 8);
    context.currentTime = 30;
    expect(() => engine.scheduleCrossfade("b", "a", 31, 4)).toThrow(
      "another crossfade is already active"
    );
    expect(engine.getActiveCrossfade()).toBe(schedule);
  });

  it("cancels a half-armed crossfade and restores stable source ownership", () => {
    const { context, engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 12, 8);
    expect(engine.cancelCrossfade(schedule.id)).toBe(true);
    expect(engine.getActiveCrossfade()).toBeNull();
    expect(context.gains[1].gain.events.at(-1)).toEqual({ type: "ramp", value: 1, time: 10.03 });
    expect(context.gains[2].gain.events.at(-1)).toEqual({ type: "ramp", value: 0, time: 10.03 });
    expect(context.gains[1].gain.events).toContainEqual({ type: "hold", time: 10 });
    expect(engine.cancelCrossfade(schedule.id)).toBe(false);
  });

  it("schedules clearly audible, limiter-protected timing clicks", () => {
    const { context, engine } = createEngine();
    const cancel = engine.scheduleAuditionClicks([
      { audioTime: 11, downbeat: false },
      { audioTime: 12, downbeat: true }
    ]);
    const [beat, downbeat] = context.oscillators;
    const beatGain = context.gains.at(-2)!;
    const downbeatGain = context.gains.at(-1)!;

    expect(beat.type).toBe("square");
    expect(beat.frequency.value).toBe(1120);
    expect(downbeat.frequency.value).toBe(1760);
    expect(beatGain.connections).toEqual([context.compressor]);
    expect(downbeatGain.connections).toEqual([context.compressor]);
    expect(beatGain.gain.events).toContainEqual({ type: "ramp", value: 0.22, time: 11.001 });
    expect(downbeatGain.gain.events).toContainEqual({ type: "ramp", value: 0.32, time: 12.001 });
    cancel();
    expect(beat.stopCalls.at(-1)).toBe(context.currentTime);
  });

  it("plays a finite rehearsal preview through the protected master graph", () => {
    const { context, engine } = createEngine();
    let ended = 0;
    const cancel = engine.playProtectedPreview(
      { kind: "pre-master-stereo/v1", requiredMasterVersion: MASTER_DSP_V1.version, sampleRate: 8_000, channels: [
        Float32Array.from([0, 0.25, -0.25, 0]),
        Float32Array.from([0, -0.1, 0.1, 0])
      ] },
      () => { ended += 1; }
    );
    const source = context.sources.at(-1)!;
    expect(source.connections).toEqual([context.gains[0]]);
    expect(source.startCalls).toEqual([{ when: 10, offset: 0 }]);
    expect(context.createdBufferChannels.at(-1)?.[0]).toEqual(Float32Array.from([0, 0.25, -0.25, 0]));
    expect(context.createdBufferChannels.at(-1)?.[1]).toEqual(Float32Array.from([0, -0.1, 0.1, 0]));
    source.onended?.();
    source.onended?.();
    expect(ended).toBe(1);
    cancel();
    expect(source.stopCalls.at(-1)).toBeUndefined();
  });

  it("releases preview completion authority even when source disconnection throws", () => {
    const { context, engine } = createEngine();
    let ended = 0;
    engine.playProtectedPreview(
      { kind: "pre-master-stereo/v1", requiredMasterVersion: MASTER_DSP_V1.version, sampleRate: 8_000, channels: [
        Float32Array.from([0, 0.2, -0.2, 0]),
        Float32Array.from([0, -0.2, 0.2, 0])
      ] },
      () => { ended += 1; }
    );
    const source = context.sources.at(-1)!;
    source.disconnect = () => { throw new Error("detached graph"); };

    expect(() => source.onended?.()).not.toThrow();
    expect(ended).toBe(1);
  });

  it("owns crossfade completion on the audio clock instead of animation frames", () => {
    const { context, engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 11, 2);
    let completions = 0;
    const cancel = engine.onCrossfadeComplete(schedule.id, () => { completions += 1; });
    const completionSource = context.oscillators.at(-1)!;
    expect(completionSource.startCalls).toEqual([13]);
    expect(completionSource.stopCalls).toEqual([13.001]);
    completionSource.onended?.();
    completionSource.onended?.();
    expect(completions).toBe(1);
    cancel();
  });

  it("rejects an expired deck-gain scheduling authority before automation mutation", () => {
    const { context, engine } = createEngine();
    const gain = context.gains[0].gain;
    const events = gain.events.length;
    expect(() => engine.scheduleDeckGainCurve("a", new Float32Array([0, 1]), 11, 0.08, () => false))
      .toThrow("authority expired");
    expect(gain.events).toHaveLength(events);
  });

  it("rejects missing or duplicate crossfade completion observers", () => {
    const { engine } = createEngine();
    expect(() => engine.onCrossfadeComplete(99, () => undefined)).toThrow("not active");
    const schedule = engine.scheduleCrossfade("a", "b", 11, 2);
    engine.onCrossfadeComplete(schedule.id, () => undefined);
    expect(() => engine.onCrossfadeComplete(schedule.id, () => undefined)).toThrow("already exists");
  });

  it("releases crossfade ownership even when completion-node cleanup throws", () => {
    const { context, engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 11, 2);
    engine.onCrossfadeComplete(schedule.id, () => undefined);
    const completionSource = context.oscillators.at(-1)!;
    completionSource.disconnect = () => { throw new Error("disconnect failed"); };
    expect(() => engine.finishCrossfade(schedule.id)).toThrow("disconnect failed");
    expect(engine.getActiveCrossfade()).toBeNull();
    expect(() => engine.onCrossfadeComplete(schedule.id, () => undefined)).toThrow("not active");
  });

  it("delivers the owned completion even when sentinel disconnect throws", () => {
    const { context, engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 11, 2);
    let completions = 0;
    engine.onCrossfadeComplete(schedule.id, () => { completions += 1; });
    const completionSource = context.oscillators.at(-1)!;
    completionSource.disconnect = () => { throw new Error("disconnect failed"); };
    expect(() => completionSource.onended?.()).not.toThrow();
    expect(completions).toBe(1);
    expect(engine.finishCrossfade(schedule.id)).toBe(true);
  });

  it("cancels a pending audio-clock completion during Rescue", () => {
    const { context, engine } = createEngine();
    const schedule = engine.scheduleCrossfade("a", "b", 11, 2);
    let completed = false;
    engine.onCrossfadeComplete(schedule.id, () => { completed = true; });
    const completionSource = context.oscillators.at(-1)!;
    expect(engine.cancelCrossfade(schedule.id)).toBe(true);
    completionSource.onended?.();
    expect(completed).toBe(false);
  });

  it("does not mutate gain automation when crossfade authority has expired", () => {
    const { engine } = createEngine();
    const beforeA = engine.getDeckInput("a") as unknown as FakeGainNode;
    const beforeB = engine.getDeckInput("b") as unknown as FakeGainNode;
    const eventsA = beforeA.gain.events.length;
    const eventsB = beforeB.gain.events.length;
    expect(() => engine.scheduleCrossfade("a", "b", 11, 2, undefined, () => false))
      .toThrow("authority expired");
    expect(beforeA.gain.events).toHaveLength(eventsA);
    expect(beforeB.gain.events).toHaveLength(eventsB);
    expect(engine.getActiveCrossfade()).toBeNull();
  });

  it("owns a cancellable audio-clock deadline without connecting audible output", () => {
    const { context, engine } = createEngine();
    let deadlines = 0;
    const cancel = engine.onAudioClockDeadline(12, () => { deadlines += 1; });
    const sentinel = context.oscillators.at(-1)!;
    expect(sentinel.startCalls).toEqual([12]);
    expect(sentinel.connections).toEqual([]);
    sentinel.onended?.();
    sentinel.onended?.();
    expect(deadlines).toBe(1);
    cancel();

    const cancelSecond = engine.onAudioClockDeadline(13, () => { deadlines += 1; });
    const second = context.oscillators.at(-1)!;
    second.disconnect = () => { throw new Error("browser disconnect failed"); };
    expect(() => cancelSecond()).not.toThrow();
    second.onended?.();
    expect(deadlines).toBe(1);
  });
});

describe("DeckEngine", () => {
  const buffer = { duration: 120 } as AudioBuffer;

  it("owns preparing, ready, scheduled, playing, and paused state", () => {
    const { context, engine } = createEngine();
    const deck = engine.getDeck("a");

    deck.beginPreparing("track-a");
    expect(deck.getSnapshot().status).toBe("preparing");
    deck.loadBuffer(buffer);
    expect(deck.getSnapshot()).toMatchObject({
      status: "ready",
      trackId: "track-a",
      durationSeconds: 120
    });

    deck.play(10, 15);
    expect(deck.getSnapshot().status).toBe("scheduled");
    expect(context.sources.at(-1)?.startCalls).toEqual([{ when: 15, offset: 10 }]);
    const transportGate = context.sources.at(-1)?.connections[0] as FakeGainNode;
    expect(transportGate.gain.events.slice(-2)).toEqual([
      { type: "value", value: 0, time: 10 },
      { type: "value", value: 1, time: 15 }
    ]);

    context.currentTime = 19;
    expect(deck.getSnapshot().status).toBe("playing");
    expect(deck.getPosition()).toBe(14);
    expect(deck.pause()).toBe(true);
    expect(deck.getSnapshot()).toMatchObject({ status: "paused", positionSeconds: 14 });
    expect(transportGate.gain.value).toBe(0);
  });

  it("prepares key lock once per runtime load without affecting native readiness", async () => {
    const { engine } = createEngine();
    let factoryCalls = 0;
    let resolvePrepared!: (value: PreparedKeyLockSource) => void;
    const pending = new Promise<PreparedKeyLockSource>((resolve) => { resolvePrepared = resolve; });
    const deck = new DeckEngine(engine, "a", async () => {
      factoryCalls += 1;
      return pending;
    });
    deck.loadBuffer(buffer, "track-a");
    const first = deck.prepareKeyLock();
    const second = deck.prepareKeyLock();
    expect(first).toBe(second);
    expect(factoryCalls).toBe(1);
    expect(deck.isReady()).toBe(true);
    expect(deck.getKeyLockState()).toMatchObject({ status: "preparing" });
    resolvePrepared({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      dispose: async () => undefined
    });
    await expect(first).resolves.toBe(true);
    expect(deck.getKeyLockState()).toMatchObject({ status: "ready", latencySeconds: 0.14 });
  });

  it("disposes a stale key-lock preparation after track replacement", async () => {
    const { engine } = createEngine();
    let resolvePrepared!: (value: PreparedKeyLockSource) => void;
    const pending = new Promise<PreparedKeyLockSource>((resolve) => { resolvePrepared = resolve; });
    let disposals = 0;
    const deck = new DeckEngine(engine, "b", async () => pending);
    deck.loadBuffer(buffer, "track-a");
    const preparation = deck.prepareKeyLock();
    deck.loadBuffer({ duration: 90 } as AudioBuffer, "track-b");
    resolvePrepared({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      dispose: async () => { disposals += 1; }
    });
    await expect(preparation).resolves.toBe(false);
    expect(disposals).toBe(1);
    expect(deck.getKeyLockState()).toMatchObject({ status: "unavailable" });
    expect(deck.getSnapshot()).toMatchObject({ trackId: "track-b", status: "ready" });
  });

  it("ignores a delayed processor failure from an older same-load attempt", async () => {
    const { engine } = createEngine();
    const failures: Array<() => void> = [];
    let calls = 0;
    const deck = new DeckEngine(engine, "a", async (_context, _buffer, onFailure) => {
      failures.push(onFailure);
      calls += 1;
      if (calls === 1) throw new Error("first preparation failed");
      return {
        processor: "signalsmith-stretch-web/1.3.2",
        latencySeconds: 0.14,
        minimumRate: 0.94,
        maximumRate: 1.06,
        connect: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        dispose: async () => undefined
      };
    });
    deck.loadBuffer(buffer, "track-a");
    await expect(deck.prepareKeyLock()).resolves.toBe(false);
    await expect(deck.prepareKeyLock()).resolves.toBe(true);
    failures[0]();
    expect(deck.getKeyLockState()).toMatchObject({ status: "ready" });
  });

  it("revokes only the current load on a key-lock processor failure", async () => {
    const { context, engine } = createEngine();
    let failProcessor!: () => void;
    const deck = new DeckEngine(engine, "a", async (_context, _buffer, onFailure) => {
      failProcessor = onFailure;
      return {
        processor: "signalsmith-stretch-web/1.3.2",
        latencySeconds: 0.14,
        minimumRate: 0.94,
        maximumRate: 1.06,
        connect: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        dispose: async () => undefined
      };
    });
    deck.loadBuffer(buffer, "track-a");
    await expect(deck.prepareKeyLock()).resolves.toBe(true);
    deck.play(0, context.currentTime);
    failProcessor();
    expect(deck.getKeyLockState()).toMatchObject({ status: "failed", reason: "processor" });
    expect(deck.isReady()).toBe(true);
    const transportGate = context.sources.at(-1)?.connections[0] as FakeGainNode;
    expect(transportGate.gain.value).toBe(1);
  });

  it("disposes a candidate whose graph installation throws", async () => {
    const { engine } = createEngine();
    let disposals = 0;
    const deck = new DeckEngine(engine, "a", async () => ({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => { throw new Error("connect failed"); },
      start: async () => undefined,
      stop: async () => undefined,
      dispose: async () => { disposals += 1; }
    }));
    deck.loadBuffer(buffer, "track-a");
    await expect(deck.prepareKeyLock()).resolves.toBe(false);
    expect(disposals).toBe(1);
    expect(deck.getKeyLockState()).toMatchObject({ status: "failed", reason: "initialization" });
  });

  it("runs isolated prepared playback only with exact load ownership and enough audio-clock lead", async () => {
    const { context, engine } = createEngine();
    const starts: Array<{ outputTime: number; inputSeconds: number; rate: number }> = [];
    let stops = 0;
    const deck = new DeckEngine(engine, "b", async () => ({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async (options) => { starts.push(options); },
      stop: async () => { stops += 1; },
      dispose: async () => undefined
    }));
    deck.loadBuffer(buffer, "track-b");
    await deck.prepareKeyLock();
    const state = deck.getKeyLockState();
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    await expect(deck.playPreparedKeyLockForDiagnostic("wrong-load", 4, 0.94, 10.3)).resolves.toBe(false);
    await expect(deck.playPreparedKeyLockForDiagnostic(state.loadKey, 4, 0.94, 10.1)).resolves.toBe(false);
    await expect(deck.playPreparedKeyLockForDiagnostic(state.loadKey, 4, 0.94, 10.3)).resolves.toBe(true);
    expect(starts).toEqual([{ outputTime: 10.3, inputSeconds: 4, rate: 0.94 }]);
    expect(deck.getActivePlaybackBackend()).toBe("signalsmith");
    expect(deck.getSnapshot().status).toBe("scheduled");
    context.currentTime = 10.5;
    expect(deck.getPosition()).toBeCloseTo(4 + 0.2 * 0.94);
    expect(deck.pause()).toBe(true);
    expect(stops).toBe(1);
    expect(deck.getActivePlaybackBackend()).toBeNull();
  });

  it("keeps the gate muted when a prepared start becomes stale while awaiting acknowledgement", async () => {
    const { context, engine } = createEngine();
    let acknowledge!: () => void;
    const startPending = new Promise<void>((resolve) => { acknowledge = resolve; });
    let stops = 0;
    const deck = new DeckEngine(engine, "a", async () => ({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async () => startPending,
      stop: async () => { stops += 1; },
      dispose: async () => undefined
    }));
    deck.loadBuffer(buffer, "old");
    await deck.prepareKeyLock();
    const state = deck.getKeyLockState();
    if (state.status !== "ready") throw new Error("test preparation failed");
    const playing = deck.playPreparedKeyLockForDiagnostic(state.loadKey, 0, 1.06, 10.4);
    deck.loadBuffer({ duration: 90 } as AudioBuffer, "new");
    acknowledge();
    await expect(playing).resolves.toBe(false);
    expect(stops).toBe(1);
    expect(deck.getActivePlaybackBackend()).toBeNull();
    const transportGate = context.gains.at(-1)!;
    expect(transportGate.gain.value).toBe(0);
    expect(deck.getSnapshot()).toMatchObject({ trackId: "new", status: "ready" });
  });

  it("keeps diagnostic cleanup pending until stale preparation has disposed", async () => {
    const { engine } = createEngine();
    let resolveFactory!: (value: Awaited<ReturnType<NonNullable<ConstructorParameters<typeof DeckEngine>[2]>>>) => void;
    const pendingFactory = new Promise<Awaited<ReturnType<NonNullable<ConstructorParameters<typeof DeckEngine>[2]>>>>(
      (resolve) => { resolveFactory = resolve; }
    );
    let disposals = 0;
    let releaseDisposal!: () => void;
    const disposalPending = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const deck = new DeckEngine(engine, "a", async () => pendingFactory);
    deck.loadBuffer(buffer, "old");
    void deck.prepareKeyLock();
    deck.eject();
    let cleaned = false;
    const cleanup = deck.awaitKeyLockCleanupForDiagnostic().then(() => { cleaned = true; });
    await Promise.all([Promise.resolve(), Promise.resolve(), Promise.resolve()]);
    expect(cleaned).toBe(false);
    resolveFactory({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      dispose: async () => { disposals += 1; await disposalPending; }
    });
    await Promise.all([Promise.resolve(), Promise.resolve(), Promise.resolve()]);
    expect(disposals).toBe(1);
    expect(cleaned).toBe(false);
    releaseDisposal();
    await cleanup;
    deck.loadBuffer(buffer, "new");
    await expect(deck.prepareKeyLock()).resolves.toBe(true);
  });

  it("revokes and disposes a prepared handle after its start RPC rejects", async () => {
    const { engine } = createEngine();
    let stops = 0;
    let disposals = 0;
    const deck = new DeckEngine(engine, "a", async () => ({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async () => { throw new Error("schedule timed out"); },
      stop: async () => { stops += 1; },
      dispose: async () => { disposals += 1; }
    }));
    deck.loadBuffer(buffer, "track-a");
    await deck.prepareKeyLock();
    const state = deck.getKeyLockState();
    if (state.status !== "ready") throw new Error("test preparation failed");
    await expect(deck.playPreparedKeyLockForDiagnostic(state.loadKey, 0, 1, 10.4)).resolves.toBe(false);
    await deck.awaitKeyLockCleanupForDiagnostic();
    expect(stops).toBe(1);
    expect(disposals).toBe(1);
    expect(deck.getKeyLockState()).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("stops and mutes prepared playback on natural completion", async () => {
    const { context, engine } = createEngine();
    let stops = 0;
    const deck = new DeckEngine(engine, "a", async () => ({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async () => undefined,
      stop: async () => { stops += 1; },
      dispose: async () => undefined
    }));
    deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
    await deck.prepareKeyLock();
    const state = deck.getKeyLockState();
    if (state.status !== "ready") throw new Error("test preparation failed");
    await deck.playPreparedKeyLockForDiagnostic(state.loadKey, 1, 1, 10.4);
    const transportGate = context.gains.at(-1)!;
    expect(transportGate.gain.events).toContainEqual({ type: "value", value: 0, time: 11.4 });
    context.oscillators.at(-1)!.onended?.();
    await Promise.resolve();
    expect(stops).toBe(1);
    expect(deck.getSnapshot().status).toBe("ended");
    expect(deck.getActivePlaybackBackend()).toBeNull();
    expect(transportGate.gain.value).toBe(0);
  });

  it("disposes a failed prepared stop before native fallback can reopen the gate", async () => {
    const { context, engine } = createEngine();
    let disposals = 0;
    let releaseDisposal!: () => void;
    const disposalPending = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const deck = new DeckEngine(engine, "a", async () => ({
      processor: "signalsmith-stretch-web/1.3.2",
      latencySeconds: 0.14,
      minimumRate: 0.94,
      maximumRate: 1.06,
      connect: () => undefined,
      start: async () => undefined,
      stop: async () => { throw new Error("processor stop failed"); },
      dispose: async () => { disposals += 1; await disposalPending; }
    }));
    deck.loadBuffer(buffer, "track-a");
    await deck.prepareKeyLock();
    const state = deck.getKeyLockState();
    if (state.status !== "ready") throw new Error("test preparation failed");
    await deck.playPreparedKeyLockForDiagnostic(state.loadKey, 0, 1, 10.4);
    expect(deck.pause()).toBe(true);
    expect(() => deck.play(0, 10.5)).toThrow(/stopping/);
    await Promise.resolve();
    expect(disposals).toBe(1);
    releaseDisposal();
    await deck.awaitKeyLockCleanupForDiagnostic();
    expect(deck.getKeyLockState()).toMatchObject({ status: "failed", reason: "processor" });
    expect(() => deck.play(0, 10.5)).not.toThrow();
  });

  it("captures position and pauses when an active prepared processor fails", async () => {
    const { context, engine } = createEngine();
    let failProcessor!: () => void;
    let stops = 0;
    const deck = new DeckEngine(engine, "a", async (_context, _buffer, onFailure) => {
      failProcessor = onFailure;
      return {
        processor: "signalsmith-stretch-web/1.3.2",
        latencySeconds: 0.14,
        minimumRate: 0.94,
        maximumRate: 1.06,
        connect: () => undefined,
        start: async () => undefined,
        stop: async () => { stops += 1; },
        dispose: async () => undefined
      };
    });
    deck.loadBuffer(buffer, "track-a");
    await deck.prepareKeyLock();
    const state = deck.getKeyLockState();
    if (state.status !== "ready") throw new Error("test preparation failed");
    await deck.playPreparedKeyLockForDiagnostic(state.loadKey, 5, 1.06, 10.4);
    context.currentTime = 11.4;
    failProcessor();
    await deck.awaitKeyLockCleanupForDiagnostic();
    expect(stops).toBe(1);
    expect(deck.getSnapshot().status).toBe("paused");
    expect(deck.getSnapshot().positionSeconds).toBeCloseTo(6.06);
    expect(deck.getActivePlaybackBackend()).toBeNull();
    expect(deck.getKeyLockState()).toMatchObject({ status: "failed", reason: "processor" });
  });

  it("waits for deferred disposal after an active processor failure", async () => {
    const { engine } = createEngine();
    let failProcessor!: () => void;
    let releaseDisposal!: () => void;
    const disposal = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const deck = new DeckEngine(engine, "a", async (_context, _buffer, onFailure) => {
      failProcessor = onFailure;
      return {
        processor: "signalsmith-stretch-web/1.3.2",
        latencySeconds: 0.14,
        minimumRate: 0.94,
        maximumRate: 1.06,
        connect: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        dispose: async () => disposal
      };
    });
    deck.loadBuffer(buffer, "track-a");
    await deck.prepareKeyLock();
    const state = deck.getKeyLockState();
    if (state.status !== "ready") throw new Error("test preparation failed");
    await deck.playPreparedKeyLockForDiagnostic(state.loadKey, 0, 1, 10.4);
    failProcessor();
    let cleaned = false;
    const cleanup = deck.awaitKeyLockCleanupForDiagnostic().then(() => { cleaned = true; });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    releaseDisposal();
    await cleanup;
    expect(cleaned).toBe(true);
  });

  it("tracks the integral of a scheduled playback-rate ramp", () => {
    const { context, engine } = createEngine();
    const deck = engine.getDeck("b");
    deck.loadBuffer(buffer, "track-b");
    deck.setPlaybackRate(1.2);
    deck.play(0, 10);
    deck.schedulePlaybackRateRamp(1, 12, 4);

    context.currentTime = 14;
    expect(deck.getPlaybackRate()).toBeCloseTo(1.1);
    expect(deck.getPosition()).toBeCloseTo(4.7);
  });

  it("restarts from the beginning after natural completion", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    deck.loadBuffer(buffer, "track-a");
    deck.play(0, 10);
    context.currentTime = 130;
    context.sources.at(-1)?.onended?.();
    expect(deck.getSnapshot().status).toBe("ended");

    deck.play();
    expect(context.sources.at(-1)?.startCalls[0]).toEqual({ when: 130, offset: 0 });
  });

  it("settles exact native natural completion once from the source callback", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    const completions: Parameters<Parameters<typeof deck.subscribePlaybackCompletion>[0]>[0][] = [];
    deck.subscribe(() => { throw new Error("snapshot observer failed"); });
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
    deck.play(0, 10);
    expect(deck.hasNativePlaybackCompletionAuthority()).toBe(true);
    const source = context.sources.at(-1)!;
    const primary = source.onended;

    context.currentTime = 12;
    primary?.();
    primary?.();

    expect(deck.getSnapshot().status).toBe("ended");
    expect(deck.hasNativePlaybackCompletionAuthority()).toBe(false);
    expect(completions).toEqual([expect.objectContaining({
      channel: "a",
      trackId: "short",
      settledBy: "source-onended",
      outcome: "on-time"
    })]);
  });

  it("labels a source callback delivered beyond the watchdog boundary as late", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    const completions: Array<{ settledBy: string; outcome: string }> = [];
    deck.subscribe(() => { throw new Error("snapshot observer failed"); });
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
    deck.play(0, 10);
    const retainedPrimary = context.sources.at(-1)!.onended;

    context.currentTime = 12.2;
    retainedPrimary?.();

    expect(completions).toEqual([expect.objectContaining({
      settledBy: "source-onended",
      outcome: "late"
    })]);
  });

  it("recovers a dropped source callback from the exact audio-clock sentinel once", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("b");
    const completions: Array<{ settledBy: string; outcome: string }> = [];
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
    deck.play(0, 10);
    const source = context.sources.at(-1)!;
    const retainedPrimary = source.onended;
    const sentinel = context.oscillators.at(-1)!;
    const sentinelCallback = sentinel.onended;

    context.currentTime = 12.05;
    sentinelCallback?.();
    retainedPrimary?.();

    expect(deck.getSnapshot().status).toBe("ended");
    expect(completions).toEqual([expect.objectContaining({ settledBy: "audio-clock", outcome: "recovered" })]);
  });

  it("reconciles a missing callback from Web Audio time without waiting for wall time", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    const completions: Array<{ settledBy: string; outcome: string }> = [];
    deck.subscribe(() => { throw new Error("snapshot observer failed"); });
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
    deck.play(0, 10);

    context.currentTime = 11;
    expect(deck.reconcilePlaybackCompletion(12)).toBe(false);
    context.currentTime = 12;
    expect(deck.reconcilePlaybackCompletion(12)).toBe(false);
    context.currentTime = 12.05;
    expect(deck.reconcilePlaybackCompletion(12.05)).toBe(true);
    expect(deck.reconcilePlaybackCompletion(12.05)).toBe(false);
    expect(completions).toEqual([expect.objectContaining({ settledBy: "reconcile", outcome: "recovered" })]);
  });

  it("starts the source before a deadline-registration failure can recover its completion", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    const completions: unknown[] = [];
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
    let sourceWasStartedAtRegistration = false;
    engine.onAudioClockDeadline = (() => {
      const source = context.sources.at(-1)!;
      sourceWasStartedAtRegistration = source.startCalls.length === 1;
      const transportGate = source.connections[0] as FakeGainNode;
      expect(transportGate.gain.events).toContainEqual({ type: "value", value: 1, time: 10 });
      context.currentTime = 12.1;
      throw new Error("deadline registration failed");
    }) as typeof engine.onAudioClockDeadline;

    deck.play(0, 10);
    const source = context.sources.at(-1)!;

    expect(source.startCalls).toEqual([{ when: 10, offset: 0 }]);
    expect(sourceWasStartedAtRegistration).toBe(true);
    expect(completions).toEqual([]);
    expect(deck.getSnapshot()).toMatchObject({ trackId: "short", status: "playing" });
    expect(deck.reconcilePlaybackCompletion(12.1)).toBe(true);
    expect(completions).toEqual([expect.objectContaining({
      settledBy: "reconcile",
      outcome: "recovered"
    })]);
  });

  it("rebases immediate playback and leaves the transport gate open at the effective start", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
    const createSource = context.createBufferSource.bind(context);
    context.createBufferSource = () => {
      const source = createSource();
      context.currentTime = 10.1;
      return source;
    };

    expect(deck.play(0, 10)).toBe(10.1);
    const source = context.sources.at(-1)!;
    const transportGate = source.connections[0] as FakeGainNode;
    const gateValues = transportGate.gain.events.filter((event) => event.type === "value");

    expect(source.startCalls).toEqual([{ when: 10.1, offset: 0 }]);
    expect(gateValues.slice(-2)).toEqual([
      { type: "value", value: 0, time: 10.1 },
      { type: "value", value: 1, time: 10.1 }
    ]);
  });

  it("fails closed when the exact native source ends before its media boundary", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    const completions: Array<{ settledBy: string; outcome: string }> = [];
    deck.subscribe(() => { throw new Error("snapshot observer failed"); });
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 5 } as AudioBuffer, "short");
    deck.play(0, 10);

    context.currentTime = 11;
    context.sources.at(-1)!.onended?.();

    expect(deck.getSnapshot()).toMatchObject({ status: "recoverable-error", positionSeconds: 1 });
    expect(completions).toEqual([expect.objectContaining({ settledBy: "source-onended", outcome: "premature" })]);
  });

  it.each(["suspended", "closed"] as const)(
    "never declares natural completion from a source callback while the context is %s",
    (state) => {
      const { context, engine } = createEngine();
      context.state = "running";
      const deck = engine.getDeck("a");
      const completions: Array<{ settledBy: string; outcome: string }> = [];
      deck.subscribePlaybackCompletion((event) => completions.push(event));
      deck.loadBuffer({ duration: 2 } as AudioBuffer, "short");
      deck.play(0, 10);
      context.currentTime = 12.2;
      context.state = state;

      context.sources.at(-1)!.onended?.();

      expect(deck.getSnapshot()).toMatchObject({ status: "recoverable-error" });
      expect(completions).toEqual([expect.objectContaining({
        settledBy: "source-onended",
        outcome: "premature"
      })]);
    }
  );

  it("settles a scheduled stop as paused without emitting natural completion", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    const completions: unknown[] = [];
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 10 } as AudioBuffer, "short");
    deck.play(0, 10);
    expect(deck.stopAt(15)).toBe(true);

    context.currentTime = 15;
    context.sources.at(-1)!.onended?.();

    expect(deck.getSnapshot()).toMatchObject({ status: "paused", positionSeconds: 5 });
    expect(completions).toEqual([]);
  });

  it("settles an exact scheduled stop as paused while the context is suspended", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("b");
    const completions: unknown[] = [];
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 10 } as AudioBuffer, "short");
    deck.play(0, 10);
    expect(deck.stopAt(15)).toBe(true);
    context.currentTime = 15;
    context.state = "suspended";

    context.sources.at(-1)!.onended?.();

    expect(deck.getSnapshot()).toMatchObject({ status: "paused", positionSeconds: 5 });
    expect(completions).toEqual([]);
  });

  it("rejects a rate ramp after an exact scheduled stop is owned", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    deck.loadBuffer({ duration: 10 } as AudioBuffer, "short");
    deck.play(0, 10);
    expect(deck.stopAt(15)).toBe(true);
    expect(deck.schedulePlaybackRateRamp(1.2, 12, 2)).toBe(false);

    context.currentTime = 15;
    context.sources.at(-1)!.onended?.();
    expect(deck.getSnapshot()).toMatchObject({ status: "paused", positionSeconds: 5 });
  });

  it("revokes stale source and watchdog completion across pause, reload, and replay", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("b");
    const completions: unknown[] = [];
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 4 } as AudioBuffer, "old");
    deck.play(0, 10);
    const oldPrimary = context.sources.at(-1)!.onended;
    const oldWatchdog = context.oscillators.at(-1)!.onended;
    context.currentTime = 11;
    expect(deck.pause()).toBe(true);
    deck.loadBuffer({ duration: 8 } as AudioBuffer, "new");
    deck.play(0, 12);

    context.currentTime = 20;
    oldPrimary?.();
    oldWatchdog?.();

    expect(deck.getSnapshot()).toMatchObject({ trackId: "new", status: "playing" });
    expect(completions).toEqual([]);
  });

  it("revokes native completion before fallible clock and gate cleanup", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    const completions: unknown[] = [];
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 4 } as AudioBuffer, "old");
    deck.play(0, 10);
    const source = context.sources.at(-1)!;
    const oldPrimary = source.onended;
    const oldWatchdog = context.oscillators.at(-1)!.onended;
    const transportGate = source.connections[0] as FakeGainNode;
    (engine.clock as unknown as { now: () => number }).now = () => {
      throw new Error("clock failed");
    };
    transportGate.gain.cancelScheduledValues = () => {
      throw new Error("gate failed");
    };

    expect(() => deck.pause()).not.toThrow();
    (engine.clock as unknown as { now: () => number }).now = () => context.currentTime;
    oldPrimary?.();
    oldWatchdog?.();

    expect(deck.getSnapshot().status).toBe("paused");
    expect(transportGate.gain.value).toBe(0);
    expect(completions).toEqual([]);
  });

  it("revokes native completion during audio-only host teardown", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("b");
    const completions: unknown[] = [];
    deck.subscribePlaybackCompletion((event) => completions.push(event));
    deck.loadBuffer({ duration: 4 } as AudioBuffer, "old");
    deck.play(0, 10);
    const oldPrimary = context.sources.at(-1)!.onended;
    const oldWatchdog = context.oscillators.at(-1)!.onended;

    expect(deck.shutdownForHostTeardown()).toBe(true);
    context.currentTime = 20;
    oldPrimary?.();
    oldWatchdog?.();

    expect(deck.getSnapshot().status).toBe("paused");
    expect(completions).toEqual([]);
  });

  it("re-arms the exact completion deadline after an integrated rate ramp", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("a");
    deck.loadBuffer({ duration: 12 } as AudioBuffer, "ramped");
    deck.play(0, 10);
    const oldPrimary = context.sources.at(-1)!.onended;
    expect(deck.schedulePlaybackRateRamp(1.5, 12, 4)).toBe(true);
    const rampDeadline = context.oscillators.at(-1)!;
    // 2 seconds at 1x before the ramp, 5 seconds during it, then 5 seconds at 1.5x.
    expect(rampDeadline.startCalls[0]).toBeCloseTo(16 + 5 / 1.5 + 0.05);

    context.currentTime = 22;
    oldPrimary?.();
    expect(deck.getSnapshot().status).toBe("playing");
    expect(deck.reconcilePlaybackCompletion(16 + 5 / 1.5 + 0.05)).toBe(true);
    expect(deck.getSnapshot().status).toBe("ended");
  });

  it("rejects an overlapping rate ramp whose rendered slope cannot be preserved", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deck = engine.getDeck("b");
    deck.loadBuffer({ duration: 30 } as AudioBuffer, "ramped");
    deck.play(0, 10);
    expect(deck.schedulePlaybackRateRamp(1.5, 12, 4)).toBe(true);
    context.currentTime = 13;
    expect(deck.schedulePlaybackRateRamp(0.8, 14, 2)).toBe(false);
  });

  it("surfaces recoverable errors without pretending a track is ready", () => {
    const { engine } = createEngine();
    const deck = engine.getDeck("a");
    deck.beginPreparing("broken-track");
    deck.fail(new Error("decode failed"));
    expect(deck.getSnapshot()).toMatchObject({
      status: "recoverable-error",
      error: "decode failed"
    });
    expect(deck.isReady()).toBe(false);
    expect(deck.recover()).toBe(true);
    expect(deck.getSnapshot().status).toBe("idle");

    deck.loadBuffer(buffer, "cached-track");
    deck.fail("output interrupted");
    deck.recover();
    expect(deck.getSnapshot()).toMatchObject({ status: "ready", error: null });
  });

  it("keeps EQ automation on the Web Audio clock", () => {
    const { context, engine } = createEngine();
    const deck = engine.getDeck("a");
    expect(deck.scheduleEqBandRamp("low", 0, -12, 8, 4)).toBe(10);
    const lowGain = context.filters[0].gain;
    expect(lowGain.events).toEqual([
      { type: "cancel", time: 10 },
      { type: "value", value: 0, time: 10 },
      { type: "ramp", value: -12, time: 14 }
    ]);
  });

  it("keeps the transition-filter sweep on the Web Audio clock", () => {
    const { context, engine } = createEngine();
    const deck = engine.getDeck("a");
    expect(deck.scheduleFilterSweep(20_000, 420, 8, 4)).toBe(10);
    const cutoff = context.filters[3].frequency;
    expect(cutoff.events).toEqual([
      { type: "cancel", time: 10 },
      { type: "value", value: 20_000, time: 10 },
      { type: "ramp", value: 420, time: 14 }
    ]);
    expect(deck.setFilterCutoff(30_000)).toBe(20_000);
  });

  it("mutes first, stops both Deck owners, and permanently refuses new starts after a fatal host error", () => {
    const { context, engine } = createEngine();
    context.state = "running";
    const deckA = engine.getDeck("a");
    const deckB = engine.getDeck("b");
    deckA.loadBuffer({ duration: 30 } as AudioBuffer, "a");
    deckB.loadBuffer({ duration: 30 } as AudioBuffer, "b");
    deckA.play(0, 10);
    deckB.play(0, 12);
    engine.scheduleCrossfade("a", "b", 12, 4);
    engine.playProtectedPreview({
      kind: "pre-master-stereo/v1",
      requiredMasterVersion: MASTER_DSP_V1.version,
      sampleRate: 48_000,
      channels: [new Float32Array([0.1, 0.1]), new Float32Array([0.1, 0.1])]
    });
    const previewSource = context.sources.at(-1)!;
    engine.scheduleAuditionClicks([{ audioTime: 12, downbeat: true }]);
    const auditionSource = context.oscillators.at(-1)!;

    expect(engine.shutdownForFatalHostError()).toEqual({
      version: "fatal-host-audio-shutdown/v1",
      outcome: "confirmed-stopped"
    });
    expect(context.gains[0].gain.value).toBe(0);
    expect(engine.getActiveCrossfade()).toBeNull();
    expect(previewSource.stopCalls.length).toBeGreaterThan(0);
    expect(auditionSource.stopCalls.length).toBeGreaterThan(1);
    expect(deckA.isActive()).toBe(false);
    expect(deckB.isActive()).toBe(false);
    expect(engine.isFatalHostLocked()).toBe(true);
    expect(() => deckA.play()).toThrow("fatal host error");
    expect(() => engine.scheduleCrossfade("a", "b", 20, 2)).toThrow("fatal host error");
    expect(engine.setMasterGainDb(0)).toBe(-60);
    expect(context.gains[0].gain.value).toBe(0);
    expect(engine.setDeckGain("a", 1)).toBe(0);
  });

  it("reports uncertainty when the protected master mute cannot be proven", () => {
    const { context, engine } = createEngine();
    context.gains[0].gain.setValueAtTime = () => { throw new Error("private AudioParam failure"); };
    expect(engine.shutdownForFatalHostError().outcome).toBe("uncertain");
    expect(engine.isFatalHostLocked()).toBe(true);
  });

  it("reports uncertainty when an audible auxiliary owner cannot confirm cleanup", () => {
    const { context, engine } = createEngine();
    engine.scheduleAuditionClicks([{ audioTime: 12, downbeat: true }]);
    const audition = context.oscillators.at(-1)!;
    const originalStop = audition.stop.bind(audition);
    const originalDisconnect = audition.disconnect.bind(audition);
    audition.stop = () => { throw new Error("private stop failure"); };
    audition.disconnect = () => { throw new Error("private disconnect failure"); };
    expect(engine.shutdownForFatalHostError().outcome).toBe("uncertain");
    expect(engine.shutdownForFatalHostError().outcome).toBe("uncertain");
    audition.stop = originalStop;
    audition.disconnect = originalDisconnect;
    expect(engine.shutdownForFatalHostError().outcome).toBe("confirmed-stopped");
  });
});
