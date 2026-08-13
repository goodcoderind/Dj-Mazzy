/// <reference lib="webworker" />

import * as ort from "onnxruntime-web/webgpu";
import {
  BEAT_THIS_CONFIG_URL,
  BEAT_THIS_CONFIG_SHA256,
  BEAT_THIS_EXPERIMENT_VERSION,
  BEAT_THIS_MEL_FILTERBANK_BYTES,
  BEAT_THIS_MEL_FILTERBANK_SHA256,
  BEAT_THIS_MEL_FILTERBANK_URL,
  BEAT_THIS_MODEL_BYTES,
  BEAT_THIS_MODEL_SHA256,
  BEAT_THIS_MODEL_URL,
  BEAT_THIS_ZERO_WINDOW_FLOATS,
  type BeatThisBackend,
  validateBeatThisConfig,
  validateBeatThisOutputs
} from "../experimental/beatThisContract";
import { BEAT_THIS_SAMPLE_RATE, computeBeatThisLogMel } from "../experimental/beatThisPreprocessing";
import {
  aggregateBeatThisLogits,
  postprocessBeatThisLogits,
  splitBeatThisSpectrogram
} from "../experimental/beatThisPostprocessing";
import { analyzeBeatSynchronousFeatures } from "../analysis/analyzeMusicalFeatures";

type StartupRequest = { type: "diagnose"; requestId: number; preferWebGpu?: boolean };
type TrackRequest = {
  type: "analyze-track";
  requestId: number;
  preferWebGpu?: boolean;
  pcmBuffer: ArrayBuffer;
  sampleRate: number;
  sourceSampleRate: number;
  durationSeconds: number;
};
type DiagnosticRequest = StartupRequest | TrackRequest;

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let active = false;
let cachedContract: Awaited<ReturnType<typeof fetchContract>> | null = null;
let cachedSession: Awaited<ReturnType<typeof createSession>> | null = null;
let sessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
const SESSION_IDLE_MS = 60_000;
const MODEL_CACHE = "mazzy-timing-model-v1";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  wasm: new URL(
    "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm",
    import.meta.url
  ).href
};

const postProgress = (requestId: number, stage: string) => {
  workerScope.postMessage({ type: "progress", requestId, stage });
};

const fetchCached = async (url: string) => {
  const cache = await caches.open(MODEL_CACHE);
  const cached = await cache.match(url);
  if (cached) return cached;
  const response = await fetch(url, { cache: "no-store" });
  if (response.ok) await cache.put(url, response.clone());
  return response;
};

const sha256 = async (buffer: ArrayBuffer) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))
).map((byte) => byte.toString(16).padStart(2, "0")).join("");

const loadVerifiedAsset = async (url: string, expectedSha256: string) => {
  let response = await fetchCached(url);
  if (!response.ok) return response;
  let buffer = await response.clone().arrayBuffer();
  if (await sha256(buffer) === expectedSha256) return response;
  const cache = await caches.open(MODEL_CACHE);
  await cache.delete(url);
  response = await fetch(url, { cache: "reload" });
  if (!response.ok) return response;
  buffer = await response.clone().arrayBuffer();
  if (await sha256(buffer) !== expectedSha256) throw new Error("Beat This asset checksum mismatch.");
  await cache.put(url, response.clone());
  return response;
};

const fetchContract = async () => {
  const [configResponse, filterbankResponse] = await Promise.all([
    loadVerifiedAsset(BEAT_THIS_CONFIG_URL, BEAT_THIS_CONFIG_SHA256),
    loadVerifiedAsset(BEAT_THIS_MEL_FILTERBANK_URL, BEAT_THIS_MEL_FILTERBANK_SHA256)
  ]);
  if (!configResponse.ok) throw new Error(`Beat This config unavailable (${configResponse.status}).`);
  if (!filterbankResponse.ok) {
    throw new Error(`Beat This mel filterbank unavailable (${filterbankResponse.status}).`);
  }
  const config: unknown = await configResponse.json();
  if (!validateBeatThisConfig(config)) {
    throw new Error("Beat This configuration does not match the pinned preprocessing contract.");
  }
  const filterbankBuffer = await filterbankResponse.arrayBuffer();
  if (filterbankBuffer.byteLength !== BEAT_THIS_MEL_FILTERBANK_BYTES) {
    throw new Error("Beat This mel filterbank byte length does not match the pinned artifact.");
  }
  return { config, filterbank: new Float32Array(filterbankBuffer) };
};

