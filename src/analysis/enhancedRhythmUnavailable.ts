import {
  enhancedTimingModelCacheHasEntries,
  enhancedTimingModelCacheHasEntriesForRemoval,
  enhancedTimingModelAssetsRevoked,
  revokeAndRemoveEnhancedTimingModelAssets
} from "./enhancedTimingModelStorage";

type EnhancedRhythmAssetState = "stored" | "stored-unavailable" | "removal-needed" | "downloadable" | "not-included" | "unavailable";
export const getEnhancedRhythmAssetState = async (): Promise<EnhancedRhythmAssetState> => {
  try {
    if (await enhancedTimingModelAssetsRevoked()) {
      return await enhancedTimingModelCacheHasEntriesForRemoval() ? "removal-needed" : "not-included";
    }
    return await enhancedTimingModelCacheHasEntries() ? "stored-unavailable" : "not-included";
  } catch {
    return "not-included";
  }
};

export const hasEnhancedRhythmAssets = async () => false;
export const enhancedRhythmAssetAdmissionIsCurrent = async () => false;

export const prepareEnhancedRhythm = async () => {
  throw new Error("Enhanced timing is not included in this build.");
};

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
