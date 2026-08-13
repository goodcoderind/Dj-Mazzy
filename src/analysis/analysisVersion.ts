import { BASIC_ANALYZER_VERSION } from "../domain/versions";

export type BasicAnalysisRecord = {
  analyzerVersion?: string | null;
  duration?: number | null;
};

export const hasCurrentBasicAnalysis = (record: BasicAnalysisRecord) =>
  record.analyzerVersion === BASIC_ANALYZER_VERSION &&
  record.duration != null;
