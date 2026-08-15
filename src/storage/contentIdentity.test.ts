import { describe, expect, it, vi } from "vitest";
import { identifyLocalFile, normalizeContentIdentity, readLocalFileBytes } from "./contentIdentity";

describe("local file content identity", () => {
  it("is stable for byte-identical files and changes with content", async () => {
    const first = { arrayBuffer: async () => new TextEncoder().encode("same audio bytes").buffer };
    const duplicate = { arrayBuffer: async () => new TextEncoder().encode("same audio bytes").buffer };
    const different = { arrayBuffer: async () => new TextEncoder().encode("different audio bytes").buffer };
    expect(await identifyLocalFile(first)).toBe(await identifyLocalFile(duplicate));
    expect(await identifyLocalFile(different)).not.toBe(await identifyLocalFile(first));
  });

  it("normalizes only the versioned exact digest shape", async () => {
    const identity = await identifyLocalFile({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    expect(normalizeContentIdentity(identity)).toBe(identity);
    expect(normalizeContentIdentity(identity.toUpperCase())).toBeNull();
    expect(normalizeContentIdentity("sha256:private filename.mp3")).toBeNull();
  });

  it("rejects an already-cancelled read without retaining file work", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(readLocalFileBytes({
      arrayBuffer: async () => { called = true; return new ArrayBuffer(0); }
    }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toBe(false);
  });

  it("makes a non-abortable fallback read inert after cancellation", async () => {
    let resolveRead!: (value: ArrayBuffer) => void;
    const controller = new AbortController();
    const pending = readLocalFileBytes({
      arrayBuffer: () => new Promise((resolve) => { resolveRead = resolve; })
    }, { signal: controller.signal });
    controller.abort();
    resolveRead(new Uint8Array([1, 2, 3]).buffer);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("actively aborts FileReader and rejects without publishing bytes", async () => {
    let reader: any = null;
    class ControlledFileReader {
      result: ArrayBuffer | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      abort = vi.fn(() => this.onabort?.());
      readAsArrayBuffer = vi.fn();
      constructor() { reader = this; }
    }
    vi.stubGlobal("FileReader", ControlledFileReader);
    const controller = new AbortController();
    const pending = readLocalFileBytes({
      arrayBuffer: async () => new ArrayBuffer(0)
    }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.abort).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
