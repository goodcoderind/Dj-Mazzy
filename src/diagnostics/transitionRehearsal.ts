import { createDeckDspChain } from "../audio/deckDspChain";
import { MASTER_DSP_V1 } from "../audio/masterDsp";
import type { TransitionDspV1 } from "../audio/transitionDsp";
import { validateTransitionDsp } from "../audio/transitionDsp";
import { assessTransitionRenderQuality, type TransitionQualityGate } from "./renderTransition";

export type PreMasterStereoPreview = Readonly<{
  kind: "pre-master-stereo/v1";
  requiredMasterVersion: typeof MASTER_DSP_V1.version;
  sampleRate: number;
  channels: readonly [Float32Array, Float32Array];
}>;

export type TransitionRehearsalRender = Readonly<{
  preview: PreMasterStereoPreview;
  transitionStartSeconds: number;
  transitionEndSeconds: number;
  quality: TransitionQualityGate;
}>;

export type TransitionRehearsalWindow = Readonly<{
  sourceCueSeconds: number;
  preRollSeconds?: number;
  postRollSeconds?: number;
  outputSampleRate: number;
}>;

export const deriveRehearsalSourceCueSeconds = (
  positionSeconds: number,
  sourcePlaybackRate: number,
  requestedAt: number,
  startTime: number
) => {
  if (![positionSeconds, sourcePlaybackRate, requestedAt, startTime].every(Number.isFinite) ||
    positionSeconds < 0 || sourcePlaybackRate <= 0) {
    throw new RangeError("Rehearsal cue inputs must be finite with a positive playback rate");
  }
  return positionSeconds + Math.max(0, startTime - requestedAt) * sourcePlaybackRate;
};

export const assessStereoTransitionQuality = (
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): TransitionQualityGate => {
  if (left.length !== right.length || left.length < 2) {
    throw new RangeError("Stereo rehearsal channels must have equal non-empty lengths");
  }
  const combined = Float32Array.from(left, (sample, index) => Math.hypot(sample, right[index]));
  const options = { peakCeiling: 1.4, maxSilentSeconds: 0.1, maxSampleJump: 0.8 };
  const leftQuality = assessTransitionRenderQuality(left, sampleRate, options);
  const rightQuality = assessTransitionRenderQuality(right, sampleRate, options);
  const combinedQuality = assessTransitionRenderQuality(combined, sampleRate, {
    ...options,
    peakCeiling: Number.POSITIVE_INFINITY,
    maxSampleJump: Number.POSITIVE_INFINITY
  });
  const perChannelReasons = [...leftQuality.reasons, ...rightQuality.reasons]
    .filter((reason) => !reason.includes("silence gap"));
  const reasons = [...new Set([...perChannelReasons, ...combinedQuality.reasons])];
  return Object.freeze({
    passed: reasons.length === 0,
    reasons,
    peakDbfs: Math.max(leftQuality.peakDbfs, rightQuality.peakDbfs),
    longestSilentSeconds: combinedQuality.longestSilentSeconds,
    maximumSampleJump: Math.max(leftQuality.maximumSampleJump, rightQuality.maximumSampleJump)
  });
};

const dbToGain = (db: number) => 10 ** (db / 20);
const setEq = (chain: ReturnType<typeof createDeckDspChain>, values: { low: number; mid: number; high: number }) => {
  chain.eq.low.value = values.low;
  chain.eq.mid.value = values.mid;
  chain.eq.high.value = values.high;
};

