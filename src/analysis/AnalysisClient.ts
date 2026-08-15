import type { BasicAnalysisResult } from "./analyzePcm";

type WorkerResultMessage =
  | { type: "result"; requestId: number; result: BasicAnalysisResult }
  | { type: "error"; requestId: number; error: string };

type PendingRequest = {
  resolve: (result: BasicAnalysisResult) => void;
  reject: (error: Error) => void;
};

type AnalysisWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

export class AnalysisClient {
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor(
    private readonly worker: AnalysisWorker = new Worker(
      new URL("../workers/analysis.worker.ts", import.meta.url),
      { type: "module", name: "mazzy-analysis" }
    )
  ) {
    worker.onmessage = (event: MessageEvent<WorkerResultMessage>) => {
      const message = event.data;
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      if (message.type === "result") request.resolve(message.result);
      else request.reject(new Error(message.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "analysis worker failed");
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
  }

  analyzeAudioBuffer(audioBuffer: AudioBuffer) {
    const channels = Array.from(
      { length: Math.min(audioBuffer.numberOfChannels, 2) },
      (_, channel) => new Float32Array(audioBuffer.getChannelData(channel))
    );
    return this.analyzeChannels(
      channels,
      audioBuffer.sampleRate,
      audioBuffer.duration,
      audioBuffer.numberOfChannels
    );
  }

  analyzePcm(pcm: Float32Array, sampleRate: number, durationSeconds: number) {
    return this.analyzeChannels([pcm], sampleRate, durationSeconds, 1);
  }

  private analyzeChannels(
    channels: Float32Array[],
    sampleRate: number,
    durationSeconds: number,
    sourceChannelCount: number
  ) {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<BasicAnalysisResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const pcmBuffers = channels.map((channel) => channel.buffer);
      this.worker.postMessage(
        {
          type: "analyze",
          requestId,
          pcmBuffers,
          sourceChannelCount,
          sampleRate,
          durationSeconds
        },
        pcmBuffers
      );
    });
  }

  dispose() {
    this.worker.terminate();
    const error = new Error("analysis client disposed");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

let sharedAnalysisClient: AnalysisClient | null = null;

export const getAnalysisClient = () => {
  if (!sharedAnalysisClient) sharedAnalysisClient = new AnalysisClient();
  return sharedAnalysisClient;
};

export const disposeAnalysisClient = () => {
  sharedAnalysisClient?.dispose();
  sharedAnalysisClient = null;
};
