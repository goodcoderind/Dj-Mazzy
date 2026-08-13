/// <reference lib="webworker" />

import { analyzePcm } from "../analysis/analyzePcm";

type AnalysisWorkerRequest = {
  type: "analyze";
  requestId: number;
  pcmBuffer: ArrayBuffer;
  sampleRate: number;
  durationSeconds: number;
};

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;
  if (request.type !== "analyze") return;
  try {
    const result = analyzePcm(
      new Float32Array(request.pcmBuffer),
      request.sampleRate,
      request.durationSeconds
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
