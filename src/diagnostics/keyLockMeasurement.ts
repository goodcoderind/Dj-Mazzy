export const scanSpectralPeak = (
  samples: readonly number[] | Float32Array,
  sampleRate: number,
  minimumHz: number,
  maximumHz: number,
  stepHz: number
) => {
  let bestFrequency = 0;
  let bestMagnitude = -Infinity;
  for (let frequency = minimumHz; frequency <= maximumHz + stepHz / 2; frequency += stepHz) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(samples.length - 1, 1));
      const phase = 2 * Math.PI * frequency * index / sampleRate;
      real += samples[index] * window * Math.cos(phase);
      imaginary -= samples[index] * window * Math.sin(phase);
    }
    const magnitude = Math.hypot(real, imaginary);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestFrequency = frequency;
    }
  }
  return bestFrequency;
};

export const estimateCarrierFrequency = (samples: Float32Array, sampleRate: number, expectedHz: number) =>
  scanSpectralPeak(samples, sampleRate, expectedHz - 20, expectedHz + 20, 0.05);

export const estimatePulseRate = (samples: Float32Array, sampleRate: number) => {
  const blockSize = 96;
  const levels: number[] = [];
  for (let start = 0; start + blockSize <= samples.length; start += blockSize) {
    let sum = 0;
    for (let index = start; index < start + blockSize; index += 1) sum += samples[index] * samples[index];
    levels.push(Math.sqrt(sum / blockSize));
  }
  const mean = levels.reduce((sum, value) => sum + value, 0) / levels.length;
  return scanSpectralPeak(levels.map((value) => value - mean), sampleRate / blockSize, 12, 20, 0.002);
};

export const magnitudeAt = (samples: Float32Array, sampleRate: number, frequency: number) => {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const phase = 2 * Math.PI * frequency * index / sampleRate;
    real += samples[index] * Math.cos(phase);
    imaginary -= samples[index] * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / samples.length;
};

export const carrierProminenceDb = (samples: Float32Array, sampleRate: number, carrierHz: number) => {
  const carrier = magnitudeAt(samples, sampleRate, carrierHz);
  let strongestControl = 1e-12;
  for (let frequency = carrierHz - 100; frequency <= carrierHz + 100; frequency += 5) {
    // The deliberate 16 Hz amplitude marker creates expected sidebands.
    if (Math.abs(frequency - carrierHz) < 30) continue;
    strongestControl = Math.max(strongestControl, magnitudeAt(samples, sampleRate, frequency));
  }
  return 20 * Math.log10(Math.max(carrier, 1e-12) / strongestControl);
};

export const stereoLeakageDb = (left: Float32Array, right: Float32Array, sampleRate: number) => {
  const leftLeakage = magnitudeAt(left, sampleRate, 660) / Math.max(magnitudeAt(left, sampleRate, 440), 1e-12);
  const rightLeakage = magnitudeAt(right, sampleRate, 440) / Math.max(magnitudeAt(right, sampleRate, 660), 1e-12);
  return 20 * Math.log10(Math.max(leftLeakage, rightLeakage, 1e-12));
};
