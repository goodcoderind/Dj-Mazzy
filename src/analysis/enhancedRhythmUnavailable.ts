type EnhancedRhythmAssetState = "stored" | "stored-unavailable" | "downloadable" | "not-included" | "unavailable";
const timingCacheName = "mazzy-timing-model-v1";

export const getEnhancedRhythmAssetState = async (): Promise<EnhancedRhythmAssetState> => {
  try {
    if (!(await caches.has(timingCacheName))) return "not-included";
    const cache = await caches.open(timingCacheName);
    return (await cache.keys()).length > 0 ? "stored-unavailable" : "not-included";
  } catch {
    return "not-included";
  }
};

export const hasEnhancedRhythmAssets = async () => false;

export const prepareEnhancedRhythm = async () => {
  throw new Error("Enhanced timing is not included in this build.");
};

export const removeEnhancedRhythmModel = async () => caches.delete(timingCacheName);

export const disposeEnhancedRhythmClient = () => {};

export const analyzeEnhancedRhythm = async () => {
  throw new Error("Enhanced timing is not included in this build.");
};
