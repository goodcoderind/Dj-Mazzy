import React from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import AppFatalBoundary from "../AppFatalBoundary";
import "../App.css";
import { getAudioEngine } from "../audioContext";
import {
  loadLibraryRecoveryBundle,
  savePartySessionCheckpointToDb
} from "../libraryDb";
import { isPartySessionCheckpointOwnershipTransfer } from "../domain/partySessionCheckpoint";
import { MAZZY_ROOT_ERROR_OPTIONS } from "../reactRootErrorOptions";
import {
  buildPartyCheckpointTransferReport,
  readPartyCheckpointTransferFinalState,
  shouldRecordPartyCheckpointTransferEvidence
} from "./partyCheckpointTransferReport";

const statusElement = document.querySelector("#checkpoint-transfer-status");
const seedButton = document.querySelector("#checkpoint-transfer-seed");
const reportElement = document.querySelector("#checkpoint-transfer-report");
const rootElement = document.querySelector("#root");
if (!statusElement || !seedButton || !reportElement || !rootElement) {
  throw new Error("The checkpoint transfer diagnostic page is incomplete");
}

const SESSION_KEY = "mazzy-checkpoint-transfer-diagnostic/v2";
const engine = getAudioEngine();
let appRoot = null;
let cleanupPromise = null;
let finishPromise = null;
let terminal = false;
let instrumentationClosed = false;
let checkPending = false;
let beforeTransfer = null;
let removalExpected = null;
let timeoutId = 0;
let pollId = 0;
let recoveryWaitTimer = 0;
let observer = null;

const emptyEvidence = () => ({
  version: 2,
  phase: "import",
  hydratedTracks: 0,
  recoveryCardsObserved: 0,
  transfersCompleted: 0,
  payloadTransfersVerified: 0,
  visibleStateApplicationsVerified: 0,
  libraryCounterDrifts: 0,
  deckStartAttempts: 0,
  contextResumeAttempts: 0,
  wakeLockRequests: 0,
  recoveryFocusPreserved: 0,
  restoredFocusVerified: 0,
  exactCleanupVerified: false,
  externalRequests: 0,
  uncaughtErrors: 0,
  unhandledRejections: 0
});

const evidenceKeys = Object.keys(emptyEvidence()).sort().join("|");
const readEvidence = () => {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (!value || value.version !== 2 || Object.keys(value).sort().join("|") !== evidenceKeys ||
        !["import", "seeded", "transferred-once", "transferred-twice"].includes(value.phase)) return emptyEvidence();
    return value;
  } catch {
    return emptyEvidence();
  }
};
let evidence = readEvidence();
const saveEvidence = () => sessionStorage.setItem(SESSION_KEY, JSON.stringify(evidence));
const updateEvidence = (updates, category = "phase") => {
  if (!shouldRecordPartyCheckpointTransferEvidence({
    finishing: terminal,
    instrumentationClosed,
    category
  })) return false;
  evidence = { ...evidence, ...updates };
  saveEvidence();
  return true;
};
const updateInstrumentation = (updates) => updateEvidence(updates, "instrumentation");

const originalResume = engine.resume.bind(engine);
engine.resume = (...args) => {
  updateInstrumentation({ contextResumeAttempts: evidence.contextResumeAttempts + 1 });
  return originalResume(...args);
};
const deckPlayRestores = [];
for (const channel of ["a", "b"]) {
  const deck = engine.getDeck(channel);
  const originalPlay = deck.play.bind(deck);
  deckPlayRestores.push(() => { deck.play = originalPlay; });
  deck.play = (...args) => {
    updateInstrumentation({ deckStartAttempts: evidence.deckStartAttempts + 1 });
    return originalPlay(...args);
  };
}

const originalWakeLockDescriptor = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
try {
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async () => {
        updateInstrumentation({ wakeLockRequests: evidence.wakeLockRequests + 1 });
        return { released: false, release: async () => undefined, addEventListener: () => undefined };
      }
    }
  });
} catch { /* An unavailable wake API is already a zero-acquisition environment. */ }

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  try {
    const value = typeof input === "string" || input instanceof URL ? input : input.url;
    if (new URL(value, location.href).origin !== location.origin) {
      updateInstrumentation({ externalRequests: evidence.externalRequests + 1 });
    }
  } catch {
    updateInstrumentation({ externalRequests: evidence.externalRequests + 1 });
  }
  return originalFetch(input, init);
};
const onError = () => updateInstrumentation({ uncaughtErrors: evidence.uncaughtErrors + 1 });
const onUnhandledRejection = () => {
  updateInstrumentation({ unhandledRejections: evidence.unhandledRejections + 1 });
};
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onUnhandledRejection);

