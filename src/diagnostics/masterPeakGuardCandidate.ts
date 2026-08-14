import { configureMasterDspNodes, MASTER_DSP_V1 } from "../audio/masterDsp";
import { assessPostMasterPeak, type PostMasterPeakCheck } from "./postMasterPeak";
import type { PreMasterStereoPreview } from "./transitionRehearsal";

export const MASTER_PEAK_GUARD_CANDIDATE = Object.freeze({
  version: "mazzy-master-peak-guard-candidate/v1" as const,
  sampleCeilingDbfs: -3,
  oversample: "4x" as OverSampleType,
  curvePoints: 65_537
});

export const MASTER_PEAK_GUARD_COMPARISON_VERSION =
  "master-peak-guard-paired-render/v1" as const;

const RENDER_PADDING_SECONDS = 0.25;
const dbToGain = (value: number) => 10 ** (value / 20);

export const buildMasterPeakGuardCurve = () => {
  const ceiling = dbToGain(MASTER_PEAK_GUARD_CANDIDATE.sampleCeilingDbfs);
  const curve = new Float32Array(MASTER_PEAK_GUARD_CANDIDATE.curvePoints);
  for (let index = 0; index < curve.length; index += 1) {
    const input = index / (curve.length - 1) * 2 - 1;
    curve[index] = Math.max(-ceiling, Math.min(ceiling, input));
  }
  return curve;
};

const buildIdentityCurve = () => Float32Array.from(
  { length: MASTER_PEAK_GUARD_CANDIDATE.curvePoints },
  (_, index) => index / (MASTER_PEAK_GUARD_CANDIDATE.curvePoints - 1) * 2 - 1
);

export const createMasterPeakGuardCandidate = (context: BaseAudioContext) => {
  const node = context.createWaveShaper();
  node.curve = buildMasterPeakGuardCurve();
  node.oversample = MASTER_PEAK_GUARD_CANDIDATE.oversample;
  return node;
};

export type MasterPeakGuardCandidateCheck = Readonly<{
  kind: "master-peak-guard-candidate-check/v1";
  peakGuardCandidateVersion: typeof MASTER_PEAK_GUARD_CANDIDATE.version;
  peak: PostMasterPeakCheck;
}>;

export type MasterPeakGuardListeningRender = Readonly<{
  kind: "master-peak-guard-listening-render/v2";
  variant: "current-master" | "identity-4x" | "peak-guard-candidate";
  outputStage: "post-current-master" | "post-identity-4x" | "post-peak-guard";
  peakGuardCandidateVersion: typeof MASTER_PEAK_GUARD_CANDIDATE.version | null;
  comparisonOrdinal: number;
  sampleRate: number;
  frameCount: number;
  channels: readonly [Float32Array, Float32Array];
  peak: PostMasterPeakCheck;
}>;

export type MasterPeakGuardListeningComparison = Readonly<{
  kind: typeof MASTER_PEAK_GUARD_COMPARISON_VERSION;
  comparisonOrdinal: number;
  currentMasterVersion: typeof MASTER_DSP_V1.version;
  peakGuardCandidateVersion: typeof MASTER_PEAK_GUARD_CANDIDATE.version;
  sampleRate: number;
  frameCount: number;
  currentMaster: MasterPeakGuardListeningRender;
  identity4x: MasterPeakGuardListeningRender;
  peakGuardCandidate: MasterPeakGuardListeningRender;
  identityMaximumDelta: number;
  identityRmsDeltaDb: number | null;
  identityPeakDeltaDb: number | null;
  identityResidualDb: number | null;
  identityAlignedMaximumDelta: number | null;
  guardMaximumDelta: number;
  peakReductionDb: number | null;
}>;

