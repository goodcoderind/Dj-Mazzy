import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeEnhancedRhythm,
  getEnhancedRhythmAssetState,
  removeEnhancedRhythmModel
} from "./enhancedRhythmUnavailable";
import {
  ENHANCED_TIMING_MODEL_CACHE,
  ENHANCED_TIMING_MODEL_CONTROL_CACHE,
  ENHANCED_TIMING_MODEL_CONTROL_VERSION
} from "./enhancedTimingModelStorage";

afterEach(() => vi.unstubAllGlobals());

describe("standard-build enhanced timing boundary", () => {
  it("exposes a previously stored pack for deletion without making analysis usable", async () => {
    let modelStored = true;
    let control: unknown = null;
    const deleteCache = vi.fn(async (name: string) => {
      if (name === ENHANCED_TIMING_MODEL_CACHE) modelStored = false;
      return true;
    });
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CACHE ? modelStored : control !== null),
      open: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
        ? {
            match: async () => control ? new Response(JSON.stringify(control)) : undefined,
            put: async (_key: string, response: Response) => { control = await response.json(); },
            delete: async () => { control = null; return true; },
            keys: async () => []
          }
        : {
            keys: async () => [new Request("https://mazzy.invalid/model.onnx")],
            match: async () => undefined,
            put: async () => undefined,
            delete: async () => false
          }),
      delete: deleteCache
    });
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() } });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("stored-unavailable");
    await expect(analyzeEnhancedRhythm()).rejects.toThrow("not included");
    await expect(removeEnhancedRhythmModel()).resolves.toBe(true);
    expect(deleteCache).toHaveBeenCalledWith("mazzy-timing-model-v1");
  });

  it("uses verified absence rather than the cache delete return value", async () => {
    let control: unknown = null;
    vi.stubGlobal("caches", {
      has: vi.fn(async () => false),
      open: vi.fn(async () => ({
        match: async () => control ? new Response(JSON.stringify(control)) : undefined,
        put: async (_key: string, response: Response) => { control = await response.json(); },
        delete: async () => { control = null; return true; },
        keys: async () => []
      })),
      delete: vi.fn(async () => false)
    });
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() } });
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    await expect(removeEnhancedRhythmModel()).resolves.toBe(true);

    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CACHE),
      open: vi.fn(async () => ({
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => true
      })),
      delete: vi.fn(async () => true)
    });
    await expect(removeEnhancedRhythmModel()).resolves.toBe(false);
  });

  it("does not create or advertise a model cache when none exists", async () => {
    let control: unknown = null;
    const open = vi.fn(async () => ({
      match: async () => control ? new Response(JSON.stringify(control)) : undefined,
      put: async (_key: string, response: Response) => { control = await response.json(); },
      delete: async () => true,
      keys: async () => []
    }));
    vi.stubGlobal("caches", {
      has: vi.fn(async () => false),
      open,
      delete: vi.fn(async () => false)
    });
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-0000-0000-000000000001" });
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("not-included");
    expect(open).not.toHaveBeenCalledWith(ENHANCED_TIMING_MODEL_CACHE);
  });

  it("keeps removal available for a revoked cache that still has entries", async () => {
    vi.stubGlobal("caches", {
      has: vi.fn(async (name: string) => [
        ENHANCED_TIMING_MODEL_CACHE,
        ENHANCED_TIMING_MODEL_CONTROL_CACHE
      ].includes(name)),
      open: vi.fn(async (name: string) => name === ENHANCED_TIMING_MODEL_CONTROL_CACHE
        ? {
            match: async () => new Response(JSON.stringify({
              version: ENHANCED_TIMING_MODEL_CONTROL_VERSION,
              epoch: 4,
              token: "authority-token-000004",
              revoked: true
            }))
          }
        : { keys: async () => ["model"] })
    });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("location", { origin: "https://mazzy.invalid" });
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("removal-needed");
  });
});
