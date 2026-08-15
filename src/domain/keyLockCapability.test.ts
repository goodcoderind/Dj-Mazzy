import { describe, expect, it } from "vitest";
import { keyLockCapabilityCovers, type KeyLockCapability } from "./keyLockCapability";

const approved: KeyLockCapability = {
  schemaVersion: "key-lock-capability/v1",
  processor: "signalsmith-stretch-web/1.3.2",
  status: "benchmark-approved",
  minimumRate: 0.94,
  maximumRate: 1.06,
  sampleRate: 48_000,
  acceptanceContract: "key-lock-device-acceptance/v1",
  contextSampleRate: 48_000,
  sourceLoadKey: "deck-a-load-1",
  targetLoadKey: "deck-b-load-1",
  sourceBackend: "signalsmith-stretch-web/1.3.2",
  targetBackend: "signalsmith-stretch-web/1.3.2"
};

const runtime = {
  contextSampleRate: 48_000,
  sourceLoadKey: "deck-a-load-1",
  targetLoadKey: "deck-b-load-1",
  sourceBackend: "signalsmith-stretch-web/1.3.2",
  targetBackend: "signalsmith-stretch-web/1.3.2"
};

describe("key-lock capability", () => {
  it("covers only rates inside the benchmarked processor contract", () => {
    expect(keyLockCapabilityCovers(approved, [1, 0.94, 1.06], runtime)).toBe(true);
    expect(keyLockCapabilityCovers(approved, [0.939], runtime)).toBe(false);
    expect(keyLockCapabilityCovers({ ...approved, minimumRate: 0.5 }, [1], runtime)).toBe(false);
    expect(keyLockCapabilityCovers({ ...approved, processor: "wrong" } as unknown as KeyLockCapability, [1], runtime)).toBe(false);
    expect(keyLockCapabilityCovers(approved, [1], { ...runtime, targetLoadKey: "other" })).toBe(false);
    expect(keyLockCapabilityCovers(approved, [1])).toBe(false);
    expect(keyLockCapabilityCovers(null, [1], runtime)).toBe(false);
  });
});
