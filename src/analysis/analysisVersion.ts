import { BASIC_ANALYZER_VERSION, TRACK_ANALYSIS_SCHEMA_VERSION } from "../domain/versions";

export type BasicAnalysisRecord = {
  analyzerVersion?: string | null;
  schemaVersion?: string | null;
  analysisStatus?: string | null;
  duration?: number | null;
};

export const hasCurrentBasicAnalysis = (record: BasicAnalysisRecord) =>
  record.analyzerVersion === BASIC_ANALYZER_VERSION &&
  (record.schemaVersion == null || record.schemaVersion === TRACK_ANALYSIS_SCHEMA_VERSION) &&
  (record.analysisStatus == null || record.analysisStatus === "ready") &&
  record.duration != null && Number.isFinite(record.duration) && record.duration >= 0;
