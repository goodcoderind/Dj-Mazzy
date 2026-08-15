import { describe, expect, it } from "vitest";
import artifact from "../../PARTY_CHECKPOINT_TRANSFER_BROWSER_ACCEPTANCE_REPORT.json";

const collectKeys = (value: unknown, keys = new Set<string>()) => {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    collectKeys(child, keys);
  }
  return keys;
};

describe("committed checkpoint transfer browser acceptance", () => {
  it("contains two exact fresh-profile double-reload passes", () => {
    expect(Object.keys(artifact).sort()).toEqual([
      "evidenceScope", "freshProfileRuns", "privacy", "reports", "reportsMatched",
      "runnerContract", "schemaVersion", "status"
    ].sort());
    expect(artifact).toMatchObject({
      schemaVersion: "party-checkpoint-transfer-browser-acceptance/v1",
      runnerContract: "party-checkpoint-transfer-browser-runner/v1",
      status: "passed",
      freshProfileRuns: 2,
      reportsMatched: true
    });
    expect(artifact.reports).toHaveLength(2);
    for (const report of artifact.reports) {
      expect(report).toMatchObject({
        schemaVersion: "party-checkpoint-transfer-browser-report/v1",
        passed: true,
        failureCodes: [],
        counts: {
          fixtureTracks: 4,
          hydratedTracks: 4,
          recoveryCardsObserved: 2,
          transfersCompleted: 2,
          payloadTransfersVerified: 2,
          visibleStateApplicationsVerified: 2
        },
        safety: {
          libraryCounterDrifts: 0,
          deckStartAttempts: 0,
          contextResumeAttempts: 0,
          wakeLockRequests: 0,
          activeDecksAfter: 0,
          autoPilotActiveAfter: false
        },
        focus: {
          recoveryCardsVisibleWithFocusPreserved: 2,
          restoredCardsVerified: 2,
          removalVerified: true
        },
        cleanup: {
          checkpointStatusAfter: "cleared",
          exactOwnerRevisionAndLibraryVerified: true
        },
        interrupted: false
      });
    }
  });

  it("contains no file, plan identity, token, timestamp, error text, or media fields", () => {
    const keys = collectKeys(artifact);
    for (const forbidden of [
      "filename", "filepath", "path", "trackid", "sessionid", "writertoken",
      "contentidentity", "hash", "timestamp", "audiotime", "errormessage", "stack",
      "useragent", "deviceid", "audio", "pcm"
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(artifact)).not.toMatch(/generated-recovery-|\.wav|\/Users\/|private-song|track-private-id/i);
  });
});
