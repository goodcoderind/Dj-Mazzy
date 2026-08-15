/// <reference lib="webworker" />

import { analyzePcm } from "../analysis/analyzePcm";

type AnalysisWorkerRequest = {
  type: "analyze";
  requestId: number;
  pcmBuffers: ArrayBuffer[];
  sourceChannelCount: number;
  sampleRate: number;
  durationSeconds: number;
};

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;
  if (request.type !== "analyze") return;
  try {
    const channels = request.pcmBuffers.map((buffer) => new Float32Array(buffer));
    const rhythmPcm = channels[0];
    if (!rhythmPcm) throw new Error("analysis requires at least one channel");
    const result = analyzePcm(
      rhythmPcm,
      request.sampleRate,
      request.durationSeconds,
      channels,
      request.sourceChannelCount
    );
    workerScope.postMessage({ type: "result", requestId: request.requestId, result });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export {};
