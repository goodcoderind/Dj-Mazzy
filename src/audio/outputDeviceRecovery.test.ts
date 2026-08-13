import { describe, expect, it } from "vitest";
import { OUTPUT_DEVICE_RECOVERY_MESSAGE, supportsOutputDeviceChangeMonitoring } from "./outputDeviceRecovery";

describe("output device recovery", () => {
  it("detects only an event-capable mediaDevices surface", () => {
    expect(supportsOutputDeviceChangeMonitoring(null)).toBe(false);
    expect(supportsOutputDeviceChangeMonitoring({})).toBe(false);
    expect(supportsOutputDeviceChangeMonitoring({ addEventListener() {} })).toBe(true);
  });

  it("uses actionable copy without claiming an output was verified", () => {
    expect(OUTPUT_DEVICE_RECOVERY_MESSAGE).toContain("media-device change");
    expect(OUTPUT_DEVICE_RECOVERY_MESSAGE).toContain("may keep playing");
    expect(OUTPUT_DEVICE_RECOVERY_MESSAGE).toContain("check the speakers");
    expect(OUTPUT_DEVICE_RECOVERY_MESSAGE).toContain("Autopilot is paused");
  });
});