const cleanupPage = () => {
  if (cleanupPromise) return cleanupPromise;
  terminal = true;
  instrumentationClosed = true;
  cleanupPromise = (async () => {
    window.clearTimeout(timeoutId);
    window.clearInterval(pollId);
    window.clearTimeout(recoveryWaitTimer);
    observer?.disconnect();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    globalThis.fetch = originalFetch;
    engine.resume = originalResume;
    for (const restore of deckPlayRestores.splice(0)) restore();
    try {
      if (originalWakeLockDescriptor) Object.defineProperty(navigator, "wakeLock", originalWakeLockDescriptor);
      else delete navigator.wakeLock;
    } catch { /* Diagnostic teardown remains independent. */ }
    try { appRoot?.unmount(); } catch { /* Engine shutdown remains independent. */ }
    appRoot = null;
    try { engine.shutdownForFatalHostError(); } catch { /* Continue to context closure. */ }
    if (engine.context.state !== "closed") {
      try { await engine.context.close(); } catch {
        try { await engine.context.suspend(); } catch { /* Page teardown is complete. */ }
      }
    }
  })();
  return cleanupPromise;
};

const checkpointStatus = (record) => record?.recordStatus === "cleared"
  ? "cleared"
  : record?.recordStatus === "available" ? "available" : "other";

const finish = async ({ timedOut = false, aborted = false } = {}) => {
  if (finishPromise) return finishPromise;
  terminal = true;
  window.clearTimeout(timeoutId);
  window.clearInterval(pollId);
  window.clearTimeout(recoveryWaitTimer);
  observer?.disconnect();
  finishPromise = (async () => {
    let bundle = null;
    try {
      bundle = await readPartyCheckpointTransferFinalState({
        drain: () => new Promise((resolve) => window.setTimeout(resolve, 50)),
        read: () => loadLibraryRecoveryBundle()
      });
    } catch { /* Fixed failed report below. */ }
    instrumentationClosed = true;
    const finalEvidence = evidence;
    const report = buildPartyCheckpointTransferReport({
    scenario: "double-reload-paused-plan",
    fixtureTracks: Array.isArray(bundle?.tracks) ? bundle.tracks.length : 0,
    hydratedTracks: finalEvidence.hydratedTracks,
    recoveryCardsObserved: finalEvidence.recoveryCardsObserved,
    transfersCompleted: finalEvidence.transfersCompleted,
    payloadTransfersVerified: finalEvidence.payloadTransfersVerified,
    visibleStateApplicationsVerified: finalEvidence.visibleStateApplicationsVerified,
    libraryCounterDrifts: finalEvidence.libraryCounterDrifts,
    deckStartAttempts: finalEvidence.deckStartAttempts,
    contextResumeAttempts: finalEvidence.contextResumeAttempts,
    wakeLockRequests: finalEvidence.wakeLockRequests,
    activeDecksAfter: ["a", "b"].filter((channel) => engine.getDeck(channel).isActive()).length,
    autoPilotActiveAfter: [...document.querySelectorAll("button")]
      .some((button) => button.textContent?.includes("PAUSE AUTOPILOT")),
    recoveryFocusPreserved: finalEvidence.recoveryFocusPreserved,
    restoredFocusVerified: finalEvidence.restoredFocusVerified,
    removalFocusVerified: document.activeElement?.id === "party-mode-title",
    exactCleanupVerified: finalEvidence.exactCleanupVerified,
    checkpointStatusAfter: checkpointStatus(bundle?.checkpointRecord),
    externalRequests: finalEvidence.externalRequests,
    uncaughtErrors: finalEvidence.uncaughtErrors,
    unhandledRejections: finalEvidence.unhandledRejections,
    timedOut,
    aborted
    });
    reportElement.textContent = JSON.stringify(report, null, 2);
    statusElement.textContent = report.passed
      ? "The paused recovery survived two explicit writer transfers and reloads."
      : `The paused recovery transfer gate failed: ${report.failureCodes.join(", ")}.`;
    await cleanupPage();
  })();
  return finishPromise;
};