const loadVerifiedModel = async () => {
  const response = await loadVerifiedAsset(BEAT_THIS_MODEL_URL, BEAT_THIS_MODEL_SHA256);
  if (!response.ok) throw new Error(`Beat This model unavailable (${response.status}).`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== BEAT_THIS_MODEL_BYTES) throw new Error("Beat This model byte length mismatch.");
  const digest = await sha256(buffer);
  if (digest !== BEAT_THIS_MODEL_SHA256) throw new Error("Beat This model checksum mismatch.");
  return new Uint8Array(buffer);
};

const loadContract = async () => {
  if (!cachedContract) cachedContract = await fetchContract();
  return cachedContract;
};

const createSession = async (preferWebGpu: boolean | undefined, webGpuAvailable: boolean) => {
  const candidates: BeatThisBackend[] = preferWebGpu !== false && webGpuAvailable
    ? ["webgpu", "wasm"]
    : ["wasm"];
  const backendFailures: string[] = [];
  const model = await loadVerifiedModel();
  for (const backend of candidates) {
    try {
      const startedAt = performance.now();
      const session = await ort.InferenceSession.create(model, {
        executionProviders: [backend],
        graphOptimizationLevel: "all"
      });
      if (session.inputNames.length !== 1 || session.inputNames[0] !== "spect") {
        await session.release();
        throw new Error(`unexpected input names: ${session.inputNames.join(", ")}`);
      }
      if (!session.outputNames.includes("beat") || !session.outputNames.includes("downbeat")) {
        await session.release();
        throw new Error(`unexpected output names: ${session.outputNames.join(", ")}`);
      }
      return { backend, backendFailures, session, sessionLoadMs: performance.now() - startedAt };
    } catch (error) {
      backendFailures.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No Beat This backend could initialize. ${backendFailures.join(" | ")}`);
};

const releaseCachedSession = async () => {
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  sessionIdleTimer = null;
  const current = cachedSession;
  cachedSession = null;
  if (current) await current.session.release();
};

const getSession = async (preferWebGpu: boolean | undefined, webGpuAvailable: boolean) => {
  if (!cachedSession) cachedSession = await createSession(preferWebGpu, webGpuAvailable);
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  return cachedSession;
};

const scheduleSessionRelease = () => {
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  sessionIdleTimer = setTimeout(() => { void releaseCachedSession(); }, SESSION_IDLE_MS);
};

const runWindow = async (session: ort.InferenceSession, data: Float32Array, frames: number) => {
  const input = new ort.Tensor("float32", data, [1, frames, 128]);
  const outputs = await session.run({ spect: input });
  const beat = outputs.beat;
  const downbeat = outputs.downbeat;
  if (!beat || !downbeat) throw new Error("Beat This outputs are missing.");
  if (!validateBeatThisOutputs(beat.dims, downbeat.dims, beat.data as ArrayLike<number>, downbeat.data as ArrayLike<number>, frames)) {
    throw new Error("Beat This returned malformed or non-finite outputs.");
  }
  return {
    beat: new Float32Array(beat.data as Float32Array),
    downbeat: new Float32Array(downbeat.data as Float32Array)
  };
};

const diagnoseStartup = async (request: StartupRequest) => {
  postProgress(request.requestId, "checking-capabilities");
  const webGpuAvailable = "gpu" in navigator;
  await loadContract();
  postProgress(request.requestId, "loading-83mb-model");
  const created = await getSession(request.preferWebGpu, webGpuAvailable);
    postProgress(request.requestId, "running-zero-window");
    const inferenceStartedAt = performance.now();
    const outputs = await runWindow(created.session, new Float32Array(BEAT_THIS_ZERO_WINDOW_FLOATS), 1_500);
    const zeroWindowInferenceMs = performance.now() - inferenceStartedAt;
    workerScope.postMessage({
      type: "result",
      requestId: request.requestId,
      result: {
        experimentVersion: BEAT_THIS_EXPERIMENT_VERSION,
        backend: created.backend,
        webGpuAvailable,
        modelBytes: BEAT_THIS_MODEL_BYTES,
        sessionLoadMs: created.sessionLoadMs,
        zeroWindowInferenceMs,
        beatOutputShape: [1, outputs.beat.length],
        downbeatOutputShape: [1, outputs.downbeat.length],
        finiteOutput: true,
        backendFailures: created.backendFailures,
        experimentalOnly: true,
        eligibilityConfidence: 0
      }
    });
};

const analyzeTrack = async (request: TrackRequest) => {
  if (request.sampleRate !== BEAT_THIS_SAMPLE_RATE) {
    throw new Error(
      `Track diagnostic requires browser-decoded mono PCM at ${BEAT_THIS_SAMPLE_RATE} Hz; received ${request.sampleRate} Hz.`
    );
  }
  postProgress(request.requestId, "loading-contract");
  const webGpuAvailable = "gpu" in navigator;
  const { filterbank } = await loadContract();
  postProgress(request.requestId, "computing-log-mel");
  const preprocessingStartedAt = performance.now();
  const pcm = new Float32Array(request.pcmBuffer);
  const spectrogram = computeBeatThisLogMel(pcm, filterbank);
  const chunks = splitBeatThisSpectrogram(spectrogram.data, spectrogram.frames, spectrogram.melBins);
  const preprocessingMs = performance.now() - preprocessingStartedAt;
  postProgress(request.requestId, "loading-83mb-model");
  const created = await getSession(request.preferWebGpu, webGpuAvailable);
    const predictions: Array<{ startFrame: number; beat: Float32Array; downbeat: Float32Array }> = [];
    const inferenceStartedAt = performance.now();
    for (let index = 0; index < chunks.length; index += 1) {
      postProgress(request.requestId, `inferring-window-${index + 1}-of-${chunks.length}`);
      const chunk = chunks[index];
      predictions.push({ startFrame: chunk.startFrame, ...(await runWindow(created.session, chunk.data, chunk.frames)) });
    }
    const inferenceMs = performance.now() - inferenceStartedAt;
    const logits = aggregateBeatThisLogits(predictions, spectrogram.frames);
    const events = postprocessBeatThisLogits(logits.beat, logits.downbeat);
    const features = analyzeBeatSynchronousFeatures(pcm, BEAT_THIS_SAMPLE_RATE, events.beatsSeconds);
    workerScope.postMessage({
      type: "track-result",
      requestId: request.requestId,
      result: {
        experimentVersion: BEAT_THIS_EXPERIMENT_VERSION,
        backend: created.backend,
        webGpuAvailable,
        sourceSampleRate: request.sourceSampleRate,
        analysisSampleRate: BEAT_THIS_SAMPLE_RATE,
        durationSeconds: request.durationSeconds,
        featureFrames: spectrogram.frames,
        chunks: chunks.length,
        preprocessingMs,
        sessionLoadMs: created.sessionLoadMs,
        inferenceMs,
        beatsSeconds: events.beatsSeconds,
        downbeatsSeconds: events.downbeatsSeconds,
        ...features,
        backendFailures: created.backendFailures,
        experimentalOnly: true,
        eligibilityConfidence: 0
      }
    });
};

workerScope.onmessage = async (event: MessageEvent<DiagnosticRequest>) => {
  const request = event.data;
  if (request.type !== "diagnose" && request.type !== "analyze-track") return;
  if (active) {
    workerScope.postMessage({ type: "error", requestId: request.requestId, error: "Beat This worker is already processing a diagnostic." });
    return;
  }
  active = true;
  try {
    if (request.type === "diagnose") await diagnoseStartup(request);
    else await analyzeTrack(request);
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    active = false;
    scheduleSessionRelease();
  }
};

export {};
