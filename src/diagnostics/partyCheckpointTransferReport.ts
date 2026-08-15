export const PARTY_CHECKPOINT_TRANSFER_REPORT_VERSION =
  "party-checkpoint-transfer-browser-report/v1" as const;

export type PartyCheckpointTransferFailure =
  | "fixture"
  | "recovery-card"
  | "transfer"
  | "payload"
  | "app-state"
  | "audio-authority"
  | "focus"
  | "cleanup"
  | "browser"
  | "interrupted";

export type PartyCheckpointTransferReportInput = Readonly<{
  scenario: "double-reload-paused-plan";
  fixtureTracks: number;
  hydratedTracks: number;
  recoveryCardsObserved: number;
  transfersCompleted: number;
  payloadTransfersVerified: number;
  visibleStateApplicationsVerified: number;
  libraryCounterDrifts: number;
  deckStartAttempts: number;
  contextResumeAttempts: number;
  wakeLockRequests: number;
  activeDecksAfter: number;
  autoPilotActiveAfter: boolean;
  recoveryFocusPreserved: number;
  restoredFocusVerified: number;
  removalFocusVerified: boolean;
  exactCleanupVerified: boolean;
  checkpointStatusAfter: "cleared" | "available" | "other";
  externalRequests: number;
  uncaughtErrors: number;
  unhandledRejections: number;
  timedOut: boolean;
  aborted: boolean;
}>;

const boundedInteger = (value: unknown, maximum = 100) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;

export const shouldRecordPartyCheckpointTransferEvidence = ({
  finishing,
  instrumentationClosed,
  category
}: {
  finishing: boolean;
  instrumentationClosed: boolean;
  category: "phase" | "instrumentation";
}) => !instrumentationClosed && (!finishing || category === "instrumentation");

export const readPartyCheckpointTransferFinalState = async <T>({
  drain,
  read
}: {
  drain: () => Promise<void>;
  read: () => Promise<T>;
}) => {
  await drain();
  return read();
};

export const buildPartyCheckpointTransferReport = (
  input: PartyCheckpointTransferReportInput
) => {
  const exactKeys = [
    "aborted", "activeDecksAfter", "autoPilotActiveAfter",
    "checkpointStatusAfter", "contextResumeAttempts", "deckStartAttempts", "externalRequests",
    "exactCleanupVerified", "fixtureTracks", "hydratedTracks", "libraryCounterDrifts",
    "payloadTransfersVerified", "recoveryCardsObserved", "recoveryFocusPreserved",
    "removalFocusVerified", "restoredFocusVerified",
    "scenario", "timedOut", "transfersCompleted", "uncaughtErrors", "unhandledRejections",
    "visibleStateApplicationsVerified", "wakeLockRequests"
  ].sort();
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join("|") !== exactKeys.join("|") ||
      input.scenario !== "double-reload-paused-plan" ||
      ![input.fixtureTracks, input.hydratedTracks, input.recoveryCardsObserved,
        input.transfersCompleted, input.payloadTransfersVerified,
        input.visibleStateApplicationsVerified, input.libraryCounterDrifts,
        input.deckStartAttempts, input.contextResumeAttempts, input.wakeLockRequests,
        input.activeDecksAfter, input.recoveryFocusPreserved, input.restoredFocusVerified,
        input.externalRequests, input.uncaughtErrors, input.unhandledRejections]
        .every((value) => boundedInteger(value)) ||
      ![input.autoPilotActiveAfter, input.removalFocusVerified, input.exactCleanupVerified,
        input.timedOut, input.aborted]
        .every((value) => typeof value === "boolean") ||
      !["cleared", "available", "other"].includes(input.checkpointStatusAfter)) {
    throw new TypeError("Checkpoint transfer browser evidence is malformed.");
  }

  const failures: PartyCheckpointTransferFailure[] = [];
  if (input.fixtureTracks !== 4 || input.hydratedTracks !== 4) failures.push("fixture");
  if (input.recoveryCardsObserved !== 2) failures.push("recovery-card");
  if (input.transfersCompleted !== 2) failures.push("transfer");
  if (input.payloadTransfersVerified !== 2 || input.libraryCounterDrifts !== 0) failures.push("payload");
  if (input.visibleStateApplicationsVerified !== 2) failures.push("app-state");
  if (input.deckStartAttempts !== 0 || input.contextResumeAttempts !== 0 ||
      input.wakeLockRequests !== 0 || input.activeDecksAfter !== 0 || input.autoPilotActiveAfter) {
    failures.push("audio-authority");
  }
  if (input.recoveryFocusPreserved !== 2 || input.restoredFocusVerified !== 2 ||
      !input.removalFocusVerified) failures.push("focus");
  if (input.checkpointStatusAfter !== "cleared" || !input.exactCleanupVerified) failures.push("cleanup");
  if (input.externalRequests !== 0 || input.uncaughtErrors !== 0 || input.unhandledRejections !== 0) {
    failures.push("browser");
  }
  if (input.timedOut || input.aborted) failures.push("interrupted");

  return Object.freeze({
    schemaVersion: PARTY_CHECKPOINT_TRANSFER_REPORT_VERSION,
    scenario: input.scenario,
    passed: failures.length === 0,
    failureCodes: Object.freeze([...new Set(failures)]),
    counts: Object.freeze({
      fixtureTracks: input.fixtureTracks,
      hydratedTracks: input.hydratedTracks,
      recoveryCardsObserved: input.recoveryCardsObserved,
      transfersCompleted: input.transfersCompleted,
      payloadTransfersVerified: input.payloadTransfersVerified,
      visibleStateApplicationsVerified: input.visibleStateApplicationsVerified
    }),
    safety: Object.freeze({
      libraryCounterDrifts: input.libraryCounterDrifts,
      deckStartAttempts: input.deckStartAttempts,
      contextResumeAttempts: input.contextResumeAttempts,
      wakeLockRequests: input.wakeLockRequests,
      activeDecksAfter: input.activeDecksAfter,
      autoPilotActiveAfter: input.autoPilotActiveAfter
    }),
    focus: Object.freeze({
      recoveryCardsVisibleWithFocusPreserved: input.recoveryFocusPreserved,
      restoredCardsVerified: input.restoredFocusVerified,
      removalVerified: input.removalFocusVerified
    }),
    cleanup: Object.freeze({
      checkpointStatusAfter: input.checkpointStatusAfter,
      exactOwnerRevisionAndLibraryVerified: input.exactCleanupVerified
    }),
    browser: Object.freeze({
      externalRequests: input.externalRequests,
      uncaughtErrors: input.uncaughtErrors,
      unhandledRejections: input.unhandledRejections
    }),
    interrupted: input.timedOut || input.aborted,
    privacy: "Fixed enums, booleans, and capped counts only; no names, paths, IDs, tokens, hashes, timestamps, errors, Files, audio, or device metadata."
  });
};
