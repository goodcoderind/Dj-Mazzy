import { BeatThisDiagnosticClient } from "../experimental/BeatThisDiagnosticClient";
import { ResettableSerialQueue } from "./resettableSerialQueue";
import {
  allowEnhancedTimingModelAssetsAfterHostAction,
  currentEnhancedTimingModelAllowedAuthority,
  enhancedTimingModelCacheHasEntries,
  enhancedTimingModelCacheHasEntriesForRemoval,
  enhancedTimingModelAssetsRevoked,
  enhancedTimingModelPreparationIsVerified,
  enhancedTimingModelStorageSupportsExclusiveLock,
  invalidateEnhancedTimingModelPreparationProof,
  markEnhancedTimingModelPreparationVerified,
  matchEnhancedTimingModelAsset,
  runIfEnhancedTimingModelAllowed,
  type EnhancedTimingModelAuthority,
  revokeAndRemoveEnhancedTimingModelAssets
} from "./enhancedTimingModelStorage";

const ANALYSIS_SAMPLE_RATE = 22_050;
let sharedClient: BeatThisDiagnosticClient | null = null;
let clientGeneration = 0;
const analysisQueue = new ResettableSerialQueue();
let inferenceTail: Promise<void> = Promise.resolve();
let activeStorageAuthority: EnhancedTimingModelAuthority | null = null;

const scheduleEnhancedInference = <T>(task: () => Promise<T>) => {
  const run = inferenceTail.catch(() => undefined).then(task);
  inferenceTail = run.then(() => undefined, () => undefined);
  return run;
};

export type EnhancedRhythmAssetState = "stored" | "stored-unavailable" | "partial" | "removal-needed" | "downloadable" | "not-included" | "unavailable" | "probe-error" | "coordination-unavailable";

export const projectRevokedEmptyEnhancedRhythmAssetState = ({
  included,
  online
}: {
  included: boolean;
  online: boolean;
}): EnhancedRhythmAssetState => !included
  ? "not-included"
  : online
    ? "downloadable"
    : "unavailable";

export const projectEnhancedTimingStorageCoordinationState = ({
  included,
  exclusiveLockAvailable
}: {
  included: boolean;
  exclusiveLockAvailable: boolean;
}): "coordination-unavailable" | null => included && !exclusiveLockAvailable
  ? "coordination-unavailable"
  : null;

const packBaseUrl = `${import.meta.env.BASE_URL}models/beat-this-final0/v1/`;
const packManifestUrl = `${packBaseUrl}config.json`;
const requiredPackUrls = [
  `${packBaseUrl}config.json`,
  `${packBaseUrl}beat_this.onnx`,
  `${packBaseUrl}mel-filterbank.bin`
];

const hasStoredPack = async (storageAuthority: EnhancedTimingModelAuthority) => {
  return (await Promise.all(
    requiredPackUrls.map((url) => matchEnhancedTimingModelAsset(url, storageAuthority))
  )).every(Boolean);
};

const originTimingRuntimeReachable = async (signal?: AbortSignal) => {
  if (!navigator.onLine) return false;
  try {
    const response = await fetch(packManifestUrl, { method: "HEAD", cache: "no-store", signal });
    return response.ok && response.headers.get("content-type")?.includes("application/json") === true;
  } catch {
    return false;
  }
};

