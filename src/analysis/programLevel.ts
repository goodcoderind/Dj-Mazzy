import {
  DECODED_TRUE_PEAK_ALGORITHM_VERSION,
  DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR,
  estimateDecodedTruePeakLinear
} from "./decodedTruePeak";

export const PROGRAM_LEVEL_SCHEMA_VERSION = "program-level/v3" as const;
export const PROGRAM_LEVEL_ALGORITHM_VERSION = "bs1770-k-weighted-gated/v1" as const;
export const PARTY_LEVEL_TRIM_POLICY_VERSION = "party-level-trim/v3" as const;

export type ProgramLevelMeasurementStatus =
  | "measured"
  | "silence"
  | "invalid-input"
  | "unsupported-channels";

export type ProgramLevelMeasurement = {
  algorithmVersion: typeof PROGRAM_LEVEL_ALGORITHM_VERSION;
  status: ProgramLevelMeasurementStatus;
  sampleRate: number;
  channelCount: number;
  integratedLufs: number | null;
  samplePeakDbfs: number | null;
  decodedPeakAlgorithmVersion: typeof DECODED_TRUE_PEAK_ALGORITHM_VERSION;
  decodedPeakOversampleFactor: typeof DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR;
  estimatedTruePeakDbtp: number | null;
  absoluteGatedBlockCount: number;
  relativeGatedBlockCount: number;
};

export type ProgramLevelAnalysis = {
  schemaVersion: typeof PROGRAM_LEVEL_SCHEMA_VERSION;
  measurement: ProgramLevelMeasurement;
  normalization: {
    policyVersion: typeof PARTY_LEVEL_TRIM_POLICY_VERSION;
    targetLufs: number;
    decodedPeakCeilingDbtp: number;
    trimDb: number;
  };
};

export const PARTY_LEVEL_TARGET_LUFS = -14;
// This per-file ceiling cannot prove post-EQ, overlap, stretch, limiter, DAC,
// or speaker output safety. The estimator is intentionally not presented as a
// certified meter.
export const PARTY_DECODED_PEAK_CEILING_DBTP = -2;

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const MINIMUM_TRIM_DB = -6;
const MAXIMUM_TRIM_DB = 3;
const ROUNDING_TOLERANCE = 0.051;

const roundTenth = (value: number) => Math.round(value * 10) / 10;
const roundPeakUpTenth = (value: number) => Math.ceil(value * 10 - Number.EPSILON) / 10;
const roundTrimDownTenth = (value: number) => Math.floor(value * 10 + Number.EPSILON) / 10;
const db = (amplitude: number) => amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
const loudnessFromPower = (power: number) => power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

type BiquadCoefficients = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

