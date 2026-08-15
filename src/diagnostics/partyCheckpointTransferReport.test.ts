import { describe, expect, it } from "vitest";
import {
  buildPartyCheckpointTransferReport,
  readPartyCheckpointTransferFinalState,
  shouldRecordPartyCheckpointTransferEvidence
} from "./partyCheckpointTransferReport";

const passing = () => ({
  scenario: "double-reload-paused-plan" as const,
  fixtureTracks: 4,
  hydratedTracks: 4,
  recoveryCardsObserved: 2,
  transfersCompleted: 2,
  payloadTransfersVerified: 2,
  visibleStateApplicationsVerified: 2,
  libraryCounterDrifts: 0,
  deckStartAttempts: 0,
  contextResumeAttempts: 0,
  wakeLockRequests: 0,
  activeDecksAfter: 0,
  autoPilotActiveAfter: false,
  recoveryFocusPreserved: 2,
  restoredFocusVerified: 2,
  removalFocusVerified: true,
  exactCleanupVerified: true,
  checkpointStatusAfter: "cleared" as const,
  externalRequests: 0,
  uncaughtErrors: 0,
  unhandledRejections: 0,
  timedOut: false,
  aborted: false
});

describe("party checkpoint transfer browser report", () => {
  it("keeps safety instrumentation live through the final drain but freezes phase work", () => {
    expect(shouldRecordPartyCheckpointTransferEvidence({
      finishing: true,
      instrumentationClosed: false,
      category: "instrumentation"
    })).toBe(true);
    expect(shouldRecordPartyCheckpointTransferEvidence({
      finishing: true,
      instrumentationClosed: false,
      category: "phase"
    })).toBe(false);
    expect(shouldRecordPartyCheckpointTransferEvidence({
      finishing: true,
      instrumentationClosed: true,
      category: "instrumentation"
    })).toBe(false);
  });

  it("reads authoritative storage only after the final drain", async () => {
    let stored = "cleared";
    const order: string[] = [];
    const result = await readPartyCheckpointTransferFinalState({
      drain: async () => {
        order.push("drain");
        stored = "available";
      },
      read: async () => {
        order.push("read");
        return stored;
      }
    });
    expect(order).toEqual(["drain", "read"]);
    expect(result).toBe("available");
  });

  it("accepts only the exact double-reload ownership-transfer evidence", () => {
    const report = buildPartyCheckpointTransferReport(passing());
    expect(report.passed).toBe(true);
    expect(report.failureCodes).toEqual([]);
  });

  it("fails every safety and continuity boundary independently", () => {
    for (const mutation of [
      { recoveryCardsObserved: 1 },
      { transfersCompleted: 1 },
      { payloadTransfersVerified: 1 },
      { visibleStateApplicationsVerified: 1 },
      { libraryCounterDrifts: 1 },
      { deckStartAttempts: 1 },
      { contextResumeAttempts: 1 },
      { wakeLockRequests: 1 },
      { activeDecksAfter: 1 },
      { autoPilotActiveAfter: true },
      { recoveryFocusPreserved: 1 },
      { restoredFocusVerified: 1 },
      { removalFocusVerified: false },
      { exactCleanupVerified: false },
      { checkpointStatusAfter: "available" as const },
      { externalRequests: 1 },
      { uncaughtErrors: 1 },
      { unhandledRejections: 1 },
      { timedOut: true },
      { aborted: true }
    ]) {
      expect(buildPartyCheckpointTransferReport({ ...passing(), ...mutation } as ReturnType<typeof passing>).passed)
        .toBe(false);
    }
  });

  it("rejects hostile shapes, private-looking extras, and unbounded counters", () => {
    expect(() => buildPartyCheckpointTransferReport({
      ...passing(),
      filename: "private-song.wav"
    } as never)).toThrow();
    expect(() => buildPartyCheckpointTransferReport({
      ...passing(),
      fixtureTracks: Number.MAX_SAFE_INTEGER
    })).toThrow();
    expect(JSON.stringify(buildPartyCheckpointTransferReport(passing())))
      .not.toMatch(/private-song|trackId|writerToken|sessionId|errorText|userAgent/i);
  });
});