const visibleStateMatchesFixture = (checkpoint, tracks) => {
  const namesById = new Map(tracks.map((track) => [track.id, track.name]));
  const expectedQueueNames = checkpoint.remainingTrackIds.map((trackId) => namesById.get(trackId));
  const actualQueueNames = [...document.querySelectorAll(".queue-name")]
    .map((node) => node.textContent?.trim());
  const expectedSourceName = namesById.get(checkpoint.lastStableSourceTrackId);
  const clockText = [...document.querySelectorAll(".party-clock-status")]
    .some((node) => node.textContent?.includes("0h 2m active"));
  const duration = document.querySelector("#party-mode-duration");
  const energy = document.querySelector("#party-energy-profile");
  const includeLibrary = [...document.querySelectorAll(".party-mode-options input[type='checkbox']")][0];
  const restoredText = document.querySelector(".party-checkpoint-recovery.restored")?.textContent ?? "";
  return JSON.stringify(actualQueueNames) === JSON.stringify(expectedQueueNames) &&
    expectedSourceName && restoredText.includes(expectedSourceName) && clockText &&
    duration?.value === "120" && energy?.value === "journey" && includeLibrary?.checked === true;
};

const checkTransfer = async () => {
  if (terminal || checkPending || !beforeTransfer ||
      !document.body.textContent?.includes("PARTY PLAN RESTORED · PAUSED")) return;
  checkPending = true;
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  try {
    const bundle = await loadLibraryRecoveryBundle();
    if (terminal) return;
    const transferred = isPartySessionCheckpointOwnershipTransfer({
      previous: beforeTransfer,
      next: bundle.checkpointRecord,
      nextWriterToken: bundle.checkpointRecord?.writerToken ?? ""
    });
    const sameLibrary = bundle.libraryState.epoch === beforeTransfer.libraryEpoch &&
      bundle.libraryState.revision === beforeTransfer.libraryRevision;
    const visibleStateVerified = visibleStateMatchesFixture(beforeTransfer, bundle.tracks);
    const restoredFocused = document.activeElement?.textContent?.includes("PARTY PLAN RESTORED · PAUSED") === true;
    const first = evidence.phase === "seeded";
    updateEvidence({
      phase: first ? "transferred-once" : "transferred-twice",
      transfersCompleted: evidence.transfersCompleted + 1,
      payloadTransfersVerified: evidence.payloadTransfersVerified + (transferred ? 1 : 0),
      visibleStateApplicationsVerified: evidence.visibleStateApplicationsVerified + (visibleStateVerified ? 1 : 0),
      libraryCounterDrifts: evidence.libraryCounterDrifts + (sameLibrary ? 0 : 1),
      restoredFocusVerified: evidence.restoredFocusVerified + (restoredFocused ? 1 : 0)
    });
    if (!first && transferred && sameLibrary) {
      removalExpected = Object.freeze({
        revision: bundle.checkpointRecord.revision,
        sessionId: bundle.checkpointRecord.sessionId,
        writerToken: bundle.checkpointRecord.writerToken,
        libraryEpoch: bundle.libraryState.epoch,
        libraryRevision: bundle.libraryState.revision
      });
    }
    beforeTransfer = null;
    statusElement.textContent = first
      ? "FIRST TRANSFER CONFIRMED · reload before choosing or playing a song."
      : "SECOND TRANSFER CONFIRMED · remove the saved recovery copy with the real App action.";
  } catch {
    void finish({ aborted: true });
  } finally {
    checkPending = false;
  }
};

const checkRemoval = async () => {
  if (terminal || checkPending || evidence.phase !== "transferred-twice" ||
      document.body.textContent?.includes("PARTY PLAN RESTORED · PAUSED")) return;
  checkPending = true;
  try {
    const bundle = await loadLibraryRecoveryBundle();
    if (terminal) return;
    if (bundle.checkpointRecord?.recordStatus === "cleared") {
      const exactCleanup = Boolean(removalExpected &&
        bundle.checkpointRecord.revision === removalExpected.revision + 1 &&
        bundle.checkpointRecord.sessionId === removalExpected.sessionId &&
        bundle.checkpointRecord.writerToken === removalExpected.writerToken &&
        bundle.libraryState.epoch === removalExpected.libraryEpoch &&
        bundle.libraryState.revision === removalExpected.libraryRevision);
      updateEvidence({
        exactCleanupVerified: exactCleanup,
        libraryCounterDrifts: evidence.libraryCounterDrifts + (exactCleanup ? 0 : 1)
      });
      await finish();
    }
  } catch { /* Keep the bounded observer active. */ }
  checkPending = false;
};

