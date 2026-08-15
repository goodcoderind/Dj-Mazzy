import { describe, expect, it } from "vitest";
import { analyzeProgramLevel } from "../analysis/programLevel";
import { buildPartyLevelListeningCandidate } from "./partyLevelListening";

const sine = (peakDbfs: number) => {
  const amplitude = 10 ** (peakDbfs / 20);
  return Float32Array.from({ length: 48_000 * 4 }, (_, frame) =>
    amplitude * Math.sin(2 * Math.PI * 1_000 * frame / 48_000)
  );
};
const stereoAnalysis = (peakDbfs: number) => {
  const channel = sine(peakDbfs);
  return analyzeProgramLevel([channel, channel], 48_000);
};

describe("party level listening candidates", () => {
  it("projects only bounded anonymous comparison values", () => {
    const trackA = { ...stereoAnalysis(-18), filename: "private-a.wav" };
    const trackB = { ...stereoAnalysis(-18.5), path: "/private/b.wav" };
    const candidate = buildPartyLevelListeningCandidate(trackA, trackB, -16);
    expect(candidate).toMatchObject({
      schemaVersion: "party-level-listening-candidate/v1",
      targetLufs: -16,
      warning: "none"
    });
    expect(candidate?.predictedDifferenceLu).toBeLessThanOrEqual(0.1);
    expect(JSON.stringify(candidate)).not.toMatch(/private|filename|path/);
  });

  it("marks a target constrained by the shared trim bounds", () => {
    const quiet = stereoAnalysis(-30);
    const ordinary = stereoAnalysis(-18);
    const candidate = buildPartyLevelListeningCandidate(quiet, ordinary, -12);
    expect(candidate?.trackA.trimDb).toBe(3);
    expect(candidate?.trackA.targetConstrained).toBe(true);
    expect(candidate?.warning).toBe("one-or-more-tracks-cannot-reach-target");
  });

  it("rejects unsupported targets and stale or unmeasured inputs", () => {
    const valid = stereoAnalysis(-18);
    expect(buildPartyLevelListeningCandidate(valid, valid, -15)).toBeNull();
    expect(buildPartyLevelListeningCandidate({ schemaVersion: "program-level/v3" }, valid, -14)).toBeNull();
    expect(buildPartyLevelListeningCandidate(
      analyzeProgramLevel([new Float32Array(48_000 * 4)], 48_000),
      valid,
      -14
    )).toBeNull();
  });
});
