export const PARTY_DECK_COMPLETION_INGESTION_VERSION = "party-deck-completion-ingestion/v1" as const;

export type PartyDeck = "a" | "b";

export type PartyDeckLoadIdentity = Readonly<{
  trackId: string;
  trackOrdinal: number;
  loadOrdinal: number;
}>;

export type PartyDeckCompletionEvent = Readonly<{
  channel: PartyDeck;
  trackId: string | null;
  operation: number;
  loadRevision: number;
  settledBy: "source-onended" | "audio-clock" | "reconcile";
  outcome: "on-time" | "recovered" | "late" | "premature";
}>;

export type PartyDeckCompletionSnapshot = Readonly<{
  channel: PartyDeck;
  status: string;
  trackId: string | null;
  completionIntent: "natural" | "scheduled-stop" | null;
  completionOperation: number | null;
  completionLoadRevision: number | null;
}>;

export type PartyDeckCompletionDecision = Readonly<{
  version: typeof PARTY_DECK_COMPLETION_INGESTION_VERSION;
  kind:
    | "ignore-stale"
    | "finish-final"
    | "pause-premature"
    | "settle-transition-source"
    | "pause-unexpected-source"
    | "lock-transition"
    | "pause-conflict";
  reason:
    | "identity-mismatch"
    | "inactive-session"
    | "exact-final"
    | "premature"
    | "transition-source-ended"
    | "non-final-source-ended"
    | "transition-deck-ended"
    | "owner-unobservable"
    | "conflicting-owner";
}>;

export type PartyDeckCompletionInput = Readonly<{
  callbackDeck: PartyDeck;
  event: PartyDeckCompletionEvent;
  snapshot: PartyDeckCompletionSnapshot | null;
  partyLoad: PartyDeckLoadIdentity | null;
  masterDeck: PartyDeck;
  autoPilotOwned: boolean;
  traceRunning: boolean;
  finalOwner: Readonly<{ deck: PartyDeck; trackId: string; loadOrdinal: number }> | null;
  activeTransition: Readonly<{ source: PartyDeck; target: PartyDeck }> | null;
  armOwned: boolean;
  preloadOwned: boolean;
}>;

const positiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const result = (
  kind: PartyDeckCompletionDecision["kind"],
  reason: PartyDeckCompletionDecision["reason"]
): PartyDeckCompletionDecision => Object.freeze({
  version: PARTY_DECK_COMPLETION_INGESTION_VERSION,
  kind,
  reason
});

export const decidePartyDeckCompletion = (
  input: PartyDeckCompletionInput
): PartyDeckCompletionDecision => {
  const { event, snapshot, partyLoad } = input;
  const sessionOwnsCompletion = input.autoPilotOwned || input.traceRunning ||
    input.finalOwner != null || input.activeTransition != null || input.armOwned || input.preloadOwned;
  if (!snapshot || !partyLoad) {
    return sessionOwnsCompletion
      ? result("pause-conflict", "owner-unobservable")
      : result("ignore-stale", "inactive-session");
  }
  const validSignalOutcome = event.settledBy === "source-onended"
    ? ["on-time", "late", "premature"].includes(event.outcome)
    : ["audio-clock", "reconcile"].includes(event.settledBy) && event.outcome === "recovered";
  if (!validSignalOutcome) return result("ignore-stale", "identity-mismatch");
  const successful = event.outcome !== "premature";
  const exactNativeOwner = Boolean(
    input.callbackDeck === event.channel &&
    snapshot.channel === event.channel &&
    event.trackId && event.trackId === snapshot.trackId && event.trackId === partyLoad.trackId &&
    positiveSafeInteger(event.operation) && event.operation === snapshot.completionOperation &&
    positiveSafeInteger(event.loadRevision) && event.loadRevision === snapshot.completionLoadRevision &&
    snapshot.completionIntent === "natural" &&
    snapshot.status === (successful ? "ended" : "recoverable-error")
  );
  if (!exactNativeOwner) return result("ignore-stale", "identity-mismatch");

  if (!sessionOwnsCompletion) return result("ignore-stale", "inactive-session");

  const transitionOwnsSource = input.activeTransition?.source === input.callbackDeck;
  const transitionOwnsDeck = transitionOwnsSource || input.activeTransition?.target === input.callbackDeck;
  if (transitionOwnsSource && successful) {
    return result("settle-transition-source", "transition-source-ended");
  }
  if (transitionOwnsDeck) return result("lock-transition", "transition-deck-ended");

  // A materially early native ending is an audio-clock safety failure even if
  // a final declaration or arm is also open. App must preserve the structured
  // premature-failure settlement before revoking those higher-level owners.
  if (event.outcome === "premature") return result("pause-premature", "premature");

  const exactFinal = input.finalOwner?.deck === input.callbackDeck &&
    input.finalOwner.trackId === event.trackId &&
    input.finalOwner.loadOrdinal === partyLoad!.loadOrdinal;
  if (exactFinal && successful && !input.armOwned && !input.preloadOwned) {
    return result("finish-final", "exact-final");
  }
  if (input.finalOwner || input.armOwned) return result("pause-conflict", "conflicting-owner");
  if (input.callbackDeck === input.masterDeck && input.autoPilotOwned) {
    return result("pause-unexpected-source", "non-final-source-ended");
  }
  return result("pause-conflict", "conflicting-owner");
};

export const transitionCompletionSignalForDeckEvent = (
  event: PartyDeckCompletionEvent
): "primary" | "watchdog" => event.settledBy === "source-onended" ? "primary" : "watchdog";
