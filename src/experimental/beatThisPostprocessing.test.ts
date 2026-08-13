import { describe, expect, it } from "vitest";
import {
  aggregateBeatThisLogits,
  deduplicateBeatThisPeaks,
  postprocessBeatThisLogits,
  splitBeatThisSpectrogram
} from "./beatThisPostprocessing";

describe("Beat This postprocessing parity", () => {
  it("matches the official chunk starts and edge padding", () => {
    const short = splitBeatThisSpectrogram(new Float32Array(20 * 2).fill(1), 20, 2);
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ startFrame: -6, frames: 32 });
    expect(Array.from(short[0].data.slice(0, 12))).toEqual(new Array(12).fill(0));

    const long = splitBeatThisSpectrogram(new Float32Array(3_000 * 2), 3_000, 2);
    expect(long.map((chunk) => chunk.startFrame)).toEqual([-6, 1_482, 1_506]);
    expect(long.map((chunk) => chunk.frames)).toEqual([1_500, 1_500, 1_500]);
    expect(splitBeatThisSpectrogram(new Float32Array(1_488 * 2), 1_488, 2).map((chunk) => [chunk.startFrame, chunk.frames])).toEqual([[-6, 1_500]]);
    expect(splitBeatThisSpectrogram(new Float32Array(1_489 * 2), 1_489, 2).map((chunk) => [chunk.startFrame, chunk.frames])).toEqual([[-6, 1_500], [-5, 1_500]]);
    expect(splitBeatThisSpectrogram(new Float32Array(1_500 * 2), 1_500, 2).map((chunk) => [chunk.startFrame, chunk.frames])).toEqual([[-6, 1_500], [6, 1_500]]);
  });

  it("keeps earlier chunk logits in an overlap", () => {
    const first = { startFrame: -6, beat: new Float32Array(1_500).fill(1), downbeat: new Float32Array(1_500).fill(2) };
    const last = { startFrame: 6, beat: new Float32Array(1_500).fill(3), downbeat: new Float32Array(1_500).fill(4) };
    const result = aggregateBeatThisLogits([first, last], 1_500);
    expect(result.beat[10]).toBe(1);
    expect(result.beat[1_490]).toBe(3);
  });

  it("matches minimal max-pool, threshold, deduplication, and downbeat snapping", () => {
    expect(deduplicateBeatThisPeaks([2, 3, 8, 9, 10])).toEqual([2.5, 8.5, 10]);
    const beat = new Float32Array(30);
    const downbeat = new Float32Array(30);
    beat[4] = 2;
    beat[5] = 2;
    beat[20] = 3;
    downbeat[3] = 1;
    downbeat[19] = 1;
    expect(postprocessBeatThisLogits(beat, downbeat, 50)).toEqual({
      beatsSeconds: [0.09, 0.4],
      downbeatsSeconds: [0.09, 0.4]
    });
  });
});