const checkImport = async () => {
  if (terminal || checkPending || evidence.phase !== "import" || document.querySelectorAll(".library-row").length !== 4) return;
  checkPending = true;
  try {
    const bundle = await loadLibraryRecoveryBundle();
    if (terminal) return;
    if (bundle.tracks.length === 4 && evidence.phase === "import") {
      seedButton.disabled = false;
      statusElement.textContent = "IMPORT COMMITTED · create the minimized paused recovery fixture.";
    }
  } catch { /* Keep waiting. */ }
  checkPending = false;
};

observer = new MutationObserver(() => {
  void checkImport();
  void checkTransfer();
  void checkRemoval();
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
pollId = window.setInterval(() => {
  void checkImport();
  void checkTransfer();
  void checkRemoval();
}, 100);

seedButton.addEventListener("click", async () => {
  if (terminal || seedButton.disabled || evidence.phase !== "import") return;
  seedButton.disabled = true;
  statusElement.textContent = "SAVING A MINIMIZED PAUSED RECOVERY FIXTURE…";
  try {
    const bundle = await loadLibraryRecoveryBundle();
    if (terminal) return;
    if (bundle.tracks.length !== 4) throw new Error("fixture membership changed");
    const ids = bundle.tracks.map((track) => track.id);
    const current = bundle.checkpointRecord;
    const saved = await savePartySessionCheckpointToDb({
      sessionId: crypto.randomUUID(),
      writerToken: crypto.randomUUID(),
      libraryEpoch: bundle.libraryState.epoch,
      libraryRevision: bundle.libraryState.revision,
      checkpointReason: "host-paused",
      plannedDurationSeconds: 7_200,
      accumulatedActiveSeconds: 123,
      energyProfile: "journey",
      energyShiftSteps: 2,
      includeRestOfLibrary: true,
      playedTrackIds: ids.slice(0, 2),
      remainingTrackIds: ids.slice(2),
      lastStableSourceTrackId: ids[1]
    }, {
      checkpointRevision: bundle.checkpointRevision,
      libraryEpoch: bundle.libraryState.epoch,
      libraryRevision: bundle.libraryState.revision,
      sessionId: current?.recordStatus === "available" ? current.sessionId : null,
      writerToken: current?.recordStatus === "available" ? current.writerToken : null
    });
    if (terminal) return;
    if (saved.status !== "saved") throw new Error("fixture save rejected");
    updateEvidence({ phase: "seeded", hydratedTracks: 4 });
    statusElement.textContent = "PAUSED RECOVERY SAVED · reload to use the real recovery card.";
  } catch {
    void finish({ aborted: true });
  }
});

appRoot = createRoot(rootElement, MAZZY_ROOT_ERROR_OPTIONS);
statusElement.tabIndex = -1;
statusElement.focus();
appRoot.render(
  <AppFatalBoundary>
    <React.StrictMode><App /></React.StrictMode>
  </AppFatalBoundary>
);

const initialize = async () => {
  try {
    const bundle = await loadLibraryRecoveryBundle();
    if (evidence.phase === "import") {
      statusElement.textContent = bundle.tracks.length === 0
        ? "EMPTY DISPOSABLE PROFILE · import exactly four generated WAV files through Mazzy."
        : "Waiting for the exact four-track import to commit…";
      void checkImport();
      return;
    }
    if (!["seeded", "transferred-once"].includes(evidence.phase) ||
        bundle.tracks.length !== 4 || bundle.checkpointRecord?.recordStatus !== "available") {
      throw new Error("recovery fixture unavailable");
    }
    beforeTransfer = bundle.checkpointRecord;
    const waitForRecovery = () => {
      if (terminal) return;
      const card = document.querySelector(".party-checkpoint-recovery[aria-labelledby='party-checkpoint-title']");
      if (card && document.body.textContent?.includes("PAUSED PARTY PLAN FOUND")) {
        updateEvidence({
          recoveryCardsObserved: evidence.recoveryCardsObserved + 1,
          recoveryFocusPreserved: evidence.recoveryFocusPreserved +
            (document.activeElement === statusElement ? 1 : 0)
        });
        statusElement.textContent = evidence.phase === "seeded"
          ? "FIRST RECOVERY READY · restore the paused plan with the real App action."
          : "SECOND RECOVERY READY · the transferred payload survived reload; restore it again.";
        return;
      }
      recoveryWaitTimer = window.setTimeout(waitForRecovery, 50);
    };
    waitForRecovery();
  } catch {
    void finish({ aborted: true });
  }
};

timeoutId = window.setTimeout(() => void finish({ timedOut: true }), 60_000);
window.addEventListener("pagehide", () => { void cleanupPage(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
void initialize();