export const getEnhancedRhythmAssetState = async (signal?: AbortSignal): Promise<EnhancedRhythmAssetState> => {
  try {
    if (signal?.aborted) throw new Error("enhanced timing probe cancelled");
    if (await enhancedTimingModelAssetsRevoked()) {
      if (await enhancedTimingModelCacheHasEntriesForRemoval()) return "removal-needed";
      const coordinationState = projectEnhancedTimingStorageCoordinationState({
        included: __MAZZY_ENHANCED_TIMING_INCLUDED__,
        exclusiveLockAvailable: enhancedTimingModelStorageSupportsExclusiveLock()
      });
      if (coordinationState) return coordinationState;
      return projectRevokedEmptyEnhancedRhythmAssetState({
        included: __MAZZY_ENHANCED_TIMING_INCLUDED__,
        online: navigator.onLine
      });
    }
    const coordinationState = projectEnhancedTimingStorageCoordinationState({
      included: __MAZZY_ENHANCED_TIMING_INCLUDED__,
      exclusiveLockAvailable: enhancedTimingModelStorageSupportsExclusiveLock()
    });
    if (coordinationState) return coordinationState;
    const storageAuthority = await currentEnhancedTimingModelAllowedAuthority();
    const finish = <T extends EnhancedRhythmAssetState>(state: T) =>
      runIfEnhancedTimingModelAllowed(storageAuthority, async () => state);
    const stored = await hasStoredPack(storageAuthority) &&
      await enhancedTimingModelPreparationIsVerified(storageAuthority);
    if (stored && !(await originTimingRuntimeReachable(signal))) return finish("stored-unavailable");
    if (stored) {
      const result = await finish("stored");
      activeStorageAuthority = storageAuthority;
      return result;
    }
    if (await enhancedTimingModelCacheHasEntries(storageAuthority)) return finish("partial");
    if (!__MAZZY_ENHANCED_TIMING_INCLUDED__) return finish("not-included");
    if (!navigator.onLine) return finish("unavailable");
    const manifest = await fetch(packManifestUrl, { cache: "no-store", signal });
    return finish(manifest.ok && manifest.headers.get("content-type")?.includes("application/json")
      ? "downloadable"
      : "not-included");
  } catch {
    if (signal?.aborted) throw new Error("enhanced timing probe cancelled");
    return "probe-error";
  }
};

export const hasEnhancedRhythmAssets = async () =>
  (await getEnhancedRhythmAssetState()) === "stored";

export const enhancedRhythmAssetAdmissionIsCurrent = async () => {
  if (!activeStorageAuthority) return false;
  try {
    return await runIfEnhancedTimingModelAllowed(activeStorageAuthority, async () => true);
  } catch {
    return false;
  }
};

export const prepareEnhancedRhythm = async (
  onProgress?: (stage: string) => void,
  onAuthority?: (authority: EnhancedTimingModelAuthority) => void,
  ownsAuthority: () => boolean = () => true,
  signal?: AbortSignal
) => {
  if (!ownsAuthority()) throw new Error("enhanced timing preparation cancelled");
  if (!enhancedTimingModelStorageSupportsExclusiveLock()) {
    throw new Error("enhanced timing model storage coordination is unavailable");
  }
  let storageAuthority: EnhancedTimingModelAuthority | null = null;
  try {
    storageAuthority = await allowEnhancedTimingModelAssetsAfterHostAction(
      onAuthority,
      ownsAuthority,
      signal
    );
    if (!ownsAuthority()) throw new Error("enhanced timing preparation cancelled");
    const generation = clientGeneration;
    const result = await scheduleEnhancedInference(() => {
      if (generation !== clientGeneration || !ownsAuthority()) throw new Error("enhanced analysis cancelled");
      if (!sharedClient) sharedClient = new BeatThisDiagnosticClient();
      return sharedClient.diagnose({ onProgress, storageAuthority: storageAuthority! });
    });
    if (generation !== clientGeneration || !ownsAuthority()) throw new Error("enhanced analysis cancelled");
    if (!(await hasStoredPack(storageAuthority))) throw new Error("Enhanced timing assets were not stored in the timing cache.");
    if (!ownsAuthority()) throw new Error("enhanced timing preparation cancelled");
    await runIfEnhancedTimingModelAllowed(storageAuthority, async () => undefined);
    if (!ownsAuthority()) throw new Error("enhanced timing preparation cancelled");
    await markEnhancedTimingModelPreparationVerified(storageAuthority, ownsAuthority);
    if (!ownsAuthority()) throw new Error("enhanced timing preparation cancelled");
    activeStorageAuthority = storageAuthority;
    return Object.freeze({ result, storageAuthority });
  } catch (error) {
    if (storageAuthority) {
      try { await invalidateEnhancedTimingModelPreparationProof(storageAuthority); } catch { /* A successor authority remains untouched. */ }
    }
    throw error;
  }
};

export const invalidateEnhancedRhythmPreparation = (
  authority: EnhancedTimingModelAuthority
) => invalidateEnhancedTimingModelPreparationProof(authority);

