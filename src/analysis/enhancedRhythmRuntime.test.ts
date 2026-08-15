import { afterEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({
  analyzePcm: vi.fn(),
  dispose: vi.fn(),
  construct: vi.fn()
}));

vi.mock("../experimental/BeatThisDiagnosticClient", () => ({
  BeatThisDiagnosticClient: class {
    constructor() { worker.construct(); }
    analyzePcm = worker.analyzePcm;
    dispose = worker.dispose;
    diagnose = vi.fn();
  }
}));

import {
  analyzeEnhancedRhythmPcm,
  createEnhancedRhythmAnalysisSession,
  disposeEnhancedRhythmClient,
  getEnhancedRhythmAssetState
} from "./enhancedRhythmRuntime";

afterEach(() => {
  disposeEnhancedRhythmClient();
  worker.analyzePcm.mockReset();
  worker.dispose.mockReset();
  worker.construct.mockReset();
  vi.unstubAllGlobals();
});

const stubStoredPack = () => {
  vi.stubGlobal("caches", {
    open: vi.fn(async () => ({ match: async () => new Response("cached") }))
  });
  vi.stubGlobal("navigator", { onLine: true });
};

describe("enhanced timing origin availability", () => {
  it("does not enable a cached pack when the same-origin runtime is unreachable", async () => {
    stubStoredPack();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("origin unavailable"); }));
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("stored-unavailable");
  });

  it("enables a cached pack only after its same-origin manifest responds", async () => {
    stubStoredPack();
    const fetch = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("stored");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("models/beat-this-final0/v1/config.json"),
      { method: "HEAD", cache: "no-store" }
    );
  });

  it("rebases the real enhanced queue so a hung epoch cannot block its successor", async () => {
    let rejectFirst!: (error: Error) => void;
    worker.analyzePcm.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    worker.dispose.mockImplementationOnce(() => rejectFirst(new Error("worker disposed")));
    const first = analyzeEnhancedRhythmPcm(new Float32Array([0]), 44_100, 1, undefined, "one");
    const queued = analyzeEnhancedRhythmPcm(new Float32Array([0]), 44_100, 1, undefined, "two");
    const firstRejected = expect(first).rejects.toThrow("cancelled");
    const queuedRejected = expect(queued).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(worker.analyzePcm).toHaveBeenCalledTimes(1));

    disposeEnhancedRhythmClient();
    worker.analyzePcm.mockResolvedValueOnce({ schemaVersion: "beat-this-track-diagnostic/v1" });
    const successor = analyzeEnhancedRhythmPcm(new Float32Array([0]), 44_100, 1, undefined, "two");

    await firstRejected;
    await queuedRejected;
    await expect(successor).resolves.toMatchObject({ schemaVersion: "beat-this-track-diagnostic/v1" });
    expect(worker.analyzePcm).toHaveBeenCalledTimes(2);
  });

  it("keeps a background session reset isolated from the manual shared queue", async () => {
    let rejectBackground!: (error: Error) => void;
    worker.analyzePcm
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectBackground = reject; }))
      .mockResolvedValueOnce({ schemaVersion: "manual-result" });
    worker.dispose.mockImplementationOnce(() => rejectBackground(new Error("worker disposed")));
    const background = createEnhancedRhythmAnalysisSession();
    const backgroundRun = background.analyzePcm(new Float32Array([0]), 44_100, 1, undefined, "background");
    const backgroundRejected = expect(backgroundRun).rejects.toThrow("session disposed");
    const manualRun = analyzeEnhancedRhythmPcm(new Float32Array([0]), 44_100, 1, undefined, "manual");
    await vi.waitFor(() => expect(worker.analyzePcm).toHaveBeenCalledTimes(1));

    background.dispose();
    await backgroundRejected;
    await expect(manualRun).resolves.toMatchObject({ schemaVersion: "manual-result" });
    expect(worker.analyzePcm).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a queued manual inference after its generation is disposed", async () => {
    let settleBackground!: (value: unknown) => void;
    worker.analyzePcm.mockImplementationOnce(() => new Promise((resolve) => { settleBackground = resolve; }));
    const background = createEnhancedRhythmAnalysisSession();
    const backgroundRun = background.analyzePcm(new Float32Array([0]), 44_100, 1, undefined, "background-zombie");
    await vi.waitFor(() => expect(worker.analyzePcm).toHaveBeenCalledTimes(1));

    const manualRun = analyzeEnhancedRhythmPcm(new Float32Array([0]), 44_100, 1, undefined, "manual-zombie");
    const manualRejected = expect(manualRun).rejects.toThrow("cancelled");
    disposeEnhancedRhythmClient();
    await manualRejected;
    settleBackground({ schemaVersion: "background-result" });
    await expect(backgroundRun).resolves.toMatchObject({ schemaVersion: "background-result" });
    await Promise.resolve();
    expect(worker.analyzePcm).toHaveBeenCalledTimes(1);
    expect(worker.construct).toHaveBeenCalledTimes(1);
    background.dispose();
  });
});
