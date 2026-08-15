import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BeatThisDiagnosticClient } from "./BeatThisDiagnosticClient";
import { BEAT_THIS_EXPERIMENT_VERSION } from "./beatThisContract";
import {
  ENHANCED_TIMING_MODEL_CONTROL_CACHE,
  revokeAndRemoveEnhancedTimingModelAssets
} from "../analysis/enhancedTimingModelStorage";

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

const testAuthority = Object.freeze({
  epoch: 0,
  token: "00000000-0000-0000-0000-000000000001"
});

beforeEach(() => {
  let control: unknown = null;
  vi.stubGlobal("caches", {
    has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE && control !== null),
    open: vi.fn(async () => ({
      match: async () => control ? new Response(JSON.stringify(control)) : undefined,
      put: async (_key: string, response: Response) => { control = await response.json(); },
      delete: async () => true,
      keys: async () => []
    })),
    delete: vi.fn(async () => true)
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
  vi.stubGlobal("crypto", { randomUUID: () => testAuthority.token });
});

afterEach(() => vi.unstubAllGlobals());

describe("Beat This diagnostic client", () => {
  it("forwards worker progress and keeps the result experimental-only", async () => {
    const worker = new FakeWorker();
    const client = new BeatThisDiagnosticClient(worker as unknown as Worker);
    const progress: string[] = [];
    const pending = client.diagnose({ storageAuthority: testAuthority, onProgress: (stage) => progress.push(stage) });
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
    const pending = client.diagnose({ storageAuthority: testAuthority });
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow("disposed");
    await expect(client.diagnose({ storageAuthority: testAuthority })).rejects.toThrow("disposed");
  });

  it("rejects a delivered worker result after another tab revoked its storage epoch", async () => {
    let control: unknown = null;
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE && control !== null),
      open: vi.fn(async () => ({
        match: async () => control ? new Response(JSON.stringify(control)) : undefined,
        put: async (_key: string, response: Response) => { control = await response.json(); },
        delete: async () => true,
        keys: async () => []
      })),
      delete: vi.fn(async () => true)
    });
    vi.stubGlobal("navigator", {
      locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() }
    });
    const worker = new FakeWorker();
    const client = new BeatThisDiagnosticClient(worker as unknown as Worker);
    const pending = client.diagnose({ storageAuthority: testAuthority });
    await expect(revokeAndRemoveEnhancedTimingModelAssets()).resolves.toBe(true);
    worker.onmessage?.({
      data: {
        type: "result",
        requestId: 1,
        result: {
          experimentVersion: BEAT_THIS_EXPERIMENT_VERSION,
          backend: "wasm",
          webGpuAvailable: false,
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
    await expect(pending).rejects.toThrow("disabled");
  });

  it("keeps result acceptance owned until the storage check finishes", async () => {
    const lock = { release: null as (() => void) | null };
    vi.stubGlobal("navigator", {
      locks: {
        request: <T,>(_name: string, _options: unknown, task: () => Promise<T>) =>
          new Promise<T>((resolve, reject) => {
            lock.release = () => { void task().then(resolve, reject); };
          })
      }
    });
    const worker = new FakeWorker();
    const client = new BeatThisDiagnosticClient(worker as unknown as Worker);
    const pending = client.diagnose({ storageAuthority: testAuthority });
    worker.onmessage?.({
      data: {
        type: "result",
        requestId: 1,
        result: {
          experimentVersion: BEAT_THIS_EXPERIMENT_VERSION,
          backend: "wasm",
          webGpuAvailable: false,
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
    expect(lock.release).not.toBeNull();
    client.dispose();
    await expect(pending).rejects.toThrow("disposed");
    lock.release?.();
    await Promise.resolve();
    await Promise.resolve();
  });
});
