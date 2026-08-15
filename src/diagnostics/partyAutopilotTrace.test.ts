import { describe, expect, it } from "vitest";
import {
  createPartyAutopilotTraceRecorder,
  evaluatePartyAutopilotTrace,
  type PartyAutopilotEvent,
  type PartyAutopilotEventInput,
  type PartyAutopilotTrace
} from "./partyAutopilotTrace";

const record = (events: readonly PartyAutopilotEventInput[]) => {
  const recorder = createPartyAutopilotTraceRecorder();
  events.forEach((event) => expect(recorder.append(event)).toBe(true));
  return recorder.snapshot();
};

const happyTerminalEvents: readonly PartyAutopilotEventInput[] = [
  { type: "session-started", activeSecond: 0 },
  { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2, 3] },
  { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
  { type: "preload-started", activeSecond: 2, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
  { type: "preload-settled", activeSecond: 4, operation: 1, outcome: "committed" },
  { type: "queue-committed", activeSecond: 4, revision: 2, trackOrdinals: [3] },
  { type: "arm-started", activeSecond: 199, operation: 1, origin: "autopilot" },
  { type: "arm-settled", activeSecond: 200, operation: 1, outcome: "scheduled", pauseRequired: false },
  { type: "transition-scheduled", activeSecond: 200, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "autopilot", template: "safe-fade" },
  { type: "transition-completed", activeSecond: 204, transition: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, settledBy: "primary", completionOutcome: "on-time", pauseRequired: false },
  { type: "preload-started", activeSecond: 206, operation: 2, generation: 2, deck: "a", trackOrdinal: 3, loadOrdinal: 3, selectionSource: "queue" },
  { type: "preload-settled", activeSecond: 208, operation: 2, outcome: "committed" },
  { type: "queue-committed", activeSecond: 208, revision: 3, trackOrdinals: [] },
  { type: "arm-started", activeSecond: 409, operation: 2, origin: "autopilot" },
  { type: "arm-settled", activeSecond: 410, operation: 2, outcome: "scheduled", pauseRequired: false },
  { type: "transition-scheduled", activeSecond: 410, transition: 2, sourceTrackOrdinal: 2, sourceLoadOrdinal: 2, targetTrackOrdinal: 3, targetLoadOrdinal: 3, ownership: "autopilot", template: "downbeat-cut" },
  { type: "transition-completed", activeSecond: 411, transition: 2, targetTrackOrdinal: 3, targetLoadOrdinal: 3, settledBy: "primary", completionOutcome: "on-time", pauseRequired: false },
  { type: "final-declared", activeSecond: 412, deck: "a", trackOrdinal: 3, loadOrdinal: 3 },
  { type: "deck-ended", activeSecond: 620, deck: "a", trackOrdinal: 3, loadOrdinal: 3, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
  { type: "session-ended", activeSecond: 620, reason: "final-track-ended" }
];

describe("Party Autopilot trace", () => {
  it("accepts a complete three-track session with exact transition and final ownership", () => {
    const evaluation = evaluatePartyAutopilotTrace(record(happyTerminalEvents));
    expect(evaluation.status).toBe("valid-terminal");
    expect(evaluation.failureCodes).toEqual([]);
    expect(evaluation.counters).toEqual({
      playedTracks: 3,
      preloadsCommitted: 2,
      preloadsTimedOut: 0,
      armFailures: 0,
      armTimeouts: 0,
      transitionsCompleted: 2,
      transitionsRescued: 0,
      transitionsCancelled: 0,
      transitionCompletionRecoveries: 0,
      lateTransitionCompletions: 0,
      transitionCompletionFailures: 0,
      transitionCompletionCleanupFailures: 0,
      coordinatorFailures: 0,
      deckCompletionRecoveries: 0,
      lateDeckCompletions: 0,
      deckCompletionFailures: 0,
      fallbackStarts: 0,
      fallbackFailures: 0,
      pauses: 0
    });
  });

  it("consumes an exact committed target after non-final EOF and requires failure to pause", () => {
    const prefix: readonly PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 1, operation: 1, outcome: "committed" },
      { type: "queue-committed", activeSecond: 1, revision: 2, trackOrdinals: [] },
      { type: "deck-ended", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "fallback-started", activeSecond: 2, operation: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, cause: "natural-eof" }
    ];
    const scheduled = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "fallback-settled", activeSecond: 2, operation: 1, outcome: "scheduled", pauseRequired: false }
    ]));
    expect(scheduled.status).toBe("valid-in-progress");
    expect(scheduled.failureCodes).toEqual([]);
    expect(scheduled.counters).toMatchObject({ playedTracks: 2, fallbackStarts: 1, fallbackFailures: 0 });

    const failed = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "fallback-settled", activeSecond: 2, operation: 1, outcome: "failed", pauseRequired: true },
      { type: "session-paused", activeSecond: 2, reason: "source-stopped" }
    ]));
    expect(failed.failureCodes).toEqual([]);
    expect(failed.counters).toMatchObject({ fallbackStarts: 1, fallbackFailures: 1, pauses: 1 });

    const missingPause = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "fallback-settled", activeSecond: 2, operation: 1, outcome: "failed", pauseRequired: true }
    ]));
    expect(missingPause.failureCodes).toContain("deck-completion-not-paused");
  });

  it("rejects fallback evidence with a same-deck target, open arm, or queued target", () => {
    const fallbackTail: readonly PartyAutopilotEventInput[] = [
      { type: "deck-ended", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "fallback-started", activeSecond: 2, operation: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, cause: "natural-eof" },
      { type: "fallback-settled", activeSecond: 2, operation: 1, outcome: "scheduled", pauseRequired: false }
    ];
    const prefix = (deck: "a" | "b", consumeQueue: boolean): PartyAutopilotEventInput[] => [
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck, trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 1, operation: 1, outcome: "committed" },
      ...(consumeQueue ? [{ type: "queue-committed", activeSecond: 1, revision: 2, trackOrdinals: [] } as const] : [])
    ];
    expect(evaluatePartyAutopilotTrace(record([...prefix("a", true), ...fallbackTail])).failureCodes)
      .toContain("fallback-owner-mismatch");
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix("b", true),
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "autopilot" },
      ...fallbackTail
    ])).failureCodes).toContain("fallback-owner-mismatch");
    expect(evaluatePartyAutopilotTrace(record([...prefix("b", false), ...fallbackTail])).failureCodes)
      .toContain("fallback-owner-mismatch");
  });

  it("consumes a preserved committed target only after an exact host recovery play", () => {
    const failedPrefix: readonly PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 1, operation: 1, outcome: "committed" },
      { type: "queue-committed", activeSecond: 1, revision: 2, trackOrdinals: [] },
      { type: "deck-ended", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "fallback-started", activeSecond: 2, operation: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, cause: "natural-eof" },
      { type: "fallback-settled", activeSecond: 2, operation: 1, outcome: "failed", pauseRequired: true },
      { type: "session-paused", activeSecond: 2, reason: "source-stopped" },
      { type: "session-resumed", activeSecond: 2 }
    ];
    const exact = evaluatePartyAutopilotTrace(record([
      ...failedPrefix,
      { type: "track-played", activeSecond: 2, trackOrdinal: 2, loadOrdinal: 2, cause: "host" },
      { type: "final-declared", activeSecond: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 2 },
      { type: "deck-ended", activeSecond: 3, deck: "b", trackOrdinal: 2, loadOrdinal: 2, nativeOwnerOrdinal: 2, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-ended", activeSecond: 3, reason: "final-track-ended" }
    ]));
    expect(exact.status).toBe("valid-terminal");
    expect(exact.failureCodes).toEqual([]);

    const replacement = evaluatePartyAutopilotTrace(record([
      ...failedPrefix,
      { type: "track-played", activeSecond: 2, trackOrdinal: 2, loadOrdinal: 3, cause: "host" },
      { type: "final-declared", activeSecond: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 3 },
      { type: "deck-ended", activeSecond: 3, deck: "b", trackOrdinal: 2, loadOrdinal: 3, nativeOwnerOrdinal: 2, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-ended", activeSecond: 3, reason: "final-track-ended" }
    ]));
    expect(replacement.failureCodes).toContain("session-ended-with-open-operation");
  });

  it("requires invalidated preloads to settle without becoming transition targets", () => {
    const trace = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 2, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "session-paused", activeSecond: 2, reason: "host-request" },
      { type: "preload-settled", activeSecond: 2, operation: 1, outcome: "discarded" },
      { type: "session-resumed", activeSecond: 2 },
      { type: "transition-scheduled", activeSecond: 3, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "autopilot", template: "safe-fade" }
    ]);
    expect(evaluatePartyAutopilotTrace(trace).failureCodes).toContain("uncommitted-autopilot-target");
    expect(evaluatePartyAutopilotTrace(trace).failureCodes).toContain("preload-not-settled-before-pause");
  });

  it("accepts exact preload supersession before pause and a fresh resumed operation", () => {
    const evaluation = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 2, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 2, operation: 1, outcome: "superseded" },
      { type: "session-paused", activeSecond: 2, reason: "host-request" },
      { type: "session-resumed", activeSecond: 2 },
      { type: "preload-started", activeSecond: 3, operation: 2, generation: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 3, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 3, operation: 2, outcome: "committed" },
      { type: "queue-committed", activeSecond: 3, revision: 2, trackOrdinals: [] }
    ]));

    expect(evaluation.status).toBe("valid-in-progress");
    expect(evaluation.failureCodes).toEqual([]);
    expect(evaluation.counters).toMatchObject({ preloadsCommitted: 1, pauses: 1 });
  });

  it("requires source-stopped pause to settle its active preload first", () => {
    const valid = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 2, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 2, operation: 1, outcome: "superseded" },
      { type: "session-paused", activeSecond: 2, reason: "source-stopped" }
    ]));
    expect(valid.failureCodes).toEqual([]);
    expect(valid.counters.pauses).toBe(1);
  });

  it("requires every arm operation to settle and rejects mismatched ownership", () => {
    const openArm = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 2, operation: 1, origin: "autopilot" },
      { type: "final-declared", activeSecond: 3, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "deck-ended", activeSecond: 4, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-ended", activeSecond: 4, reason: "final-track-ended" }
    ]);
    expect(evaluatePartyAutopilotTrace(openArm).failureCodes).toContain("session-ended-with-open-operation");

    const wrongArm = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 2, operation: 1, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 2, operation: 2, outcome: "cancelled", pauseRequired: false }
    ]);
    expect(evaluatePartyAutopilotTrace(wrongArm).failureCodes).toContain("arm-owner-mismatch");

    const transitionWithoutArm = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "transition-scheduled", activeSecond: 2, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" }
    ]);
    expect(evaluatePartyAutopilotTrace(transitionWithoutArm).failureCodes).toContain("arm-owner-mismatch");
  });

  it("allows one Autopilot arm retry and requires an owned pause after the second failure", () => {
    const valid = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 1, operation: 1, outcome: "failed", pauseRequired: false },
      { type: "arm-started", activeSecond: 2, operation: 2, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 2, operation: 2, outcome: "timed-out", pauseRequired: true },
      { type: "session-paused", activeSecond: 2, reason: "transition-arm" }
    ]));
    expect(valid.status).toBe("valid-in-progress");
    expect(valid.counters).toMatchObject({ armFailures: 2, armTimeouts: 1, pauses: 1 });

    const missingPause = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 1, operation: 1, outcome: "failed", pauseRequired: false },
      { type: "arm-started", activeSecond: 2, operation: 2, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 2, operation: 2, outcome: "failed", pauseRequired: false }
    ]));
    expect(missingPause.failureCodes).toContain("arm-failure-not-paused");

    const hostCannotOwnPolicyPause = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 1, operation: 1, outcome: "failed", pauseRequired: true }
    ]));
    expect(hostCannotOwnPolicyPause.failureCodes).toContain("unexpected-arm-failure-pause");
  });

  it("rejects repeated tracks and mismatched transition completion", () => {
    const trace = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "track-played", activeSecond: 1, trackOrdinal: 1, loadOrdinal: 2, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 2, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 2, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 3, ownership: "host", template: "safe-fade" },
      { type: "transition-completed", activeSecond: 3, transition: 1, targetTrackOrdinal: 3, targetLoadOrdinal: 4, settledBy: "primary", completionOutcome: "on-time", pauseRequired: false }
    ]);
    expect(evaluatePartyAutopilotTrace(trace).failureCodes).toEqual(expect.arrayContaining([
      "track-repeated",
      "transition-owner-mismatch"
    ]));
  });

  it("models source- and target-side Rescue without automatically resuming", () => {
    const sourceKept = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 9, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 10, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 10, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" },
      { type: "transition-rescued", activeSecond: 11, transition: 1, kept: "source" },
      { type: "session-paused", activeSecond: 11, reason: "rescue" }
    ]));
    const targetKept = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 9, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 10, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 10, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" },
      { type: "transition-rescued", activeSecond: 11, transition: 1, kept: "target" },
      { type: "session-paused", activeSecond: 11, reason: "rescue" }
    ]));
    expect(sourceKept.status).toBe("valid-in-progress");
    expect(sourceKept.counters.playedTracks).toBe(1);
    expect(targetKept.status).toBe("valid-in-progress");
    expect(targetKept.counters.playedTracks).toBe(2);
  });

  it("preserves a committed target across Stop All Sound and a paused resume", () => {
    const evaluation = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 2, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 3, operation: 1, outcome: "committed" },
      { type: "queue-committed", activeSecond: 3, revision: 2, trackOrdinals: [] },
      { type: "arm-started", activeSecond: 8, operation: 1, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 9, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 9, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "autopilot", template: "safe-fade" },
      { type: "transition-cancelled", activeSecond: 10, transition: 1, reason: "stop-all-sound", targetPreserved: true },
      { type: "session-paused", activeSecond: 10, reason: "stop-all-sound" },
      { type: "session-resumed", activeSecond: 11 },
      { type: "arm-started", activeSecond: 12, operation: 2, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 12, operation: 2, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 12, transition: 2, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "autopilot", template: "safe-fade" },
      { type: "transition-completed", activeSecond: 16, transition: 2, targetTrackOrdinal: 2, targetLoadOrdinal: 2, settledBy: "primary", completionOutcome: "on-time", pauseRequired: false }
    ]));

    expect(evaluation.status).toBe("valid-in-progress");
    expect(evaluation.failureCodes).toEqual([]);
    expect(evaluation.counters).toMatchObject({ transitionsCancelled: 1, transitionsCompleted: 1, pauses: 1 });
  });

  it("requires the stop-specific pause immediately after a transition cancellation", () => {
    const cancellation: readonly PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 1, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 1, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" },
      { type: "transition-cancelled", activeSecond: 2, transition: 1, reason: "stop-all-sound", targetPreserved: true }
    ];
    const missing = evaluatePartyAutopilotTrace(record(cancellation));
    const wrongReason = evaluatePartyAutopilotTrace(record([
      ...cancellation,
      { type: "session-paused", activeSecond: 2, reason: "host-request" }
    ]));
    const delayed = evaluatePartyAutopilotTrace(record([
      ...cancellation,
      { type: "queue-committed", activeSecond: 2, revision: 1, trackOrdinals: [] },
      { type: "session-paused", activeSecond: 2, reason: "stop-all-sound" }
    ]));

    expect(missing.failureCodes).toContain("stop-all-sound-not-paused");
    expect(wrongReason.failureCodes).toContain("stop-all-sound-not-paused");
    expect(delayed.failureCodes).toContain("stop-all-sound-not-paused");
  });

  it("revokes stale final ownership and rejects the old deck end", () => {
    const trace = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "final-declared", activeSecond: 30, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "final-revoked", activeSecond: 31 },
      { type: "deck-ended", activeSecond: 32, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-ended", activeSecond: 32, reason: "final-track-ended" }
    ]);
    expect(evaluatePartyAutopilotTrace(trace).failureCodes).toContain("session-ended-without-final");
  });

  it("fails closed on malformed order, interruption, and overflow", () => {
    expect(evaluatePartyAutopilotTrace(createPartyAutopilotTraceRecorder().snapshot()).failureCodes)
      .toContain("empty-trace");
    const recorder = createPartyAutopilotTraceRecorder(1);
    expect(recorder.append({ type: "session-started", activeSecond: 2 })).toBe(true);
    expect(recorder.append({ type: "session-paused", activeSecond: 2, reason: "host-request" })).toBe(false);
    const overflowEvaluation = evaluatePartyAutopilotTrace(recorder.snapshot());
    expect(overflowEvaluation.failureCodes).toContain("trace-overflow");

    const malformed = record([
      { type: "session-started", activeSecond: 2 },
      { type: "session-paused", activeSecond: 1, reason: "host-request" }
    ]);
    const mutated = { ...malformed, events: malformed.events.map((event, index) =>
      index === 1 ? { ...event, sequence: 4 } : event) } as PartyAutopilotTrace;
    expect(evaluatePartyAutopilotTrace(mutated).failureCodes).toEqual(expect.arrayContaining([
      "sequence-gap",
      "active-time-regressed"
    ]));

    const interruptedRecorder = createPartyAutopilotTraceRecorder();
    interruptedRecorder.append({ type: "session-started", activeSecond: 0 });
    interruptedRecorder.markInterrupted();
    expect(evaluatePartyAutopilotTrace(interruptedRecorder.snapshot()).failureCodes).toContain("trace-interrupted");

    const malformedArm = createPartyAutopilotTraceRecorder();
    expect(malformedArm.append({ type: "arm-settled", activeSecond: 0, operation: 1, outcome: "scheduled" } as PartyAutopilotEventInput))
      .toBe(false);
    expect(evaluatePartyAutopilotTrace(malformedArm.snapshot()).failureCodes).toContain("trace-interrupted");
  });

  it("rejects operations outside the running session and events after terminal", () => {
    const beforeStart = record([
      { type: "preload-started", activeSecond: 0, operation: 1, generation: 1, deck: "b", trackOrdinal: 1, loadOrdinal: 1, selectionSource: "queue" }
    ]);
    expect(evaluatePartyAutopilotTrace(beforeStart).failureCodes).toContain("invalid-session-lifecycle");

    const afterTerminal = record([
      { type: "session-started", activeSecond: 0 },
      { type: "final-declared", activeSecond: 1, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "deck-ended", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-ended", activeSecond: 2, reason: "final-track-ended" },
      { type: "final-revoked", activeSecond: 2 }
    ]);
    expect(evaluatePartyAutopilotTrace(afterTerminal).failureCodes).toContain("invalid-session-lifecycle");
  });

  it("rejects retrying a track already proven unplayable in this session", () => {
    const trace = record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2, 3] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 2, operation: 1, outcome: "unplayable" },
      { type: "preload-started", activeSecond: 3, operation: 2, generation: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 3, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 4, operation: 2, outcome: "unplayable" }
    ]);
    expect(evaluatePartyAutopilotTrace(trace).failureCodes).toContain("unplayable-track-retried");
  });

  it("allows retry only after a successful manual load restores playability", () => {
    const trace = record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 2, operation: 1, outcome: "unplayable" },
      { type: "session-paused", activeSecond: 3, reason: "host-control" },
      { type: "track-playability-restored", activeSecond: 3, trackOrdinal: 2 },
      { type: "session-resumed", activeSecond: 4 },
      { type: "preload-started", activeSecond: 5, operation: 2, generation: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 3, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 6, operation: 2, outcome: "failed" }
    ]);
    expect(evaluatePartyAutopilotTrace(trace).failureCodes).not.toContain("unplayable-track-retried");
  });

  it("rejects retrying a timed-out preload unless a manual load restores it", () => {
    const rejected = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 21, operation: 1, outcome: "timed-out" },
      { type: "preload-started", activeSecond: 22, operation: 2, generation: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 3, selectionSource: "queue" }
    ]));
    expect(rejected.failureCodes).toContain("timed-out-track-retried");
    expect(rejected.counters.preloadsTimedOut).toBe(1);

    const restored = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 21, operation: 1, outcome: "timed-out" },
      { type: "session-paused", activeSecond: 21, reason: "host-control" },
      { type: "track-playability-restored", activeSecond: 21, trackOrdinal: 2 },
      { type: "session-resumed", activeSecond: 22 },
      { type: "preload-started", activeSecond: 23, operation: 2, generation: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 3, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 24, operation: 2, outcome: "failed" }
    ]));
    expect(restored.failureCodes).not.toContain("timed-out-track-retried");
  });

  it("requires the second consecutive timeout to pause immediately and rejects premature timeout pauses", () => {
    const missingPause = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2, 3] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 21, operation: 1, outcome: "timed-out" },
      { type: "preload-started", activeSecond: 22, operation: 2, generation: 2, deck: "b", trackOrdinal: 3, loadOrdinal: 3, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 42, operation: 2, outcome: "timed-out" }
    ]));
    expect(missingPause.failureCodes).toContain("preload-timeout-not-paused");

    const prematurePause = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "session-paused", activeSecond: 1, reason: "preload-timeout" }
    ]));
    expect(prematurePause.failureCodes).toContain("unexpected-preload-timeout-pause");

    const runwayPause = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "session-paused", activeSecond: 1, reason: "preload-runway" }
    ]));
    expect(runwayPause.status).toBe("valid-in-progress");
  });

  it("requires an immediate completion-safety pause after a late owned handoff", () => {
    const prefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 2, operation: 1, outcome: "committed" },
      { type: "queue-committed", activeSecond: 2, revision: 2, trackOrdinals: [] },
      { type: "arm-started", activeSecond: 3, operation: 1, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 3, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 3, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "autopilot", template: "safe-fade" },
      { type: "transition-completed", activeSecond: 8, transition: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, settledBy: "watchdog", completionOutcome: "late", pauseRequired: true }
    ];
    const valid = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "session-paused", activeSecond: 8, reason: "transition-completion" }
    ]));
    expect(valid.failureCodes).not.toContain("transition-completion-not-paused");
    expect(valid.counters.transitionCompletionRecoveries).toBe(1);
    expect(valid.counters.lateTransitionCompletions).toBe(1);

    expect(evaluatePartyAutopilotTrace(record(prefix)).failureCodes)
      .toContain("transition-completion-not-paused");
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "session-paused", activeSecond: 8, reason: "host-control" }
    ])).failureCodes).toContain("transition-completion-not-paused");
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "queue-committed", activeSecond: 8, revision: 2, trackOrdinals: [] },
      { type: "session-paused", activeSecond: 8, reason: "transition-completion" }
    ])).failureCodes).toContain("transition-completion-not-paused");
  });

  it("keeps failed completion ownership until a paused Rescue or Stop resolves it", () => {
    const failedPrefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [2] },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 1, generation: 1, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "queue" },
      { type: "preload-settled", activeSecond: 2, operation: 1, outcome: "committed" },
      { type: "queue-committed", activeSecond: 2, revision: 2, trackOrdinals: [] },
      { type: "arm-started", activeSecond: 3, operation: 1, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 3, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 3, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "autopilot", template: "safe-fade" },
      { type: "transition-completion-failed", activeSecond: 8, transition: 1, reason: "ownership-lost", pauseRequired: true },
      { type: "session-paused", activeSecond: 8, reason: "transition-completion" }
    ];
    expect(evaluatePartyAutopilotTrace(record(failedPrefix)).failureCodes)
      .toContain("transition-completion-unresolved");

    for (const resolution of [
      { type: "transition-rescued", activeSecond: 8, transition: 1, kept: "source" },
      { type: "transition-rescued", activeSecond: 8, transition: 1, kept: "target" },
      { type: "transition-cancelled", activeSecond: 8, transition: 1, reason: "stop-all-sound", targetPreserved: true },
      { type: "transition-cancelled", activeSecond: 8, transition: 1, reason: "stop-all-sound", targetPreserved: false }
    ] as const) {
      const evaluation = evaluatePartyAutopilotTrace(record([...failedPrefix, resolution]));
      expect(evaluation.failureCodes).toEqual([]);
      expect(evaluation.status).toBe("valid-in-progress");
    }
  });

  it("distinguishes late completion from cleanup degradation", () => {
    const cleanupEvents = happyTerminalEvents.map((event) => event.type === "transition-completed"
      ? { ...event, completionOutcome: "cleanup-degraded" as const, pauseRequired: true }
      : event);
    const firstCompletion = cleanupEvents.findIndex((event) => event.type === "transition-completed");
    cleanupEvents.splice(firstCompletion + 1, 0, {
      type: "session-paused",
      activeSecond: cleanupEvents[firstCompletion].activeSecond,
      reason: "transition-completion"
    });
    const evaluation = evaluatePartyAutopilotTrace(record(cleanupEvents.slice(0, firstCompletion + 2)));
    expect(evaluation.counters.lateTransitionCompletions).toBe(0);
    expect(evaluation.counters.transitionCompletionCleanupFailures).toBe(1);

    const lateAndDegradedEvents = happyTerminalEvents.map((event) => event.type === "transition-completed"
      ? { ...event, settledBy: "watchdog" as const, completionOutcome: "late-cleanup-degraded" as const, pauseRequired: true }
      : event);
    const combinedCompletion = lateAndDegradedEvents.findIndex((event) => event.type === "transition-completed");
    lateAndDegradedEvents.splice(combinedCompletion + 1, 0, {
      type: "session-paused",
      activeSecond: lateAndDegradedEvents[combinedCompletion].activeSecond,
      reason: "transition-completion"
    });
    const combined = evaluatePartyAutopilotTrace(record(lateAndDegradedEvents.slice(0, combinedCompletion + 2)));
    expect(combined.counters.transitionCompletionRecoveries).toBe(1);
    expect(combined.counters.lateTransitionCompletions).toBe(1);
    expect(combined.counters.transitionCompletionCleanupFailures).toBe(1);
  });

  it("requires exactly one immediate safety pause after a coordinator failure", () => {
    const prefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "coordinator-failed", activeSecond: 4, operation: 7, phase: "decision", pauseRequired: true }
    ];
    const valid = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "session-paused", activeSecond: 4, reason: "coordinator-failure" }
    ]));
    expect(valid.failureCodes).toEqual([]);
    expect(valid.counters.coordinatorFailures).toBe(1);
    expect(valid.status).toBe("valid-in-progress");

    expect(evaluatePartyAutopilotTrace(record(prefix)).failureCodes)
      .toContain("coordinator-failure-not-paused");
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "session-paused", activeSecond: 4, reason: "host-request" }
    ])).failureCodes).toContain("coordinator-failure-not-paused");
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "queue-committed", activeSecond: 4, revision: 1, trackOrdinals: [] },
      { type: "session-paused", activeSecond: 4, reason: "coordinator-failure" }
    ])).failureCodes).toContain("coordinator-failure-not-paused");

    const openPreload = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "preload-started", activeSecond: 1, operation: 2, generation: 2, deck: "b", trackOrdinal: 2, loadOrdinal: 2, selectionSource: "library" },
      { type: "coordinator-failed", activeSecond: 1, operation: 8, phase: "preload", pauseRequired: true },
      { type: "session-paused", activeSecond: 1, reason: "coordinator-failure" }
    ]));
    expect(openPreload.failureCodes).toContain("preload-owner-mismatch");
  });

  it("keeps an active transition owned until paused coordinator recovery is resolved", () => {
    const prefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 1, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 1, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" },
      { type: "coordinator-failed", activeSecond: 2, operation: 9, phase: "transition-watchdog", pauseRequired: true },
      { type: "session-paused", activeSecond: 2, reason: "coordinator-failure" }
    ];

    const rescued = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "transition-rescued", activeSecond: 2, transition: 1, kept: "source" }
    ]));
    expect(rescued.failureCodes).toEqual([]);
    expect(rescued.counters.transitionsRescued).toBe(1);

    const stopped = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "transition-cancelled", activeSecond: 2, transition: 1, reason: "stop-all-sound", targetPreserved: true }
    ]));
    expect(stopped.failureCodes).toEqual([]);
    expect(stopped.counters.transitionsCancelled).toBe(1);

    expect(evaluatePartyAutopilotTrace(record(prefix)).failureCodes)
      .toContain("transition-completion-unresolved");
  });

  it("binds native deck completion provenance and requires exact terminal ordering", () => {
    const recoveredEvents = happyTerminalEvents.map((event) => event.type === "deck-ended"
      ? { ...event, settledBy: "audio-clock" as const, outcome: "recovered" as const }
      : event);
    const recovered = evaluatePartyAutopilotTrace(record(recoveredEvents));
    expect(recovered.failureCodes).toEqual([]);
    expect(recovered.counters.deckCompletionRecoveries).toBe(1);

    const lateEvents = happyTerminalEvents.map((event) => event.type === "deck-ended"
      ? { ...event, outcome: "late" as const }
      : event);
    const late = evaluatePartyAutopilotTrace(record(lateEvents));
    expect(late.failureCodes).toEqual([]);
    expect(late.counters.lateDeckCompletions).toBe(1);

    const duplicateIndex = recoveredEvents.findIndex((event) => event.type === "session-ended");
    const duplicateEvents = [...recoveredEvents];
    duplicateEvents.splice(duplicateIndex, 0, {
      type: "deck-ended",
      activeSecond: 620,
      deck: "a",
      trackOrdinal: 3,
      loadOrdinal: 3,
      nativeOwnerOrdinal: 1,
      settledBy: "audio-clock",
      outcome: "recovered"
    });
    expect(evaluatePartyAutopilotTrace(record(duplicateEvents)).failureCodes)
      .toContain("duplicate-deck-completion");

    const delayedTerminal = [...happyTerminalEvents];
    const terminalIndex = delayedTerminal.findIndex((event) => event.type === "session-ended");
    delayedTerminal.splice(terminalIndex, 0, {
      type: "queue-committed",
      activeSecond: 620,
      revision: 4,
      trackOrdinals: []
    });
    expect(evaluatePartyAutopilotTrace(record(delayedTerminal)).failureCodes)
      .toContain("session-ended-without-final");

    const pausedTerminal = [...happyTerminalEvents];
    const finalEndIndex = pausedTerminal.findIndex((event) => event.type === "deck-ended");
    pausedTerminal.splice(finalEndIndex, 0, {
      type: "session-paused",
      activeSecond: 620,
      reason: "host-request"
    });
    expect(evaluatePartyAutopilotTrace(record(pausedTerminal)).failureCodes)
      .toContain("invalid-session-lifecycle");
  });

  it("requires a safety pause after premature exact-source completion", () => {
    const prefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "deck-completion-failed", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", reason: "premature", pauseRequired: true }
    ];
    const valid = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "session-paused", activeSecond: 2, reason: "deck-completion" }
    ]));
    expect(valid.failureCodes).toEqual([]);
    expect(valid.counters.deckCompletionFailures).toBe(1);
    expect(evaluatePartyAutopilotTrace(record(prefix)).failureCodes)
      .toContain("deck-completion-not-paused");
  });

  it("consumes failed native and Party completion owners before a resumed callback", () => {
    const prefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "deck-completion-failed", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 7, settledBy: "source-onended", reason: "premature", pauseRequired: true },
      { type: "session-paused", activeSecond: 2, reason: "deck-completion" },
      { type: "session-resumed", activeSecond: 2 }
    ];
    const samePartyOwner = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "deck-ended", activeSecond: 3, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 8, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-paused", activeSecond: 3, reason: "source-stopped" }
    ]));
    expect(samePartyOwner.failureCodes).toContain("duplicate-deck-completion");

    const sameNativeOwner = evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "track-played", activeSecond: 2, trackOrdinal: 2, loadOrdinal: 2, cause: "host" },
      { type: "deck-ended", activeSecond: 3, deck: "a", trackOrdinal: 2, loadOrdinal: 2, nativeOwnerOrdinal: 7, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-paused", activeSecond: 3, reason: "source-stopped" }
    ]));
    expect(sameNativeOwner.failureCodes).toContain("duplicate-deck-completion");
  });

  it("requires an immediate source-stopped pause after a non-final natural ending", () => {
    const prefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "deck-ended", activeSecond: 20, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" }
    ];
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "session-paused", activeSecond: 20, reason: "source-stopped" }
    ])).failureCodes).toEqual([]);
    expect(evaluatePartyAutopilotTrace(record(prefix)).failureCodes)
      .toContain("deck-completion-not-paused");
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "queue-committed", activeSecond: 20, revision: 1, trackOrdinals: [] },
      { type: "session-paused", activeSecond: 20, reason: "source-stopped" }
    ])).failureCodes).toContain("deck-completion-not-paused");
  });

  it("rejects duplicate native completion ownership even if Party load evidence changes", () => {
    const evaluation = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "deck-ended", activeSecond: 20, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-paused", activeSecond: 20, reason: "source-stopped" },
      { type: "session-resumed", activeSecond: 20 },
      { type: "track-played", activeSecond: 20, trackOrdinal: 2, loadOrdinal: 2, cause: "host" },
      { type: "deck-ended", activeSecond: 40, deck: "a", trackOrdinal: 2, loadOrdinal: 2, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "on-time" },
      { type: "session-paused", activeSecond: 40, reason: "source-stopped" }
    ]));
    expect(evaluation.failureCodes).toContain("duplicate-deck-completion");
  });

  it("keeps a transition unresolved until paused deck-completion recovery finishes", () => {
    const prefix: PartyAutopilotEventInput[] = [
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 1, operation: 1, outcome: "scheduled", pauseRequired: false },
      { type: "transition-scheduled", activeSecond: 1, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" },
      { type: "deck-completion-failed", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", reason: "premature", pauseRequired: true },
      { type: "session-paused", activeSecond: 2, reason: "deck-completion" }
    ];
    expect(evaluatePartyAutopilotTrace(record(prefix)).failureCodes)
      .toContain("transition-completion-unresolved");
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "transition-rescued", activeSecond: 2, transition: 1, kept: "source" }
    ])).failureCodes).toEqual([]);
    expect(evaluatePartyAutopilotTrace(record([
      ...prefix,
      { type: "transition-cancelled", activeSecond: 2, transition: 1, reason: "stop-all-sound", targetPreserved: false }
    ])).failureCodes).toEqual([]);
  });

  it("records only bounded allowlisted fields", () => {
    const recorder = createPartyAutopilotTraceRecorder();
    recorder.append({ type: "session-started", activeSecond: 0, filename: "private.mp3", trackId: "secret" } as never);
    recorder.append({ type: "queue-committed", activeSecond: 0, revision: 1, trackOrdinals: [1] });
    const snapshot = recorder.snapshot();
    const json = JSON.stringify(snapshot);
    expect(json).not.toMatch(/trackId|filename|file|bpm|key|audioTime|userAgent|timestamp/i);
    expect(snapshot.privacy).toContain("no song metadata");
    expect(snapshot.evidenceScope).toContain("not audio continuity");
    expect(Object.isFrozen((snapshot.events[1] as Extract<PartyAutopilotEvent, { type: "queue-committed" }>).trackOrdinals)).toBe(true);

    const hostile = createPartyAutopilotTraceRecorder();
    expect(hostile.append({ type: "session-paused", activeSecond: 0, reason: "private filename.mp3" } as never)).toBe(false);
    expect(hostile.append({ type: "transition-scheduled", activeSecond: 0, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "private filename.mp3" } as never)).toBe(false);
    expect(hostile.append({ type: "final-declared", activeSecond: 0, deck: "private filename.mp3", trackOrdinal: 1, loadOrdinal: 1 } as never)).toBe(false);
    expect(hostile.append({ type: "queue-committed", activeSecond: 0, revision: "private filename.mp3", trackOrdinals: [1] } as never)).toBe(false);
    expect(hostile.append({ type: "coordinator-failed", activeSecond: 0, operation: 1, phase: "private filename.mp3", pauseRequired: true } as never)).toBe(false);
    expect(hostile.append({ type: "deck-ended", activeSecond: 0, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "timer", outcome: "recovered" } as never)).toBe(false);
    expect(hostile.append({ type: "deck-ended", activeSecond: 0, deck: "a", trackOrdinal: 1, loadOrdinal: 1, nativeOwnerOrdinal: 1, settledBy: "source-onended", outcome: "recovered" } as never)).toBe(false);
    const hostileJson = JSON.stringify(hostile.snapshot());
    expect(hostileJson).not.toContain("private filename.mp3");
    expect(hostile.snapshot().interrupted).toBe(true);
  });
});