const validatePreview = (preview: PreMasterStereoPreview) => {
  if (
    preview.kind !== "pre-master-stereo/v1" ||
    preview.requiredMasterVersion !== MASTER_DSP_V1.version ||
    !Number.isFinite(preview.sampleRate) || preview.sampleRate < 8_000 || preview.sampleRate > 384_000 ||
    !preview.channels[0].length || preview.channels[0].length !== preview.channels[1].length
  ) {
    throw new RangeError("Master listening input is malformed or incompatible");
  }
  for (const channel of preview.channels) {
    if (channel.some((sample) => !Number.isFinite(sample))) {
      throw new RangeError("Master listening input must contain finite samples");
    }
  }
};

const copyCentralWindow = (
  rendered: AudioBuffer,
  startFrame: number,
  frameCount: number
): readonly [Float32Array, Float32Array] => Object.freeze([
  new Float32Array(rendered.getChannelData(0).slice(startFrame, startFrame + frameCount)),
  new Float32Array(rendered.getChannelData(Math.min(1, rendered.numberOfChannels - 1))
    .slice(startFrame, startFrame + frameCount))
]) as readonly [Float32Array, Float32Array];

const renderCurrentMaster = async (preview: PreMasterStereoPreview) => {
  validatePreview(preview);
  const paddingFrames = Math.round(preview.sampleRate * RENDER_PADDING_SECONDS);
  const frameCount = preview.channels[0].length;
  const context = new OfflineAudioContext(2, frameCount + paddingFrames * 2, preview.sampleRate);
  const buffer = context.createBuffer(2, frameCount, preview.sampleRate);
  buffer.copyToChannel(new Float32Array(preview.channels[0]), 0);
  buffer.copyToChannel(new Float32Array(preview.channels[1]), 1);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const masterGain = context.createGain();
  const limiter = context.createDynamicsCompressor();
  configureMasterDspNodes(masterGain, limiter);
  source.connect(masterGain);
  masterGain.connect(limiter);
  limiter.connect(context.destination);
  source.start(RENDER_PADDING_SECONDS);
  return copyCentralWindow(await context.startRendering(), paddingFrames, frameCount);
};

const renderPostMasterFanout = async (
  channels: readonly [Float32Array, Float32Array],
  sampleRate: number
) => {
  const paddingFrames = Math.round(sampleRate * RENDER_PADDING_SECONDS);
  const frameCount = channels[0].length;
  const context = new OfflineAudioContext(6, frameCount + paddingFrames * 2, sampleRate);
  const buffer = context.createBuffer(2, frameCount, sampleRate);
  buffer.copyToChannel(new Float32Array(channels[0]), 0);
  buffer.copyToChannel(new Float32Array(channels[1]), 1);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const identity = context.createWaveShaper();
  identity.curve = buildIdentityCurve();
  identity.oversample = MASTER_PEAK_GUARD_CANDIDATE.oversample;
  const guard = createMasterPeakGuardCandidate(context);
  const merger = context.createChannelMerger(6);
  const connectStereoBranch = (node: AudioNode, firstOutputChannel: number) => {
    const splitter = context.createChannelSplitter(2);
    node.connect(splitter);
    splitter.connect(merger, 0, firstOutputChannel);
    splitter.connect(merger, 1, firstOutputChannel + 1);
  };
  connectStereoBranch(source, 0);
  source.connect(identity);
  connectStereoBranch(identity, 2);
  source.connect(guard);
  connectStereoBranch(guard, 4);
  merger.connect(context.destination);
  source.start(RENDER_PADDING_SECONDS);
  const rendered = await context.startRendering();
  const branch = (firstChannel: number) => Object.freeze([
    new Float32Array(rendered.getChannelData(firstChannel).slice(paddingFrames, paddingFrames + frameCount)),
    new Float32Array(rendered.getChannelData(firstChannel + 1).slice(paddingFrames, paddingFrames + frameCount))
  ]) as readonly [Float32Array, Float32Array];
  return Object.freeze({
    direct: branch(0),
    identity: branch(2),
    guard: branch(4)
  });
};

