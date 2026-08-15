import type { HostEnergyCurve } from "./EnergyStoryline";

export type PartyEnergyProfile = "steady" | "build" | "journey";

export const PARTY_ENERGY_CURVES: Readonly<Record<PartyEnergyProfile, HostEnergyCurve>> = Object.freeze({
  steady: Object.freeze({ warmUp: 0.58, build: 0.58, peak: 0.58, cooldown: 0.58 }),
  build: Object.freeze({ warmUp: 0.35, build: 0.62, peak: 0.9, cooldown: 0.82 }),
  journey: Object.freeze({ warmUp: 0.35, build: 0.62, peak: 0.9, cooldown: 0.4 })
});

export const partyEnergyCurve = (profile: PartyEnergyProfile): HostEnergyCurve =>
  PARTY_ENERGY_CURVES[profile];

export const shiftEnergyCurve = (curve: HostEnergyCurve, delta: number): HostEnergyCurve => {
  if (!Number.isFinite(delta)) throw new RangeError("Energy shift must be finite");
  const shift = (value: number) => Math.max(0, Math.min(1, value + delta));
  return Object.freeze({
    warmUp: shift(curve.warmUp),
    build: shift(curve.build),
    peak: shift(curve.peak),
    cooldown: shift(curve.cooldown)
  });
};
