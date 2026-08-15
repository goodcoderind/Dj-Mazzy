import {
  DECODED_TRUE_PEAK_ALGORITHM_VERSION,
  DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR,
  estimateDecodedTruePeakLinear
} from "../analysis/decodedTruePeak";
import { MASTER_DSP_V1 } from "../audio/masterDsp";

export const POST_MASTER_PEAK_CHECK_SCHEMA_VERSION = "post-master-peak-check/v2" as const;
export const POST_MASTER_PEAK_CEILING_DBTP = -1;

export type PostMasterPeakCheck = Readonly<{
  schemaVersion: typeof POST_MASTER_PEAK_CHECK_SCHEMA_VERSION;
  requiredMasterVersion: typeof MASTER_DSP_V1.version;
  outputStage: "post-limiter";
  sampleRate: number;
  channelCount: 2;
  peakEstimateAlgorithmVersion: typeof DECODED_TRUE_PEAK_ALGORITHM_VERSION;
  peakOversampleFactor: typeof DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR;
  samplePeakDbfs: number | null;
  estimatedTruePeakDbtp: number | null;
  ceilingDbtp: typeof POST_MASTER_PEAK_CEILING_DBTP;
  passed: boolean;
  failureCodes: readonly ("no-signal" | "post-master-estimated-true-peak-overload")[];
}>;

const roundPeakUpTenth = (value: number) => Math.ceil(value * 10 - Number.EPSILON) / 10;
const toDb = (value: number) => value > 0 ? 20 * Math.log10(value) : null;

export const assessPostMasterPeak = (
  channels: readonly [Float32Array, Float32Array],
  sampleRate: number
): PostMasterPeakCheck => {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) {
    throw new RangeError("post-master sample rate must be finite and supported");
  }
  if (!channels[0].length || channels[0].length !== channels[1].length) {
    throw new RangeError("post-master channels must have equal non-empty lengths");
  }
  let samplePeak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new RangeError("post-master samples must be finite");
      samplePeak = Math.max(samplePeak, Math.abs(sample));
    }
  }
  const estimatedTruePeak = estimateDecodedTruePeakLinear(channels);
  const samplePeakDbfs = toDb(samplePeak);
  const estimatedTruePeakDbtp = toDb(estimatedTruePeak);
  const roundedSamplePeak = samplePeakDbfs == null ? null : roundPeakUpTenth(samplePeakDbfs);
  const roundedTruePeak = estimatedTruePeakDbtp == null ? null : roundPeakUpTenth(estimatedTruePeakDbtp);
  const failureCodes: Array<"no-signal" | "post-master-estimated-true-peak-overload"> = [];
  if (roundedTruePeak == null) failureCodes.push("no-signal");
  if (roundedTruePeak != null && roundedTruePeak > POST_MASTER_PEAK_CEILING_DBTP) {
    failureCodes.push("post-master-estimated-true-peak-overload");
  }
  return Object.freeze({
    schemaVersion: POST_MASTER_PEAK_CHECK_SCHEMA_VERSION,
    requiredMasterVersion: MASTER_DSP_V1.version,
    outputStage: "post-limiter",
    sampleRate,
    channelCount: 2,
    peakEstimateAlgorithmVersion: DECODED_TRUE_PEAK_ALGORITHM_VERSION,
    peakOversampleFactor: DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR,
    samplePeakDbfs: roundedSamplePeak,
    estimatedTruePeakDbtp: roundedTruePeak,
    ceilingDbtp: POST_MASTER_PEAK_CEILING_DBTP,
    passed: failureCodes.length === 0,
    failureCodes: Object.freeze(failureCodes)
  });
};
