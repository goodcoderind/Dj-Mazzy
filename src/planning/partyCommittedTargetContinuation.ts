export const PARTY_COMMITTED_TARGET_CONTINUATION_VERSION =
  "party-committed-target-continuation/v1" as const;

export type PartyContinuationDeck = "a" | "b";

export type PartyContinuationLoad = Readonly<{
  trackId: string;
  trackOrdinal: number;
  loadOrdinal: number;
}>;

export type PartyContinuationSnapshot = Readonly<{
  channel: PartyContinuationDeck;
  trackId: string | null;
  status: string;
  ready: boolean;
  playing: boolean;
  playbackRate: number;
}>;

export type PartyCommittedTargetContinuationDecision = Readonly<{
  version: typeof PARTY_COMMITTED_TARGET_CONTINUATION_VERSION;
  kind: "start-committed-target" | "pause-source-stopped";
  reason:
    | "exact-committed-target"
    | "session-not-authoritative"
    | "conflicting-owner"
    | "playback-locked"
    | "context-not-running"
    | "target-not-ready"
    | "target-identity-mismatch";
}>;

export type PartyCommittedTargetContinuationInput = Readonly<{
  sourceDeck: PartyContinuationDeck;
  targetDeck: PartyContinuationDeck;
  autoPilotOwned: boolean;
  contextState: AudioContextState;
  playbackLocked: boolean;
  conflictingOwner: boolean;
  targetSnapshot: PartyContinuationSnapshot | null;
  targetPartyLoad: PartyContinuationLoad | null;
  committedTarget: PartyContinuationLoad | null;
}>;

const positiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const validLoad = (value: PartyContinuationLoad | null): value is PartyContinuationLoad => Boolean(
  value && typeof value.trackId === "string" && value.trackId.length > 0 &&
  positiveSafeInteger(value.trackOrdinal) && positiveSafeInteger(value.loadOrdinal)
);

const result = (
  kind: PartyCommittedTargetContinuationDecision["kind"],
  reason: PartyCommittedTargetContinuationDecision["reason"]
): PartyCommittedTargetContinuationDecision => Object.freeze({
  version: PARTY_COMMITTED_TARGET_CONTINUATION_VERSION,
  kind,
  reason
});

export const decidePartyCommittedTargetContinuation = (
  input: PartyCommittedTargetContinuationInput
): PartyCommittedTargetContinuationDecision => {
  if (!input.autoPilotOwned || input.sourceDeck === input.targetDeck) {
    return result("pause-source-stopped", "session-not-authoritative");
  }
  if (input.conflictingOwner) return result("pause-source-stopped", "conflicting-owner");
  if (input.playbackLocked) return result("pause-source-stopped", "playback-locked");
  if (input.contextState !== "running") return result("pause-source-stopped", "context-not-running");

  const snapshot = input.targetSnapshot;
  if (!snapshot || snapshot.channel !== input.targetDeck || !snapshot.ready || snapshot.playing ||
    snapshot.status !== "ready" || snapshot.playbackRate !== 1) {
    return result("pause-source-stopped", "target-not-ready");
  }
  const partyLoad = input.targetPartyLoad;
  const committed = input.committedTarget;
  if (!validLoad(partyLoad) || !validLoad(committed) || snapshot.trackId !== partyLoad.trackId ||
    partyLoad.trackId !== committed.trackId || partyLoad.trackOrdinal !== committed.trackOrdinal ||
    partyLoad.loadOrdinal !== committed.loadOrdinal) {
    return result("pause-source-stopped", "target-identity-mismatch");
  }
  return result("start-committed-target", "exact-committed-target");
};
