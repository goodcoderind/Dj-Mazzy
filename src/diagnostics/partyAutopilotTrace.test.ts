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
  { type: "arm-settled", activeSecond: 200, operation: 1, outcome: "scheduled" },
  { type: "transition-scheduled", activeSecond: 200, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "autopilot", template: "safe-fade" },
  { type: "transition-completed", activeSecond: 204, transition: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2 },
  { type: "preload-started", activeSecond: 206, operation: 2, generation: 2, deck: "a", trackOrdinal: 3, loadOrdinal: 3, selectionSource: "queue" },
  { type: "preload-settled", activeSecond: 208, operation: 2, outcome: "committed" },
  { type: "queue-committed", activeSecond: 208, revision: 3, trackOrdinals: [] },
  { type: "arm-started", activeSecond: 409, operation: 2, origin: "autopilot" },
  { type: "arm-settled", activeSecond: 410, operation: 2, outcome: "scheduled" },
  { type: "transition-scheduled", activeSecond: 410, transition: 2, sourceTrackOrdinal: 2, sourceLoadOrdinal: 2, targetTrackOrdinal: 3, targetLoadOrdinal: 3, ownership: "autopilot", template: "downbeat-cut" },
  { type: "transition-completed", activeSecond: 411, transition: 2, targetTrackOrdinal: 3, targetLoadOrdinal: 3 },
  { type: "final-declared", activeSecond: 412, deck: "a", trackOrdinal: 3, loadOrdinal: 3 },
  { type: "deck-ended", activeSecond: 620, deck: "a", trackOrdinal: 3, loadOrdinal: 3 },
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
      transitionsCompleted: 2,
      transitionsRescued: 0,
      pauses: 0
    });
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
  });

  it("requires every arm operation to settle and rejects mismatched ownership", () => {
    const openArm = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 2, operation: 1, origin: "autopilot" },
      { type: "final-declared", activeSecond: 3, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "deck-ended", activeSecond: 4, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "session-ended", activeSecond: 4, reason: "final-track-ended" }
    ]);
    expect(evaluatePartyAutopilotTrace(openArm).failureCodes).toContain("session-ended-with-open-operation");

    const wrongArm = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 2, operation: 1, origin: "autopilot" },
      { type: "arm-settled", activeSecond: 2, operation: 2, outcome: "cancelled" }
    ]);
    expect(evaluatePartyAutopilotTrace(wrongArm).failureCodes).toContain("arm-owner-mismatch");

    const transitionWithoutArm = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "transition-scheduled", activeSecond: 2, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" }
    ]);
    expect(evaluatePartyAutopilotTrace(transitionWithoutArm).failureCodes).toContain("arm-owner-mismatch");
  });

  it("rejects repeated tracks and mismatched transition completion", () => {
    const trace = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "track-played", activeSecond: 1, trackOrdinal: 1, loadOrdinal: 2, cause: "host" },
      { type: "arm-started", activeSecond: 1, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 2, operation: 1, outcome: "scheduled" },
      { type: "transition-scheduled", activeSecond: 2, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 3, ownership: "host", template: "safe-fade" },
      { type: "transition-completed", activeSecond: 3, transition: 1, targetTrackOrdinal: 3, targetLoadOrdinal: 4 }
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
      { type: "arm-settled", activeSecond: 10, operation: 1, outcome: "scheduled" },
      { type: "transition-scheduled", activeSecond: 10, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" },
      { type: "transition-rescued", activeSecond: 11, transition: 1, kept: "source" },
      { type: "session-paused", activeSecond: 11, reason: "rescue" }
    ]));
    const targetKept = evaluatePartyAutopilotTrace(record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "arm-started", activeSecond: 9, operation: 1, origin: "host" },
      { type: "arm-settled", activeSecond: 10, operation: 1, outcome: "scheduled" },
      { type: "transition-scheduled", activeSecond: 10, transition: 1, sourceTrackOrdinal: 1, sourceLoadOrdinal: 1, targetTrackOrdinal: 2, targetLoadOrdinal: 2, ownership: "host", template: "safe-fade" },
      { type: "transition-rescued", activeSecond: 11, transition: 1, kept: "target" },
      { type: "session-paused", activeSecond: 11, reason: "rescue" }
    ]));
    expect(sourceKept.status).toBe("valid-in-progress");
    expect(sourceKept.counters.playedTracks).toBe(1);
    expect(targetKept.status).toBe("valid-in-progress");
    expect(targetKept.counters.playedTracks).toBe(2);
  });

  it("revokes stale final ownership and rejects the old deck end", () => {
    const trace = record([
      { type: "session-started", activeSecond: 0 },
      { type: "track-played", activeSecond: 0, trackOrdinal: 1, loadOrdinal: 1, cause: "host" },
      { type: "final-declared", activeSecond: 30, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "final-revoked", activeSecond: 31 },
      { type: "deck-ended", activeSecond: 32, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
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
  });

  it("rejects operations outside the running session and events after terminal", () => {
    const beforeStart = record([
      { type: "preload-started", activeSecond: 0, operation: 1, generation: 1, deck: "b", trackOrdinal: 1, loadOrdinal: 1, selectionSource: "queue" }
    ]);
    expect(evaluatePartyAutopilotTrace(beforeStart).failureCodes).toContain("invalid-session-lifecycle");

    const afterTerminal = record([
      { type: "session-started", activeSecond: 0 },
      { type: "final-declared", activeSecond: 1, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "deck-ended", activeSecond: 2, deck: "a", trackOrdinal: 1, loadOrdinal: 1 },
      { type: "session-ended", activeSecond: 2, reason: "final-track-ended" },
      { type: "final-revoked", activeSecond: 2 }
    ]);
    expect(evaluatePartyAutopilotTrace(afterTerminal).failureCodes).toContain("invalid-session-lifecycle");
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
    const hostileJson = JSON.stringify(hostile.snapshot());
    expect(hostileJson).not.toContain("private filename.mp3");
    expect(hostile.snapshot().interrupted).toBe(true);
  });
});
