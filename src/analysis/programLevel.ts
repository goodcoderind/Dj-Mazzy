export type ProgramLevelAnalysis = {
  schemaVersion: "program-level/v1";
  activeRmsDbfs: number | null;
  samplePeakDbfs: number | null;
  trimDb: number;
  activeBlockCount: number;
};

const db = (amplitude: number) => amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export const analyzeProgramLevel = (
  channels: readonly Float32Array[],
  sampleRate: number
): ProgramLevelAnalysis => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("sampleRate must be positive and finite");
  if (!channels.length) return { schemaVersion: "program-level/v1", activeRmsDbfs: null, samplePeakDbfs: null, trimDb: 0, activeBlockCount: 0 };
  const length = Math.min(...channels.map((channel) => channel.length));
  const blockFrames = Math.max(1, Math.round(sampleRate * 0.4));
  const hopFrames = Math.max(1, Math.round(sampleRate * 0.2));
  const blockLevels: number[] = [];
  let peak = 0;
  for (let start = 0; start < length; start += hopFrames) {
    const end = Math.min(length, start + blockFrames);
    if (end - start < blockFrames / 2) break;
    let sumSquares = 0;
    for (let index = start; index < end; index += 1) {
      let channelSquares = 0;
      for (const channel of channels) {
        const sample = Number.isFinite(channel[index]) ? channel[index] : 0;
        peak = Math.max(peak, Math.abs(sample));
        channelSquares += sample * sample;
      }
      sumSquares += channelSquares / channels.length;
    }
    const level = db(Math.sqrt(sumSquares / (end - start)));
    if (level >= -50) blockLevels.push(level);
  }
  if (!blockLevels.length) {
    return {
      schemaVersion: "program-level/v1",
      activeRmsDbfs: null,
      samplePeakDbfs: peak > 0 ? db(peak) : null,
      trimDb: 0,
      activeBlockCount: 0
    };
  }
  blockLevels.sort((left, right) => left - right);
  const activeRmsDbfs = blockLevels[Math.floor((blockLevels.length - 1) * 0.6)];
  const samplePeakDbfs = db(peak);
  const desiredTrim = -14 - activeRmsDbfs;
  const peakLimitedTrim = -1 - samplePeakDbfs;
  const trimDb = clamp(Math.min(desiredTrim, peakLimitedTrim), -6, 3);
  return {
    schemaVersion: "program-level/v1",
    activeRmsDbfs: Math.round(activeRmsDbfs * 10) / 10,
    samplePeakDbfs: Math.round(samplePeakDbfs * 10) / 10,
    trimDb: Math.round(trimDb * 10) / 10,
    activeBlockCount: blockLevels.length
  };
};

export const analyzeAudioBufferProgramLevel = (buffer: AudioBuffer) =>
  analyzeProgramLevel(
    Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
    buffer.sampleRate
  );
