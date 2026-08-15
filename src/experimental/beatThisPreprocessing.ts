export const BEAT_THIS_SAMPLE_RATE = 22_050;
export const BEAT_THIS_N_FFT = 1_024;
export const BEAT_THIS_HOP_LENGTH = 441;
export const BEAT_THIS_FREQUENCY_BINS = BEAT_THIS_N_FFT / 2 + 1;
export const BEAT_THIS_LOG_MULTIPLIER = 1_000;

export type BeatThisSpectrogram = {
  data: Float32Array;
  frames: number;
  melBins: number;
};

type SparseMelWeight = { mel: number; weight: number };

const reflectIndex = (index: number, length: number) => {
  if (length < 2) return 0;
  let reflected = index;
  while (reflected < 0 || reflected >= length) {
    if (reflected < 0) reflected = -reflected;
    if (reflected >= length) reflected = 2 * length - 2 - reflected;
  }
  return reflected;
};

const fftInPlace = (real: Float32Array, imaginary: Float32Array) => {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      const halfLength = length >> 1;
      for (let index = 0; index < halfLength; index += 1) {
        const evenIndex = offset + index;
        const oddIndex = evenIndex + halfLength;
        const oddReal = real[oddIndex] * twiddleReal - imaginary[oddIndex] * twiddleImaginary;
        const oddImaginary = real[oddIndex] * twiddleImaginary + imaginary[oddIndex] * twiddleReal;
        real[oddIndex] = real[evenIndex] - oddReal;
        imaginary[oddIndex] = imaginary[evenIndex] - oddImaginary;
        real[evenIndex] += oddReal;
        imaginary[evenIndex] += oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
};

const makeSparseFilterbank = (filterbank: Float32Array, melBins: number) => {
  if (filterbank.length !== BEAT_THIS_FREQUENCY_BINS * melBins) {
    throw new Error(
      `Beat This mel filterbank must contain ${BEAT_THIS_FREQUENCY_BINS * melBins} float32 values.`
    );
  }
  const sparse = Array.from({ length: BEAT_THIS_FREQUENCY_BINS }, () => [] as SparseMelWeight[]);
  for (let frequency = 0; frequency < BEAT_THIS_FREQUENCY_BINS; frequency += 1) {
    for (let mel = 0; mel < melBins; mel += 1) {
      const weight = filterbank[frequency * melBins + mel];
      if (weight !== 0) sparse[frequency].push({ mel, weight });
    }
  }
  return sparse;
};

/**
 * Reproduces Beat This's TorchAudio LogMelSpect contract for already-resampled
 * mono PCM: centered reflect padding, periodic Hann window, magnitude STFT
 * normalized by sqrt(frame length), the pinned Slaney filterbank, then log1p.
 */
export const computeBeatThisLogMel = (
  pcm: Float32Array,
  filterbank: Float32Array,
  melBins = 128
): BeatThisSpectrogram => {
  if (pcm.length < 2) throw new Error("Beat This preprocessing requires at least two PCM samples.");
  const frames = Math.floor(pcm.length / BEAT_THIS_HOP_LENGTH) + 1;
  const output = new Float32Array(frames * melBins);
  const sparseFilterbank = makeSparseFilterbank(filterbank, melBins);
  const real = new Float32Array(BEAT_THIS_N_FFT);
  const imaginary = new Float32Array(BEAT_THIS_N_FFT);
  const magnitude = new Float32Array(BEAT_THIS_FREQUENCY_BINS);
  const mel = new Float32Array(melBins);
  const normalization = Math.sqrt(BEAT_THIS_N_FFT);
  const centerPadding = BEAT_THIS_N_FFT / 2;

  for (let frame = 0; frame < frames; frame += 1) {
    const frameStart = frame * BEAT_THIS_HOP_LENGTH - centerPadding;
    for (let index = 0; index < BEAT_THIS_N_FFT; index += 1) {
      const sample = pcm[reflectIndex(frameStart + index, pcm.length)];
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / BEAT_THIS_N_FFT);
      real[index] = sample * hann;
      imaginary[index] = 0;
    }
    fftInPlace(real, imaginary);
    for (let frequency = 0; frequency < BEAT_THIS_FREQUENCY_BINS; frequency += 1) {
      magnitude[frequency] = Math.hypot(real[frequency], imaginary[frequency]) / normalization;
    }
    mel.fill(0);
    for (let frequency = 0; frequency < BEAT_THIS_FREQUENCY_BINS; frequency += 1) {
      const value = magnitude[frequency];
      for (const { mel: melIndex, weight } of sparseFilterbank[frequency]) {
        mel[melIndex] += value * weight;
      }
    }
    for (let melIndex = 0; melIndex < melBins; melIndex += 1) {
      output[frame * melBins + melIndex] = Math.log1p(BEAT_THIS_LOG_MULTIPLIER * mel[melIndex]);
    }
  }
  return { data: output, frames, melBins };
};
