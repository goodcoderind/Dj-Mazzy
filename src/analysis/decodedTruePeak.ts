export const DECODED_TRUE_PEAK_ALGORITHM_VERSION =
  "itu-r-bs1770-5-annex2-4x-fir-estimate/v1" as const;

export const DECODED_TRUE_PEAK_OVERSAMPLE_FACTOR = 4 as const;

// ITU-R BS.1770-5 Annex 2's order-48, four-phase interpolation filter.
// The Recommendation specifies it for 48 kHz and permits similar or superior
// methods. Mazzy deliberately calls the result an estimate: decoded files can
// have other sample rates, and this is not a meter-conformance claim.
const PHASES = [
  [
    0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125,
    -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875,
    0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125
  ],
  [
    -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125,
    -0.16650390625, 0.465087890625, 0.77978515625, -0.2003173828125,
    0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375
  ],
  [
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625,
    -0.2003173828125, 0.77978515625, 0.465087890625, -0.16650390625,
    0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875
  ],
  [
    -0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875,
    -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875,
    0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375
  ]
] as const;

const TAP_COUNT = PHASES[0].length;

export const estimateDecodedTruePeakLinear = (
  channels: readonly Float32Array[]
) => {
  if (!channels.length || channels.some((channel) => !(channel instanceof Float32Array))) {
    throw new RangeError("decoded true-peak input must contain Float32 channels");
  }
  const frameCount = channels[0].length;
  if (channels.some((channel) => channel.length !== frameCount)) {
    throw new RangeError("decoded true-peak channels must have equal lengths");
  }

  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) {
        throw new RangeError("decoded true-peak input must contain finite samples");
      }
      peak = Math.max(peak, Math.abs(sample));
    }

    // Zero padding flushes both boundaries of the finite decoded programme.
    // Include the original sample peak above so interpolation can only make
    // the safety measurement more conservative.
    for (let outputFrame = 0; outputFrame < frameCount + TAP_COUNT - 1; outputFrame += 1) {
      let phase0 = 0;
      let phase1 = 0;
      let phase2 = 0;
      let phase3 = 0;
      const firstInput = Math.max(0, outputFrame - TAP_COUNT + 1);
      const lastInput = Math.min(outputFrame, frameCount - 1);
      for (let inputFrame = firstInput; inputFrame <= lastInput; inputFrame += 1) {
        const tap = outputFrame - inputFrame;
        const sample = channel[inputFrame];
        phase0 += PHASES[0][tap] * sample;
        phase1 += PHASES[1][tap] * sample;
        phase2 += PHASES[2][tap] * sample;
        phase3 += PHASES[3][tap] * sample;
      }
      peak = Math.max(
        peak,
        Math.abs(phase0),
        Math.abs(phase1),
        Math.abs(phase2),
        Math.abs(phase3)
      );
    }
  }
  return peak;
};