export const removeEnhancedRhythmModel = async () => {
  clientGeneration += 1;
  analysisQueue.reset("enhanced analysis cancelled");
  sharedClient?.dispose();
  sharedClient = null;
  return revokeAndRemoveEnhancedTimingModelAssets();
};

export const disposeEnhancedRhythmClient = () => {
  clientGeneration += 1;
  analysisQueue.reset("enhanced analysis cancelled");
  sharedClient?.dispose();
  sharedClient = null;
};

export const canonicalizeForEnhancedRhythm = async (decoded: AudioBuffer) => {
  const outputFrames = Math.max(1, Math.round(decoded.duration * ANALYSIS_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, outputFrames, ANALYSIS_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  const splitter = offline.createChannelSplitter(decoded.numberOfChannels);
  source.connect(splitter);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const gain = offline.createGain();
    gain.gain.value = 1 / decoded.numberOfChannels;
    splitter.connect(gain, channel);
    gain.connect(offline.destination);
  }
  source.start(0);
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
};

export const analyzeEnhancedRhythm = async (
  decoded: AudioBuffer,
  onProgress?: (stage: string) => void,
  dedupeKey?: string | null
) => {
  const generation = clientGeneration;
  const storageAuthority = activeStorageAuthority;
  if (!storageAuthority) throw new Error("enhanced timing model admission unavailable");
  return analysisQueue.enqueue(async () => {
    if (generation !== clientGeneration) throw new Error("enhanced analysis cancelled");
    const pcm = await canonicalizeForEnhancedRhythm(decoded);
    if (generation !== clientGeneration) throw new Error("enhanced analysis cancelled");
    return scheduleEnhancedInference(() => {
      if (generation !== clientGeneration) throw new Error("enhanced analysis cancelled");
      if (!sharedClient) sharedClient = new BeatThisDiagnosticClient();
      return sharedClient.analyzePcm(
        pcm,
        decoded.sampleRate,
        decoded.duration,
        { onProgress, storageAuthority }
      );
    });
  }, dedupeKey);
};

export const analyzeEnhancedRhythmPcm = async (
  pcm: Float32Array,
  sourceSampleRate: number,
  durationSeconds: number,
  onProgress?: (stage: string) => void,
  dedupeKey?: string | null
) => {
  const generation = clientGeneration;
  const storageAuthority = activeStorageAuthority;
  if (!storageAuthority) throw new Error("enhanced timing model admission unavailable");
  return analysisQueue.enqueue(async () => {
    if (generation !== clientGeneration) throw new Error("enhanced analysis cancelled");
    return scheduleEnhancedInference(() => {
      if (generation !== clientGeneration) throw new Error("enhanced analysis cancelled");
      if (!sharedClient) sharedClient = new BeatThisDiagnosticClient();
      return sharedClient.analyzePcm(
        pcm,
        sourceSampleRate,
        durationSeconds,
        { onProgress, storageAuthority }
      );
    });
  }, dedupeKey);
};

export const createEnhancedRhythmAnalysisSession = () => {
  const queue = new ResettableSerialQueue();
  let client: BeatThisDiagnosticClient | null = null;
  let disposed = false;
  const storageAuthority = activeStorageAuthority;
  return {
    analyzePcm: (
      pcm: Float32Array,
      sourceSampleRate: number,
      durationSeconds: number,
      onProgress?: (stage: string) => void,
      dedupeKey?: string | null
    ) => queue.enqueue(async () => {
      if (disposed) throw new Error("enhanced analysis session disposed");
      if (!storageAuthority) throw new Error("enhanced timing model admission unavailable");
      return scheduleEnhancedInference(async () => {
        if (disposed) throw new Error("enhanced analysis session disposed");
        if (!client) {
          // Inference is globally serialized, so an idle manual client can be
          // released before the background owner loads the same model.
          sharedClient?.dispose();
          sharedClient = null;
          client = new BeatThisDiagnosticClient();
        }
        return client.analyzePcm(pcm, sourceSampleRate, durationSeconds, {
          onProgress,
          storageAuthority
        });
      });
    }, dedupeKey),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      queue.reset("enhanced analysis session disposed");
      client?.dispose();
      client = null;
    }
  };
};
