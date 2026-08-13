import { BeatThisDiagnosticClient } from "../experimental/BeatThisDiagnosticClient";

const ANALYSIS_SAMPLE_RATE = 22_050;
let sharedClient: BeatThisDiagnosticClient | null = null;
let analysisQueue: Promise<void> = Promise.resolve();
let clientGeneration = 0;
const pendingByKey = new Map<string, Promise<Awaited<ReturnType<BeatThisDiagnosticClient["analyzePcm"]>>>>();

export type EnhancedRhythmAssetState = "stored" | "downloadable" | "not-included" | "unavailable";

const packManifestUrl = "/models/beat-this-final0/v1/config.json";

export const getEnhancedRhythmAssetState = async (): Promise<EnhancedRhythmAssetState> => {
  try {
    const required = [
      "/models/beat-this-final0/v1/config.json",
      "/models/beat-this-final0/v1/beat_this.onnx",
      "/models/beat-this-final0/v1/mel-filterbank.bin"
    ];
    const cached = await Promise.all(required.map((url) => caches.match(url)));
    if (cached.every(Boolean)) return "stored";
    if (!__MAZZY_ENHANCED_TIMING_INCLUDED__) return "not-included";
    if (!navigator.onLine) return "unavailable";
    const manifest = await fetch(packManifestUrl, { cache: "no-store" });
    return manifest.ok && manifest.headers.get("content-type")?.includes("application/json")
      ? "downloadable"
      : "not-included";
  } catch {
    return "unavailable";
  }
};

export const hasEnhancedRhythmAssets = async () =>
  (await getEnhancedRhythmAssetState()) === "stored";

export const prepareEnhancedRhythm = async (onProgress?: (stage: string) => void) => {
  if (!sharedClient) sharedClient = new BeatThisDiagnosticClient();
  return sharedClient.diagnose({ onProgress });
};

export const removeEnhancedRhythmModel = async () => {
  clientGeneration += 1;
  sharedClient?.dispose();
  sharedClient = null;
  pendingByKey.clear();
  return caches.delete("mazzy-timing-model-v1");
};

export const disposeEnhancedRhythmClient = () => {
  clientGeneration += 1;
  sharedClient?.dispose();
  sharedClient = null;
  pendingByKey.clear();
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
  const key = dedupeKey || null;
  if (key && pendingByKey.has(key)) return pendingByKey.get(key)!;
  const generation = clientGeneration;
  const run = new Promise<Awaited<ReturnType<BeatThisDiagnosticClient["analyzePcm"]>>>((resolve, reject) => {
    analysisQueue = analysisQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          if (generation !== clientGeneration) throw new Error("enhanced analysis cancelled");
          if (!sharedClient) sharedClient = new BeatThisDiagnosticClient();
          const pcm = await canonicalizeForEnhancedRhythm(decoded);
          if (generation !== clientGeneration) throw new Error("enhanced analysis cancelled");
          resolve(await sharedClient.analyzePcm(pcm, decoded.sampleRate, decoded.duration, { onProgress }));
        } catch (error) {
          reject(error);
        }
      });
  });
  if (key) {
    pendingByKey.set(key, run);
    void run.finally(() => pendingByKey.delete(key)).catch(() => undefined);
  }
  return run;
};
