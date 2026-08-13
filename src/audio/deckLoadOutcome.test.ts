import { describe, expect, it } from "vitest";
import { DECK_LOAD_OUTCOME, shouldQuarantineAutoPilotLoad } from "./deckLoadOutcome";

describe("deck load outcomes", () => {
  it("quarantines only a current Autopilot file-read or decode failure", () => {
    expect(shouldQuarantineAutoPilotLoad({
      outcome: DECK_LOAD_OUTCOME.unplayableFile,
      autoPilotEnabled: true,
      operationCurrent: true
    })).toBe(true);

    for (const outcome of [
      DECK_LOAD_OUTCOME.loaded,
      DECK_LOAD_OUTCOME.cancelled,
      DECK_LOAD_OUTCOME.audioBlocked
    ]) {
      expect(shouldQuarantineAutoPilotLoad({ outcome, autoPilotEnabled: true, operationCurrent: true })).toBe(false);
    }
  });

  it("does not poison a track after pause or supersession", () => {
    expect(shouldQuarantineAutoPilotLoad({
      outcome: DECK_LOAD_OUTCOME.unplayableFile,
      autoPilotEnabled: false,
      operationCurrent: true
    })).toBe(false);
    expect(shouldQuarantineAutoPilotLoad({
      outcome: DECK_LOAD_OUTCOME.unplayableFile,
      autoPilotEnabled: true,
      operationCurrent: false
    })).toBe(false);
  });
});
