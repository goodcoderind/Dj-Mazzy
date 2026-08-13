export const BEAT_THIS_EXPERIMENT_VERSION = "beat-this-onnx-final0/experiment-v2" as const;
export const BEAT_THIS_MODEL_URL = "/models/beat-this-final0/v1/beat_this.onnx";
export const BEAT_THIS_CONFIG_URL = "/models/beat-this-final0/v1/config.json";
export const BEAT_THIS_MEL_FILTERBANK_URL = "/models/beat-this-final0/v1/mel-filterbank.bin";
export const BEAT_THIS_MODEL_BYTES = 83_143_431;
export const BEAT_THIS_MODEL_SHA256 = "078572af6ca47741e06a82d09525d13c793eaa8e311a8cf15e831dcd7e73f218";
export const BEAT_THIS_CONFIG_SHA256 = "56cc961ddc588c57787c20c01ec6ab483b23af1049e65bd33d599a81803acd69";
export const BEAT_THIS_MEL_FILTERBANK_BYTES = 262_656;
export const BEAT_THIS_MEL_FILTERBANK_SHA256 = "1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533";
export const BEAT_THIS_CHUNK_FRAMES = 1_500;
export const BEAT_THIS_MEL_BINS = 128;
export const BEAT_THIS_ZERO_WINDOW_FLOATS = BEAT_THIS_CHUNK_FRAMES * BEAT_THIS_MEL_BINS;

export type BeatThisBackend = "webgpu" | "wasm";

export type BeatThisDiagnosticResult = {
  experimentVersion: typeof BEAT_THIS_EXPERIMENT_VERSION;
  backend: BeatThisBackend;
  webGpuAvailable: boolean;
  modelBytes: number;
  sessionLoadMs: number;
  zeroWindowInferenceMs: number;
  beatOutputShape: readonly number[];
  downbeatOutputShape: readonly number[];
  finiteOutput: boolean;
  experimentalOnly: true;
  eligibilityConfidence: 0;
};

export type BeatThisTrackDiagnosticResult = {
  experimentVersion: typeof BEAT_THIS_EXPERIMENT_VERSION;
  backend: BeatThisBackend;
  webGpuAvailable: boolean;
  sourceSampleRate: number;
  analysisSampleRate: 22_050;
  durationSeconds: number;
  featureFrames: number;
  chunks: number;
  preprocessingMs: number;
  sessionLoadMs: number;
  inferenceMs: number;
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  /** Scale-free, beat-aligned PCM activity; never persisted as raw audio. */
  energyByBeat?: number[];
  bandEnergyByBeat?: Array<{ low: number; mid: number; high: number }>;
  vocalProbabilityByBeat?: number[];
  structureBoundaries?: Array<{ beatIndex: number; type: "energy-change"; confidence: number }>;
  phraseCandidates?: Array<{ beatIndex: number; confidence: number }>;
  backendFailures: string[];
  experimentalOnly: true;
  eligibilityConfidence: 0;
};

export type BeatThisConfig = {
  modelType: "beat-this-final0";
  sampleRate: 22_050;
  mono: true;
  downmix: "mean";
  nFft: 1_024;
  hopLength: 441;
  melBins: 128;
  window: "hann";
  logMultiplier: 1_000;
  fps: 50;
  frameDuration: 0.02;
  chunkSize: 1_500;
  borderSize: 6;
  overlapMode: "keep_first";
  peakKernel: 7;
  peakThreshold: 0;
  deduplicateWidth: 1;
  melFilterbank: { file: "mel-filterbank.bin"; shape: [513, 128]; dtype: "float32"; layout: "row-major" };
  model: {
    file: "beat_this.onnx";
    input: { name: "spect"; shape: ["windows", "frames", 128]; dtype: "float32" };
    outputs: Array<{ name: "beat" | "downbeat"; shape: ["windows", "frames"]; dtype: "float32" }>;
  };
};

export const validateBeatThisConfig = (value: unknown): value is BeatThisConfig => {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, any>;
  return (
    config.modelType === "beat-this-final0" &&
    config.sampleRate === 22_050 &&
    config.mono === true &&
    config.downmix === "mean" &&
    config.nFft === 1_024 &&
    config.hopLength === 441 &&
    config.melBins === 128 &&
    config.window === "hann" &&
    config.logMultiplier === 1_000 &&
    config.fps === 50 &&
    config.frameDuration === 0.02 &&
    config.chunkSize === 1_500 &&
    config.borderSize === 6 &&
    config.overlapMode === "keep_first" &&
    config.peakKernel === 7 &&
    config.peakThreshold === 0 &&
    config.deduplicateWidth === 1 &&
    config.melFilterbank?.file === "mel-filterbank.bin" &&
    JSON.stringify(config.melFilterbank?.shape) === "[513,128]" &&
    config.melFilterbank?.dtype === "float32" &&
    config.melFilterbank?.layout === "row-major" &&
    config.model?.file === "beat_this.onnx" &&
    config.model?.input?.name === "spect" &&
    JSON.stringify(config.model?.input?.shape) === '["windows","frames",128]' &&
    config.model?.input?.dtype === "float32" &&
    JSON.stringify(config.model?.outputs?.map((output: any) => output.name)) === '["beat","downbeat"]' &&
    config.model.outputs.every(
      (output: any) => JSON.stringify(output.shape) === '["windows","frames"]' && output.dtype === "float32"
    )
  );
};

export const validateBeatThisOutputs = (
  beatDimensions: readonly number[],
  downbeatDimensions: readonly number[],
  beatData: ArrayLike<number>,
  downbeatData: ArrayLike<number>,
  expectedFrames = BEAT_THIS_CHUNK_FRAMES
) => {
  const expectedShape = [1, expectedFrames];
  const shapeMatches = (dimensions: readonly number[]) =>
    dimensions.length === expectedShape.length &&
    dimensions.every((value, index) => value === expectedShape[index]);
  return (
    shapeMatches(beatDimensions) &&
    shapeMatches(downbeatDimensions) &&
    beatData.length === expectedFrames &&
    downbeatData.length === expectedFrames &&
    Array.from(beatData).every(Number.isFinite) &&
    Array.from(downbeatData).every(Number.isFinite)
  );
};