type BiquadState = BiquadCoefficients & {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

const kWeightingCoefficients = (sampleRate: number) => {
  // These continuous-design parameters reproduce the coefficients published
  // by ITU-R BS.1770 at 48 kHz while adapting the response to the actual rate.
  const shelfFrequency = 1681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfK = Math.tan(Math.PI * shelfFrequency / sampleRate);
  const shelfVh = 10 ** (shelfGainDb / 20);
  const shelfVb = shelfVh ** 0.4996667741545416;
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: BiquadCoefficients = {
    b0: (shelfVh + shelfVb * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    b1: 2 * (shelfK * shelfK - shelfVh) / shelfA0,
    b2: (shelfVh - shelfVb * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    a1: 2 * (shelfK * shelfK - 1) / shelfA0,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0
  };

  const highPassFrequency = 38.13547087602444;
  const highPassQ = 0.5003270373238773;
  const highPassK = Math.tan(Math.PI * highPassFrequency / sampleRate);
  const highPassA0 = 1 + highPassK / highPassQ + highPassK * highPassK;
  const highPass: BiquadCoefficients = {
    // BS.1770 deliberately specifies unity numerator coefficients here.
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (highPassK * highPassK - 1) / highPassA0,
    a2: (1 - highPassK / highPassQ + highPassK * highPassK) / highPassA0
  };
  return { shelf, highPass };
};

const createBiquadState = (coefficients: BiquadCoefficients): BiquadState => ({
  ...coefficients,
  x1: 0,
  x2: 0,
  y1: 0,
  y2: 0
});

const processBiquad = (state: BiquadState, input: number) => {
  const output = state.b0 * input + state.b1 * state.x1 + state.b2 * state.x2 -
    state.a1 * state.y1 - state.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;
  return output;
};

const emptyMeasurement = (
  status: Exclude<ProgramLevelMeasurementStatus, "measured">,
  sampleRate: number,
  channelCount: number
): ProgramLevelMeasurement => ({
  algorithmVersion: PROGRAM_LEVEL_ALGORITHM_VERSION,
  status,
  sampleRate,
  channelCount,
  integratedLufs: null,
  samplePeakDbfs: null,
  decodedPeakAlgorithmVersion: DECODED_TRUE_PEAK_ALGORITHM_VERSION,
  decodedPeakOversampleFactor: DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR,
  estimatedTruePeakDbtp: null,
  absoluteGatedBlockCount: 0,
  relativeGatedBlockCount: 0
});

export const deriveProgramTrim = (measurement: ProgramLevelMeasurement) => {
  let trimDb = 0;
  if (
    measurement.status === "measured" &&
    measurement.integratedLufs != null &&
    measurement.estimatedTruePeakDbtp != null
  ) {
    const desiredTrim = PARTY_LEVEL_TARGET_LUFS - measurement.integratedLufs;
    const peakLimitedTrim = PARTY_DECODED_PEAK_CEILING_DBTP - measurement.estimatedTruePeakDbtp;
    trimDb = clamp(Math.min(desiredTrim, peakLimitedTrim), MINIMUM_TRIM_DB, MAXIMUM_TRIM_DB);
  }
  return {
    policyVersion: PARTY_LEVEL_TRIM_POLICY_VERSION,
    targetLufs: PARTY_LEVEL_TARGET_LUFS,
    decodedPeakCeilingDbtp: PARTY_DECODED_PEAK_CEILING_DBTP,
    trimDb: roundTrimDownTenth(trimDb)
  } as const;
};

const buildAnalysis = (measurement: ProgramLevelMeasurement): ProgramLevelAnalysis => ({
  schemaVersion: PROGRAM_LEVEL_SCHEMA_VERSION,
  measurement,
  normalization: deriveProgramTrim(measurement)
});

export const analyzeProgramLevel = (
  channels: readonly Float32Array[],
  sampleRate: number,
  sourceChannelCount = channels.length
): ProgramLevelAnalysis => {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) {
    throw new RangeError("sampleRate must be finite and between 8 kHz and 384 kHz");
  }
  if (sourceChannelCount !== 1 && sourceChannelCount !== 2) {
    return buildAnalysis(emptyMeasurement("unsupported-channels", sampleRate, sourceChannelCount));
  }
  if (channels.length !== sourceChannelCount || channels.some((channel) => !(channel instanceof Float32Array))) {
    return buildAnalysis(emptyMeasurement("invalid-input", sampleRate, sourceChannelCount));
  }
  const length = channels[0]?.length ?? 0;
  if (!length || channels.some((channel) => channel.length !== length)) {
    return buildAnalysis(emptyMeasurement(length ? "invalid-input" : "silence", sampleRate, sourceChannelCount));
  }

  let samplePeak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) {
        return buildAnalysis(emptyMeasurement("invalid-input", sampleRate, sourceChannelCount));
      }
      samplePeak = Math.max(samplePeak, Math.abs(sample));
    }
  }
  const estimatedTruePeak = estimateDecodedTruePeakLinear(channels);

  const blockFrames = Math.max(1, Math.round(sampleRate * 0.4));
  const hopFrames = Math.max(1, Math.round(blockFrames * 0.25));
  if (length < blockFrames) {
    const measurement = emptyMeasurement("silence", sampleRate, sourceChannelCount);
    measurement.samplePeakDbfs = samplePeak > 0 ? roundPeakUpTenth(db(samplePeak)) : null;
    measurement.estimatedTruePeakDbtp = estimatedTruePeak > 0
      ? roundPeakUpTenth(db(estimatedTruePeak))
      : null;
    return buildAnalysis(measurement);
  }

  const coefficients = kWeightingCoefficients(sampleRate);
  const filters = channels.map(() => ({
    shelf: createBiquadState(coefficients.shelf),
    highPass: createBiquadState(coefficients.highPass)
  }));
  const energyRing = new Float64Array(blockFrames);
  const blockPowers: number[] = [];
  let rollingPower = 0;

  for (let frame = 0; frame < length; frame += 1) {
    let framePower = 0;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const sample = channels[channelIndex][frame];
      const filter = filters[channelIndex];
      const weighted = processBiquad(
        filter.highPass,
        processBiquad(filter.shelf, sample)
      );
      framePower += weighted * weighted;
    }
    const ringIndex = frame % blockFrames;
    rollingPower += framePower - energyRing[ringIndex];
    energyRing[ringIndex] = framePower;
    const completeFrames = frame + 1;
    if (completeFrames >= blockFrames && (completeFrames - blockFrames) % hopFrames === 0) {
      blockPowers.push(rollingPower / blockFrames);
    }
  }

  const absoluteGated = blockPowers.filter((power) => loudnessFromPower(power) > ABSOLUTE_GATE_LUFS);
  if (!absoluteGated.length) {
    const measurement = emptyMeasurement("silence", sampleRate, sourceChannelCount);
    measurement.samplePeakDbfs = samplePeak > 0 ? roundPeakUpTenth(db(samplePeak)) : null;
    measurement.estimatedTruePeakDbtp = estimatedTruePeak > 0
      ? roundPeakUpTenth(db(estimatedTruePeak))
      : null;
    return buildAnalysis(measurement);
  }
  const absoluteMeanPower = absoluteGated.reduce((sum, power) => sum + power, 0) / absoluteGated.length;
  const relativeThreshold = loudnessFromPower(absoluteMeanPower) + RELATIVE_GATE_LU;
  const relativeGated = absoluteGated.filter((power) => loudnessFromPower(power) > relativeThreshold);
  if (!relativeGated.length) {
    return buildAnalysis(emptyMeasurement("invalid-input", sampleRate, sourceChannelCount));
  }
  const integratedPower = relativeGated.reduce((sum, power) => sum + power, 0) / relativeGated.length;
  const measurement: ProgramLevelMeasurement = {
    algorithmVersion: PROGRAM_LEVEL_ALGORITHM_VERSION,
    status: "measured",
    sampleRate,
    channelCount: sourceChannelCount,
    integratedLufs: roundTenth(loudnessFromPower(integratedPower)),
    samplePeakDbfs: roundPeakUpTenth(db(samplePeak)),
    decodedPeakAlgorithmVersion: DECODED_TRUE_PEAK_ALGORITHM_VERSION,
    decodedPeakOversampleFactor: DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR,
    estimatedTruePeakDbtp: roundPeakUpTenth(db(estimatedTruePeak)),
    absoluteGatedBlockCount: absoluteGated.length,
    relativeGatedBlockCount: relativeGated.length
  };
  return buildAnalysis(measurement);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNullableFinite = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const closeTo = (left: number, right: number) => Math.abs(left - right) <= ROUNDING_TOLERANCE;

