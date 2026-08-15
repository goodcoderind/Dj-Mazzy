import {
  enhancedTimingModelCacheHasEntries,
  enhancedTimingModelCacheHasEntriesForRemoval,
  enhancedTimingModelAssetsRevoked,
  revokeAndRemoveEnhancedTimingModelAssets
} from "./enhancedTimingModelStorage";

type EnhancedRhythmAssetState = "stored" | "stored-unavailable" | "partial" | "removal-needed" | "downloadable" | "not-included" | "unavailable" | "probe-error" | "coordination-unavailable";
export const getEnhancedRhythmAssetState = async (_signal?: AbortSignal): Promise<EnhancedRhythmAssetState> => {
  try {
    if (await enhancedTimingModelAssetsRevoked()) {
      return await enhancedTimingModelCacheHasEntriesForRemoval() ? "removal-needed" : "not-included";
    }
    return await enhancedTimingModelCacheHasEntries() ? "stored-unavailable" : "not-included";
  } catch {
    return "probe-error";
  }
};

export const hasEnhancedRhythmAssets = async () => false;
export const enhancedRhythmAssetAdmissionIsCurrent = async () => false;

export const prepareEnhancedRhythm = async (
  _onProgress?: (stage: string) => void,
  _onAuthority?: (authority: unknown) => void,
  _ownsAuthority?: () => boolean,
  _signal?: AbortSignal
) => {
  throw new Error("Enhanced timing is not included in this build.");
};

export const invalidateEnhancedRhythmPreparation = async (_authority: unknown) => false;

export const removeEnhancedRhythmModel = async () => {
  return revokeAndRemoveEnhancedTimingModelAssets();
};

export const disposeEnhancedRhythmClient = () => {};

export const canonicalizeForEnhancedRhythm = async () => {
  throw new Error("Enhanced timing is not included in this build.");
};

export const analyzeEnhancedRhythmPcm = async () => {
  throw new Error("Enhanced timing is not included in this build.");
};

export const createEnhancedRhythmAnalysisSession = () => ({
  analyzePcm: async () => { throw new Error("Enhanced timing is not included in this build."); },
  dispose: () => undefined
});

export const analyzeEnhancedRhythm = async () => {
  throw new Error("Enhanced timing is not included in this build.");
};
