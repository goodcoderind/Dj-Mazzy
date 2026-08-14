export const programLevelFailurePolicy = (hadCurrentBasicAnalysis: boolean) => ({
  preserveBasicAnalysis: hadCurrentBasicAnalysis,
  trimDb: 0,
  levelStatus: "failed" as const
});
