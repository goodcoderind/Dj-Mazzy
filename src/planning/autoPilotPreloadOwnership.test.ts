import { describe, expect, it } from "vitest";
import {
  shouldCommitAutoPilotPreload,
  shouldDiscardSettledAutoPilotPreload,
  type AutoPilotPreloadSettlement
} from "./autoPilotPreloadOwnership";

const validSettlement = (overrides: Partial<AutoPilotPreloadSettlement> = {}): AutoPilotPreloadSettlement => ({
  loaded: true,
  autoPilotEnabled: true,
  operationCurrent: true,
  stillEligible: true,
  requestedTrackId: "next",
  targetTrackId: "next",
  targetPlaying: false,
  ...overrides
});

describe("Autopilot preload ownership", () => {
  it("commits only the current eligible preload on the idle target deck", () => {
    expect(shouldCommitAutoPilotPreload(validSettlement())).toBe(true);
    for (const settlement of [
      validSettlement({ autoPilotEnabled: false }),
      validSettlement({ operationCurrent: false }),
      validSettlement({ stillEligible: false }),
      validSettlement({ targetTrackId: "host-track" }),
      validSettlement({ targetPlaying: true })
    ]) {
      expect(shouldCommitAutoPilotPreload(settlement)).toBe(false);
    }
  });

  it("discards an invalidated preload after pause even though its generation changed", () => {
    const pausedDuringDecode = validSettlement({
      autoPilotEnabled: false,
      operationCurrent: false
    });

    expect(shouldCommitAutoPilotPreload(pausedDuringDecode)).toBe(false);
    expect(shouldDiscardSettledAutoPilotPreload(pausedDuringDecode)).toBe(true);
  });

  it("never ejects a host replacement or a track that has started playing", () => {
    expect(shouldDiscardSettledAutoPilotPreload(validSettlement({
      operationCurrent: false,
      targetTrackId: "host-track"
    }))).toBe(false);
    expect(shouldDiscardSettledAutoPilotPreload(validSettlement({
      operationCurrent: false,
      targetPlaying: true
    }))).toBe(false);
  });
});
