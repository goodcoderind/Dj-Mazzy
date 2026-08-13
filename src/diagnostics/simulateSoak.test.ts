import { describe, expect, it } from "vitest";
import { simulatePlaybackSoak } from "./simulateSoak";

describe("simulatePlaybackSoak", () => {
  it("covers a two-hour session without gaps or runaway decoding", () => {
    const result = simulatePlaybackSoak();
    expect(result.completed).toBe(true);
    expect(result.sessionDurationSeconds).toBe(7200);
    expect(result.renderedUntilSeconds).toBeGreaterThanOrEqual(7200);
    expect(result.transitions).toBeGreaterThan(30);
    expect(result.uncoveredSeconds).toBe(0);
    expect(result.maximumConcurrentTracks).toBe(2);
    expect(result.maximumDecodedTracks).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it("is deterministic for identical session parameters", () => {
    const options = {
      sessionDurationSeconds: 3600,
      trackDurationSeconds: 180,
      transitionDurationSeconds: 12
    };
    expect(simulatePlaybackSoak(options)).toEqual(simulatePlaybackSoak(options));
  });

  it("rejects impossible transition timelines", () => {
    expect(() =>
      simulatePlaybackSoak({
        trackDurationSeconds: 10,
        transitionDurationSeconds: 10
      })
    ).toThrow(RangeError);
    expect(() => simulatePlaybackSoak({ sessionDurationSeconds: 0 })).toThrow(RangeError);
  });
});