export const normalizeProgramLevel = (value: unknown): ProgramLevelAnalysis | null => {
  if (!isRecord(value) || value.schemaVersion !== PROGRAM_LEVEL_SCHEMA_VERSION) return null;
  const rawMeasurement = value.measurement;
  const rawNormalization = value.normalization;
  if (!isRecord(rawMeasurement) || !isRecord(rawNormalization)) return null;
  const status = rawMeasurement.status;
  const sampleRate = rawMeasurement.sampleRate;
  const channelCount = rawMeasurement.channelCount;
  const integratedLufs = rawMeasurement.integratedLufs;
  const samplePeakDbfs = rawMeasurement.samplePeakDbfs;
  const estimatedTruePeakDbtp = rawMeasurement.estimatedTruePeakDbtp;
  const absoluteGatedBlockCount = rawMeasurement.absoluteGatedBlockCount;
  const relativeGatedBlockCount = rawMeasurement.relativeGatedBlockCount;
  if (
    rawMeasurement.algorithmVersion !== PROGRAM_LEVEL_ALGORITHM_VERSION ||
    !["measured", "silence", "invalid-input", "unsupported-channels"].includes(String(status)) ||
    typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000 ||
    typeof channelCount !== "number" || !Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32 ||
    !isNullableFinite(integratedLufs) || !isNullableFinite(samplePeakDbfs) ||
    rawMeasurement.decodedPeakAlgorithmVersion !== DECODED_TRUE_PEAK_ALGORITHM_VERSION ||
    rawMeasurement.decodedPeakOversampleFactor !== DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR ||
    !isNullableFinite(estimatedTruePeakDbtp) ||
    (samplePeakDbfs != null && (samplePeakDbfs < -1_000 || samplePeakDbfs > 1_000)) ||
    (estimatedTruePeakDbtp != null && (estimatedTruePeakDbtp < -1_000 || estimatedTruePeakDbtp > 1_000)) ||
    typeof absoluteGatedBlockCount !== "number" || !Number.isInteger(absoluteGatedBlockCount) || absoluteGatedBlockCount < 0 ||
    typeof relativeGatedBlockCount !== "number" || !Number.isInteger(relativeGatedBlockCount) || relativeGatedBlockCount < 0 ||
    relativeGatedBlockCount > absoluteGatedBlockCount
  ) return null;
  if (
    status === "measured" &&
    (channelCount > 2 || integratedLufs == null || integratedLufs < -70 || integratedLufs > 1_000 ||
      samplePeakDbfs == null || estimatedTruePeakDbtp == null ||
      absoluteGatedBlockCount === 0 || relativeGatedBlockCount === 0)
  ) return null;
  if (
    samplePeakDbfs != null && estimatedTruePeakDbtp != null &&
    estimatedTruePeakDbtp + ROUNDING_TOLERANCE < samplePeakDbfs
  ) return null;
  if ((samplePeakDbfs == null) !== (estimatedTruePeakDbtp == null)) return null;
  if (status !== "measured" && integratedLufs !== null) return null;
  if ((status === "measured" || status === "silence") && channelCount > 2) return null;
  if (status === "unsupported-channels" && channelCount <= 2) return null;

  const measurement: ProgramLevelMeasurement = {
    algorithmVersion: PROGRAM_LEVEL_ALGORITHM_VERSION,
    status: status as ProgramLevelMeasurementStatus,
    sampleRate,
    channelCount,
    integratedLufs,
    samplePeakDbfs,
    decodedPeakAlgorithmVersion: DECODED_TRUE_PEAK_ALGORITHM_VERSION,
    decodedPeakOversampleFactor: DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR,
    estimatedTruePeakDbtp,
    absoluteGatedBlockCount,
    relativeGatedBlockCount
  };
  const normalization = deriveProgramTrim(measurement);
  if (
    rawNormalization.policyVersion !== PARTY_LEVEL_TRIM_POLICY_VERSION ||
    rawNormalization.targetLufs !== PARTY_LEVEL_TARGET_LUFS ||
    rawNormalization.decodedPeakCeilingDbtp !== PARTY_DECODED_PEAK_CEILING_DBTP ||
    typeof rawNormalization.trimDb !== "number" || !Number.isFinite(rawNormalization.trimDb) ||
    !closeTo(rawNormalization.trimDb, normalization.trimDb)
  ) return null;
  return { schemaVersion: PROGRAM_LEVEL_SCHEMA_VERSION, measurement, normalization };
};

export const analyzeAudioBufferProgramLevel = (buffer: AudioBuffer) => {
  const channels = Array.from(
    { length: Math.min(buffer.numberOfChannels, 2) },
    (_, channel) => buffer.getChannelData(channel)
  );
  return analyzeProgramLevel(channels, buffer.sampleRate, buffer.numberOfChannels);
};
