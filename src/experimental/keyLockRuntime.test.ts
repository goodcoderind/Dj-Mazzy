import { describe, expect, it } from "vitest";
import {
  EXPERIMENTAL_KEY_LOCK_CONTRACT,
  isExperimentalKeyLockRateSupported
} from "./keyLockRuntime";

describe("experimental key-lock contract", () => {
  it("is versioned and keeps the initial stretch budget within six percent", () => {
    expect(EXPERIMENTAL_KEY_LOCK_CONTRACT).toBe("signalsmith-stretch-web/1.3.2/key-lock-spike-v1");
    expect(isExperimentalKeyLockRateSupported(0.94)).toBe(true);
    expect(isExperimentalKeyLockRateSupported(1.06)).toBe(true);
    expect(isExperimentalKeyLockRateSupported(0.939999)).toBe(false);
    expect(isExperimentalKeyLockRateSupported(1.060001)).toBe(false);
    expect(isExperimentalKeyLockRateSupported(Number.NaN)).toBe(false);
  });
});