const maxDifference = (
  left: readonly [Float32Array, Float32Array],
  right: readonly [Float32Array, Float32Array]
) => {
  let maximum = 0;
  for (let channel = 0; channel < 2; channel += 1) {
    for (let frame = 0; frame < left[channel].length; frame += 1) {
      maximum = Math.max(maximum, Math.abs(left[channel][frame] - right[channel][frame]));
    }
  }
  return maximum;
};

const stereoRmsDb = (channels: readonly [Float32Array, Float32Array]) => {
  let power = 0;
  let samples = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      power += sample * sample;
      samples += 1;
    }
  }
  const rms = Math.sqrt(power / Math.max(1, samples));
  return rms > 0 ? 20 * Math.log10(rms) : null;
};

const stereoAlignmentMetrics = (
  left: readonly [Float32Array, Float32Array],
  right: readonly [Float32Array, Float32Array]
) => {
  const maximumLag = Math.min(256, Math.floor(left[0].length / 8));
  const edge = maximumLag;
  const stride = 17;
  let bestLag: number | null = null;
  let bestRatio = Number.POSITIVE_INFINITY;
  for (let lag = -maximumLag; lag <= maximumLag; lag += 1) {
    let differencePower = 0;
    let referencePower = 0;
    let samples = 0;
    for (let channel = 0; channel < 2; channel += 1) {
      for (let frame = edge; frame < left[channel].length - edge; frame += stride) {
        const shifted = frame + lag;
        if (shifted < 0 || shifted >= right[channel].length) continue;
        const difference = left[channel][frame] - right[channel][shifted];
        differencePower += difference * difference;
        referencePower += left[channel][frame] * left[channel][frame];
        samples += 1;
      }
    }
    if (!samples || referencePower <= 0) continue;
    const ratio = Math.sqrt(differencePower / referencePower);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestLag = lag;
    }
  }
  if (bestLag == null) return null;
  let fullDifferencePower = 0;
  let fullReferencePower = 0;
  let maximumDelta = 0;
  for (let channel = 0; channel < 2; channel += 1) {
    for (let frame = edge; frame < left[channel].length - edge; frame += 1) {
      const shifted = frame + bestLag;
      if (shifted < 0 || shifted >= right[channel].length) continue;
      const difference = left[channel][frame] - right[channel][shifted];
      fullDifferencePower += difference * difference;
      fullReferencePower += left[channel][frame] * left[channel][frame];
      maximumDelta = Math.max(maximumDelta, Math.abs(difference));
    }
  }
  if (fullReferencePower <= 0) return null;
  const fullRatio = Math.sqrt(fullDifferencePower / fullReferencePower);
  return Object.freeze({
    residualDb: fullRatio <= 0 ? -300 : 20 * Math.log10(fullRatio),
    maximumDelta
  });
};

export const deriveMasterPeakGuardComparisonMetrics = (
  currentChannels: readonly [Float32Array, Float32Array],
  identityChannels: readonly [Float32Array, Float32Array],
  candidateChannels: readonly [Float32Array, Float32Array],
  sampleRate: number
) => {
  const currentPeak = assessPostMasterPeak(currentChannels, sampleRate);
  const identityPeak = assessPostMasterPeak(identityChannels, sampleRate);
  const candidatePeak = assessPostMasterPeak(candidateChannels, sampleRate);
  const currentRmsDb = stereoRmsDb(currentChannels);
  const identityRmsDb = stereoRmsDb(identityChannels);
  const alignment = stereoAlignmentMetrics(currentChannels, identityChannels);
  return Object.freeze({
    currentPeak,
    identityPeak,
    candidatePeak,
    identityMaximumDelta: maxDifference(currentChannels, identityChannels),
    identityRmsDeltaDb: currentRmsDb == null || identityRmsDb == null
      ? null
      : Math.abs(currentRmsDb - identityRmsDb),
    identityPeakDeltaDb: currentPeak.estimatedTruePeakDbtp == null ||
      identityPeak.estimatedTruePeakDbtp == null
      ? null
      : Math.abs(currentPeak.estimatedTruePeakDbtp - identityPeak.estimatedTruePeakDbtp),
    identityResidualDb: alignment?.residualDb ?? null,
    identityAlignedMaximumDelta: alignment?.maximumDelta ?? null,
    guardMaximumDelta: maxDifference(identityChannels, candidateChannels),
    peakReductionDb: currentPeak.estimatedTruePeakDbtp == null ||
      candidatePeak.estimatedTruePeakDbtp == null
      ? null
      : currentPeak.estimatedTruePeakDbtp - candidatePeak.estimatedTruePeakDbtp
  });
};

