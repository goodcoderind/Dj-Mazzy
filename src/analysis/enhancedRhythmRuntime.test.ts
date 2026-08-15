import { afterEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({
  analyzePcm: vi.fn(),
  diagnose: vi.fn(),
  dispose: vi.fn(),
  construct: vi.fn()
}));

vi.mock("../experimental/BeatThisDiagnosticClient", () => ({
  BeatThisDiagnosticClient: class {
    constructor() { worker.construct(); }
    analyzePcm = worker.analyzePcm;
    dispose = worker.dispose;
    diagnose = worker.diagnose;
  }
}));

import {
  analyzeEnhancedRhythmPcm,
  createEnhancedRhythmAnalysisSession,
  disposeEnhancedRhythmClient,
  getEnhancedRhythmAssetState,
  invalidateEnhancedRhythmPreparation,
  prepareEnhancedRhythm,
  projectEnhancedTimingStorageCoordinationState,
  projectRevokedEmptyEnhancedRhythmAssetState,
  removeEnhancedRhythmModel
} from "./enhancedRhythmRuntime";
import {
  ENHANCED_TIMING_MODEL_CACHE,
  ENHANCED_TIMING_MODEL_CONTROL_CACHE,
  ENHANCED_TIMING_MODEL_CONTROL_VERSION,
  ENHANCED_TIMING_MODEL_PREPARATION_PROOF_VERSION
} from "./enhancedTimingModelStorage";

afterEach(() => {
  disposeEnhancedRhythmClient();
  worker.analyzePcm.mockReset();
  worker.diagnose.mockReset();
  worker.dispose.mockReset();
  worker.construct.mockReset();
  vi.unstubAllGlobals();
});

const stubStoredPack = () => {
  const authority = {
    epoch: 0,
    token: "00000000-0000-0000-0000-000000000001"
  };
  let control: unknown = {
    version: ENHANCED_TIMING_MODEL_CONTROL_VERSION,
    ...authority,
    revoked: false
  };
  let proof: unknown = {
    version: ENHANCED_TIMING_MODEL_PREPARATION_PROOF_VERSION,
    ...authority
  };
  vi.stubGlobal("caches", {
    has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CACHE ||
      (name === ENHANCED_TIMING_MODEL_CONTROL_CACHE && control !== null)),
    open: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
      ? {
          match: async (key: string) => key.includes("preparation-proof")
            ? proof ? new Response(JSON.stringify(proof)) : undefined
            : control ? new Response(JSON.stringify(control)) : undefined,
          put: async (key: string, response: Response) => {
            if (key.includes("preparation-proof")) proof = await response.json();
            else control = await response.json();
          },
          delete: async (key: string) => {
            if (key.includes("preparation-proof")) proof = null;
            else control = null;
            return true;
          },
          keys: async () => []
        }
      : {
          match: async () => new Response("cached"),
          put: async () => undefined,
          delete: async () => false,
          keys: async () => ["model"]
        })
  });
  vi.stubGlobal("navigator", {
    onLine: true,
    locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() }
  });
  vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-0000-0000-000000000001" });
};

const admitStoredPack = async () => {
  stubStoredPack();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
    status: 200,
    headers: { "content-type": "application/json" }
  })));
  await expect(getEnhancedRhythmAssetState()).resolves.toBe("stored");
};

