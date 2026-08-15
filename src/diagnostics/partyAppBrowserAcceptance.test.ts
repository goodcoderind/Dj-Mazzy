import { describe, expect, it } from "vitest";
import artifact from "../../PARTY_APP_BROWSER_ACCEPTANCE_REPORT.json";

const collectKeys = (value: unknown, keys = new Set<string>()) => {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    collectKeys(child, keys);
  }
  return keys;
};

describe("committed full-App browser acceptance", () => {
  it("contains two passing fresh-profile reports with the exact terminal journey", () => {
    expect(Object.keys(artifact).sort()).toEqual([
      "evidenceScope", "freshProfileRuns", "privacy", "reports", "reportsMatched",
      "runnerContract", "schemaVersion", "status"
    ].sort());
    expect(artifact).toMatchObject({
      schemaVersion: "party-app-browser-acceptance/v1",
      runnerContract: "party-app-browser-runner/v1",
      status: "passed",
      freshProfileRuns: 2,
      reportsMatched: true
    });
    expect(artifact.reports).toHaveLength(2);
    for (const report of artifact.reports) {
      expect(report).toMatchObject({
        schemaVersion: "party-app-journey-report/v1",
        passed: true,
        failureCodes: [],
        counts: {
          importedTracks: 3,
          hydratedTracks: 3,
          storedTracksAfter: 3,
          immediateDeckStarts: 1,
          scheduledTargetStarts: 2,
          scheduledTransitions: 2,
          completedTransitions: 2,
          nativeTransitionSourceCompletions: 2,
          nativeTransitionDispatches: 2,
          recoveredTransitionDispatches: 0,
          crossfadeSentinelDispatches: 0,
          safeFadeTransitions: 2
        },
        terminal: {
          tracePassed: true,
          queueTracks: 0,
          autoPilotActive: false,
          checkpointStatus: "cleared",
          activeDecks: 0,
          activeCrossfade: false,
          recoveryUiVisible: false,
          stopControlReady: true
        },
        focus: { importRestored: true, firstSongPlay: true, readiness: true }
      });
      expect(Object.keys(report.audioHealth)).not.toContain("sampleRate");
      expect(report.audioHealth.renderedFrames).toBeLessThanOrEqual(48_000 * 120);
      expect(report.audioHealth.expectedActiveFrames).toBeLessThanOrEqual(48_000 * 120);
      expect(report.audioHealth.renderQuanta).toBeLessThanOrEqual(48_000 * 120 / 128);
      expect(report.audioHealth.reports).toBeLessThanOrEqual(200);
      expect(report.audioHealth.peak).toBeGreaterThan(0);
      expect(report.audioHealth.peak).toBeLessThan(1);
    }
  });

  it("contains no per-file, identity, timestamp, error-text, device, or media fields", () => {
    const keys = collectKeys(artifact);
    for (const forbidden of [
      "filename", "filepath", "path", "trackid", "contentidentity", "hash", "timestamp",
      "audiotime", "error", "errormessage", "stack", "useragent", "deviceid", "audio", "pcm"
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toMatch(/generated-party-|\.wav|\/Users\/|private-song|track-private-id/i);
  });
});
