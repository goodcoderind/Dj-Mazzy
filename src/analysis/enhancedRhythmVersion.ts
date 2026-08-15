import {
  BEAT_THIS_EXPERIMENT_VERSION,
  BEAT_THIS_MODEL_SHA256
} from "../experimental/beatThisContract";
import { AUTOMATIC_RHYTHM_TRUST_SCHEMA_VERSION } from "../domain/versions";

export const ENHANCED_RHYTHM_DETECTOR = "beat-this/final0/onnx-v1" as const;

export type EnhancedRhythmRecord = {
  rhythmDetector?: unknown;
  rhythmAnalysisVersion?: unknown;
  rhythmModelSha256?: unknown;
  rhythmBackend?: unknown;
  automaticRhythmTrust?: { schemaVersion?: unknown } | null;
  beatsSeconds?: unknown;
  downbeatsSeconds?: unknown;
};

/** Fail closed when a restored grid is missing any part of its detector contract. */
export const hasCurrentEnhancedRhythm = (record: EnhancedRhythmRecord | null | undefined) =>
  record?.rhythmDetector === ENHANCED_RHYTHM_DETECTOR &&
  record.rhythmAnalysisVersion === BEAT_THIS_EXPERIMENT_VERSION &&
  record.rhythmModelSha256 === BEAT_THIS_MODEL_SHA256 &&
  (record.rhythmBackend === "webgpu" || record.rhythmBackend === "wasm") &&
  record.automaticRhythmTrust?.schemaVersion === AUTOMATIC_RHYTHM_TRUST_SCHEMA_VERSION &&
  Array.isArray((record.automaticRhythmTrust as Record<string, unknown>)?.usableCutBeatIndices) &&
  Array.isArray(record.beatsSeconds) &&
  Array.isArray(record.downbeatsSeconds);
