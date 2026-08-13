import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnhancedRhythmAssetState } from "./enhancedRhythmRuntime";

afterEach(() => vi.unstubAllGlobals());

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
});
