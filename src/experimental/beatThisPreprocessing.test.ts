import { describe, expect, it } from "vitest";
import { BEAT_THIS_FREQUENCY_BINS, computeBeatThisLogMel } from "./beatThisPreprocessing";

describe("Beat This log-mel preprocessing", () => {
  it("uses centered frames, magnitude normalization, and log1p projection", () => {
    const pcm = new Float32Array(882);
    pcm[0] = 1;
    const filterbank = new Float32Array(BEAT_THIS_FREQUENCY_BINS * 2);
    filterbank[0] = 1;
    filterbank[1] = 0.5;
    const result = computeBeatThisLogMel(pcm, filterbank, 2);
    expect(result.frames).toBe(3);
    expect(result.melBins).toBe(2);
    expect(result.data).toHaveLength(6);
    expect(result.data.every(Number.isFinite)).toBe(true);
    expect(result.data[0]).toBeGreaterThan(result.data[1]);
  });

  it("rejects a filterbank with the wrong shape", () => {
    expect(() => computeBeatThisLogMel(new Float32Array(100), new Float32Array(10), 2)).toThrow(
      "filterbank"
    );
  });

  it("matches a TorchAudio 2.11 synthetic STFT/log-mel oracle", () => {
    const pcm = new Float32Array(5_000);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] =
        0.35 * Math.sin((2 * Math.PI * 440 * index) / 22_050) +
        0.17 * Math.sin((2 * Math.PI * 1_234 * index) / 22_050);
    }
    pcm[1_000] += 0.8;
    const filterbank = new Float32Array(BEAT_THIS_FREQUENCY_BINS * 4);
    filterbank[0 * 4 + 0] = 1;
    filterbank[20 * 4 + 0] = 0.25;
    filterbank[20 * 4 + 1] = 0.5;
    filterbank[40 * 4 + 1] = 0.75;
    filterbank[57 * 4 + 2] = 1;
    filterbank[120 * 4 + 2] = 0.2;
    filterbank[200 * 4 + 3] = 0.7;
    filterbank[400 * 4 + 3] = 0.3;
    const expected = [
      6.1917629, 6.3458219, 5.8896055, 1.6374980,
      6.4446397, 7.1228952, 7.1514316, 0.1769747,
      6.4600272, 7.1306224, 7.1510220, 3.1295681,
      6.4434309, 7.1284308, 7.1582932, 2.1405680,
      6.4302859, 7.1223302, 7.1549420, 0.0015772,
      6.4299755, 7.1223593, 7.1549397, 0.0008673,
      6.4302831, 7.1223779, 7.1549315, 0.0014238,
      6.4301643, 7.1224117, 7.1549201, 0.0010112,
      6.4301672, 7.1224256, 7.1549129, 0.0024245,
      6.4302840, 7.1224155, 7.1549129, 0.0010006,
      6.4299850, 7.1224103, 7.1549244, 0.0025360,
      6.4447050, 7.1312971, 7.1700058, 0.1693749
    ];
    const actual = computeBeatThisLogMel(pcm, filterbank, 4);
    expect(actual.frames).toBe(12);
    const errors = Array.from(actual.data, (value, index) => Math.abs(value - expected[index]));
    const meaningfulErrors = errors.filter((_, index) => expected[index] > 0.01);
    expect(Math.max(...meaningfulErrors)).toBeLessThan(3e-4);
    expect(Math.max(...errors)).toBeLessThan(3e-3);
    expect(errors.reduce((sum, value) => sum + value, 0) / errors.length).toBeLessThan(3e-4);
  });
});
