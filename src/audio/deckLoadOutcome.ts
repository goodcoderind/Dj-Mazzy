export const DECK_LOAD_OUTCOME = Object.freeze({
  loaded: "loaded",
  unplayableFile: "unplayable-file",
  cancelled: "cancelled",
  audioBlocked: "audio-blocked"
} as const);

export type DeckLoadOutcome = typeof DECK_LOAD_OUTCOME[keyof typeof DECK_LOAD_OUTCOME];

export const shouldQuarantineAutoPilotLoad = ({
  outcome,
  autoPilotEnabled,
  operationCurrent
}: {
  outcome: DeckLoadOutcome;
  autoPilotEnabled: boolean;
  operationCurrent: boolean;
}) => outcome === DECK_LOAD_OUTCOME.unplayableFile && autoPilotEnabled && operationCurrent;
