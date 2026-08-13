import { describe, expect, it } from "vitest";
import {
  BEAT_THIS_CHUNK_FRAMES,
  BEAT_THIS_MODEL_BYTES,
  BEAT_THIS_ZERO_WINDOW_FLOATS,
  validateBeatThisConfig,
  validateBeatThisOutputs
} from "./beatThisContract";

describe("Beat This ONNX experimental contract", () => {
  it("pins the published artifact and one-window input shape", () => {
    expect(BEAT_THIS_MODEL_BYTES).toBe(83_143_431);
    expect(BEAT_THIS_ZERO_WINDOW_FLOATS).toBe(1_500 * 128);
  });

  it("accepts only finite one-window outputs", () => {
    const values = new Float32Array(BEAT_THIS_CHUNK_FRAMES);
    expect(validateBeatThisOutputs([1, 1_500], [1, 1_500], values, values)).toBe(true);
    expect(validateBeatThisOutputs([2, 1_500], [1, 1_500], values, values)).toBe(false);
    values[4] = Number.NaN;
    expect(validateBeatThisOutputs([1, 1_500], [1, 1_500], values, values)).toBe(false);
  });

  it("rejects drift in the complete preprocessing contract", () => {
    const config = {
      modelType: "beat-this-final0", sampleRate: 22050, mono: true, downmix: "mean",
      nFft: 1024, hopLength: 441, melBins: 128, window: "hann", logMultiplier: 1000,
      fps: 50, frameDuration: 0.02, chunkSize: 1500, borderSize: 6,
      overlapMode: "keep_first", peakKernel: 7, peakThreshold: 0, deduplicateWidth: 1,
      melFilterbank: { file: "mel-filterbank.bin", shape: [513, 128], dtype: "float32", layout: "row-major" },
      model: {
        file: "beat_this.onnx",
        input: { name: "spect", shape: ["windows", "frames", 128], dtype: "float32" },
        outputs: [
          { name: "beat", shape: ["windows", "frames"], dtype: "float32" },
          { name: "downbeat", shape: ["windows", "frames"], dtype: "float32" }
        ]
      }
    };
    expect(validateBeatThisConfig(config)).toBe(true);
    expect(validateBeatThisConfig({ ...config, hopLength: 512 })).toBe(false);
  });
});
