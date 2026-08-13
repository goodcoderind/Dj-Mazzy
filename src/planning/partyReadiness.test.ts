import { describe, expect, it } from "vitest";
import { assessPartyReadiness } from "./partyReadiness";

describe("party readiness", () => {
  it("requires a playing source and a next track", () => {
    expect(assessPartyReadiness({
      sourcePlaying: false, sourceReady: true, targetReady: true, targetActive: false,
      queuedTracks: 2, analyzedQueuedTracks: 2, libraryFillTracks: 0, enhancedTimingReady: true
    })).toMatchObject({ canStart: false, level: "start-source" });
    expect(assessPartyReadiness({
      sourcePlaying: true, sourceReady: true, targetReady: false, targetActive: false,
      queuedTracks: 0, analyzedQueuedTracks: 0, libraryFillTracks: 0, enhancedTimingReady: true
    })).toMatchObject({ canStart: false, level: "needs-tracks" });
  });

  it("allows a safe-only party when enhanced timing is unavailable", () => {
    expect(assessPartyReadiness({
      sourcePlaying: true, sourceReady: true, targetReady: false, targetActive: false,
      queuedTracks: 3, analyzedQueuedTracks: 1, libraryFillTracks: 0, enhancedTimingReady: false
    })).toMatchObject({ canStart: true, level: "safe-only", headline: "Ready with conservative song changes" });
  });

  it("reports queue analysis separately from optional library continuation", () => {
    const readiness = assessPartyReadiness({
      sourcePlaying: true, sourceReady: true, targetReady: false, targetActive: false,
      queuedTracks: 2, analyzedQueuedTracks: 1, libraryFillTracks: 8, enhancedTimingReady: true
    });
    expect(readiness.details).toContain("1/2 queued tracks analyzed.");
    expect(readiness.details).toContain("8 additional unplayed library tracks available after the queue.");
  });

  it("rejects an already-playing target instead of restarting it", () => {
    expect(assessPartyReadiness({
      sourcePlaying: true, sourceReady: true, targetReady: true, targetActive: true,
      queuedTracks: 0, analyzedQueuedTracks: 0, libraryFillTracks: 0, enhancedTimingReady: true
    })).toMatchObject({ canStart: false, level: "stop-target" });
  });
});