describe("enhanced timing origin availability", () => {
  it("confirms the enhanced cache is absent after deletion", async () => {
    let stored = true;
    let revoked = false;
    vi.stubGlobal("caches", {
      delete: vi.fn(async (name: string) => {
        if (name === ENHANCED_TIMING_MODEL_CACHE) stored = false;
        return true;
      }),
      has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CACHE ? stored : revoked),
      open: vi.fn(async () => ({
        match: async () => revoked ? new Response("revoked") : undefined,
        put: async () => { revoked = true; },
        delete: async () => { revoked = false; return true; }
      }))
    });
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() } });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    await expect(removeEnhancedRhythmModel()).resolves.toBe(true);
  });

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

  it("reports an incomplete allowed cache instead of advertising a fresh download", async () => {
    let control: unknown = null;
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CACHE ||
        (name === ENHANCED_TIMING_MODEL_CONTROL_CACHE && control !== null)),
      open: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
        ? {
            match: async () => control ? new Response(JSON.stringify(control)) : undefined,
            put: async (_key: string, response: Response) => { control = await response.json(); },
            keys: async () => []
          }
        : {
            match: async (url: string) => url.endsWith("config.json") ? new Response("cached") : undefined,
            keys: async () => ["config.json"]
          })
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-0000-0000-000000000001" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(getEnhancedRhythmAssetState()).resolves.toBe("partial");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not report complete cached bytes as ready without exact preparation proof", async () => {
    let control: unknown = null;
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CACHE ||
        (name === ENHANCED_TIMING_MODEL_CONTROL_CACHE && control !== null)),
      open: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
        ? {
            match: async (key: string) => key.includes("preparation-proof")
              ? undefined
              : control ? new Response(JSON.stringify(control)) : undefined,
            put: async (_key: string, response: Response) => { control = await response.json(); },
            keys: async () => []
          }
        : {
            match: async () => new Response("cached"),
            keys: async () => ["config", "model", "mel"]
          })
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-0000-0000-000000000001" });

    await expect(getEnhancedRhythmAssetState()).resolves.toBe("partial");
  });

  it("does not create a worker when preparation authority is lost after storage admission", async () => {
    stubStoredPack();
    let owned = true;
    const preparation = prepareEnhancedRhythm(
      undefined,
      () => { owned = false; },
      () => owned
    );
    await expect(preparation).rejects.toThrow("cancelled");
    expect(worker.construct).not.toHaveBeenCalled();
  });

  it("invalidates complete cached bytes when outer preparation acceptance is refused", async () => {
    stubStoredPack();
    worker.diagnose.mockResolvedValueOnce({ experimentalOnly: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    const prepared = await prepareEnhancedRhythm();
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("stored");
    await expect(invalidateEnhancedRhythmPreparation(prepared.storageAuthority)).resolves.toEqual({
      outcome: "confirmed-absent"
    });
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("partial");
  });

  it("keeps retry removal visible when revocation exists but model files remain", async () => {
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => [
        ENHANCED_TIMING_MODEL_CACHE,
        ENHANCED_TIMING_MODEL_CONTROL_CACHE
      ].includes(name)),
      open: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
        ? {
            match: async () => new Response(JSON.stringify({
              version: ENHANCED_TIMING_MODEL_CONTROL_VERSION,
              epoch: 2,
              token: "authority-token-000002",
              revoked: true
            }))
          }
        : { keys: async () => ["model"] })
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("removal-needed");
  });

  it("keeps an included build retryable after verified removal while offline", () => {
    expect(projectRevokedEmptyEnhancedRhythmAssetState({
      included: true,
      online: false
    })).toBe("unavailable");
    expect(projectRevokedEmptyEnhancedRhythmAssetState({
      included: true,
      online: true
    })).toBe("downloadable");
    expect(projectRevokedEmptyEnhancedRhythmAssetState({
      included: false,
      online: false
    })).toBe("not-included");
  });

  it("projects a clean included profile without Web Locks as coordination-unavailable", () => {
    expect(projectEnhancedTimingStorageCoordinationState({
      included: true,
      exclusiveLockAvailable: false
    })).toBe("coordination-unavailable");
    expect(projectEnhancedTimingStorageCoordinationState({
      included: true,
      exclusiveLockAvailable: true
    })).toBeNull();
    expect(projectEnhancedTimingStorageCoordinationState({
      included: false,
      exclusiveLockAvailable: false
    })).toBeNull();
  });

  it("refuses preparation before storage admission or worker creation without an origin lock", async () => {
    let controlOpened = false;
    vi.stubGlobal("caches", {
      has: vi.fn(async () => false),
      open: vi.fn(async () => {
        controlOpened = true;
        throw new Error("must not open");
      })
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });

    await expect(prepareEnhancedRhythm()).rejects.toThrow("coordination is unavailable");
    expect(controlOpened).toBe(false);
    expect(worker.construct).not.toHaveBeenCalled();
  });

  it("cannot publish stored availability from a probe superseded by removal", async () => {
    const authority = { epoch: 1, token: "authority-token-000001" };
    let control: unknown = {
      version: ENHANCED_TIMING_MODEL_CONTROL_VERSION,
      ...authority,
      revoked: false
    };
    let proof: unknown = {
      version: ENHANCED_TIMING_MODEL_PREPARATION_PROOF_VERSION,
      ...authority
    };
    let modelStored = true;
    let resolveHead!: (response: Response) => void;
    const head = new Promise<Response>((resolve) => { resolveHead = resolve; });
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
        ? control !== null
        : modelStored),
      open: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
        ? {
            match: async (key: string) => key.includes("preparation-proof")
              ? proof ? new Response(JSON.stringify(proof)) : undefined
              : control ? new Response(JSON.stringify(control)) : undefined,
            put: async (key: string, response: Response) => {
              if (key.includes("preparation-proof")) proof = await response.json();
              else control = await response.json();
            },
            delete: async (key: string): Promise<boolean> => {
              if (key.includes("preparation-proof")) proof = null;
              else control = null;
              return true;
            }
          }
        : {
            match: async () => modelStored ? new Response("cached") : undefined,
            put: async () => undefined,
            delete: async (): Promise<boolean> => false,
            keys: async () => modelStored ? ["model"] : []
          }),
      delete: vi.fn(async (name: string) => {
        if (name === ENHANCED_TIMING_MODEL_CACHE) modelStored = false;
        return true;
      })
    });
    vi.stubGlobal("navigator", {
      onLine: true,
      locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() }
    });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    const fetch = vi.fn(async () => head);
    vi.stubGlobal("fetch", fetch);

    const probe = getEnhancedRhythmAssetState();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(removeEnhancedRhythmModel()).resolves.toBe(true);
    resolveHead(new Response(null, { status: 200, headers: { "content-type": "application/json" } }));
    await expect(probe).resolves.toBe("probe-error");
  });

  it("rebases the real enhanced queue so a hung epoch cannot block its successor", async () => {
    await admitStoredPack();
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
    await admitStoredPack();
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
    await admitStoredPack();
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
