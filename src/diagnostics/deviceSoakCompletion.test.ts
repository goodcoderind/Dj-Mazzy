import { describe, expect, it } from "vitest";
import { decideDeviceSoakCompletion } from "./deviceSoakCompletion";

describe("device soak completion", () => {
  it("waits until both wall and audio clocks reach the requested duration", () => {
    expect(decideDeviceSoakCompletion(60, 59, 60)).toBe("continue");
    expect(decideDeviceSoakCompletion(60, 60, 60)).toBe("finish");
  });

  it("finishes after bounded wall-clock slack so a stalled context fails in the report", () => {
    expect(decideDeviceSoakCompletion(64.9, 59, 60)).toBe("continue");
    expect(decideDeviceSoakCompletion(65, 59, 60)).toBe("finish-stalled");
  });

  it("rejects malformed clocks instead of manufacturing evidence", () => {
    expect(() => decideDeviceSoakCompletion(Number.NaN, 60, 60)).toThrow(RangeError);
    expect(() => decideDeviceSoakCompletion(60, -1, 60)).toThrow(RangeError);
    expect(() => decideDeviceSoakCompletion(60, 60, 0)).toThrow(RangeError);
  });
});
