export const MASTER_PEAK_GUARD_CANDIDATE = Object.freeze({
  version: "mazzy-master-peak-guard-candidate/v1" as const,
  sampleCeilingDbfs: -3,
  oversample: "4x" as OverSampleType,
  curvePoints: 65_537
});

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

export const renderMasterPeakGuardCandidateCheck = async (
  preview: PreMasterStereoPreview
): Promise<MasterPeakGuardCandidateCheck> => {
  if (
    preview.kind !== "pre-master-stereo/v1" ||
    preview.requiredMasterVersion !== MASTER_DSP_V1.version ||
    !Number.isFinite(preview.sampleRate) || preview.sampleRate < 8_000 || preview.sampleRate > 384_000 ||
    !preview.channels[0].length || preview.channels[0].length !== preview.channels[1].length
  ) {
    throw new RangeError("Peak-guard candidate input is malformed or incompatible");
  }
  const context = new OfflineAudioContext(2, preview.channels[0].length, preview.sampleRate);
  const buffer = context.createBuffer(2, preview.channels[0].length, preview.sampleRate);
  buffer.copyToChannel(new Float32Array(preview.channels[0]), 0);
  buffer.copyToChannel(new Float32Array(preview.channels[1]), 1);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const masterGain = context.createGain();
  const limiter = context.createDynamicsCompressor();
  const peakGuard = createMasterPeakGuardCandidate(context);
  configureMasterDspNodes(masterGain, limiter);
  source.connect(masterGain);
  masterGain.connect(limiter);
  limiter.connect(peakGuard);
  peakGuard.connect(context.destination);
  source.start(0);
  const rendered = await context.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(Math.min(1, rendered.numberOfChannels - 1));
  return Object.freeze({
    kind: "master-peak-guard-candidate-check/v1",
    peakGuardCandidateVersion: MASTER_PEAK_GUARD_CANDIDATE.version,
    peak: assessPostMasterPeak([left, right], rendered.sampleRate)
  });
};
import { configureMasterDspNodes, MASTER_DSP_V1 } from "../audio/masterDsp";
import { assessPostMasterPeak, type PostMasterPeakCheck } from "./postMasterPeak";
import type { PreMasterStereoPreview } from "./transitionRehearsal";