const buildRender = (
  channels: readonly [Float32Array, Float32Array],
  sampleRate: number,
  comparisonOrdinal: number,
  variant: MasterPeakGuardListeningRender["variant"]
): MasterPeakGuardListeningRender => Object.freeze({
  kind: "master-peak-guard-listening-render/v2",
  variant,
  outputStage: variant === "current-master"
    ? "post-current-master"
    : variant === "identity-4x"
      ? "post-identity-4x"
      : "post-peak-guard",
  peakGuardCandidateVersion: variant === "peak-guard-candidate"
    ? MASTER_PEAK_GUARD_CANDIDATE.version
    : null,
  comparisonOrdinal,
  sampleRate,
  frameCount: channels[0].length,
  channels,
  peak: assessPostMasterPeak(channels, sampleRate)
});

export const renderMasterPeakGuardListeningComparison = async (
  preview: PreMasterStereoPreview,
  comparisonOrdinal = 1
): Promise<MasterPeakGuardListeningComparison> => {
  if (!Number.isSafeInteger(comparisonOrdinal) || comparisonOrdinal <= 0) {
    throw new RangeError("comparison ordinal must be a positive safe integer");
  }
  const sharedMasterChannels = await renderCurrentMaster(preview);
  const fanout = await renderPostMasterFanout(sharedMasterChannels, preview.sampleRate);
  const currentChannels = fanout.direct;
  const identityChannels = fanout.identity;
  const candidateChannels = fanout.guard;
  const currentMaster = buildRender(currentChannels, preview.sampleRate, comparisonOrdinal, "current-master");
  const identity4x = buildRender(identityChannels, preview.sampleRate, comparisonOrdinal, "identity-4x");
  const peakGuardCandidate = buildRender(
    candidateChannels,
    preview.sampleRate,
    comparisonOrdinal,
    "peak-guard-candidate"
  );
  const metrics = deriveMasterPeakGuardComparisonMetrics(
    currentChannels,
    identityChannels,
    candidateChannels,
    preview.sampleRate
  );
  return Object.freeze({
    kind: MASTER_PEAK_GUARD_COMPARISON_VERSION,
    comparisonOrdinal,
    currentMasterVersion: MASTER_DSP_V1.version,
    peakGuardCandidateVersion: MASTER_PEAK_GUARD_CANDIDATE.version,
    sampleRate: preview.sampleRate,
    frameCount: currentChannels[0].length,
    currentMaster,
    identity4x,
    peakGuardCandidate,
    identityMaximumDelta: metrics.identityMaximumDelta,
    identityRmsDeltaDb: metrics.identityRmsDeltaDb,
    identityPeakDeltaDb: metrics.identityPeakDeltaDb,
    identityResidualDb: metrics.identityResidualDb,
    identityAlignedMaximumDelta: metrics.identityAlignedMaximumDelta,
    guardMaximumDelta: metrics.guardMaximumDelta,
    peakReductionDb: metrics.peakReductionDb
  });
};

export const renderMasterPeakGuardCandidateCheck = async (
  preview: PreMasterStereoPreview
): Promise<MasterPeakGuardCandidateCheck> => {
  const rendered = await renderMasterPeakGuardListeningComparison(preview);
  return Object.freeze({
    kind: "master-peak-guard-candidate-check/v1",
    peakGuardCandidateVersion: MASTER_PEAK_GUARD_CANDIDATE.version,
    peak: rendered.peakGuardCandidate.peak
  });
};
