import { describe, expect, it } from "vitest";
import {
  PARTY_STOP_ALL_SOUND_SCHEMA_VERSION,
  PARTY_STOP_ALL_SOUND_STEPS,
  runPartyStopAllSound,
  verifyPartyStopAllSound
} from "./partyStopAllSound";

describe("Party Stop All Sound", () => {
  it("runs every safety boundary in the declared order", () => {
    const calls: string[] = [];
    const result = runPartyStopAllSound((step) => calls.push(step));

    expect(calls).toEqual(PARTY_STOP_ALL_SOUND_STEPS);
    expect(result).toEqual({
      schemaVersion: PARTY_STOP_ALL_SOUND_SCHEMA_VERSION,
      completedSteps: PARTY_STOP_ALL_SOUND_STEPS,
      failedSteps: [],
      passed: true
    });
  });

  it("still stops both decks and the session when transition cleanup fails", () => {
    const calls: string[] = [];
    const result = runPartyStopAllSound((step) => {
      calls.push(step);
      if (step === "cancel-active-transition") throw new Error("stale schedule");
    });

    expect(calls).toEqual(PARTY_STOP_ALL_SOUND_STEPS);
    expect(result.failedSteps).toEqual(["cancel-active-transition"]);
    expect(result.completedSteps).toContain("stop-deck-a");
    expect(result.completedSteps).toContain("stop-deck-b");
    expect(result.completedSteps).toContain("pause-party-session");
    expect(result.passed).toBe(false);
  });

  it("is safe to invoke repeatedly", () => {
    const counts = new Map<string, number>();
    const perform = (step: string) => counts.set(step, (counts.get(step) ?? 0) + 1);

    expect(runPartyStopAllSound(perform).passed).toBe(true);
    expect(runPartyStopAllSound(perform).passed).toBe(true);
    expect([...counts.values()]).toEqual(PARTY_STOP_ALL_SOUND_STEPS.map(() => 2));
  });

  it("unlocks new starts only after every audible owner is confirmed stopped", () => {
    const stopped = {
      deckAStopped: true,
      deckBStopped: true,
      crossfadeCleared: true,
      transitionAuthorityCleared: true,
      preloadAuthorityCleared: true,
      armAuthorityCleared: true,
      auxiliaryAuthorityCleared: true
    };

    expect(verifyPartyStopAllSound(stopped)).toBe(true);
    for (const key of Object.keys(stopped)) {
      expect(verifyPartyStopAllSound({ ...stopped, [key]: false })).toBe(false);
    }
  });
});
