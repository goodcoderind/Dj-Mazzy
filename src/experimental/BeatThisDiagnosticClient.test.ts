import { describe, expect, it } from "vitest";
import { BeatThisDiagnosticClient } from "./BeatThisDiagnosticClient";
import { BEAT_THIS_EXPERIMENT_VERSION } from "./beatThisContract";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: unknown[] = [];
  terminated = false;
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
}

describe("Beat This diagnostic client", () => {
  it("forwards worker progress and keeps the result experimental-only", async () => {
    const worker = new FakeWorker();
    const client = new BeatThisDiagnosticClient(worker as unknown as Worker);
    const progress: string[] = [];
    const pending = client.diagnose({ onProgress: (stage) => progress.push(stage) });
    worker.onmessage?.({ data: { type: "progress", requestId: 1, stage: "loading-83mb-model" } } as MessageEvent);
    worker.onmessage?.({
      data: {
        type: "result",
        requestId: 1,
        result: {
          experimentVersion: BEAT_THIS_EXPERIMENT_VERSION,
          backend: "webgpu",
          webGpuAvailable: true,
          modelBytes: 83_143_431,
          sessionLoadMs: 10,
          zeroWindowInferenceMs: 20,
          beatOutputShape: [1, 1_500],
          downbeatOutputShape: [1, 1_500],
          finiteOutput: true,
          experimentalOnly: true,
          eligibilityConfidence: 0
        }
      }
    } as MessageEvent);
    await expect(pending).resolves.toMatchObject({ experimentalOnly: true, eligibilityConfidence: 0 });
    expect(progress).toEqual(["loading-83mb-model"]);
  });

  it("rejects pending diagnostics when disposed", async () => {
    const worker = new FakeWorker();
    const client = new BeatThisDiagnosticClient(worker as unknown as Worker);
    const pending = client.diagnose();
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow("disposed");
    await expect(client.diagnose()).rejects.toThrow("disposed");
  });
});
