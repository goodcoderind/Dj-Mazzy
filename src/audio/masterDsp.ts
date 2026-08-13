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
