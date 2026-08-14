import { hasCurrentBasicAnalysis } from "./analysisVersion";
import { normalizeProgramLevel } from "./programLevel";

type LibraryAnalysisRecord = Record<string, unknown>;

export const applyQueuedAnalysisFailure = <T extends LibraryAnalysisRecord>(
  record: T,
  needsBasicAnalysis: boolean,
  needsProgramLevel: boolean
): T => {
  if (needsBasicAnalysis && !hasCurrentBasicAnalysis(record)) {
    return {
      ...record,
      analysisStatus: "failed",
      bpm: null,
      key: null,
      scale: null
    };
  }
  if (needsProgramLevel && !normalizeProgramLevel(record.programLevel)) {
    return {
      ...record,
      programLevel: null,
      programLevelStatus: "failed"
    };
  }
  return record;
};
