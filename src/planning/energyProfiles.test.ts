import { describe, expect, it } from "vitest";
import { partyEnergyCurve, shiftEnergyCurve } from "./energyProfiles";
import { targetEnergyAtProgress } from "./EnergyStoryline";

describe("party energy profiles", () => {
  it("keeps the steady profile level across the party", () => {
    const curve = partyEnergyCurve("steady");
    expect(targetEnergyAtProgress(curve, 0)).toBe(targetEnergyAtProgress(curve, 1));
  });

  it("keeps the build profile high at the end and cools the journey profile", () => {
    expect(targetEnergyAtProgress(partyEnergyCurve("build"), 1)).toBeGreaterThan(0.8);
    expect(targetEnergyAtProgress(partyEnergyCurve("journey"), 1)).toBeLessThan(0.5);
  });

  it("shifts live host intent while preserving bounded stage order", () => {
    expect(shiftEnergyCurve(partyEnergyCurve("journey"), 0.2)).toEqual({
      warmUp: 0.55,
      build: 0.8200000000000001,
      peak: 1,
      cooldown: 0.6000000000000001
    });
    expect(shiftEnergyCurve(partyEnergyCurve("build"), -2)).toEqual({
      warmUp: 0,
      build: 0,
      peak: 0,
      cooldown: 0
    });
    expect(() => shiftEnergyCurve(partyEnergyCurve("steady"), Number.NaN)).toThrow("finite");
  });
});
