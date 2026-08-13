import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeEnhancedRhythm,
  getEnhancedRhythmAssetState,
  removeEnhancedRhythmModel
} from "./enhancedRhythmUnavailable";

afterEach(() => vi.unstubAllGlobals());

describe("standard-build enhanced timing boundary", () => {
  it("exposes a previously stored pack for deletion without making analysis usable", async () => {
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      has: vi.fn(async () => true),
      open: vi.fn(async () => ({ keys: async () => [new Request("https://mazzy.invalid/model.onnx")] })),
      delete: deleteCache
    });
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("stored-unavailable");
    await expect(analyzeEnhancedRhythm()).rejects.toThrow("not included");
    await expect(removeEnhancedRhythmModel()).resolves.toBe(true);
    expect(deleteCache).toHaveBeenCalledWith("mazzy-timing-model-v1");
  });

  it("does not create or advertise a model cache when none exists", async () => {
    const open = vi.fn();
    vi.stubGlobal("caches", {
      has: vi.fn(async () => false),
      open,
      delete: vi.fn(async () => false)
    });
    await expect(getEnhancedRhythmAssetState()).resolves.toBe("not-included");
    expect(open).not.toHaveBeenCalled();
  });
});