const scheduleDeck = (
  context: OfflineAudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  dsp: TransitionDspV1["source"],
  startTime: number,
  offsetSeconds: number,
  gainStartTime: number,
  durationSeconds: number
) => {
  const gain = context.createGain();
  gain.gain.value = dsp.gainCurve[0];
  gain.gain.setValueCurveAtTime(new Float32Array(dsp.gainCurve), gainStartTime, durationSeconds);
  gain.connect(destination);
  const chain = createDeckDspChain(context, gain);
  chain.trim.value = dbToGain(dsp.trimDb);
  setEq(chain, dsp.initialEqDb);
  for (const { band, ramp } of dsp.eqRamps) {
    const param = chain.eq[band];
    const rampStart = gainStartTime + ramp.startOffsetSeconds;
    param.setValueAtTime(ramp.fromDb, rampStart);
    param.linearRampToValueAtTime(ramp.toDb, rampStart + ramp.durationSeconds);
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = dsp.playbackRate;
  source.connect(chain.input);
  source.start(startTime, offsetSeconds);
};

export const computeTransitionRehearsalWindow = (
  sourceCueSeconds: number,
  sourcePlaybackRate: number,
  transitionDurationSeconds: number,
  preRollSeconds = 2,
  postRollSeconds = 2
) => {
  if (![sourceCueSeconds, sourcePlaybackRate, transitionDurationSeconds, preRollSeconds, postRollSeconds]
    .every(Number.isFinite) || sourceCueSeconds < 0 || sourcePlaybackRate <= 0 ||
    transitionDurationSeconds <= 0 || preRollSeconds < 0 || postRollSeconds < 0) {
    throw new RangeError("Rehearsal timing must be finite and non-negative");
  }
  const sourceOffsetSeconds = Math.max(0, sourceCueSeconds - preRollSeconds * sourcePlaybackRate);
  const transitionStartSeconds = (sourceCueSeconds - sourceOffsetSeconds) / sourcePlaybackRate;
  return Object.freeze({
    sourceOffsetSeconds,
    transitionStartSeconds,
    transitionEndSeconds: transitionStartSeconds + transitionDurationSeconds,
    totalSeconds: transitionStartSeconds + transitionDurationSeconds + postRollSeconds
  });
};

export const renderTransitionRehearsal = async (
  sourceBuffer: AudioBuffer,
  targetBuffer: AudioBuffer,
  dsp: TransitionDspV1,
  window: TransitionRehearsalWindow
): Promise<TransitionRehearsalRender> => {
  validateTransitionDsp(dsp);
  const preRollSeconds = window.preRollSeconds ?? 2;
  const postRollSeconds = window.postRollSeconds ?? 2;
  if (![window.sourceCueSeconds, preRollSeconds, postRollSeconds, window.outputSampleRate]
    .every((value) => Number.isFinite(value) && value >= 0) || window.outputSampleRate <= 0) {
    throw new RangeError("Rehearsal window must contain finite non-negative timing");
  }
  const timing = computeTransitionRehearsalWindow(
    window.sourceCueSeconds,
    dsp.source.playbackRate,
    dsp.durationSeconds,
    preRollSeconds,
    postRollSeconds
  );
  const frameCount = Math.max(2, Math.ceil(timing.totalSeconds * window.outputSampleRate));
  const context = new OfflineAudioContext(2, frameCount, window.outputSampleRate);

  scheduleDeck(context, sourceBuffer, context.destination, dsp.source, 0, timing.sourceOffsetSeconds,
    timing.transitionStartSeconds, dsp.durationSeconds);
  scheduleDeck(context, targetBuffer, context.destination, dsp.target, timing.transitionStartSeconds,
    dsp.targetCueSeconds, timing.transitionStartSeconds, dsp.durationSeconds);

  const rendered = await context.startRendering();
  const left = new Float32Array(rendered.getChannelData(0));
  const right = new Float32Array(rendered.getChannelData(Math.min(1, rendered.numberOfChannels - 1)));
  const quality = assessStereoTransitionQuality(left, right, rendered.sampleRate);
  return Object.freeze({
    preview: Object.freeze({
      kind: "pre-master-stereo/v1",
      requiredMasterVersion: MASTER_DSP_V1.version,
      sampleRate: rendered.sampleRate,
      channels: Object.freeze([left, right]) as readonly [Float32Array, Float32Array]
    }),
    transitionStartSeconds: timing.transitionStartSeconds,
    transitionEndSeconds: timing.transitionEndSeconds,
    quality
  });
};
