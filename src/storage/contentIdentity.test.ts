import { describe, expect, it } from "vitest";
import { identifyLocalFile, normalizeContentIdentity } from "./contentIdentity";

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
});
