import { describe, expect, it } from "vitest";
import { audioRecoveryMessage, needsHostAudioRecovery } from "./audioContextRecovery";

describe("audio context recovery state", () => {
  it("requires host recovery for suspended, interrupted, and closed audio", () => {
    expect(needsHostAudioRecovery("running")).toBe(false);
    expect(needsHostAudioRecovery("suspended")).toBe(true);
    expect(needsHostAudioRecovery("interrupted")).toBe(true);
    expect(needsHostAudioRecovery("closed")).toBe(true);
  });

  it("uses actionable non-technical copy", () => {
    expect(audioRecoveryMessage("suspended")).toContain("Resume audio");
    expect(audioRecoveryMessage("interrupted")).toContain("interrupted");
    expect(audioRecoveryMessage("closed")).toContain("Reload Mazzy");
  });
});
