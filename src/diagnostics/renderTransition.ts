import { equalPowerGains } from "../planning/transitionMath";

export type SampleMetrics = {
  peak: number;
  rms: number;
  clippedSamples: number;
  nonFiniteSamples: number;
  longestSilentRun: number;
  maximumSampleJump: number;
};

export const measureSamples = (
  samples: Float32Array,
  silenceThreshold = 1e-5
): SampleMetrics => {
  if (!Number.isFinite(silenceThreshold) || silenceThreshold < 0) {
    throw new RangeError("silenceThreshold must be a non-negative finite number");
  }

  let peak = 0;
  let power = 0;
  let clippedSamples = 0;
  let nonFiniteSamples = 0;
  let silentRun = 0;
  let longestSilentRun = 0;
  let maximumSampleJump = 0;
  let previousFinite: number | null = null;

  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      nonFiniteSamples += 1;
      silentRun = 0;
      continue;
    }

    const magnitude = Math.abs(sample);
    if (previousFinite != null) maximumSampleJump = Math.max(maximumSampleJump, Math.abs(sample - previousFinite));
    previousFinite = sample;
    peak = Math.max(peak, magnitude);
    power += sample * sample;
    if (magnitude > 1) clippedSamples += 1;

    if (magnitude <= silenceThreshold) {
      silentRun += 1;
      longestSilentRun = Math.max(longestSilentRun, silentRun);
    } else {
      silentRun = 0;
    }
  }

  return {
    peak,
    rms: samples.length ? Math.sqrt(power / samples.length) : 0,
    clippedSamples,
    nonFiniteSamples,
    longestSilentRun,
    maximumSampleJump
  };
};

export type TransitionQualityGate = {
  passed: boolean;
  reasons: string[];
  peakDbfs: number;
  longestSilentSeconds: number;
  maximumSampleJump: number;
};

export const assessTransitionRenderQuality = (
  samples: Float32Array,
  sampleRate: number,
  { peakCeiling = 0.99, maxSilentSeconds = 0.02, maxSampleJump = 0.8 } = {}
): TransitionQualityGate => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("sampleRate must be positive and finite");
  const metrics = measureSamples(samples);
  const reasons: string[] = [];
  if (metrics.nonFiniteSamples) reasons.push("Rendered transition contains non-finite samples.");
  if (metrics.peak > peakCeiling) reasons.push("Rendered transition exceeds the peak ceiling.");
  const longestSilentSeconds = metrics.longestSilentRun / sampleRate;
  if (longestSilentSeconds > maxSilentSeconds) reasons.push("Rendered transition contains an audible silence gap.");
  if (metrics.maximumSampleJump > maxSampleJump) reasons.push("Rendered transition contains a discontinuity risk.");
  return {
    passed: reasons.length === 0,
    reasons,
    peakDbfs: metrics.peak > 0 ? 20 * Math.log10(metrics.peak) : -Infinity,
    longestSilentSeconds,
    maximumSampleJump: metrics.maximumSampleJump
  };
};

export type RenderTransitionOptions = {
  headroomGain?: number;
};

export const renderEqualPowerTransition = (
  source: Float32Array,
  target: Float32Array,
  { headroomGain = 1 }: RenderTransitionOptions = {}
) => {
  if (source.length !== target.length || source.length < 2) {
    throw new RangeError("source and target must have equal lengths of at least two samples");
  }
  if (!Number.isFinite(headroomGain) || headroomGain < 0) {
    throw new RangeError("headroomGain must be a non-negative finite number");
  }

  const mixed = new Float32Array(source.length);
  const sourceGain = new Float32Array(source.length);
  const targetGain = new Float32Array(source.length);

  for (let index = 0; index < source.length; index += 1) {
    const gains = equalPowerGains(index / (source.length - 1));
    sourceGain[index] = gains.source;
    targetGain[index] = gains.target;
    mixed[index] = (source[index] * gains.source + target[index] * gains.target) * headroomGain;
  }

  return {
    mixed,
    sourceGain,
    targetGain,
    metrics: measureSamples(mixed)
  };
};
