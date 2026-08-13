export const BEAT_THIS_FPS = 50;
export const BEAT_THIS_CHUNK_SIZE = 1_500;
export const BEAT_THIS_BORDER_SIZE = 6;

export type BeatThisChunk = {
  startFrame: number;
  frames: number;
  data: Float32Array;
};

export const splitBeatThisSpectrogram = (
  spectrogram: Float32Array,
  frameCount: number,
  melBins = 128,
  chunkSize = BEAT_THIS_CHUNK_SIZE,
  borderSize = BEAT_THIS_BORDER_SIZE
) => {
  if (spectrogram.length !== frameCount * melBins) {
    throw new Error("Beat This spectrogram shape does not match its frame and mel dimensions.");
  }
  const step = chunkSize - 2 * borderSize;
  const starts: number[] = [];
  for (let start = -borderSize; start < frameCount - borderSize; start += step) starts.push(start);
  if (frameCount > step) starts[starts.length - 1] = frameCount - (chunkSize - borderSize);

  return starts.map((startFrame): BeatThisChunk => {
    const inputStart = Math.max(startFrame, 0);
    const inputEnd = Math.min(startFrame + chunkSize, frameCount);
    const leftPadding = Math.max(0, -startFrame);
    const rightPadding = Math.max(0, Math.min(borderSize, startFrame + chunkSize - frameCount));
    const frames = leftPadding + (inputEnd - inputStart) + rightPadding;
    const data = new Float32Array(frames * melBins);
    data.set(
      spectrogram.subarray(inputStart * melBins, inputEnd * melBins),
      leftPadding * melBins
    );
    return { startFrame, frames, data };
  });
};

export const aggregateBeatThisLogits = (
  chunks: Array<{ startFrame: number; beat: Float32Array; downbeat: Float32Array }>,
  frameCount: number,
  borderSize = BEAT_THIS_BORDER_SIZE,
  overlapMode: "keep_first" | "keep_last" = "keep_first"
) => {
  const beat = new Float32Array(frameCount).fill(-1_000);
  const downbeat = new Float32Array(frameCount).fill(-1_000);
  const ordered = overlapMode === "keep_first" ? [...chunks].reverse() : chunks;
  for (const chunk of ordered) {
    if (chunk.beat.length !== chunk.downbeat.length) throw new Error("Beat This output lengths differ.");
    const usableStart = borderSize;
    const usableEnd = chunk.beat.length - borderSize;
    const destinationStart = chunk.startFrame + borderSize;
    for (let index = usableStart; index < usableEnd; index += 1) {
      const destination = destinationStart + index - usableStart;
      if (destination >= 0 && destination < frameCount) {
        beat[destination] = chunk.beat[index];
        downbeat[destination] = chunk.downbeat[index];
      }
    }
  }
  return { beat, downbeat };
};

const localMaxima = (logits: Float32Array, kernel = 7, threshold = 0) => {
  const radius = Math.floor(kernel / 2);
  const peaks: number[] = [];
  for (let index = 0; index < logits.length; index += 1) {
    const value = logits[index];
    if (!(value > threshold)) continue;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let neighbor = Math.max(0, index - radius); neighbor <= Math.min(logits.length - 1, index + radius); neighbor += 1) {
      maximum = Math.max(maximum, logits[neighbor]);
    }
    if (value === maximum) peaks.push(index);
  }
  return peaks;
};

export const deduplicateBeatThisPeaks = (peaks: readonly number[], width = 1) => {
  if (peaks.length === 0) return [];
  const result: number[] = [];
  let mean = peaks[0];
  let count = 1;
  for (let index = 1; index < peaks.length; index += 1) {
    const peak = peaks[index];
    if (peak - mean <= width) {
      count += 1;
      mean += (peak - mean) / count;
    } else {
      result.push(mean);
      mean = peak;
      count = 1;
    }
  }
  result.push(mean);
  return result;
};

export const postprocessBeatThisLogits = (
  beatLogits: Float32Array,
  downbeatLogits: Float32Array,
  fps = BEAT_THIS_FPS
) => {
  if (beatLogits.length !== downbeatLogits.length) throw new Error("Beat This logit lengths differ.");
  const beatFrames = deduplicateBeatThisPeaks(localMaxima(beatLogits));
  const rawDownbeatFrames = deduplicateBeatThisPeaks(localMaxima(downbeatLogits));
  const beatsSeconds = beatFrames.map((frame) => frame / fps);
  const snappedDownbeats = rawDownbeatFrames.map((frame) => {
    let closest = beatFrames[0];
    for (const beat of beatFrames) {
      if (Math.abs(beat - frame) < Math.abs(closest - frame)) closest = beat;
    }
    return closest / fps;
  });
  return {
    beatsSeconds,
    downbeatsSeconds: [...new Set(snappedDownbeats)].filter(Number.isFinite)
  };
};
