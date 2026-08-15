export const MASTER_DSP_V1 = Object.freeze({
  version: "mazzy-master/v1" as const,
  headroomDb: -6,
  limiter: Object.freeze({
    thresholdDb: -1,
    kneeDb: 0,
    ratio: 20,
    attackSeconds: 0.003,
    releaseSeconds: 0.1
  })
});

export const configureMasterDspNodes = (
  masterGain: GainNode,
  limiter: DynamicsCompressorNode
) => {
  masterGain.gain.value = 10 ** (MASTER_DSP_V1.headroomDb / 20);
  limiter.threshold.value = MASTER_DSP_V1.limiter.thresholdDb;
  limiter.knee.value = MASTER_DSP_V1.limiter.kneeDb;
  limiter.ratio.value = MASTER_DSP_V1.limiter.ratio;
  limiter.attack.value = MASTER_DSP_V1.limiter.attackSeconds;
  limiter.release.value = MASTER_DSP_V1.limiter.releaseSeconds;
};
