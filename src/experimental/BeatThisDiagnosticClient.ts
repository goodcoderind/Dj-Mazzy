import type { BeatThisDiagnosticResult, BeatThisTrackDiagnosticResult } from "./beatThisContract";

type DiagnosticWorkerMessage =
  | { type: "progress"; requestId: number; stage: string }
  | { type: "result"; requestId: number; result: BeatThisDiagnosticResult }
  | { type: "track-result"; requestId: number; result: BeatThisTrackDiagnosticResult }
  | { type: "error"; requestId: number; error: string };

type PendingDiagnostic = {
  resolve: (result: BeatThisDiagnosticResult | BeatThisTrackDiagnosticResult) => void;
  reject: (error: Error) => void;
  onProgress?: (stage: string) => void;
};

type DiagnosticWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

export class BeatThisDiagnosticClient {
  private readonly pending = new Map<number, PendingDiagnostic>();
  private nextRequestId = 1;
  private disposed = false;

  constructor(
    private readonly worker: DiagnosticWorker = new Worker(
      new URL("../workers/beatThisDiagnostic.worker.ts", import.meta.url),
      { type: "module", name: "mazzy-beat-this-diagnostic" }
    )
  ) {
    worker.onmessage = (event: MessageEvent<DiagnosticWorkerMessage>) => {
      const message = event.data;
      const request = this.pending.get(message.requestId);
      if (!request) return;
      if (message.type === "progress") {
        request.onProgress?.(message.stage);
        return;
      }
      this.pending.delete(message.requestId);
      if (message.type === "result" || message.type === "track-result") request.resolve(message.result);
      else request.reject(new Error(message.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "Beat This diagnostic worker failed");
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
  }

  diagnose(options: { preferWebGpu?: boolean; onProgress?: (stage: string) => void } = {}) {
    if (this.disposed) return Promise.reject(new Error("Beat This diagnostic client disposed"));
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<BeatThisDiagnosticResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as PendingDiagnostic["resolve"], reject, onProgress: options.onProgress });
      this.worker.postMessage({ type: "diagnose", requestId, preferWebGpu: options.preferWebGpu });
    });
  }

  analyzePcm(
    pcm: Float32Array,
    sourceSampleRate: number,
    durationSeconds: number,
    options: { preferWebGpu?: boolean; onProgress?: (stage: string) => void } = {}
  ) {
    if (this.disposed) return Promise.reject(new Error("Beat This diagnostic client disposed"));
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<BeatThisTrackDiagnosticResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as PendingDiagnostic["resolve"], reject, onProgress: options.onProgress });
      this.worker.postMessage(
        {
          type: "analyze-track",
          requestId,
          preferWebGpu: options.preferWebGpu,
          pcmBuffer: pcm.buffer,
          sampleRate: 22_050,
          sourceSampleRate,
          durationSeconds
        },
        [pcm.buffer]
      );
    });
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    const error = new Error("Beat This diagnostic client disposed");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
