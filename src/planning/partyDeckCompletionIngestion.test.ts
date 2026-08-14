import { describe, expect, it } from "vitest";
import { decidePartyDeckCompletion, type PartyDeckCompletionInput } from "./partyDeckCompletionIngestion";

const base = (): PartyDeckCompletionInput => ({
  callbackDeck: "a",
  event: {
    channel: "a",
    trackId: "source",
    operation: 7,
    loadRevision: 11,
    settledBy: "source-onended",
    outcome: "on-time"
  },
  snapshot: {
    channel: "a",
    status: "ended",
    trackId: "source",
    completionIntent: "natural",
    completionOperation: 7,
    completionLoadRevision: 11
  },
  partyLoad: { trackId: "source", trackOrdinal: 1, loadOrdinal: 4 },
  masterDeck: "a",
  autoPilotOwned: true,
  traceRunning: true,
  finalOwner: null,
  activeTransition: null,
  armOwned: false,
  preloadOwned: false
});

describe("Party deck completion ingestion", () => {
  it("pauses an exact non-final master completion synchronously", () => {
    expect(decidePartyDeckCompletion(base())).toMatchObject({
      version: "party-deck-completion-ingestion/v1",
      kind: "pause-unexpected-source"
    });
  });

  it("finishes only an exact conflict-free final owner", () => {
    const input = base();
    expect(decidePartyDeckCompletion({
      ...input,
      finalOwner: { deck: "a", trackId: "source", loadOrdinal: 4 }
    }).kind).toBe("finish-final");
    expect(decidePartyDeckCompletion({
      ...input,
      finalOwner: { deck: "a", trackId: "source", loadOrdinal: 4 },
      preloadOwned: true
    }).kind).toBe("pause-conflict");
  });

  it("rejects stale same-track callbacks from another native operation or load", () => {
    const input = base();
    expect(decidePartyDeckCompletion({
      ...input,
      event: { ...input.event, operation: 6 }
    }).kind).toBe("ignore-stale");
    expect(decidePartyDeckCompletion({
      ...input,
      event: { ...input.event, loadRevision: 10 }
    }).kind).toBe("ignore-stale");
    expect(decidePartyDeckCompletion({
      ...input,
      event: { ...input.event, channel: "b" }
    }).kind).toBe("ignore-stale");
  });

  it("requires natural completion status and intent", () => {
    const input = base();
    expect(decidePartyDeckCompletion({
      ...input,
      snapshot: { ...input.snapshot!, completionIntent: "scheduled-stop" }
    }).kind).toBe("ignore-stale");
    expect(decidePartyDeckCompletion({
      ...input,
      snapshot: { ...input.snapshot!, status: "playing" }
    }).kind).toBe("ignore-stale");
  });

  it("rejects impossible signal and outcome pairs inside the shared boundary", () => {
    const input = base();
    expect(decidePartyDeckCompletion({
      ...input,
      event: { ...input.event, settledBy: "audio-clock", outcome: "on-time" }
    }).kind).toBe("ignore-stale");
    expect(decidePartyDeckCompletion({
      ...input,
      event: { ...input.event, settledBy: "source-onended", outcome: "recovered" }
    }).kind).toBe("ignore-stale");
  });

  it("routes an exact premature completion into safety recovery", () => {
    const input = base();
    const premature = {
      ...input,
      event: { ...input.event, outcome: "premature" },
      snapshot: { ...input.snapshot!, status: "recoverable-error" }
    } as const;
    expect(decidePartyDeckCompletion(premature).kind).toBe("pause-premature");
    expect(decidePartyDeckCompletion({
      ...premature,
      finalOwner: { deck: "a", trackId: "source", loadOrdinal: 4 }
    }).kind).toBe("pause-premature");
    expect(decidePartyDeckCompletion({
      ...premature,
      armOwned: true
    }).kind).toBe("pause-premature");
  });

  it("never treats either deck of an active transition as an ordinary ending", () => {
    const input = base();
    expect(decidePartyDeckCompletion({
      ...input,
      activeTransition: { source: "a", target: "b" }
    }).kind).toBe("lock-transition");
    expect(decidePartyDeckCompletion({
      ...input,
      callbackDeck: "b",
      event: { ...input.event, channel: "b", trackId: "target" },
      snapshot: { ...input.snapshot!, channel: "b", trackId: "target" },
      partyLoad: { trackId: "target", trackOrdinal: 2, loadOrdinal: 5 },
      activeTransition: { source: "a", target: "b" }
    }).kind).toBe("lock-transition");
  });

  it("ignores exact manual completions after session authority is gone", () => {
    const input = base();
    expect(decidePartyDeckCompletion({
      ...input,
      autoPilotOwned: false,
      traceRunning: false
    }).kind).toBe("ignore-stale");
  });

  it("pauses exact completion while an arm-only or preload-only owner is open", () => {
    const input = base();
    const inactive = { ...input, autoPilotOwned: false, traceRunning: false };
    expect(decidePartyDeckCompletion({ ...inactive, armOwned: true }).kind).toBe("pause-conflict");
    expect(decidePartyDeckCompletion({ ...inactive, preloadOwned: true }).kind).toBe("pause-conflict");
    expect(decidePartyDeckCompletion({
      ...inactive,
      armOwned: true,
      event: { ...input.event, outcome: "premature" },
      snapshot: { ...input.snapshot!, status: "recoverable-error" }
    }).kind).toBe("pause-premature");
  });

  it("fails closed when active Party authority cannot observe the current deck owner", () => {
    const input = base();
    expect(decidePartyDeckCompletion({ ...input, snapshot: null })).toMatchObject({
      kind: "pause-conflict",
      reason: "owner-unobservable"
    });
    expect(decidePartyDeckCompletion({ ...input, partyLoad: null }).kind).toBe("pause-conflict");
    expect(decidePartyDeckCompletion({
      ...input,
      snapshot: null,
      autoPilotOwned: false,
      traceRunning: false
    }).kind).toBe("ignore-stale");
  });
});
