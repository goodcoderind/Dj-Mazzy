import type { AudioHealthSnapshot } from "../audio/AudioEngine";
import { assessPostMasterPeak } from "./postMasterPeak";
import { MASTER_PEAK_GUARD_LISTENING_PLAYBACK_PEAK_DBTP } from "./masterPeakGuardListening";

export const validateMasterPeakGuardAuditionPcm = (
  channels: readonly [Float32Array, Float32Array],
  sampleRate: number,
  requiredSampleRate: number
) => {
  if (sampleRate !== requiredSampleRate || !Number.isFinite(sampleRate)) return false;
  try {
    const peak = assessPostMasterPeak(channels, sampleRate);
    return peak.estimatedTruePeakDbtp != null &&
      peak.estimatedTruePeakDbtp <= MASTER_PEAK_GUARD_LISTENING_PLAYBACK_PEAK_DBTP;
  } catch {
    return false;
  }
};

export class MasterPeakGuardAuditionEngine {
  private healthNode: AudioWorkletNode | null = null;
  private expectedActive = false;
  private totals = this.emptyTotals();
  private readonly contextStates: AudioContextState[] = [];
  private nextResetToken = 1;
  private readonly resetWaiters = new Map<number, (acknowledged: boolean) => void>();

  constructor(readonly context: AudioContext) {
    this.contextStates.push(context.state);
    context.addEventListener("statechange", () => {
      if (this.contextStates.at(-1) !== context.state) this.contextStates.push(context.state);
    });
  }

  async resume() {
    if (this.context.state === "closed") throw new Error("AudioContext is closed");
    if (this.context.state === "suspended" || this.context.state === "interrupted") {
      await this.context.resume();
    }
    if (this.context.state !== "running") throw new Error("AudioContext did not resume");
  }

  async enableHealthMonitoring() {
    if (this.healthNode) return true;
    if (!this.context.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
    await this.context.audioWorklet.addModule(new URL("../audio/audioHealth.worklet.js", import.meta.url));
    const node = new AudioWorkletNode(this.context, "mazzy-audio-health-v2", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    node.port.onmessage = (event) => {
      const report = event.data;
      if (report?.type === "reset-ack" && Number.isSafeInteger(report.token)) {
        this.resetWaiters.get(report.token)?.(true);
        return;
      }
      if (report?.type !== "health") return;
      const counters = [report.frames, report.expectedActiveFrames, report.silentFrames,
        report.renderQuanta, report.nonFiniteSamples, report.clippedSamples, report.longestSilentFrames];
      if (!counters.every((value) => Number.isSafeInteger(value) && value >= 0) ||
        !Number.isFinite(report.peak) || report.peak < 0 || report.sampleRate !== this.context.sampleRate) {
        this.totals.processorErrors += 1;
        return;
      }
      this.totals.renderedFrames += report.frames;
      this.totals.expectedActiveFrames += report.expectedActiveFrames;
      this.totals.silentFrames += report.silentFrames;
      this.totals.renderQuanta += report.renderQuanta;
      this.totals.nonFiniteSamples += report.nonFiniteSamples;
      this.totals.clippedSamples += report.clippedSamples;
      this.totals.processorErrors += 0;
      this.totals.peak = Math.max(this.totals.peak, report.peak);
      this.totals.longestUnexpectedSilentSeconds = Math.max(
        this.totals.longestUnexpectedSilentSeconds,
        report.longestSilentFrames / report.sampleRate
      );
      this.totals.reports += 1;
    };
    node.onprocessorerror = () => {
      this.totals.processorErrors += 1;
      for (const settle of this.resetWaiters.values()) settle(false);
      this.resetWaiters.clear();
    };
    node.connect(this.context.destination);
    this.healthNode = node;
    this.setExpectedOutputActive(this.expectedActive);
    return true;
  }

  setExpectedOutputActive(active: boolean) {
    this.expectedActive = active === true;
    this.healthNode?.port.postMessage({ type: "expected-active", value: this.expectedActive });
  }

  async resetHealthMonitoring(timeoutMs = 1_000) {
    if (!this.healthNode || this.expectedActive || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
    const token = this.nextResetToken++;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (acknowledged: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.resetWaiters.delete(token);
        if (acknowledged) this.totals = this.emptyTotals();
        resolve(acknowledged);
      };
      const timeout = window.setTimeout(() => finish(false), timeoutMs);
      this.resetWaiters.set(token, finish);
      this.healthNode!.port.postMessage({ type: "reset", token });
    });
  }

  getHealthSnapshot(): AudioHealthSnapshot {
    return Object.freeze({
      schemaVersion: "audio-health/v2",
      supported: this.healthNode !== null,
      expectedOutputActive: this.expectedActive,
      sampleRate: this.context.sampleRate,
      ...this.totals,
      contextStates: Object.freeze([...this.contextStates])
    });
  }

  play(
    channels: readonly [Float32Array, Float32Array],
    sampleRate: number,
    onEnded?: () => void
  ) {
    if (!this.healthNode ||
      !validateMasterPeakGuardAuditionPcm(channels, sampleRate, this.context.sampleRate)) {
      throw new RangeError("audition PCM must be monitored, native-rate, stereo, and at or below -6 dBTP");
    }
    const buffer = this.context.createBuffer(2, channels[0].length, sampleRate);
    buffer.copyToChannel(new Float32Array(channels[0]), 0);
    buffer.copyToChannel(new Float32Array(channels[1]), 1);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.healthNode);
    let ended = false;
    source.onended = () => {
      if (ended) return;
      ended = true;
      source.disconnect();
      onEnded?.();
    };
    source.start(this.context.currentTime);
    return () => {
      try { source.stop(); } catch { /* Source may already have ended. */ }
      if (!ended) {
        ended = true;
        source.disconnect();
      }
    };
  }

  dispose() {
    this.setExpectedOutputActive(false);
    this.healthNode?.disconnect();
    this.healthNode = null;
    for (const settle of this.resetWaiters.values()) settle(false);
    this.resetWaiters.clear();
  }

  private emptyTotals() {
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
}
