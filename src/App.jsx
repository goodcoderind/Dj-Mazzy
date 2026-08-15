import { useEffect, useMemo, useRef, useState } from "react";
import Deck from "./components/Deck";
import { getAudioEngine } from "./audioContext";
import {
  claimPartySessionCheckpoint,
  clearPartySessionCheckpoint,
  clearTracksFromDb,
  deleteTrackFromDb,
  loadLibraryRecoveryBundle,
  savePartySessionCheckpointToDb,
  saveImportedTracksToDb,
  saveRoutineTrackUpdatesToDb,
  subscribeToLibraryMutations
} from "./libraryDb";
import { equalPowerGains } from "./planning/transitionMath";
import { AnalysisClient, disposeAnalysisClient } from "./analysis/AnalysisClient";
import { hasCurrentBasicAnalysis } from "./analysis/analysisVersion";
import {
  emptyBeatGridOverrides,
  getEffectiveBpm,
  normalizeBeatGridOverrides
} from "./analysis/beatGridCorrections";
import { TRACK_ANALYSIS_SCHEMA_VERSION } from "./domain/versions";
import { mergeGeneratedAnalysis } from "./analysis/mergeAnalysis";
import { planAutomaticTransition } from "./planning/TransitionPlanner";
import { assessPartyReadiness } from "./planning/partyReadiness";
import { decideRescueTransition } from "./planning/rescueTransition";
import {
  decidePartyDeckCompletion,
  transitionCompletionSignalForDeckEvent
} from "./planning/partyDeckCompletionIngestion";
import { decidePartyCommittedTargetContinuation } from "./planning/partyCommittedTargetContinuation";
import { runPartyCommittedTargetAudioTransaction } from "./audio/partyCommittedTargetContinuationAudio";
import { isTimingReviewCurrent, normalizeTimingReview } from "./domain/timingReview";
import {
  canonicalizeForEnhancedRhythm,
  createEnhancedRhythmAnalysisSession,
  disposeEnhancedRhythmClient,
  getEnhancedRhythmAssetState,
  prepareEnhancedRhythm,
  removeEnhancedRhythmModel
} from "@mazzy/enhanced-rhythm";
import { mergeEnhancedRhythm } from "./analysis/mergeEnhancedRhythm";
import { hasCurrentEnhancedRhythm } from "./analysis/enhancedRhythmVersion";
import {
  BACKGROUND_ANALYSIS_STAGE_TIMEOUT_MS,
  backgroundAnalysisRowsAfterMutationRollback,
  backgroundAnalysisJobKey,
  createBackgroundAnalysisLease,
  createBackgroundAnalysisStageLease,
  decideBackgroundDecodeFailure,
  deriveBackgroundAnalysisNotice,
  ownsBackgroundAnalysisLease,
  ownsBackgroundAnalysisStageLease,
  readBlobForBackgroundAnalysis,
  isRetryableBackgroundAnalysisDeferral,
  shouldRetainBackgroundAnalysisDeferral,
  sortBackgroundAnalysisJobs,
  startBoundedBackgroundStage
} from "./analysis/backgroundAnalysisRuntime";
import { deriveRehearsalSourceCueSeconds, renderTransitionRehearsal } from "./diagnostics/transitionRehearsal";
import {
  startTransitionRehearsalRuntime,
  transitionRehearsalBlocksPlayback,
  transitionRehearsalSettlementOpensCircuit
} from "./diagnostics/transitionRehearsalRuntime";
import { partyEnergyCurve, shiftEnergyCurve } from "./planning/energyProfiles";
import { buildAutoPilotCandidateIds, buildAutoPilotPlanningIds } from "./planning/autoPilotCrate";
import {
  decideAutoPilotSessionTick
} from "./planning/autoPilotSessionDecision";
import {
  autoPilotPreloadLoadAuthorityKey,
  maySettleAutoPilotPreloadLease,
  ownsAutoPilotPreloadLease,
  runAutoPilotPreloadPauseCleanup,
  shouldCommitAutoPilotPreload,
  shouldDiscardSettledAutoPilotPreload
} from "./planning/autoPilotPreloadOwnership";
import {
  createAutoPilotArmLease,
  decideAutoPilotArmFailure,
  deriveAutoPilotArmDeadline,
  inspectAutoPilotArmLease,
  ownsAutoPilotArmLease
} from "./planning/autoPilotArmOwnership";
import {
  createAutoPilotTransitionCompletionLease,
  inspectAutoPilotTransitionCompletion,
  ownsAutoPilotTransitionCompletionLease
} from "./planning/autoPilotTransitionCompletionOwnership";
import {
  advancePartyAutopilotTickEpoch,
  claimPartyAutopilotTickFailure,
  createPartyAutopilotTickBoundary,
  issuePartyAutopilotTick,
  ownsPartyAutopilotTick,
  runPartyAutopilotTickTask
} from "./planning/partyAutopilotTickBoundary";
import { compileTransitionDsp } from "./audio/transitionDsp";
import {
  createPartySessionClock,
  partySessionClockSnapshot,
  pausePartySessionClock,
  resetPartySessionClock,
  restorePausedPartySessionClock,
  setPartySessionDuration,
  startPartySessionClock
} from "./planning/PartySessionClock";
import {
  createPartySessionCheckpoint,
  isPartySessionCheckpointOwnershipTransfer,
  normalizePartySessionCheckpointRecord,
  partySessionCheckpointFingerprint,
  projectPausedPartySessionCheckpoint,
  projectRestoredPausedPartyState,
  reconcilePartySessionCheckpoint,
  refreshOwnedPartySessionCheckpointDiscardTarget,
  resolvePartySessionCheckpointDiscardTarget
} from "./domain/partySessionCheckpoint";
import {
  createPartyAutopilotTraceRecorder,
  evaluatePartyAutopilotTrace
} from "./diagnostics/partyAutopilotTrace";
import { assessImportCapacity, formatStorageSize } from "./storage/importCapacity";
import { identifyLocalFile, normalizeContentIdentity, readLocalFileBytes } from "./storage/contentIdentity";
import { ownsLibraryHydration, startLibraryHydration } from "./storage/libraryHydrationRuntime";
import {
  createLibraryImportPickerOwner,
  createLibraryMembershipMutationOwner,
  libraryMembershipRevocationDisposition,
  mayCancelLibraryMembershipPreparation,
  mayClaimPreparedImportCommit,
  mayContinueLibraryMembershipAfterExclusive,
  membershipFailureHasDefiniteRollback,
  ownsLibraryImportPicker,
  ownsLibraryMembershipMutation,
  retryExactDeckMembershipCleanup,
  startBoundedLibraryMembershipStage,
  verifyDeckMembershipCleanup
} from "./storage/libraryMembershipMutationRuntime";
import {
  createLibraryRoutinePatchBatch,
  createLibraryRoutineMembershipBatch,
  createLibraryRoutineSnapshotBatch,
  hasUnpersistedLibraryRoutineGeneration,
  libraryRoutineEnqueueOwnsPersistence,
  libraryRoutineSaveStatusAfterSettlement,
  mergeLibraryRoutineWriteBatches,
  retryRejectedLibraryRoutineSnapshot,
  shouldEnqueueLibraryRoutineSnapshot,
  shouldQueueLibraryRoutineSnapshot
} from "./storage/libraryRoutineWriteBatch";
import { createLibraryRoutineWriteRuntime } from "./storage/libraryRoutineWriteRuntime";
import {
  createLibraryReconciliationRuntime,
  libraryReconciliationResultCovers,
  mergeLibraryReconciliationRequirements,
  settleLibraryReconciliationWaiters,
  shouldQuiescePartyForRemoteCheckpoint
} from "./storage/libraryReconciliationRuntime";
import {
  createPartyCheckpointClaimOwner,
  createPartyCheckpointClearOwner,
  createPartyCheckpointWriteRuntime,
  ownsPartyCheckpointClaim,
  ownsPartyCheckpointClear,
  shouldQueuePartyCheckpointCandidate,
  startBoundedPartyCheckpointOperation
} from "./storage/partyCheckpointWriteRuntime";
import { createPartyWakeLockController } from "./power/partyWakeLock";
import { registerFatalHostWakeLockRelease } from "./audio/fatalHostAudioSafety";
import { audioRecoveryMessage, needsHostAudioRecovery } from "./audio/audioContextRecovery";
import { OUTPUT_DEVICE_RECOVERY_MESSAGE, supportsOutputDeviceChangeMonitoring } from "./audio/outputDeviceRecovery";
import { DECK_LOAD_OUTCOME, shouldQuarantineAutoPilotLoad } from "./audio/deckLoadOutcome";
import {
  DECK_LOAD_PURPOSE,
  ownsDeckLoadReadiness,
  shouldAutoEjectDeckLoadFailure
} from "./audio/deckLoadReadiness";
import { normalizeProgramLevel } from "./analysis/programLevel";
import { applyQueuedAnalysisFailure } from "./analysis/analysisQueueSettlement";
import { ownsQueuedAnalysisLibraryRow, shouldRequeueReplacementAnalysis } from "./analysis/analysisQueueOwnership";
import { runPartyStopAllSound, verifyPartyStopAllSound } from "./planning/partyStopAllSound";
import {
  createPartyFirstSongLoadOwner,
  decidePartyFirstSongLoadSettlement,
  mayClearPartyFirstSongRecoveryStatus,
  ownsPartyFirstSongLoad,
  ownsPartyFirstSongTimer,
  partyFirstSongBlocksAutopilotStart,
  partyFirstSongReadyActionMessage,
  shouldClearPartyFirstSongReadyForLoad,
  shouldClearPartyFirstSongReadyForLoadInvalidation,
  shouldClearPartyFirstSongReadyForTransportStart,
  shouldClearPartyFirstSongStatusAfterStop
} from "./planning/partyFirstSongLoad";
import {
  ownsPartyFirstSongStart,
  partyFirstSongStartMayContinue,
  partyFirstSongStartRequiresRecoveryCircuit,
  startPartyFirstSongStart
} from "./planning/partyFirstSongStart";

const audioExt = [".mp3", ".wav", ".flac", ".aiff", ".m4a"];
const stripExt = (name) => name.replace(/\.[^/.]+$/, "");
const transitionLabel = (template) => template === "phrase-blend"
  ? "SMOOTH PHRASE BLEND"
  : template === "downbeat-cut"
    ? "SHORT BAR-ALIGNED HANDOFF"
    : template === "filtered-fade"
      ? "FILTERED FADE"
    : "SAFE FADE";
const transitionButtonLabel = (template) => template === "phrase-blend"
  ? "AUTO MIX · PHRASE BLEND"
  : template === "downbeat-cut"
    ? "AUTO MIX · BAR HANDOFF"
    : template === "filtered-fade"
      ? "AUTO MIX · FILTERED FADE"
    : "AUTO MIX · SAFE FADE";
const previewReason = (plan) => {
  const reasons = plan?.eligibility?.reasons ?? [];
  return reasons.find((reason) =>
    reason.includes("locally trusted") ||
    reason.includes("disabled") ||
    reason.includes("manually repaired") ||
    reason.includes("downbeat grid") ||
    reason.includes("beat grid")
  ) ?? reasons[0] ?? "A protected fallback is available.";
};

const persistedTrack = (track) => ({
  id: track.id,
  name: track.name,
  file: track.file,
  duration: track.duration,
  bpm: track.bpm,
  key: track.key ?? null,
  scale: track.scale ?? null,
  schemaVersion: track.schemaVersion ?? TRACK_ANALYSIS_SCHEMA_VERSION,
  analyzerVersion: track.analyzerVersion ?? null,
  bpmCandidates: track.bpmCandidates ?? [],
  beatsSeconds: track.beatsSeconds ?? [],
  downbeatsSeconds: track.downbeatsSeconds ?? [],
  meter: track.meter ?? null,
  tempoConfidence: track.tempoConfidence ?? 0,
  beatConfidence: track.beatConfidence ?? 0,
  downbeatConfidence: track.downbeatConfidence ?? 0,
  keyConfidence: track.keyConfidence ?? 0,
  energyByBeat: track.energyByBeat ?? [],
  bandEnergyByBeat: track.bandEnergyByBeat ?? [],
  vocalProbabilityByBeat: track.vocalProbabilityByBeat ?? [],
  structureBoundaries: track.structureBoundaries ?? [],
  phraseCandidates: track.phraseCandidates ?? [],
  automaticRhythmTrust: track.automaticRhythmTrust ?? null,
  programLevel: normalizeProgramLevel(track.programLevel),
  rhythmDetector: track.rhythmDetector ?? null,
  rhythmAnalysisVersion: track.rhythmAnalysisVersion ?? null,
  rhythmModelSha256: track.rhythmModelSha256 ?? null,
  rhythmBackend: track.rhythmBackend ?? null,
  sampleRate: track.sampleRate ?? null,
  analysisOverrides: normalizeBeatGridOverrides(track.analysisOverrides),
  timingReview: normalizeTimingReview(track.timingReview),
  analysisStatus: track.analysisStatus ?? "pending",
  contentIdentity: normalizeContentIdentity(track.contentIdentity)
});

const restorePersistedTrack = (track) => {
  const timingReview = normalizeTimingReview(track.timingReview);
  const restored = {
    id: track.id,
    name: track.name,
    file: track.file,
    duration: track.duration ?? null,
    bpm: track.bpm ?? null,
    key: track.key ?? null,
    scale: track.scale ?? null,
    schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: track.analyzerVersion ?? null,
    bpmCandidates: track.bpmCandidates ?? [],
    beatsSeconds: track.beatsSeconds ?? [],
    downbeatsSeconds: track.downbeatsSeconds ?? [],
    meter: track.meter ?? null,
    tempoConfidence: track.tempoConfidence ?? 0,
    beatConfidence: track.beatConfidence ?? 0,
    downbeatConfidence: track.downbeatConfidence ?? 0,
    keyConfidence: track.keyConfidence ?? 0,
    energyByBeat: track.energyByBeat ?? [],
    bandEnergyByBeat: track.bandEnergyByBeat ?? [],
    vocalProbabilityByBeat: track.vocalProbabilityByBeat ?? [],
    structureBoundaries: track.structureBoundaries ?? [],
    phraseCandidates: track.phraseCandidates ?? [],
    automaticRhythmTrust: track.automaticRhythmTrust ?? null,
    programLevel: normalizeProgramLevel(track.programLevel),
    programLevelStatus: normalizeProgramLevel(track.programLevel) ? "ready" : "pending",
    rhythmDetector: track.rhythmDetector ?? null,
    rhythmAnalysisVersion: track.rhythmAnalysisVersion ?? null,
    rhythmModelSha256: track.rhythmModelSha256 ?? null,
    rhythmBackend: track.rhythmBackend ?? null,
    sampleRate: track.sampleRate ?? null,
    analysisOverrides: normalizeBeatGridOverrides(track.analysisOverrides),
    timingReview: null,
    analysisStatus: hasCurrentBasicAnalysis(track) ? "ready" : "pending",
    contentIdentity: normalizeContentIdentity(track.contentIdentity),
    loaded: false
  };
  return {
    ...restored,
    timingReview: timingReview && isTimingReviewCurrent(timingReview, restored)
      ? timingReview
      : null
  };
};

export default function App() {
  const [fade, setFade] = useState(0.5);
  const [autoMixing, setAutoMixing] = useState(false);
  const [autoMixArming, setAutoMixArming] = useState(false);
  const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
  const [autoPilotChoice, setAutoPilotChoice] = useState(null);
  const [autoPilotIntervention, setAutoPilotIntervention] = useState(null);
  const [transitionCompletionUncertain, setTransitionCompletionUncertain] = useState(false);
  const [partyEnergyProfile, setPartyEnergyProfile] = useState("build");
  const [partyEnergyShift, setPartyEnergyShift] = useState(0);
  const [autoPilotUseLibrary, setAutoPilotUseLibrary] = useState(false);
  const [partyDurationMinutes, setPartyDurationMinutes] = useState(180);
  const [partyClockDisplay, setPartyClockDisplay] = useState(() =>
    partySessionClockSnapshot(createPartySessionClock(180 * 60), 0)
  );
  const [playedTrackIds, setPlayedTrackIds] = useState([]);
  const [partyCheckpointRecovery, setPartyCheckpointRecovery] = useState(null);
  const [partyCheckpointCardVisible, setPartyCheckpointCardVisible] = useState(true);
  const [partyCheckpointBusy, setPartyCheckpointBusy] = useState(false);
  const [partyCheckpointError, setPartyCheckpointError] = useState("");
  const [partyCheckpointWriterLost, setPartyCheckpointWriterLost] = useState(false);
  const [partyCheckpointWriteCircuitOpen, setPartyCheckpointWriteCircuitOpen] = useState(false);
  const [restoredPartyPlan, setRestoredPartyPlan] = useState(null);
  const [unavailableAutoPilotTrackIds, setUnavailableAutoPilotTrackIds] = useState([]);
  const [timedOutAutoPilotTrackIds, setTimedOutAutoPilotTrackIds] = useState([]);
  const [showPartyReadiness, setShowPartyReadiness] = useState(false);
  const [autoMixBeats, setAutoMixBeats] = useState(null);
  const [transitionInfo, setTransitionInfo] = useState(null);
  const [pairPreview, setPairPreview] = useState(null);
  const [rehearsalStatus, setRehearsalStatus] = useState(null);
  const [rehearsalActive, setRehearsalActive] = useState(false);
  const [rehearsalCircuitOpen, setRehearsalCircuitOpen] = useState(false);
  const [showAdvancedMixer, setShowAdvancedMixer] = useState(false);
  const [partyEndingFinalTrack, setPartyEndingFinalTrack] = useState(false);
  const [partyDiagnosticEnabled, setPartyDiagnosticEnabled] = useState(false);
  const [partyDiagnosticEvaluation, setPartyDiagnosticEvaluation] = useState(null);
  const [partyWakeLockStatus, setPartyWakeLockStatus] = useState("idle");
  const [partySoundStopStatus, setPartySoundStopStatus] = useState(null);
  const [partySoundStopLocked, setPartySoundStopLocked] = useState(false);
  const [audioRecoveryState, setAudioRecoveryState] = useState(null);
  const [outputDeviceChanged, setOutputDeviceChanged] = useState(false);
  const rehearsalPreparing = rehearsalStatus?.state === "rendering" || rehearsalStatus?.state === "cancelling";
  const [masterDeck, setMasterDeck] = useState("a");
  const [bpmByDeck, setBpmByDeck] = useState({ a: null, b: null });
  const [library, setLibrary] = useState([]);
  const [analyzingIds, setAnalyzingIds] = useState({});
  const [enhancedTimingAvailable, setEnhancedTimingAvailable] = useState(null);
  const [enhancedTimingState, setEnhancedTimingState] = useState("checking");
  const [enhancedFailureByTrack, setEnhancedFailureByTrack] = useState({});
  const [loadedByDeck, setLoadedByDeck] = useState({ a: null, b: null });
  const [queue, setQueue] = useState([]);
  const [contextMenu, setContextMenu] = useState(null);
  const [deckFlash, setDeckFlash] = useState({ a: false, b: false });
  const [toast, setToast] = useState("");
  const [librarySaveStatus, setLibrarySaveStatus] = useState("idle");
  const [libraryMutationBusy, setLibraryMutationBusy] = useState(true);
  const [libraryStorageError, setLibraryStorageError] = useState("");
  const [libraryHydrationCircuitOpen, setLibraryHydrationCircuitOpen] = useState(false);
  const [libraryReconcileBusy, setLibraryReconcileBusy] = useState(false);
  const [libraryReconcileCircuitOpen, setLibraryReconcileCircuitOpen] = useState(false);
  const [libraryMembershipStatus, setLibraryMembershipStatus] = useState(null);
  const [libraryMembershipCircuitOpen, setLibraryMembershipCircuitOpen] = useState(false);
  const [libraryRoutineWriteCircuitOpen, setLibraryRoutineWriteCircuitOpen] = useState(false);
  const [libraryAnalysisSaveError, setLibraryAnalysisSaveError] = useState("");
  const [backgroundAnalysisNotice, setBackgroundAnalysisNotice] = useState(null);
  const [libraryTimingSaveErrors, setLibraryTimingSaveErrors] = useState({});
  const [libraryRestoreAttempt, setLibraryRestoreAttempt] = useState(0);
  const [importStorageStatus, setImportStorageStatus] = useState(null);
  const [partyFirstSongLoadStatus, setPartyFirstSongLoadStatus] = useState(null);
  const [partyFirstSongStartStatus, setPartyFirstSongStartStatus] = useState(null);
  const [partyFirstSongStartCircuitOpen, setPartyFirstSongStartCircuitOpen] = useState(false);
  const partyFirstSongStarting = partyFirstSongStartStatus?.state === "starting";
  const [dragIndex, setDragIndex] = useState(null);
  const [masterMeter, setMasterMeter] = useState({ peakDb: -Infinity, limiterReductionDb: 0 });
  const contextReadyRef = useRef(false);
  const autoMixCountdownFrameRef = useRef(0);
  const masterMeterFrameRef = useRef(0);
  const lastMasterMeterUpdateRef = useRef(0);
  const deckARef = useRef(null);
  const deckBRef = useRef(null);
  const importRef = useRef(null);
  const libraryImportPickerOperationRef = useRef(0);
  const libraryImportPickerOwnerRef = useRef(null);
  const libraryImportPickerReleaseTimerRef = useRef(null);
  const libraryImportPickerFocusDeferredRef = useRef(false);
  const libraryImportPickerBlurredRef = useRef(false);
  const libraryImportPickerTriggerRef = useRef(null);
  const libraryImportPickerReconcileConsumedRef = useRef(false);
  const libraryMembershipAlertRef = useRef(null);
  const libraryMembershipStatusRef = useRef(null);
  const libraryHeadingRef = useRef(null);
  const libraryMembershipCancelButtonRef = useRef(null);
  const libraryMembershipCancelRef = useRef(null);
  const libraryMembershipTriggerRef = useRef(null);
  const libraryMembershipOwnerRef = useRef(null);
  const libraryMembershipEpochRef = useRef(1);
  const libraryMembershipOperationRef = useRef(0);
  const libraryMembershipStageOperationRef = useRef(0);
  const libraryMembershipPhaseRef = useRef("idle");
  const libraryMembershipDeckCleanupRef = useRef(null);
  const partyFirstSongLoadRef = useRef(null);
  const partyFirstSongLoadOperationRef = useRef(0);
  const partyFirstSongLoadTimerRef = useRef(null);
  const partyFirstSongLoadTriggerRef = useRef(null);
  const partyFirstSongLoadAlertRef = useRef(null);
  const partyFirstSongCancelRef = useRef(null);
  const partyFirstSongPlayButtonRef = useRef(null);
  const partyFirstSongStartOperationRef = useRef(0);
  const partyFirstSongStartOwnerRef = useRef(null);
  const partyFirstSongStartRuntimeRef = useRef(null);
  const partyFirstSongStartAuthorityKeyRef = useRef(null);
  const partyFirstSongStartCircuitOpenRef = useRef(false);
  const partyFirstSongStartAlertRef = useRef(null);
  const queuedAnalysisIdsRef = useRef(new Set());
  const pendingAnalysisQueueRef = useRef([]);
  const analysisPriorityRef = useRef({ loaded: [], queued: [] });
  const analysisQueueBusyRef = useRef(false);
  const analysisGenerationRef = useRef(0);
  const backgroundAnalysisOperationRef = useRef(0);
  const activeBackgroundAnalysisRef = useRef(null);
  const activeBackgroundStageRef = useRef(null);
  const activeBackgroundStageCancelRef = useRef(null);
  const backgroundAnalysisClientRef = useRef(null);
  const backgroundEnhancedAnalysisRef = useRef(null);
  const backgroundAnalysisDeferredRef = useRef(new Map());
  const backgroundAnalysisCircuitRef = useRef({ decode: false, enhancedRender: false });
  const backgroundAnalysisRetryUsedRef = useRef(false);
  const removedTrackIdsRef = useRef(new Set());
  const autoPilotPreloadLeaseRef = useRef(null);
  const consecutiveAutoPilotPreloadTimeoutsRef = useRef(0);
  const autoPilotTransitionKeyRef = useRef(null);
  const autoPilotPreloadGenerationRef = useRef(0);
  const rehearsalCancelRef = useRef(null);
  const rehearsalGenerationRef = useRef(0);
  const rehearsalRenderOperationRef = useRef(0);
  const rehearsalRenderRuntimeRef = useRef(null);
  const rehearsalPreparationOwnedRef = useRef(false);
  const rehearsalCircuitOpenRef = useRef(false);
  const rehearsalAlertRef = useRef(null);
  const activeTransitionScheduleRef = useRef(null);
  const transitionCompletionCancelRef = useRef(null);
  const transitionCompletionRuntimeRef = useRef(null);
  const transitionCompletionUncertainRef = useRef(false);
  const transitionArmRef = useRef(false);
  const transitionArmGenerationRef = useRef(0);
  const transitionArmLeaseRef = useRef(null);
  const consecutiveAutoPilotArmFailuresRef = useRef(0);
  const autoPilotEnabledRef = useRef(false);
  const queueRef = useRef([]);
  const libraryRef = useRef([]);
  const libraryReconcileRuntimeRef = useRef(null);
  const libraryReconcileRequestRef = useRef(null);
  const libraryReconcileWaitersRef = useRef(new Set());
  const playedTrackIdsRef = useRef([]);
  const partySessionClockRef = useRef(createPartySessionClock(180 * 60));
  const libraryStateRef = useRef({ epoch: 0, revision: 0 });
  const partyCheckpointRevisionRef = useRef(0);
  const partyCheckpointSessionIdRef = useRef(null);
  const partyCheckpointWriterTokenRef = useRef(null);
  const partyCheckpointWriteGenerationRef = useRef(0);
  const partyCheckpointWriteRuntimeRef = useRef(null);
  const partyCheckpointClearOperationRef = useRef(0);
  const partyCheckpointClearOwnerRef = useRef(null);
  const partyCheckpointClearCancelRef = useRef(null);
  const partyCheckpointClaimOperationRef = useRef(0);
  const partyCheckpointClaimOwnerRef = useRef(null);
  const partyCheckpointClaimCancelRef = useRef(null);
  const partyCheckpointTerminalClearPendingRef = useRef(null);
  const partyCheckpointLastFingerprintRef = useRef("");
  const partyCheckpointTerminalRef = useRef(true);
  const partyCheckpointPauseReasonRef = useRef("host-paused");
  const partyCheckpointHydratedRef = useRef(false);
  const partyCheckpointWriterLostRef = useRef(false);
  const partyCheckpointRecoveryRef = useRef(null);
  const partyCheckpointStoredRecordRef = useRef(null);
  const partyCheckpointBusyRef = useRef(false);
  const partySoundStopInProgressRef = useRef(false);
  const partyCheckpointCardRef = useRef(null);
  const partyCheckpointShowButtonRef = useRef(null);
  const partyCheckpointAlertRef = useRef(null);
  const partyModeTitleRef = useRef(null);
  const partyReadinessRef = useRef(null);
  const partyStartButtonRef = useRef(null);
  const partyInterventionRef = useRef(null);
  const finalTrackRef = useRef(null);
  const partyTraceRecorderRef = useRef(null);
  const partyTraceRunningRef = useRef(false);
  const partyTrackOrdinalsRef = useRef(new Map());
  const partyLoadByDeckRef = useRef({ a: null, b: null });
  const partyPendingLoadByDeckRef = useRef({ a: null, b: null });
  const partyCommittedPreloadByDeckRef = useRef({ a: null, b: null });
  const partyTrackOrdinalCounterRef = useRef(0);
  const partyLoadOrdinalCounterRef = useRef(0);
  const partyNativeCompletionOrdinalsRef = useRef(new Map());
  const partyNativeCompletionOrdinalCounterRef = useRef(0);
  const partyFallbackContinuationOperationRef = useRef(0);
  const partyFallbackContinuationRef = useRef(null);
  const partyPreloadOperationRef = useRef(0);
  const partyAutopilotTickBoundaryRef = useRef(createPartyAutopilotTickBoundary());
  const partyAutopilotLastObservedNowRef = useRef(0);
  const partyQueueRevisionRef = useRef(0);
  const partyPlayedLoadsRef = useRef(new Set());
  const contextMenuRef = useRef(null);
  const contextMenuTriggerRef = useRef(null);
  const libraryMutationBusyRef = useRef(true);
  const libraryMutationModeRef = useRef("hydrating");
  const libraryHydrationGenerationRef = useRef(0);
  const libraryHydrationOperationRef = useRef(0);
  const libraryHydrationOwnerRef = useRef(null);
  const libraryHydrationCancelRef = useRef(null);
  const libraryHydrationRetryRequestedRef = useRef(false);
  const libraryHydrationStatusRef = useRef(null);
  const libraryStorageAlertRef = useRef(null);
  const libraryRoutineWriteRuntimeRef = useRef(null);
  const libraryRoutineSkipSnapshotRef = useRef(null);
  const libraryRoutineDirtyGenerationRef = useRef(0);
  const libraryRoutineSavedGenerationRef = useRef(0);
  const libraryRoutineWriteAlertRef = useRef(null);
  const libraryImportGenerationRef = useRef(0);
  const audioOutputWatchArmedRef = useRef(false);
  const outputDeviceGenerationRef = useRef(0);
  const audioRecoveryGenerationRef = useRef(0);
  const audioRecoveryPendingRef = useRef(false);
  const outputDevicePendingRef = useRef(false);
  const playbackRecoveryLockedRef = useRef(false);
  const deckPlaybackStartLockedRef = useRef(false);
  const rehearsalPlaybackLocked = () => transitionRehearsalBlocksPlayback({
    preparationOwned: rehearsalPreparationOwnedRef.current,
    renderOwned: Boolean(rehearsalRenderRuntimeRef.current),
    previewOwned: Boolean(rehearsalCancelRef.current),
    circuitOpen: rehearsalCircuitOpenRef.current
  });
  const refreshPlaybackRecoveryLock = () => {
    playbackRecoveryLockedRef.current = audioRecoveryPendingRef.current ||
      outputDevicePendingRef.current ||
      partyCheckpointBusyRef.current ||
      partyCheckpointWriterLostRef.current ||
      partySoundStopInProgressRef.current ||
      transitionCompletionUncertainRef.current ||
      rehearsalCircuitOpenRef.current ||
      partyFirstSongStartCircuitOpenRef.current;
    deckPlaybackStartLockedRef.current = playbackRecoveryLockedRef.current || rehearsalPlaybackLocked();
  };
  const publishLibrary = (update, { routineDirty = false } = {}) => {
    const previous = libraryRef.current;
    const next = typeof update === "function" ? update(previous) : update;
    libraryRef.current = next;
    if (routineDirty && next !== previous) libraryRoutineDirtyGenerationRef.current += 1;
    setLibrary(next);
    return next;
  };
  const advancePartyAutopilotCoordinatorEpoch = () => {
    partyAutopilotTickBoundaryRef.current = advancePartyAutopilotTickEpoch(
      partyAutopilotTickBoundaryRef.current
    );
  };
  const partyWakeLockRef = useRef(null);
  if (!partyCheckpointWriterTokenRef.current) {
    partyCheckpointWriterTokenRef.current = crypto.randomUUID();
  }
  const autoPilotExcludedTrackIds = [...new Set([
    ...unavailableAutoPilotTrackIds,
    ...timedOutAutoPilotTrackIds
  ])];
  const partyFirstSongOpening = partyFirstSongLoadStatus?.state === "opening" ||
    partyFirstSongLoadStatus?.state === "slow";

  useEffect(() => {
    const controller = createPartyWakeLockController({ onStatus: setPartyWakeLockStatus });
    partyWakeLockRef.current = controller;
    const unregisterFatalRelease = registerFatalHostWakeLockRelease(() => controller.releaseForHostTeardown());
    const onVisibility = () => controller.onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unregisterFatalRelease();
      void controller.release();
      partyWakeLockRef.current = null;
    };
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!supportsOutputDeviceChangeMonitoring(mediaDevices)) return;
    const onDeviceChange = () => {
      if (!audioOutputWatchArmedRef.current) return;
      invalidatePartyCheckpointClaim("Audio output changed while the saved plan was being restored. Reload Mazzy to review recovery before continuing.");
      outputDeviceGenerationRef.current += 1;
      outputDevicePendingRef.current = true;
      refreshPlaybackRecoveryLock();
      setOutputDeviceChanged(true);
      cancelPartyFirstSongStart({ message: "Starting stopped because the audio output changed." });
      cancelPartyFirstSongLoad({ keepStatus: false });
      const transitionWasActive = Boolean(activeTransitionScheduleRef.current);
      if (autoPilotEnabledRef.current && transitionWasActive) {
        advancePartyAutopilotCoordinatorEpoch();
        autoPilotEnabledRef.current = false;
        settleAutoPilotPreloadForPause("superseded");
        setAutoPilotEnabled(false);
        finalTrackRef.current = null;
        setPartyEndingFinalTrack(false);
        partyCheckpointPauseReasonRef.current = "audio-recovery";
        pausePartyClockFailClosed();
        try { void partyWakeLockRef.current?.release?.(); } catch { /* Authority is already paused. */ }
      } else if (autoPilotEnabledRef.current) {
        pauseAutoPilotForHostControl(
          "Party Autopilot paused · audio device changed",
          "output-change"
        );
      }
      stopOrCancelRehearsal("Preview cancellation is finishing while the audio output is checked. Nothing was saved.");
      autoPilotPreloadGenerationRef.current += 1;
      try { cancelCurrentTransitionArm(); } catch { /* Transition Rescue remains authoritative. */ }
      transitionArmGenerationRef.current += 1;
      if (transitionWasActive && activeTransitionScheduleRef.current) {
        try {
          rescueTransition();
        } catch {
          transitionCompletionUncertainRef.current = true;
          setTransitionCompletionUncertain(true);
          refreshPlaybackRecoveryLock();
          if (partyTraceRecorderRef.current) {
            partyTraceRunningRef.current = false;
            partyTraceRecorderRef.current.markInterrupted();
            updatePartyDiagnosticEvaluation();
          }
          showAutoPilotArmIntervention("transition-completion-lost");
        }
      }
    };
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, []);

  useEffect(() => {
    if (autoPilotEnabled) void partyWakeLockRef.current?.acquire?.();
    else void partyWakeLockRef.current?.release?.();
  }, [autoPilotEnabled]);

  useEffect(() => {
    if (!autoPilotEnabled && !autoMixArming && !autoMixing && !rehearsalActive &&
      !rehearsalPreparing && !partyFirstSongOpening && !partyFirstSongStarting && !libraryMembershipStatus) return;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [autoPilotEnabled, autoMixArming, autoMixing, rehearsalActive, rehearsalPreparing, partyFirstSongOpening, partyFirstSongStarting, libraryMembershipStatus]);

  useEffect(() => {
    const onPageHide = () => {
      cancelPartyFirstSongStart();
      const owner = libraryMembershipOwnerRef.current;
      if (!owner) return;
      if (libraryMembershipRevocationDisposition(libraryMembershipPhaseRef.current) === "cancelled") {
        libraryMembershipOwnerRef.current = null;
        libraryMembershipEpochRef.current += 1;
        try { libraryMembershipCancelRef.current?.(); } catch { /* Preparation authority is revoked. */ }
        libraryMembershipCancelRef.current = null;
        libraryMembershipTriggerRef.current = null;
        libraryMembershipPhaseRef.current = "idle";
        setLibraryMembershipStatus(null);
        if (["importing", "destructive"].includes(libraryMutationModeRef.current)) {
          setLibraryMutationLock(false);
        }
        return;
      }
      failLibraryMembershipCommitClosed(owner);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  useEffect(() => {
    const engine = getAudioEngine();
    const onStateChange = () => {
      const state = engine.context.state;
      if (state === "running") {
        return;
      }
      if (!needsHostAudioRecovery(state)) return;
      invalidatePartyCheckpointClaim("Browser audio changed while the saved plan was being restored. Reload Mazzy to review recovery before continuing.");
      audioRecoveryGenerationRef.current += 1;
      audioRecoveryPendingRef.current = true;
      refreshPlaybackRecoveryLock();
      setAudioRecoveryState(state);
      cancelPartyFirstSongStart({ message: "Starting stopped because browser audio needs attention." });
      cancelPartyFirstSongLoad({ keepStatus: false });
      const transitionWasActive = Boolean(activeTransitionScheduleRef.current);
      if (autoPilotEnabledRef.current && transitionWasActive) {
        advancePartyAutopilotCoordinatorEpoch();
        autoPilotEnabledRef.current = false;
        settleAutoPilotPreloadForPause("superseded");
        setAutoPilotEnabled(false);
        finalTrackRef.current = null;
        setPartyEndingFinalTrack(false);
        partyCheckpointPauseReasonRef.current = "audio-recovery";
        pausePartyClockFailClosed();
        try { void partyWakeLockRef.current?.release?.(); } catch { /* Authority is already paused. */ }
      } else if (autoPilotEnabledRef.current) {
        pauseAutoPilotForHostControl(
          "Party Autopilot paused · browser audio stopped",
          "audio-recovery"
        );
      }
      stopOrCancelRehearsal("Preview cancellation is finishing because browser audio needs attention. Nothing was saved.");
      try { cancelCurrentTransitionArm(); } catch { /* Transition Rescue remains authoritative. */ }
      if (transitionWasActive && activeTransitionScheduleRef.current) {
        try {
          rescueTransition();
        } catch {
          transitionCompletionUncertainRef.current = true;
          setTransitionCompletionUncertain(true);
          refreshPlaybackRecoveryLock();
          if (partyTraceRecorderRef.current) {
            partyTraceRunningRef.current = false;
            partyTraceRecorderRef.current.markInterrupted();
            updatePartyDiagnosticEvaluation();
          }
          showAutoPilotArmIntervention("transition-completion-lost");
        }
      }
    };
    engine.context.addEventListener("statechange", onStateChange);
    return () => engine.context.removeEventListener("statechange", onStateChange);
  }, []);

  const stopRemoteLibraryPlayback = () => {
    cancelPartyFirstSongStart({ message: "Starting stopped because local playback authority changed in another Mazzy tab." });
    const firstSongCleanupConfirmed = cancelPartyFirstSongLoad({ keepStatus: false });
    if (mayClearPartyFirstSongRecoveryStatus(firstSongCleanupConfirmed)) {
      setPartyFirstSongLoadStatus(null);
    }
    advancePartyAutopilotCoordinatorEpoch();
    autoPilotEnabledRef.current = false;
    settleAutoPilotPreloadForPause("superseded");
    setAutoPilotEnabled(false);
    try { cancelCurrentTransitionArm(); } catch { /* Playback remains locked if cleanup is uncertain. */ }
    transitionArmGenerationRef.current += 1;
    stopOrCancelRehearsal("Preview cancellation is finishing because local playback authority changed in another Mazzy tab.");
    autoPilotTransitionKeyRef.current = null;
    let transitionCleanupConfirmed = true;
    try {
      if (activeTransitionScheduleRef.current) rescueTransition();
      if (transitionCompletionUncertainRef.current) transitionCleanupConfirmed = false;
    } catch {
      transitionCleanupConfirmed = false;
      transitionCompletionUncertainRef.current = true;
      setTransitionCompletionUncertain(true);
      refreshPlaybackRecoveryLock();
      if (partyTraceRecorderRef.current) {
        partyTraceRunningRef.current = false;
        partyTraceRecorderRef.current.markInterrupted();
        updatePartyDiagnosticEvaluation();
      }
      showAutoPilotArmIntervention("transition-completion-lost");
    }
    try { transitionCompletionCancelRef.current?.(); } catch {
      transitionCleanupConfirmed = false;
      transitionCompletionUncertainRef.current = true;
      setTransitionCompletionUncertain(true);
      refreshPlaybackRecoveryLock();
      showAutoPilotArmIntervention("transition-completion-lost");
    }
    transitionCompletionCancelRef.current = null;
    if (transitionCleanupConfirmed) activeTransitionScheduleRef.current = null;
    transitionArmRef.current = false;
    finalTrackRef.current = null;
    pausePartyClockFailClosed();
    pausePartyDiagnostic("host-control");
    void partyWakeLockRef.current?.release?.();
    setPartyEndingFinalTrack(false);
    setAutoPilotChoice(null);
    setAutoMixing(false);
    setAutoMixArming(false);
  };

  const resumeLibraryReconciliationAfterCheckpointOperation = () => {
    if (partyCheckpointBusyRef.current || partyCheckpointClaimOwnerRef.current ||
        partyCheckpointClearOwnerRef.current) return false;
    const runtime = libraryReconcileRuntimeRef.current;
    if (runtime?.snapshot?.().mode !== "paused") return false;
    runtime.resume();
    const snapshot = runtime.snapshot();
    if (snapshot.active || snapshot.pending) {
      libraryMutationBusyRef.current = true;
      libraryMutationModeRef.current = "reconciling";
      setLibraryMutationBusy(true);
      setLibraryReconcileBusy(true);
    }
    return true;
  };

  const waitForLibraryReconciliationSettlement = () => {
    const snapshot = libraryReconcileRuntimeRef.current?.snapshot?.();
    if (!snapshot?.active && !snapshot?.pending) return Promise.resolve();
    return new Promise((resolve) => libraryReconcileWaitersRef.current.add(resolve));
  };

  const settleReconciliationWaiters = () => {
    settleLibraryReconciliationWaiters(libraryReconcileWaitersRef.current);
  };

  useEffect(() => {
    autoPilotEnabledRef.current = autoPilotEnabled;
    queueRef.current = queue;
    libraryRef.current = library;
    playedTrackIdsRef.current = playedTrackIds;
  }, [autoPilotEnabled, queue, library, playedTrackIds]);

  useEffect(() => {
    const failReconciliationClosed = () => {
      const membershipOwner = libraryMembershipOwnerRef.current;
      if (membershipOwner &&
          libraryMembershipRevocationDisposition(libraryMembershipPhaseRef.current) === "cancelled") {
        libraryMembershipOwnerRef.current = null;
        libraryMembershipEpochRef.current += 1;
        try { libraryMembershipCancelRef.current?.(); } catch { /* Reconciliation failure is authoritative. */ }
        libraryMembershipCancelRef.current = null;
        libraryMembershipTriggerRef.current = null;
        libraryMembershipPhaseRef.current = "idle";
        setLibraryMembershipStatus(null);
      }
      quiescePartyForReconciliationFailure();
      partyCheckpointTerminalClearPendingRef.current = null;
      libraryMutationBusyRef.current = true;
      libraryMutationModeRef.current = "reconcile-circuit";
      setLibraryMutationBusy(true);
      setLibraryReconcileBusy(false);
      setLibraryReconcileCircuitOpen(true);
      partyCheckpointWriterLostRef.current = true;
      setPartyCheckpointWriterLost(true);
      refreshPlaybackRecoveryLock();
      getPartyCheckpointWriteRuntime().openCircuit();
      setPartyCheckpointWriteCircuitOpen(true);
      setPartyCheckpointError("Mazzy could not confirm changes from another tab. New playback and library changes are locked. Reload Mazzy to review the current local music and saved party plan.");
      window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
    };
    const gateAutomaticWorkForReconciliation = () => {
      advancePartyAutopilotCoordinatorEpoch();
      try { settleAutoPilotPreloadForPause("superseded"); } catch { /* The synchronous storage gate remains active. */ }
      try { cancelCurrentTransitionArm(); } catch { /* The arm generation below remains authoritative. */ }
      transitionArmGenerationRef.current += 1;
    };
    const quiescePartyForReconciliationFailure = () => {
      advancePartyAutopilotCoordinatorEpoch();
      autoPilotEnabledRef.current = false;
      setAutoPilotEnabled(false);
      try { stopRemoteLibraryPlayback(); } catch { /* The recovery locks below remain authoritative. */ }
    };
    const applyReconciledBundle = (trigger, bundle) => {
      const currentLibraryState = libraryStateRef.current;
      const libraryRegressed = bundle.libraryState.epoch < currentLibraryState.epoch ||
        (bundle.libraryState.epoch === currentLibraryState.epoch &&
          bundle.libraryState.revision < currentLibraryState.revision);
      const triggerNotCovered = !libraryReconciliationResultCovers({
        requirements: trigger,
        libraryEpoch: bundle.libraryState.epoch,
        libraryRevision: bundle.libraryState.revision,
        checkpointRevision: bundle.checkpointRevision
      });
      if (libraryRegressed || triggerNotCovered ||
          bundle.checkpointRevision < partyCheckpointRevisionRef.current) {
        throw new DOMException("Stored reconciliation result is stale", "InvalidStateError");
      }
      const knownCheckpointRevision = partyCheckpointRevisionRef.current;
      const restoredRows = bundle.tracks.map(restorePersistedTrack);
      const storedIds = new Set(restoredRows.map((track) => track.id));
      const removedIds = libraryRef.current
        .map((track) => track.id)
        .filter((trackId) => !storedIds.has(trackId));
      playedTrackIdsRef.current = playedTrackIdsRef.current.filter((trackId) => storedIds.has(trackId));
      setPlayedTrackIds((current) => current.filter((trackId) => storedIds.has(trackId)));
      if (removedIds.length) {
        stopRemoteLibraryPlayback();
        for (const trackId of removedIds) {
          removedTrackIdsRef.current.add(trackId);
          cancelBackgroundAnalysisForTrack(trackId);
        }
        pendingAnalysisQueueRef.current = pendingAnalysisQueueRef.current
          .filter((track) => storedIds.has(track.id));
      }
      const loadedOnA = deckARef.current?.getTrackId?.();
      const loadedOnB = deckBRef.current?.getTrackId?.();
      if (loadedOnA && !storedIds.has(loadedOnA)) {
        deckARef.current?.eject?.();
        setLoadedByDeck((current) => ({ ...current, a: null }));
      }
      if (loadedOnB && !storedIds.has(loadedOnB)) {
        deckBRef.current?.eject?.();
        setLoadedByDeck((current) => ({ ...current, b: null }));
      }
      publishLibrary((current) => {
        const currentById = new Map(current.map((track) => [track.id, track]));
        const next = restoredRows.map((track) => currentById.get(track.id) ?? track);
        libraryRef.current = next;
        libraryRoutineSkipSnapshotRef.current = next;
        return next;
      });
      enqueueCurrentLibraryRoutineSnapshot({ membershipChanged: true });
      setQueue((current) => current.filter((trackId) => storedIds.has(trackId)));
      libraryStateRef.current = bundle.libraryState;
      partyCheckpointRevisionRef.current = bundle.checkpointRevision;
      const normalized = normalizePartySessionCheckpointRecord(bundle.checkpointRecord);
      partyCheckpointStoredRecordRef.current = normalized;
      const localSessionId = partyCheckpointSessionIdRef.current;
      const sameOwner = normalized?.sessionId === localSessionId &&
        normalized?.writerToken === partyCheckpointWriterTokenRef.current &&
        (normalized.recordStatus === "available" || normalized.recordStatus === "claimed");
      if (localSessionId && bundle.checkpointRevision > knownCheckpointRevision && !sameOwner) {
        pauseForCheckpointOwnershipLoss();
      }
      const recovery = reconcilePartySessionCheckpoint(
        bundle.checkpointRecord,
        bundle.libraryState.epoch,
        bundle.libraryState.revision,
        restoredRows.map((track) => track.id)
      );
      partyCheckpointRecoveryRef.current = localSessionId ? null : recovery;
      setPartyCheckpointRecovery(localSessionId || recovery.status === "none" ? null : recovery);
      if (!localSessionId && recovery.status !== "none") setPartyCheckpointCardVisible(true);
    };
    const runtime = createLibraryReconciliationRuntime({
      read: (_trigger, signal) => loadLibraryRecoveryBundle({ signal }),
      mergePending: mergeLibraryReconciliationRequirements,
      onStarted: () => {
        libraryMutationBusyRef.current = true;
        libraryMutationModeRef.current = "reconciling";
        setLibraryMutationBusy(true);
        setLibraryReconcileBusy(true);
      },
      onCompleted: (trigger, bundle) => {
        applyReconciledBundle(trigger, bundle);
        if (trigger.kind === "membership-stale") setLibraryStorageError("");
        libraryMutationBusyRef.current = false;
        libraryMutationModeRef.current = "idle";
        setLibraryMutationBusy(false);
        setLibraryReconcileBusy(false);
        const terminalClear = partyCheckpointTerminalClearPendingRef.current;
        if (terminalClear) {
          partyCheckpointTerminalClearPendingRef.current = null;
          const stored = partyCheckpointStoredRecordRef.current;
          const stillOwned = stored &&
            ["available", "claimed", "invalidated"].includes(stored.recordStatus) &&
            stored.sessionId === terminalClear.sessionId &&
            stored.writerToken === terminalClear.writerToken &&
            stored.revision >= terminalClear.minimumRevision;
          if (stillOwned) {
            void clearOwnedPartyCheckpoint(terminalClear.recordStatus, {
              terminalOnFailure: true,
              expectedCheckpoint: {
                revision: stored.revision,
                sessionId: stored.sessionId,
                writerToken: stored.writerToken
              }
            });
          } else {
            pauseForCheckpointOwnershipLoss();
          }
        }
        settleReconciliationWaiters();
      },
      onFailed: () => {
        failReconciliationClosed();
        settleReconciliationWaiters();
      },
      onTimedOut: () => {
        failReconciliationClosed();
        settleReconciliationWaiters();
      }
    });
    libraryReconcileRuntimeRef.current = runtime;
    const requestReconciliation = (kind = "focus", message = null, { quiesceSession = false } = {}) => {
      const trigger = Object.freeze({
        kind,
        minimumLibraryEpoch: message?.libraryEpoch ?? libraryStateRef.current.epoch,
        minimumLibraryRevision: message?.libraryRevision ?? libraryStateRef.current.revision,
        minimumCheckpointRevision: message?.checkpointRevision ?? partyCheckpointRevisionRef.current,
        checkpointSessionId: message?.sessionId ?? null,
        checkpointWriterToken: message?.writerToken ?? null
      });
      if (quiesceSession) quiescePartyForReconciliationFailure();
      else gateAutomaticWorkForReconciliation();
      if (!partyCheckpointHydratedRef.current ||
          partyCheckpointBusyRef.current || partyCheckpointClaimOwnerRef.current ||
          partyCheckpointClearOwnerRef.current ||
          (libraryMutationBusyRef.current && libraryMutationModeRef.current !== "reconciling")) {
        runtime.pause();
        runtime.request(trigger);
        return true;
      }
      const wasPaused = runtime.snapshot().mode === "paused";
      const admitted = runtime.request(trigger);
      if (admitted === "blocked") return false;
      if (wasPaused) runtime.resume();
      libraryMutationBusyRef.current = true;
      libraryMutationModeRef.current = "reconciling";
      setLibraryMutationBusy(true);
      setLibraryReconcileBusy(true);
      return true;
    };
    libraryReconcileRequestRef.current = requestReconciliation;
    const unsubscribe = subscribeToLibraryMutations((message) => {
      invalidatePartyCheckpointClaim("The saved party plan changed in another tab while it was being restored. Reload Mazzy to review recovery before continuing.");
      const newerRemoteCheckpoint = shouldQuiescePartyForRemoteCheckpoint({
        eventType: message.type,
        eventCheckpointRevision: message.checkpointRevision,
        eventSessionId: message.sessionId ?? null,
        eventWriterToken: message.writerToken ?? null,
        currentCheckpointRevision: partyCheckpointRevisionRef.current,
        currentSessionId: partyCheckpointSessionIdRef.current,
        currentWriterToken: partyCheckpointWriterTokenRef.current
      });
      if (message.type === "track-deleted") {
        stopRemoteLibraryPlayback();
        autoPilotPreloadGenerationRef.current += 1;
        removedTrackIdsRef.current.add(message.trackId);
        cancelBackgroundAnalysisForTrack(message.trackId);
        playedTrackIdsRef.current = playedTrackIdsRef.current.filter((trackId) => trackId !== message.trackId);
        publishLibrary((current) => {
          const next = current.filter((track) => track.id !== message.trackId);
          libraryRef.current = next;
          libraryRoutineSkipSnapshotRef.current = next;
          return next;
        });
        enqueueCurrentLibraryRoutineSnapshot({ membershipChanged: true });
        setQueue((current) => current.filter((trackId) => trackId !== message.trackId));
        setPlayedTrackIds((current) => current.filter((trackId) => trackId !== message.trackId));
      } else if (message.type === "library-cleared") {
        stopRemoteLibraryPlayback();
        libraryImportGenerationRef.current += 1;
        libraryMembershipEpochRef.current += 1;
        libraryMembershipOwnerRef.current = null;
        try { libraryMembershipCancelRef.current?.(); } catch { /* Remote membership is authoritative. */ }
        libraryMembershipCancelRef.current = null;
        libraryMembershipTriggerRef.current = null;
        libraryMembershipPhaseRef.current = "idle";
        setLibraryMembershipStatus(null);
        if (["importing", "destructive"].includes(libraryMutationModeRef.current)) {
          setLibraryMutationLock(false);
        }
        analysisGenerationRef.current += 1;
        cancelActiveBackgroundAnalysis({ resetEnhanced: true });
        queuedAnalysisIdsRef.current.clear();
        pendingAnalysisQueueRef.current = [];
        backgroundAnalysisDeferredRef.current.clear();
        setBackgroundAnalysisNotice(null);
        disposeAnalysisClient();
        disposeEnhancedRhythmClient();
      }
      const libraryStateAdvanced = message.libraryEpoch > libraryStateRef.current.epoch ||
        (message.libraryEpoch === libraryStateRef.current.epoch &&
          message.libraryRevision > libraryStateRef.current.revision);
      if (!message.type.startsWith("party-checkpoint-") || newerRemoteCheckpoint ||
          libraryStateAdvanced) {
        requestReconciliation("broadcast", message, { quiesceSession: newerRemoteCheckpoint });
      }
    });
    const onReturn = () => {
      const pickerOwner = libraryImportPickerOwnerRef.current;
      if (pickerOwner) {
        if (libraryImportPickerReconcileConsumedRef.current) return;
        if (!libraryImportPickerBlurredRef.current) return;
        libraryImportPickerFocusDeferredRef.current = true;
        if (libraryImportPickerReleaseTimerRef.current != null) {
          window.clearTimeout(libraryImportPickerReleaseTimerRef.current);
        }
        libraryImportPickerReleaseTimerRef.current = window.setTimeout(() => {
          if (ownsLibraryImportPicker(libraryImportPickerOwnerRef.current, pickerOwner)) {
            libraryImportPickerOwnerRef.current = null;
          }
          libraryImportPickerTriggerRef.current = null;
          libraryImportPickerBlurredRef.current = false;
          libraryImportPickerReleaseTimerRef.current = null;
          if (libraryImportPickerFocusDeferredRef.current) {
            libraryImportPickerFocusDeferredRef.current = false;
            libraryImportPickerReconcileConsumedRef.current = true;
            libraryReconcileRequestRef.current?.("focus");
          }
        }, 250);
        return;
      }
      if (document.visibilityState === "visible") requestReconciliation("focus");
    };
    const onBlur = () => {
      if (libraryImportPickerOwnerRef.current) libraryImportPickerBlurredRef.current = true;
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      runtime.halt();
      if (libraryReconcileRequestRef.current === requestReconciliation) {
        libraryReconcileRequestRef.current = null;
      }
      partyCheckpointTerminalClearPendingRef.current = null;
      if (libraryReconcileRuntimeRef.current === runtime) libraryReconcileRuntimeRef.current = null;
      unsubscribe();
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      settleReconciliationWaiters();
    };
  }, []);

  useEffect(() => {
    if (!partyTraceRecorderRef.current || !partyTraceRunningRef.current) return;
    const trackOrdinals = queue.map(partyTrackOrdinal).filter(Boolean);
    recordPartyEvent({
      type: "queue-committed",
      revision: ++partyQueueRevisionRef.current,
      trackOrdinals
    });
  }, [queue]);

  useEffect(() => {
    if (showPartyReadiness) partyReadinessRef.current?.focus?.();
  }, [showPartyReadiness]);

  useEffect(() => {
    if (!autoPilotChoice?.afterNextId) return;
    const stillEligible = buildAutoPilotCandidateIds(
      queue,
      library,
      playedTrackIds,
      [loadedByDeck.a, loadedByDeck.b],
      autoPilotUseLibrary,
      autoPilotExcludedTrackIds
    ).includes(autoPilotChoice.afterNextId);
    if (!stillEligible) {
      setAutoPilotChoice((current) => current ? {
        ...current,
        afterNextId: null,
        afterNextName: null,
        reasons: [current.reasons[0], "The later horizon will be replanned.", current.reasons[2]].filter(Boolean)
      } : current);
    }
  }, [autoPilotChoice?.afterNextId, autoPilotUseLibrary, library, loadedByDeck, playedTrackIds, queue, unavailableAutoPilotTrackIds, timedOutAutoPilotTrackIds]);

  useEffect(() => {
    const update = () => setPartyClockDisplay(
      partySessionClockSnapshot(partySessionClockRef.current, getAudioEngine().clock.now())
    );
    update();
    if (!autoPilotEnabled) return undefined;
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [autoPilotEnabled, partyDurationMinutes]);

  useEffect(() => {
    if (!partyCheckpointHydratedRef.current || partyCheckpointTerminalRef.current) return;
    queuePartyCheckpointSave();
  }, [
    autoPilotEnabled,
    autoMixArming,
    autoMixing,
    masterDeck,
    loadedByDeck,
    queue,
    playedTrackIds,
    partyDurationMinutes,
    partyEnergyProfile,
    partyEnergyShift,
    autoPilotUseLibrary,
    rehearsalActive,
    rehearsalPreparing
  ]);

  useEffect(() => {
    if (!autoPilotEnabled || partyCheckpointTerminalRef.current) return undefined;
    const timer = window.setInterval(() => queuePartyCheckpointSave("active-periodic"), 10_000);
    return () => window.clearInterval(timer);
  }, [autoPilotEnabled, masterDeck, partyEnergyProfile, partyEnergyShift, autoPilotUseLibrary]);

  const queueTracks = useMemo(
    () => queue.map((id) => library.find((t) => t.id === id)).filter(Boolean),
    [queue, library]
  );
  const nowPlayingTrack = library.find((track) => track.id === loadedByDeck[masterDeck]) ?? null;
  const availableAutoPilotTrackIds = buildAutoPilotCandidateIds(
    queue,
    library,
    playedTrackIds,
    [loadedByDeck.a, loadedByDeck.b],
    autoPilotUseLibrary,
    autoPilotExcludedTrackIds
  );
  const availableAutoPilotTracks = availableAutoPilotTrackIds.length;
  const queuePositionMap = useMemo(() => {
    const map = new Map();
    queue.forEach((id, idx) => {
      if (!map.has(id)) map.set(id, idx + 1);
    });
    return map;
  }, [queue]);

  useEffect(() => {
    analysisPriorityRef.current = {
      loaded: [loadedByDeck.a, loadedByDeck.b],
      queued: queue
    };
    pendingAnalysisQueueRef.current = sortBackgroundAnalysisJobs(
      pendingAnalysisQueueRef.current,
      analysisPriorityRef.current.loaded,
      analysisPriorityRef.current.queued
    );
  }, [loadedByDeck, queue]);

  useEffect(() => {
    if (importRef.current) {
      importRef.current.setAttribute("webkitdirectory", "");
      importRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void getEnhancedRhythmAssetState().then((assetState) => {
      if (!active) return;
      const stored = assetState === "stored";
      setEnhancedTimingAvailable(stored);
      setEnhancedTimingState(stored
        ? "stored"
        : assetState === "stored-unavailable"
          ? "stored-unavailable"
          : assetState === "downloadable"
            ? "not-downloaded"
            : assetState === "not-included"
              ? "not-included"
              : "offline");
    }).catch(() => {
      if (!active) return;
      setEnhancedTimingAvailable(false);
      setEnhancedTimingState("offline");
    });
    return () => { active = false; };
  }, []);

  const prepareTimingModel = async () => {
    setEnhancedTimingState("downloading");
    try {
      await prepareEnhancedRhythm((stage) => setEnhancedTimingState(stage));
      setEnhancedTimingAvailable(true);
      setEnhancedTimingState("ready");
    } catch {
      setEnhancedTimingAvailable(false);
      setEnhancedTimingState("error");
    }
  };

  const removeTimingModel = async () => {
    if (activeBackgroundAnalysisRef.current?.kind === "enhanced") {
      cancelActiveBackgroundAnalysis({ resetEnhanced: true });
    }
    try { backgroundEnhancedAnalysisRef.current?.dispose?.(); } catch { /* Cache removal continues. */ }
    backgroundEnhancedAnalysisRef.current = null;
    pendingAnalysisQueueRef.current = pendingAnalysisQueueRef.current.filter((job) => job.kind !== "enhanced");
    for (const key of queuedAnalysisIdsRef.current) {
      if (key.startsWith("enhanced:")) queuedAnalysisIdsRef.current.delete(key);
    }
    for (const key of backgroundAnalysisDeferredRef.current.keys()) {
      if (key.startsWith("enhanced:")) backgroundAnalysisDeferredRef.current.delete(key);
    }
    setEnhancedFailureByTrack({});
    refreshBackgroundAnalysisNotice({ enhancedEnabled: false });
    await removeEnhancedRhythmModel();
    setEnhancedTimingAvailable(false);
    setEnhancedTimingState(__MAZZY_ENHANCED_TIMING_INCLUDED__
      ? navigator.onLine ? "not-downloaded" : "offline"
      : "not-included");
  };

  useEffect(() => {
    const engine = getAudioEngine();
    const gains = equalPowerGains(0.5);
    engine.setDeckGain("a", gains.source);
    engine.setDeckGain("b", gains.target);
  }, []);

  useEffect(() => {
    if (libraryHydrationCircuitOpen) return undefined;
    const hydrationGeneration = ++libraryHydrationGenerationRef.current;
    const hydration = startLibraryHydration({
      epoch: hydrationGeneration,
      operation: ++libraryHydrationOperationRef.current,
      task: (signal) => loadLibraryRecoveryBundle({ signal }),
      ownsAuthority: (owner) => ownsLibraryHydration(libraryHydrationOwnerRef.current, owner)
    });
    libraryHydrationOwnerRef.current = hydration.owner;
    libraryHydrationCancelRef.current = hydration.cancel;
    const restore = async () => {
      let restored = false;
      const settlement = await hydration.settlement;
      if (!ownsLibraryHydration(libraryHydrationOwnerRef.current, hydration.owner)) return;
      libraryHydrationOwnerRef.current = null;
      libraryHydrationCancelRef.current = null;
      if (settlement.outcome === "completed") {
        try {
          const bundle = settlement.value;
          const restoredLibrary = bundle.tracks.map(restorePersistedTrack);
          const normalizedCheckpoint = normalizePartySessionCheckpointRecord(bundle.checkpointRecord);
          const checkpointRecovery = reconcilePartySessionCheckpoint(
            bundle.checkpointRecord,
            bundle.libraryState.epoch,
            bundle.libraryState.revision,
            restoredLibrary.map((track) => track.id)
          );
          libraryStateRef.current = bundle.libraryState;
          partyCheckpointStoredRecordRef.current = normalizedCheckpoint;
          partyCheckpointRevisionRef.current = bundle.checkpointRevision;
          partyCheckpointRecoveryRef.current = checkpointRecovery;
          setPartyCheckpointRecovery(checkpointRecovery.status === "none" ? null : checkpointRecovery);
          setPartyCheckpointCardVisible(true);
          partyCheckpointHydratedRef.current = true;
          libraryRef.current = restoredLibrary;
          libraryRoutineSkipSnapshotRef.current = restoredLibrary;
          publishLibrary(restoredLibrary);
          setLibraryStorageError("");
          if (libraryHydrationRetryRequestedRef.current) {
            libraryHydrationRetryRequestedRef.current = false;
            window.requestAnimationFrame(() => partyModeTitleRef.current?.focus?.());
          }
          restored = true;
        } catch {
          setLibraryStorageError("Saved music could not be validated. Reload Mazzy before opening local music.");
          setLibraryHydrationCircuitOpen(true);
          window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
        }
      } else if (settlement.outcome === "failed") {
        setLibraryStorageError("Saved music couldn't be opened. Close other Mazzy tabs, then retry opening local music.");
        window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
      } else if (settlement.outcome === "timed-out") {
        setLibraryHydrationCircuitOpen(true);
        setLibraryStorageError("Saved music did not finish opening because browser storage stopped responding. Reload Mazzy before trying again.");
        window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
      }
      if (restored && hydrationGeneration === libraryHydrationGenerationRef.current) {
        setLibraryMutationLock(false);
      }
    };
    void restore();
    return () => {
      if (ownsLibraryHydration(libraryHydrationOwnerRef.current, hydration.owner)) {
        libraryHydrationOwnerRef.current = null;
        try { libraryHydrationCancelRef.current?.(); } catch { /* Hydration authority is already revoked. */ }
        libraryHydrationCancelRef.current = null;
      }
      if (hydrationGeneration === libraryHydrationGenerationRef.current) {
        libraryHydrationGenerationRef.current += 1;
      }
    };
  }, [libraryRestoreAttempt, libraryHydrationCircuitOpen]);

  const dismissContextMenu = () => {
    if (contextMenuRef.current?.contains(document.activeElement)) contextMenuTriggerRef.current?.focus?.();
    setContextMenu(null);
  };

  const setLibraryMutationLock = (locked, mode = "destructive") => {
    const reconcileRuntime = libraryReconcileRuntimeRef.current;
    if (locked && mode !== "reconciling") {
      reconcileRuntime?.pause?.();
      setLibraryReconcileBusy(false);
    }
    libraryMutationBusyRef.current = locked;
    libraryMutationModeRef.current = locked ? mode : "idle";
    setLibraryMutationBusy(locked);
    if (!locked && reconcileRuntime?.snapshot?.().mode === "paused") {
      reconcileRuntime.resume();
      const snapshot = reconcileRuntime.snapshot();
      if (snapshot.active || snapshot.pending) {
        libraryMutationBusyRef.current = true;
        libraryMutationModeRef.current = "reconciling";
        setLibraryMutationBusy(true);
        setLibraryReconcileBusy(true);
      }
    }
  };

  const beginLibraryMembershipMutation = (kind) => {
    if (libraryMembershipOwnerRef.current || libraryMembershipCircuitOpen ||
        libraryMutationBusyRef.current || partyCheckpointBusyRef.current ||
        playbackRecoveryLockedRef.current || partyFirstSongStartOwnerRef.current ||
        libraryMembershipDeckCleanupRef.current) return null;
    const owner = createLibraryMembershipMutationOwner({
      epoch: libraryMembershipEpochRef.current,
      operation: ++libraryMembershipOperationRef.current,
      kind,
      expectedLibraryEpoch: libraryStateRef.current.epoch,
      expectedLibraryRevision: libraryStateRef.current.revision
    });
    libraryMembershipOwnerRef.current = owner;
    libraryMembershipPhaseRef.current = kind === "import" ? "preparing" : "waiting-exclusive";
    libraryMembershipTriggerRef.current = kind === "import"
      ? libraryImportPickerTriggerRef.current ?? document.activeElement
      : document.activeElement;
    if (kind === "import") libraryImportPickerTriggerRef.current = null;
    setLibraryMembershipStatus({ kind, state: kind === "import" ? "preparing" : "committing", completed: 0, total: 0 });
    if (kind !== "import") window.requestAnimationFrame(() => libraryMembershipStatusRef.current?.focus?.());
    return owner;
  };

  const ownsLibraryMembership = (owner) =>
    ownsLibraryMembershipMutation(libraryMembershipOwnerRef.current, owner);

  const runLibraryMembershipStage = async (owner, stage, task) => {
    if (!ownsLibraryMembership(owner)) return { outcome: "cancelled" };
    const run = startBoundedLibraryMembershipStage({
      mutation: owner,
      stage,
      stageOperation: ++libraryMembershipStageOperationRef.current,
      task,
      ownsAuthority: () => ownsLibraryMembership(owner)
    });
    libraryMembershipCancelRef.current = run.cancel;
    const settlement = await run.settlement;
    if (libraryMembershipCancelRef.current === run.cancel) libraryMembershipCancelRef.current = null;
    return settlement;
  };

  const finishLibraryMembershipMutation = (owner, { restoreFocus = false } = {}) => {
    if (!ownsLibraryMembership(owner)) return false;
    const trigger = libraryMembershipTriggerRef.current;
    libraryMembershipOwnerRef.current = null;
    libraryMembershipCancelRef.current = null;
    libraryMembershipPhaseRef.current = "idle";
    setLibraryMembershipStatus(null);
    libraryMembershipTriggerRef.current = null;
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus?.());
    queueMicrotask(() => drainPendingTerminalCheckpointAfterMembership());
    return true;
  };

  const cancelLibraryMembershipPreparation = () => {
    const owner = libraryMembershipOwnerRef.current;
    if (!owner || owner.kind !== "import" ||
        !mayCancelLibraryMembershipPreparation(libraryMembershipPhaseRef.current)) return;
    const trigger = libraryMembershipTriggerRef.current;
    libraryMembershipOwnerRef.current = null;
    try { libraryMembershipCancelRef.current?.(); } catch { /* Preparation authority is already revoked. */ }
    libraryMembershipCancelRef.current = null;
    libraryMembershipPhaseRef.current = "idle";
    libraryMembershipTriggerRef.current = null;
    setLibraryMembershipStatus(null);
    showToast("Import preparation cancelled · nothing was saved");
    window.requestAnimationFrame(() => trigger?.focus?.());
    queueMicrotask(() => drainPendingTerminalCheckpointAfterMembership());
  };

  const releaseLibraryImportPickerSoon = () => {
    const owner = libraryImportPickerOwnerRef.current;
    if (!owner) return;
    if (libraryImportPickerReleaseTimerRef.current != null) {
      window.clearTimeout(libraryImportPickerReleaseTimerRef.current);
    }
    libraryImportPickerReleaseTimerRef.current = window.setTimeout(() => {
      if (ownsLibraryImportPicker(libraryImportPickerOwnerRef.current, owner)) {
        libraryImportPickerOwnerRef.current = null;
      }
      libraryImportPickerTriggerRef.current = null;
      libraryImportPickerBlurredRef.current = false;
      libraryImportPickerReleaseTimerRef.current = null;
      if (libraryImportPickerFocusDeferredRef.current) {
        libraryImportPickerFocusDeferredRef.current = false;
        libraryReconcileRequestRef.current?.("focus");
      }
    }, 250);
  };

  const requestDeferredLibraryPickerReconciliation = () => {
    if (!libraryImportPickerFocusDeferredRef.current) return;
    libraryImportPickerFocusDeferredRef.current = false;
    libraryImportPickerReconcileConsumedRef.current = true;
    if (!libraryMembershipOwnerRef.current) {
      libraryImportPickerOwnerRef.current = null;
      libraryImportPickerBlurredRef.current = false;
      if (libraryImportPickerReleaseTimerRef.current != null) {
        window.clearTimeout(libraryImportPickerReleaseTimerRef.current);
        libraryImportPickerReleaseTimerRef.current = null;
      }
    }
    libraryReconcileRequestRef.current?.("focus");
  };

  const openLibraryImportPicker = () => {
    if (!importRef.current || libraryMembershipOwnerRef.current || libraryMembershipCircuitOpen ||
        libraryMutationBusyRef.current || partyCheckpointBusyRef.current ||
        playbackRecoveryLockedRef.current || partyFirstSongStartOwnerRef.current) return;
    const owner = createLibraryImportPickerOwner(++libraryImportPickerOperationRef.current);
    libraryImportPickerOwnerRef.current = owner;
    libraryImportPickerTriggerRef.current = document.activeElement;
    libraryImportPickerFocusDeferredRef.current = true;
    libraryImportPickerReconcileConsumedRef.current = false;
    libraryImportPickerBlurredRef.current = false;
    if (libraryImportPickerReleaseTimerRef.current != null) {
      window.clearTimeout(libraryImportPickerReleaseTimerRef.current);
      libraryImportPickerReleaseTimerRef.current = null;
    }
    try {
      importRef.current.click();
    } catch {
      if (ownsLibraryImportPicker(libraryImportPickerOwnerRef.current, owner)) {
        libraryImportPickerOwnerRef.current = null;
      }
      libraryImportPickerTriggerRef.current = null;
      libraryImportPickerFocusDeferredRef.current = false;
      libraryImportPickerReconcileConsumedRef.current = false;
      libraryImportPickerBlurredRef.current = false;
    }
  };

  const failLibraryMembershipCommitClosed = (owner) => {
    if (ownsLibraryMembership(owner)) libraryMembershipOwnerRef.current = null;
    try { libraryMembershipCancelRef.current?.(); } catch { /* Commit authority is already revoked. */ }
    libraryMembershipCancelRef.current = null;
    libraryMembershipPhaseRef.current = "circuit-open";
    libraryMembershipTriggerRef.current = null;
    setLibraryMembershipStatus(null);
    setLibraryMembershipCircuitOpen(true);
    setLibrarySaveStatus("error");
    setLibraryMutationLock(true, "membership-circuit");
    if (partyCheckpointTerminalClearPendingRef.current) {
      partyCheckpointTerminalClearPendingRef.current = null;
      partyCheckpointTerminalRef.current = true;
      getPartyCheckpointWriteRuntime().openCircuit();
      setPartyCheckpointWriteCircuitOpen(true);
      setPartyCheckpointError("The party finished, but local music storage became uncertain before saved recovery could be cleared. Reload Mazzy before starting another party.");
    }
    pauseAutoPilotForHostControl("Party Autopilot paused · local music storage needs review");
    setLibraryStorageError("Mazzy could not confirm whether the local music change finished. New playback and library changes are locked. Reload local music before continuing.");
    window.requestAnimationFrame(() => libraryMembershipAlertRef.current?.focus?.());
  };

  const focusLibraryAfterMembershipSuccess = () => {
    window.requestAnimationFrame(() => {
      if (!libraryMembershipOwnerRef.current) libraryHeadingRef.current?.focus?.();
    });
  };

  const retainPlaybackLockAfterMembershipCleanupFailure = (entries) => {
    libraryMembershipDeckCleanupRef.current = Object.freeze({
      version: "library-membership-deck-cleanup/v1",
      entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry })))
    });
    transitionCompletionUncertainRef.current = true;
    setTransitionCompletionUncertain(true);
    refreshPlaybackRecoveryLock();
    showAutoPilotArmIntervention("library-membership-cleanup");
  };

  const retryMembershipDeckCleanupAfterStop = () => {
    const pending = libraryMembershipDeckCleanupRef.current;
    if (!pending) return true;
    let allConfirmed = true;
    for (const entry of pending.entries) {
      if (!entry.exact) {
        allConfirmed = false;
        continue;
      }
      const handle = entry.deck === "a" ? deckARef.current : deckBRef.current;
      const cleanup = retryExactDeckMembershipCleanup(handle, entry);
      if (!cleanup.confirmed) {
        allConfirmed = false;
      } else if (cleanup.clearLoadedIdentity) {
        setLoadedByDeck((current) => ({ ...current, [entry.deck]: null }));
      }
    }
    if (allConfirmed) libraryMembershipDeckCleanupRef.current = null;
    return allConfirmed;
  };

  const requestLibraryMembershipReconciliation = (result = null) => {
    const libraryState = result?.libraryState ?? libraryStateRef.current;
    const requested = libraryReconcileRequestRef.current?.("membership-stale", {
      libraryEpoch: libraryState.epoch,
      libraryRevision: libraryState.revision,
      checkpointRevision: result?.checkpointRevision ?? partyCheckpointRevisionRef.current
    });
    if (requested) return true;
    libraryMembershipPhaseRef.current = "circuit-open";
    setLibraryMembershipCircuitOpen(true);
    setLibraryMutationLock(true, "membership-circuit");
    pauseAutoPilotForHostControl("Party Autopilot paused · local music changed in another tab");
    setLibraryStorageError("Mazzy could not refresh local music after another tab changed it. New playback and library changes are locked. Reload local music before continuing.");
    window.requestAnimationFrame(() => libraryMembershipAlertRef.current?.focus?.());
    return false;
  };

  const libraryWritesBlocked = () => !["idle", "importing"].includes(libraryMutationModeRef.current);

  const getLibraryRoutineWriteRuntime = () => {
    if (libraryRoutineWriteRuntimeRef.current) return libraryRoutineWriteRuntimeRef.current;
    libraryRoutineWriteRuntimeRef.current = createLibraryRoutineWriteRuntime({
      write: (batch, signal) => saveRoutineTrackUpdatesToDb(batch, { signal }),
      mergePending: mergeLibraryRoutineWriteBatches,
      retryRejectedWhileExclusive: retryRejectedLibraryRoutineSnapshot,
      onResolved: (batch, result) => {
        if (result.status !== "saved") {
          const pending = libraryRoutineWriteRuntimeRef.current?.snapshot?.().pending;
          const skippedStillCurrent = result.skippedTrackIds.some((trackId) => {
            const current = libraryRef.current.find((track) => track.id === trackId);
            if (!current) return false;
            const expected = batch.tracks?.find((track) => track.id === trackId) ??
              batch.patches.find((entry) => entry.trackId === trackId);
            if (!expected) return true;
            return normalizeContentIdentity(current.contentIdentity) ===
              normalizeContentIdentity(expected?.contentIdentity);
          });
          if (pending && !skippedStillCurrent) {
            setLibrarySaveStatus("saving");
            return true;
          }
          setLibrarySaveStatus("error");
          setLibraryRoutineWriteCircuitOpen(true);
          setLibraryAnalysisSaveError("Local music changed while analysis was being saved. Music and Safe Fade still work, but reload Mazzy before relying on newly saved analysis.");
          window.requestAnimationFrame(() => libraryRoutineWriteAlertRef.current?.focus?.());
          return false;
        }
        libraryRoutineSavedGenerationRef.current = Math.max(
          libraryRoutineSavedGenerationRef.current,
          batch.routineGeneration
        );
        const runtimeSnapshot = libraryRoutineWriteRuntimeRef.current?.snapshot?.();
        const saveStatus = libraryRoutineSaveStatusAfterSettlement({
          pending: Boolean(runtimeSnapshot?.pending),
          dirtyGeneration: libraryRoutineDirtyGenerationRef.current,
          savedGeneration: libraryRoutineSavedGenerationRef.current
        });
        setLibrarySaveStatus(saveStatus);
        if (saveStatus === "saved" && !libraryRoutineWriteCircuitOpen) setLibraryAnalysisSaveError("");
        if (saveStatus === "saving" && runtimeSnapshot?.mode === "running" && !runtimeSnapshot.pending) {
          window.queueMicrotask(() => enqueueCurrentLibraryRoutineSnapshot());
        }
        return true;
      },
      onRejected: () => {
        setLibrarySaveStatus("error");
        setLibraryAnalysisSaveError("Your music is still stored, but the newest local analysis could not be saved. Free browser storage and reload to retry analysis.");
        return true;
      },
      onTimedOut: () => {
        setLibrarySaveStatus("error");
        setLibraryRoutineWriteCircuitOpen(true);
        setLibraryAnalysisSaveError("Local analysis saving stopped because browser storage did not respond. Music and Safe Fade still work; reload Mazzy before relying on newly saved analysis.");
        window.requestAnimationFrame(() => libraryRoutineWriteAlertRef.current?.focus?.());
      }
    });
    return libraryRoutineWriteRuntimeRef.current;
  };

  const persistRoutineTrackPatch = async (trackId, patch) => {
    const current = libraryRef.current.find((track) => track.id === trackId);
    if (!current || removedTrackIdsRef.current.has(trackId)) {
      throw new DOMException("The local track changed before its update could be saved", "InvalidStateError");
    }
    const expectedContentIdentity = normalizeContentIdentity(current.contentIdentity);
    const queued = getLibraryRoutineWriteRuntime().enqueue(createLibraryRoutinePatchBatch(
      trackId,
      expectedContentIdentity,
      patch
    ));
    const settlement = await queued.settlement;
    const settledCurrent = libraryRef.current.find((track) => track.id === trackId);
    if (settlement.outcome !== "completed" || settlement.result.status !== "saved" ||
        !settlement.result.savedTrackIds.includes(trackId) ||
        normalizeContentIdentity(settledCurrent?.contentIdentity) !== expectedContentIdentity) {
      throw new DOMException("The local track update was not saved", "InvalidStateError");
    }
  };

  const prepareLibraryRoutineWriteExclusive = async () => {
    const ready = await getLibraryRoutineWriteRuntime().prepareExclusive();
    if (!ready) {
      setLibrarySaveStatus("error");
      setLibraryRoutineWriteCircuitOpen(true);
      setLibraryAnalysisSaveError("Local analysis saving did not release browser storage. Music remains available, but reload Mazzy before changing the saved library.");
      window.requestAnimationFrame(() => libraryRoutineWriteAlertRef.current?.focus?.());
    }
    return ready;
  };

  const enqueueCurrentLibraryRoutineSnapshot = ({ membershipChanged = false } = {}) => {
    const runtime = getLibraryRoutineWriteRuntime();
    const snapshot = runtime.snapshot();
    if (!shouldEnqueueLibraryRoutineSnapshot({
      membershipChanged,
      active: snapshot.active,
      pending: snapshot.pending,
      dirtyGeneration: libraryRoutineDirtyGenerationRef.current,
      savedGeneration: libraryRoutineSavedGenerationRef.current
    })) return false;
    const tracks = libraryRef.current
      .filter((track) => !removedTrackIdsRef.current.has(track.id))
      .map(persistedTrack);
    const queued = runtime.enqueue(membershipChanged
      ? createLibraryRoutineMembershipBatch(tracks, libraryRoutineDirtyGenerationRef.current)
      : createLibraryRoutineSnapshotBatch(tracks, libraryRoutineDirtyGenerationRef.current));
    if (!libraryRoutineEnqueueOwnsPersistence(queued.status)) return false;
    setLibrarySaveStatus("saving");
    return true;
  };

  const completeLibraryRoutineWriteExclusive = ({ membershipChanged = false } = {}) => {
    const runtime = getLibraryRoutineWriteRuntime();
    const snapshot = runtime.snapshot();
    const replayPending = snapshot.pending;
    const replayAllowed = snapshot.mode === "exclusive" && snapshot.exclusiveReturnMode === "running";
    const dirtyUnpersisted = hasUnpersistedLibraryRoutineGeneration({
      dirtyGeneration: libraryRoutineDirtyGenerationRef.current,
      savedGeneration: libraryRoutineSavedGenerationRef.current
    });
    if (replayAllowed && (replayPending || dirtyUnpersisted)) {
      const tracks = libraryRef.current
        .filter((track) => !removedTrackIdsRef.current.has(track.id))
        .map(persistedTrack);
      runtime.enqueue(membershipChanged
        ? createLibraryRoutineMembershipBatch(tracks, libraryRoutineDirtyGenerationRef.current)
        : createLibraryRoutineSnapshotBatch(tracks, libraryRoutineDirtyGenerationRef.current));
      setLibrarySaveStatus("saving");
    }
    return Object.freeze({
      completed: runtime.completeExclusive(),
      replayed: replayAllowed && (replayPending || dirtyUnpersisted)
    });
  };

  useEffect(() => {
    const closeMenu = () => dismissContextMenu();
    const closeMenuWithKeyboard = (event) => {
      if (event.key === "Escape" && contextMenu) closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenuWithKeyboard);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenuWithKeyboard);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (contextMenu) contextMenuRef.current?.querySelector?.("button:not(:disabled)")?.focus?.();
  }, [contextMenu]);

  const onContextMenuKeyDown = (event) => {
    if (!contextMenu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(contextMenuRef.current?.querySelectorAll?.("button:not(:disabled)") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus?.();
  };

  useEffect(() => {
    const updateMasterMeter = (timestamp) => {
      if (contextReadyRef.current && timestamp - lastMasterMeterUpdateRef.current >= 80) {
        const reading = getAudioEngine().readMasterMeter();
        setMasterMeter({
          peakDb: reading.peakDb,
          limiterReductionDb: reading.limiterReductionDb
        });
        lastMasterMeterUpdateRef.current = timestamp;
      }
      masterMeterFrameRef.current = requestAnimationFrame(updateMasterMeter);
    };
    masterMeterFrameRef.current = requestAnimationFrame(updateMasterMeter);
    return () => cancelAnimationFrame(masterMeterFrameRef.current);
  }, []);

  const showToast = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1400);
  };

  const showAutoPilotArmIntervention = (reason) => {
    partyCheckpointPauseReasonRef.current = "safety";
    setAutoPilotIntervention({
      reason,
      message: reason === "library-membership-cleanup"
        ? "Mazzy saved the local music change but could not confirm that every removed song was ejected. New playback is locked. Use Stop All Sound; use system/device mute if sound remains."
        : reason === "transition-completion-late"
        ? "The next song was kept, but the song-change confirmation arrived late. Autopilot is paused so the host can check playback before continuing."
        : reason === "transition-completion-cleanup"
          ? "The next song was kept, but Mazzy could not confirm every transition cleanup step. Autopilot is paused so the host can check playback."
          : reason === "transition-completion-lost"
            ? "Mazzy could not confirm that the song change finished. Autopilot is paused and new playback is locked. Use Stop All Sound; use system/device mute if sound remains."
            : reason === "coordinator-failure-transition"
              ? "Mazzy could not confirm the automatic song change after an unexpected local error. New playback is locked. Use Stop All Sound before continuing; use system/device mute if sound remains."
            : reason === "deck-completion-transition"
              ? "A deck stopped before Mazzy could verify the automatic song change. New playback is locked. Use Stop All Sound before continuing; use system/device mute if sound remains."
            : reason === "deck-completion-owner-unobservable"
              ? "Mazzy could not verify which deck playback ended. Autopilot is paused and new playback is locked. Use Stop All Sound; use system/device mute if sound remains."
            : reason === "deck-completion-failure"
              ? "The current song stopped before Mazzy could verify its audio-clock ending. Autopilot is paused. Choose and play a song before starting Autopilot again."
            : reason === "unexpected-source-ended"
              ? "The current song ended before Mazzy started the next one. Autopilot is paused, and no new song was started."
            : reason === "deck-completion-conflict"
              ? "A song ended while Mazzy still had another automatic operation open. Autopilot is paused so the host can check the decks before continuing."
            : reason === "preload-cleanup-uncertain"
              ? "Mazzy paused automatic planning but could not confirm that the next-song load stopped. New playback is locked. Use Stop All Sound before continuing; use system/device mute if sound remains."
            : reason === "coordinator-failure"
              ? "Mazzy stopped automatic planning after an unexpected local error. The current song was left alone. Check the decks, then start Autopilot again when ready."
        : reason === "transition-arm-timeout"
          ? "The next transition took too long to prepare. The current song is still playing and Autopilot is paused."
          : "The next transition could not be prepared safely. The current song is still playing and Autopilot is paused."
    });
    window.requestAnimationFrame(() => partyInterventionRef.current?.focus?.());
  };

  const activePartySecond = () => Math.max(0, Math.floor(
    partySessionClockSnapshot(partySessionClockRef.current, getAudioEngine().clock.now()).elapsedActiveSeconds
  ));

  const pausePartyClockFailClosed = () => {
    const clock = partySessionClockRef.current;
    try {
      const now = getAudioEngine().clock.now();
      partyAutopilotLastObservedNowRef.current = now;
      partySessionClockRef.current = pausePartySessionClock(clock, now);
      setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
      return;
    } catch { /* Fall back to the last authoritative audio-clock observation. */ }
    const fallbackNow = Math.max(
      Number(clock.runningSinceSeconds ?? 0),
      partyAutopilotLastObservedNowRef.current
    );
    try {
      partySessionClockRef.current = pausePartySessionClock(clock, fallbackNow);
      setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, fallbackNow));
    } catch {
      partySessionClockRef.current = restorePausedPartySessionClock(
        clock.plannedDurationSeconds,
        clock.accumulatedActiveSeconds
      );
      setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, 0));
    }
  };

  const checkpointSaveIsStable = () =>
    partyCheckpointHydratedRef.current &&
    !partyCheckpointTerminalRef.current &&
    !partyCheckpointWriterLostRef.current &&
    !partyFallbackContinuationRef.current &&
    !libraryMutationBusyRef.current &&
    !playbackRecoveryLockedRef.current &&
    !partyFirstSongStartOwnerRef.current &&
    !autoPilotPreloadLeaseRef.current &&
    !transitionArmLeaseRef.current &&
    !transitionArmRef.current &&
    !activeTransitionScheduleRef.current &&
    !rehearsalActive &&
    !rehearsalPreparing &&
    !rehearsalCancelRef.current;

  const pauseForCheckpointOwnershipLoss = () => {
    advancePartyAutopilotCoordinatorEpoch();
    if (partyCheckpointWriterLostRef.current) return;
    partyCheckpointWriterLostRef.current = true;
    setPartyCheckpointWriterLost(true);
    refreshPlaybackRecoveryLock();
    partyCheckpointWriteGenerationRef.current += 1;
    partyCheckpointWriteRuntimeRef.current?.halt?.();
    stopRemoteLibraryPlayback();
    deckARef.current?.pause?.();
    deckBRef.current?.pause?.();
    setPartyCheckpointError("Party recovery moved to another Mazzy tab. Autopilot and audio were paused here. Check the other tab before continuing.");
    window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
  };

  const getPartyCheckpointWriteRuntime = () => {
    if (partyCheckpointWriteRuntimeRef.current) return partyCheckpointWriteRuntimeRef.current;
    partyCheckpointWriteRuntimeRef.current = createPartyCheckpointWriteRuntime({
      write: async (candidate, signal) => {
        if (candidate.generation !== partyCheckpointWriteGenerationRef.current ||
          !checkpointSaveIsStable()) return { status: "skipped" };
        const stored = partyCheckpointStoredRecordRef.current;
        return savePartySessionCheckpointToDb(candidate.draft, {
          checkpointRevision: partyCheckpointRevisionRef.current,
          libraryEpoch: libraryStateRef.current.epoch,
          libraryRevision: libraryStateRef.current.revision,
          sessionId: stored?.recordStatus === "available" || stored?.recordStatus === "claimed"
            ? stored.sessionId
            : null,
          writerToken: stored?.recordStatus === "available" || stored?.recordStatus === "claimed"
            ? stored.writerToken
            : null
        }, { signal });
      },
      onResolved: (candidate, result) => {
        if (candidate.generation !== partyCheckpointWriteGenerationRef.current || result.status === "skipped") {
          return true;
        }
        if (result.status !== "saved") {
          if (result.status === "stale-checkpoint") {
            pauseForCheckpointOwnershipLoss();
            return false;
          }
          setPartyCheckpointError("Party recovery could not be updated. Music can continue, but refreshing may lose recent party progress.");
          return true;
        }
        partyCheckpointRevisionRef.current = result.checkpoint.revision;
        partyCheckpointStoredRecordRef.current = result.checkpoint;
        partyCheckpointLastFingerprintRef.current = candidate.fingerprint;
        libraryStateRef.current = result.libraryState;
        setPartyCheckpointError("");
        return true;
      },
      onRejected: (candidate) => {
        if (candidate.generation !== partyCheckpointWriteGenerationRef.current) return true;
        setPartyCheckpointError("Party recovery could not be updated. Music can continue, but refreshing may lose recent party progress.");
        return true;
      },
      onTimedOut: (candidate) => {
        if (candidate.generation !== partyCheckpointWriteGenerationRef.current) return;
        partyCheckpointWriteGenerationRef.current += 1;
        setPartyCheckpointWriteCircuitOpen(true);
        setPartyCheckpointError("Party recovery updates stopped because browser storage did not respond. Music can continue, but reload Mazzy before relying on saved recovery or starting a new party.");
        window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
      }
    });
    return partyCheckpointWriteRuntimeRef.current;
  };

  const invalidatePartyCheckpointClaim = (message) => {
    if (!partyCheckpointClaimOwnerRef.current) return false;
    partyCheckpointClaimOwnerRef.current = null;
    try { partyCheckpointClaimCancelRef.current?.(); } catch { /* Claim authority is already revoked. */ }
    partyCheckpointClaimCancelRef.current = null;
    partyCheckpointBusyRef.current = false;
    setPartyCheckpointBusy(false);
    refreshPlaybackRecoveryLock();
    resumeLibraryReconciliationAfterCheckpointOperation();
    getPartyCheckpointWriteRuntime().openCircuit();
    setPartyCheckpointWriteCircuitOpen(true);
    setPartyCheckpointError(message);
    window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
    return true;
  };

  const queuePartyCheckpointSave = (checkpointReason = null) => {
    if (!checkpointSaveIsStable()) return;
    const sessionId = partyCheckpointSessionIdRef.current;
    const writerToken = partyCheckpointWriterTokenRef.current;
    if (!sessionId || !writerToken) return;
    const sourceRef = masterDeck === "a" ? deckARef : deckBRef;
    const sourceTrackId = sourceRef.current?.getDeckSnapshot?.()?.trackId ?? loadedByDeck[masterDeck];
    if (!sourceTrackId || !libraryRef.current.some((track) => track.id === sourceTrackId)) return;
    const now = getAudioEngine().clock.now();
    const clockSnapshot = partySessionClockSnapshot(partySessionClockRef.current, now);
    if (clockSnapshot.status === "not-started") return;
    const targetDeck = masterDeck === "a" ? "b" : "a";
    const committedTarget = partyCommittedPreloadByDeckRef.current[targetDeck];
    const reason = checkpointReason ?? (clockSnapshot.isRunning
      ? "active-periodic"
      : partyCheckpointPauseReasonRef.current);
    let draft;
    try {
      draft = projectPausedPartySessionCheckpoint({
        sessionId,
        writerToken,
        libraryEpoch: libraryStateRef.current.epoch,
        libraryRevision: libraryStateRef.current.revision,
        checkpointReason: reason,
        plannedDurationSeconds: clockSnapshot.plannedDurationSeconds,
        elapsedActiveSeconds: clockSnapshot.elapsedActiveSeconds,
        energyProfile: partyEnergyProfile,
        energyShift: partyEnergyShift,
        includeRestOfLibrary: autoPilotUseLibrary,
        playedTrackIds: playedTrackIdsRef.current,
        queueTrackIds: queueRef.current,
        committedTargetTrackId: committedTarget?.trackId ?? null,
        lastStableSourceTrackId: sourceTrackId
      });
    } catch {
      setPartyCheckpointError("Party recovery could not capture a safe paused plan. Music can continue, but refresh recovery is unavailable.");
      return;
    }
    const candidateForFingerprint = createPartySessionCheckpoint(draft, 1);
    const fingerprint = partySessionCheckpointFingerprint(candidateForFingerprint);
    const writeRuntime = getPartyCheckpointWriteRuntime();
    const writeSnapshot = writeRuntime.snapshot();
    if (!shouldQueuePartyCheckpointCandidate({
      fingerprint,
      lastSavedFingerprint: partyCheckpointLastFingerprintRef.current,
      runtime: writeSnapshot
    })) return;
    writeRuntime.enqueue({
      fingerprint,
      value: {
        draft,
        fingerprint,
        generation: partyCheckpointWriteGenerationRef.current
      }
    });
  };

  const clearOwnedPartyCheckpoint = async (
    recordStatus = "cleared",
    { terminalOnFailure = false, expectedCheckpoint = null,
      refreshOwnedExpectedCheckpoint = false } = {}
  ) => {
    const membershipMode = libraryMutationModeRef.current;
    const membershipBlocked = Boolean(libraryMembershipOwnerRef.current) ||
      ["importing", "destructive", "membership-circuit"].includes(membershipMode);
    if (membershipBlocked) {
      if (terminalOnFailure) {
        partyCheckpointTerminalRef.current = true;
        if (membershipMode === "membership-circuit" || libraryMembershipCircuitOpen) {
          partyCheckpointTerminalClearPendingRef.current = null;
          getPartyCheckpointWriteRuntime().openCircuit();
          setPartyCheckpointWriteCircuitOpen(true);
          setPartyCheckpointError("The party finished, but saved recovery cleanup could not be confirmed while local music storage needs review. Reload Mazzy before starting another party.");
          window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
        } else {
          const stored = partyCheckpointStoredRecordRef.current;
          partyCheckpointTerminalClearPendingRef.current = Object.freeze({
            recordStatus,
            sessionId: stored?.sessionId ?? partyCheckpointSessionIdRef.current,
            writerToken: stored?.writerToken ?? partyCheckpointWriterTokenRef.current,
            minimumRevision: stored?.revision ?? partyCheckpointRevisionRef.current
          });
        }
      }
      return false;
    }
    const reconcileSnapshot = libraryReconcileRuntimeRef.current?.snapshot?.();
    if (libraryMutationModeRef.current === "reconciling" ||
        libraryMutationModeRef.current === "reconcile-circuit" ||
        reconcileSnapshot?.active) {
      if (terminalOnFailure) {
        partyCheckpointTerminalRef.current = true;
        if (libraryMutationModeRef.current === "reconciling" &&
            reconcileSnapshot?.mode === "running") {
          const stored = partyCheckpointStoredRecordRef.current;
          partyCheckpointTerminalClearPendingRef.current = Object.freeze({
            recordStatus,
            sessionId: stored?.sessionId ?? partyCheckpointSessionIdRef.current,
            writerToken: stored?.writerToken ?? partyCheckpointWriterTokenRef.current,
            minimumRevision: stored?.revision ?? partyCheckpointRevisionRef.current
          });
        } else {
          partyCheckpointTerminalClearPendingRef.current = null;
          getPartyCheckpointWriteRuntime().openCircuit();
          setPartyCheckpointWriteCircuitOpen(true);
          setPartyCheckpointError("The party finished, but saved recovery cleanup could not be confirmed. Reload Mazzy before starting another party.");
          window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
        }
      }
      return false;
    }
    if (partyCheckpointBusyRef.current || partyCheckpointClearOwnerRef.current) return false;
    const previousTerminal = partyCheckpointTerminalRef.current;
    partyCheckpointTerminalRef.current = true;
    partyCheckpointBusyRef.current = true;
    setPartyCheckpointBusy(true);
    refreshPlaybackRecoveryLock();
    const clearOwner = createPartyCheckpointClearOwner({
      operation: ++partyCheckpointClearOperationRef.current,
      sessionId: partyCheckpointSessionIdRef.current,
      writerToken: partyCheckpointWriterTokenRef.current
    });
    partyCheckpointClearOwnerRef.current = clearOwner;
    const writeRuntime = getPartyCheckpointWriteRuntime();
    try {
      if (!await writeRuntime.prepareExclusive() ||
        !ownsPartyCheckpointClear(partyCheckpointClearOwnerRef.current, clearOwner)) {
        throw new Error("checkpoint clear ownership unavailable");
      }
      partyCheckpointWriteGenerationRef.current += 1;
      const stored = partyCheckpointStoredRecordRef.current;
      let clearExpected = expectedCheckpoint ?? {
        revision: partyCheckpointRevisionRef.current,
        sessionId: stored?.sessionId ?? null,
        writerToken: stored?.writerToken ?? null
      };
      if (refreshOwnedExpectedCheckpoint) {
        clearExpected = refreshOwnedPartySessionCheckpointDiscardTarget({
          capturedTarget: clearExpected,
          storedCheckpoint: stored,
          localSessionId: clearOwner.sessionId,
          localWriterToken: clearOwner.writerToken
        });
        if (!clearExpected) throw new Error("checkpoint discard owner changed");
      }
      const expectedRevision = clearExpected.revision;
      const ownsClear = () => ownsPartyCheckpointClear(partyCheckpointClearOwnerRef.current, clearOwner) &&
        partyCheckpointSessionIdRef.current === clearOwner.sessionId &&
        partyCheckpointWriterTokenRef.current === clearOwner.writerToken &&
        writeRuntime.snapshot().mode === "exclusive";
      const boundedClear = startBoundedPartyCheckpointOperation({
        ownsAuthority: ownsClear,
        task: (signal) => clearPartySessionCheckpoint({
          expectedRevision,
          expectedSessionId: clearExpected.sessionId ?? null,
          expectedWriterToken: clearExpected.writerToken ?? null,
          recordStatus
        }, { signal })
      });
      partyCheckpointClearCancelRef.current = boundedClear.cancel;
      const settlement = await boundedClear.promise;
      if (!ownsClear()) return false;
      if (settlement.outcome !== "completed" || settlement.value.status !== "cleared") {
        writeRuntime.openCircuit();
        setPartyCheckpointWriteCircuitOpen(true);
        setPartyCheckpointError(settlement.outcome === "timed-out"
          ? "The saved party plan could not be cleared because browser storage did not respond. Reload Mazzy before starting another party."
          : settlement.outcome === "completed"
            ? "The saved party plan changed in another tab and was not deleted here. Reload Mazzy to review recovery before continuing."
            : "The saved party plan could not be deleted from browser storage. Reload Mazzy before starting another party.");
        window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
        return false;
      }
      const result = settlement.value;
      partyCheckpointRevisionRef.current = result.revision;
      partyCheckpointStoredRecordRef.current = {
        recordStatus,
        revision: result.revision,
        sessionId: clearExpected.sessionId ?? null,
        writerToken: clearExpected.writerToken ?? null
      };
      partyCheckpointLastFingerprintRef.current = "";
      partyCheckpointSessionIdRef.current = null;
      partyCheckpointWriterLostRef.current = false;
      setPartyCheckpointWriterLost(false);
      partyCheckpointRecoveryRef.current = null;
      setPartyCheckpointRecovery(null);
      setRestoredPartyPlan(null);
      setPartyCheckpointError("");
      setPartyCheckpointWriteCircuitOpen(false);
      if (!writeRuntime.completeExclusive()) {
        writeRuntime.openCircuit();
        setPartyCheckpointWriteCircuitOpen(true);
        setPartyCheckpointError("Party recovery cleanup could not be confirmed. Reload Mazzy before starting another party.");
        return false;
      }
      return true;
    } catch {
      if (ownsPartyCheckpointClear(partyCheckpointClearOwnerRef.current, clearOwner)) {
        writeRuntime.openCircuit();
        setPartyCheckpointWriteCircuitOpen(true);
        setPartyCheckpointError("Party recovery cleanup could not be confirmed. Reload Mazzy before starting another party.");
        window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
      }
      return false;
    } finally {
      if (ownsPartyCheckpointClear(partyCheckpointClearOwnerRef.current, clearOwner)) {
        partyCheckpointClearCancelRef.current = null;
        partyCheckpointClearOwnerRef.current = null;
        partyCheckpointBusyRef.current = false;
        setPartyCheckpointBusy(false);
        refreshPlaybackRecoveryLock();
        if (!terminalOnFailure && writeRuntime.snapshot().mode !== "running") {
          partyCheckpointTerminalRef.current = previousTerminal;
        }
        resumeLibraryReconciliationAfterCheckpointOperation();
      }
    }
  };

  const drainPendingTerminalCheckpointAfterMembership = () => {
    const pending = partyCheckpointTerminalClearPendingRef.current;
    if (!pending || libraryMembershipOwnerRef.current ||
        ["importing", "destructive", "membership-circuit"].includes(libraryMutationModeRef.current)) return false;
    const stored = partyCheckpointStoredRecordRef.current;
    const stillOwned = stored &&
      ["available", "claimed", "invalidated"].includes(stored.recordStatus) &&
      stored.sessionId === pending.sessionId && stored.writerToken === pending.writerToken &&
      stored.revision >= pending.minimumRevision;
    partyCheckpointTerminalClearPendingRef.current = null;
    if (!stillOwned) {
      pauseForCheckpointOwnershipLoss();
      return false;
    }
    void clearOwnedPartyCheckpoint(pending.recordStatus, {
      terminalOnFailure: true,
      expectedCheckpoint: {
        revision: stored.revision,
        sessionId: stored.sessionId,
        writerToken: stored.writerToken
      }
    });
    return true;
  };

  const partyTrackOrdinal = (trackId) => {
    if (!trackId) return null;
    const existing = partyTrackOrdinalsRef.current.get(trackId);
    if (existing) return existing;
    const next = ++partyTrackOrdinalCounterRef.current;
    partyTrackOrdinalsRef.current.set(trackId, next);
    return next;
  };

  const partyLoadIdentity = (deck, trackId, reservedLoadOrdinal = null) => {
    if (!trackId) return null;
    const current = partyLoadByDeckRef.current[deck];
    if (current?.trackId === trackId) return current;
    const identity = {
      trackId,
      trackOrdinal: partyTrackOrdinal(trackId),
      loadOrdinal: reservedLoadOrdinal ?? ++partyLoadOrdinalCounterRef.current
    };
    partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [deck]: identity };
    return identity;
  };

  const partyNativeCompletionOrdinal = (deck, operation, loadRevision) => {
    const key = `${deck}:${operation}:${loadRevision}`;
    const existing = partyNativeCompletionOrdinalsRef.current.get(key);
    if (existing) return existing;
    const next = ++partyNativeCompletionOrdinalCounterRef.current;
    partyNativeCompletionOrdinalsRef.current.set(key, next);
    return next;
  };

  const updatePartyDiagnosticEvaluation = () => {
    const recorder = partyTraceRecorderRef.current;
    if (!recorder) return;
    try { setPartyDiagnosticEvaluation(evaluatePartyAutopilotTrace(recorder.snapshot())); }
    catch { recorder.markInterrupted(); }
  };

  const recordPartyEvent = (event) => {
    const recorder = partyTraceRecorderRef.current;
    if (!recorder) return;
    try {
      recorder.append({ ...event, activeSecond: activePartySecond() });
      updatePartyDiagnosticEvaluation();
    } catch {
      recorder.markInterrupted();
    }
  };

  const startOrResumePartyDiagnostic = (sourceDeck) => {
    if (!partyDiagnosticEnabled) return;
    if (!partyTraceRecorderRef.current) {
      partyTraceRecorderRef.current = createPartyAutopilotTraceRecorder();
      partyNativeCompletionOrdinalsRef.current = new Map();
      partyNativeCompletionOrdinalCounterRef.current = 0;
      partyTraceRunningRef.current = true;
      recordPartyEvent({ type: "session-started" });
      const sourceSnapshot = (sourceDeck === "a" ? deckARef : deckBRef).current?.getDeckSnapshot?.();
      const sourceIdentity = partyLoadIdentity(sourceDeck, sourceSnapshot?.trackId ?? null);
      if (sourceIdentity) {
        partyPlayedLoadsRef.current.add(`${sourceIdentity.trackOrdinal}:${sourceIdentity.loadOrdinal}`);
        recordPartyEvent({
          type: "track-played",
          trackOrdinal: sourceIdentity.trackOrdinal,
          loadOrdinal: sourceIdentity.loadOrdinal,
          cause: "host"
        });
      } else {
        partyTraceRecorderRef.current.markInterrupted();
        updatePartyDiagnosticEvaluation();
      }
      recordPartyEvent({
        type: "queue-committed",
        revision: ++partyQueueRevisionRef.current,
        trackOrdinals: queueRef.current.map(partyTrackOrdinal).filter(Boolean)
      });
      return;
    }
    if (!partyTraceRunningRef.current) {
      partyTraceRunningRef.current = true;
      recordPartyEvent({ type: "session-resumed" });
    }
    const sourceSnapshot = (sourceDeck === "a" ? deckARef : deckBRef).current?.getDeckSnapshot?.();
    const sourceIdentity = partyLoadIdentity(sourceDeck, sourceSnapshot?.trackId ?? null);
    const sourceLoadKey = sourceIdentity ? `${sourceIdentity.trackOrdinal}:${sourceIdentity.loadOrdinal}` : null;
    if (sourceIdentity && sourceLoadKey && !partyPlayedLoadsRef.current.has(sourceLoadKey)) {
      partyPlayedLoadsRef.current.add(sourceLoadKey);
      recordPartyEvent({
        type: "track-played",
        trackOrdinal: sourceIdentity.trackOrdinal,
        loadOrdinal: sourceIdentity.loadOrdinal,
        cause: "host"
      });
    }
    recordPartyEvent({
      type: "queue-committed",
      revision: ++partyQueueRevisionRef.current,
      trackOrdinals: queueRef.current.map(partyTrackOrdinal).filter(Boolean)
    });
  };

  const pausePartyDiagnostic = (reason) => {
    settleAutoPilotPreloadForPause("superseded");
    if (!partyTraceRecorderRef.current || !partyTraceRunningRef.current) return;
    partyTraceRunningRef.current = false;
    recordPartyEvent({ type: "session-paused", reason });
  };

  const lockUnverifiedPreloadCleanup = () => {
    transitionCompletionUncertainRef.current = true;
    setTransitionCompletionUncertain(true);
    refreshPlaybackRecoveryLock();
    if (partyTraceRecorderRef.current) {
      partyTraceRunningRef.current = false;
      partyTraceRecorderRef.current.markInterrupted();
      updatePartyDiagnosticEvaluation();
    }
    showAutoPilotArmIntervention("preload-cleanup-uncertain");
  };

  const settleAutoPilotPreloadForPause = (outcome = "superseded") => {
    const lease = autoPilotPreloadLeaseRef.current;
    if (!lease || !ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, lease)) {
      return { claimed: false, cleanupConfirmed: true };
    }
    const pending = partyPendingLoadByDeckRef.current[lease.deck];

    // Claim/null exact ownership before any deck adapter or React update. A
    // settling load can no longer commit, clear a successor, or escape trace
    // settlement between a host pause and the cleanup effect.
    autoPilotPreloadLeaseRef.current = null;
    autoPilotPreloadGenerationRef.current += 1;
    if (outcome !== "timed-out") consecutiveAutoPilotPreloadTimeoutsRef.current = 0;
    if (pending?.loadOrdinal === lease.loadOrdinal) {
      partyPendingLoadByDeckRef.current = { ...partyPendingLoadByDeckRef.current, [lease.deck]: null };
    }
    const leaseRef = lease.deck === "a" ? deckARef : deckBRef;
    const handle = leaseRef.current;
    let cleanupConfirmed = false;
    if (handle?.getDeckSnapshot && handle?.isPlaying && handle?.cancelLoadIfOwned &&
      handle?.stopAllSound && handle?.eject) {
      const cleanup = runAutoPilotPreloadPauseCleanup({
        lease,
        pendingLoadOrdinal: pending?.loadOrdinal ?? null,
        observe: () => ({
          targetTrackId: handle.getDeckSnapshot()?.trackId ?? null,
          targetLoadOrdinal: partyLoadByDeckRef.current[lease.deck]?.loadOrdinal ?? null,
          targetPlaying: Boolean(handle.isPlaying())
        }),
        cancelLoadIfOwned: () => handle.cancelLoadIfOwned(autoPilotPreloadLoadAuthorityKey(lease)),
        stopAllSound: () => handle.stopAllSound(),
        eject: () => handle.eject()
      });
      cleanupConfirmed = cleanup.cleanupConfirmed;
      if (cleanupConfirmed && !cleanup.preservedReplacement) {
        partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [lease.deck]: null };
        setLoadedByDeck((current) => ({ ...current, [lease.deck]: null }));
      }
    }
    if (partyTraceRunningRef.current) {
      recordPartyEvent({ type: "preload-settled", operation: lease.operation, outcome });
    }
    if (!cleanupConfirmed) lockUnverifiedPreloadCleanup();
    return { claimed: true, cleanupConfirmed };
  };

  const stopRehearsal = (message = "Preview stopped. Nothing was saved.") => {
    rehearsalGenerationRef.current += 1;
    const cancel = rehearsalCancelRef.current;
    rehearsalCancelRef.current = null;
    try { cancel?.(); } catch { /* Rehearsal authority is already revoked. */ }
    refreshPlaybackRecoveryLock();
    setRehearsalActive(false);
    setRehearsalStatus({ state: "stopped", message });
  };

  const requestRehearsalPreparationCancellation = (
    message = "Cancelling after the current local audio step…"
  ) => {
    const runtime = rehearsalRenderRuntimeRef.current;
    if (!runtime) {
      if (!rehearsalPreparationOwnedRef.current) return false;
      rehearsalPreparationOwnedRef.current = false;
      rehearsalGenerationRef.current += 1;
      refreshPlaybackRecoveryLock();
      setRehearsalStatus({ state: "stopped", message: "Preview preparation cancelled. Nothing was saved." });
      return true;
    }
    runtime.requestCancel();
    setRehearsalActive(false);
    setRehearsalStatus({ state: "cancelling", message });
    return true;
  };

  const stopOrCancelRehearsal = (message) => {
    if (requestRehearsalPreparationCancellation(message)) return;
    if (!rehearsalCancelRef.current) return;
    stopRehearsal(message);
  };

  const cancelRehearsalPreparation = () => {
    requestRehearsalPreparationCancellation();
  };

  const pauseAutoPilotForHostControl = (
    message = "Party Autopilot paused · you took control",
    checkpointReason = "host-control"
  ) => {
    advancePartyAutopilotCoordinatorEpoch();
    if (!autoPilotEnabledRef.current) return;
    autoPilotEnabledRef.current = false;
    settleAutoPilotPreloadForPause("superseded");
    setAutoPilotEnabled(false);
    try { cancelCurrentTransitionArm(); } catch { /* Preload and Autopilot authority are already revoked. */ }
    transitionArmGenerationRef.current += 1;
    pausePartyClockFailClosed();
    finalTrackRef.current = null;
    setPartyEndingFinalTrack(false);
    setAutoPilotChoice(null);
    partyCheckpointPauseReasonRef.current = checkpointReason;
    pausePartyDiagnostic("host-control");
    void partyWakeLockRef.current?.release?.();
    showToast(message);
  };

  const onCrossFade = (event) => {
    if (autoMixing || transitionArmRef.current) return;
    const value = Number(event.target.value);
    setFade(value);
    const gains = equalPowerGains(value);
    deckARef.current?.setGain?.(gains.source);
    deckBRef.current?.setGain?.(gains.target);
  };

  const getDirectionLabel = () => (masterDeck === "a" ? "← A to B" : "B to A →");

  const onBpmChange = (channel, bpm) => {
    setBpmByDeck((prev) => ({
      ...prev,
      [channel]: bpm
    }));
  };

  const analysisJobKindForTrack = (track) => {
    if (!hasCurrentBasicAnalysis(track) ||
      (!normalizeProgramLevel(track.programLevel) && track.programLevelStatus !== "failed")) return "basic-program";
    if (enhancedTimingAvailable === true && !hasCurrentEnhancedRhythm(track)) return "enhanced";
    return null;
  };

  const refreshBackgroundAnalysisNotice = ({ enhancedEnabled = enhancedTimingAvailable === true } = {}) => {
    setBackgroundAnalysisNotice(deriveBackgroundAnalysisNotice({
      deferrals: [...backgroundAnalysisDeferredRef.current.values()].map(({ kind, stage }) => ({ kind, stage })),
      decodeCircuitOpen: backgroundAnalysisCircuitRef.current.decode,
      enhancedRenderCircuitOpen: backgroundAnalysisCircuitRef.current.enhancedRender,
      retryUsed: backgroundAnalysisRetryUsedRef.current,
      enhancedEnabled
    }));
  };

  const restoreBackgroundAnalysisDeferrals = (snapshot) => {
    for (const [key, deferred] of snapshot) {
      const current = libraryRef.current.find((track) => track.id === deferred.trackId);
      if (current && ownsQueuedAnalysisLibraryRow({
        expectedTrackId: deferred.trackId,
        expectedContentIdentity: deferred.contentIdentity,
        currentTrackId: current.id,
        currentContentIdentity: current.contentIdentity,
        expectedFile: deferred.file,
        currentFile: current.file,
        removed: removedTrackIdsRef.current.has(deferred.trackId)
      })) backgroundAnalysisDeferredRef.current.set(key, deferred);
    }
    refreshBackgroundAnalysisNotice();
  };

  const cancelActiveBackgroundAnalysis = ({ resetEnhanced = false, announceUnabortable = true } = {}) => {
    const activeStage = activeBackgroundStageRef.current?.stage ?? null;
    activeBackgroundAnalysisRef.current = null;
    activeBackgroundStageRef.current = null;
    if (activeStage === "decode") backgroundAnalysisCircuitRef.current.decode = true;
    if (activeStage === "enhanced-render") backgroundAnalysisCircuitRef.current.enhancedRender = true;
    if (announceUnabortable && (activeStage === "decode" || activeStage === "enhanced-render")) {
      setBackgroundAnalysisNotice({
        type: "circuit-open",
        retryable: false,
        message: "Local analysis paused for this tab because a browser audio step could not be cancelled. Mazzy can still try to open songs with conservative fallbacks; reload before retrying local analysis."
      });
    }
    try { activeBackgroundStageCancelRef.current?.(); } catch { /* Ownership is already revoked. */ }
    activeBackgroundStageCancelRef.current = null;
    try { backgroundAnalysisClientRef.current?.dispose?.(); } catch { /* The client is no longer authoritative. */ }
    backgroundAnalysisClientRef.current = null;
    if (resetEnhanced) {
      try { backgroundEnhancedAnalysisRef.current?.dispose?.(); } catch { /* The queue epoch is already obsolete. */ }
      backgroundEnhancedAnalysisRef.current = null;
    }
  };

  const cancelBackgroundAnalysisForTrack = (trackId) => {
    const active = activeBackgroundAnalysisRef.current;
    if (active?.trackId === trackId) {
      cancelActiveBackgroundAnalysis({ resetEnhanced: active.kind === "enhanced" });
    }
    queuedAnalysisIdsRef.current.delete(backgroundAnalysisJobKey(trackId, "basic-program"));
    queuedAnalysisIdsRef.current.delete(backgroundAnalysisJobKey(trackId, "enhanced"));
    pendingAnalysisQueueRef.current = pendingAnalysisQueueRef.current.filter((job) => job.id !== trackId);
    backgroundAnalysisDeferredRef.current.delete(backgroundAnalysisJobKey(trackId, "basic-program"));
    backgroundAnalysisDeferredRef.current.delete(backgroundAnalysisJobKey(trackId, "enhanced"));
    refreshBackgroundAnalysisNotice();
    setAnalyzingIds((current) => ({ ...current, [trackId]: false }));
  };

  const runBackgroundStage = async ({ lease, stage, task, onTimeout, onCancel = onTimeout }) => {
    const ownsAuthority = () => ownsBackgroundAnalysisLease(activeBackgroundAnalysisRef.current, lease) &&
      lease.epoch === analysisGenerationRef.current;
    const stageLease = createBackgroundAnalysisStageLease({
      job: lease,
      stage,
      startedAtMilliseconds: performance.now()
    });
    if (!stageLease) return { outcome: "cancelled" };
    const run = startBoundedBackgroundStage({
      task,
      timeoutMs: BACKGROUND_ANALYSIS_STAGE_TIMEOUT_MS[stage],
      deadlineMilliseconds: stageLease.deadlineMilliseconds,
      ownsAuthority,
      onTimeout,
      onCancel
    });
    activeBackgroundStageRef.current = stageLease;
    activeBackgroundStageCancelRef.current = run.cancel;
    const settlement = await run.settlement;
    if (ownsBackgroundAnalysisLease(activeBackgroundAnalysisRef.current, lease) &&
      ownsBackgroundAnalysisStageLease(activeBackgroundStageRef.current, stageLease)) {
      activeBackgroundStageRef.current = null;
      activeBackgroundStageCancelRef.current = null;
    }
    return settlement;
  };

  const deferBackgroundAnalysis = (track, kind, stage, unabortable) => {
    backgroundAnalysisDeferredRef.current.set(backgroundAnalysisJobKey(track.id, kind), {
      trackId: track.id,
      kind,
      file: track.file,
      contentIdentity: track.contentIdentity,
      stage
    });
    if (stage === "decode") backgroundAnalysisCircuitRef.current.decode = true;
    if (stage === "enhanced-render" || (stage === "enhanced-inference" && unabortable)) {
      backgroundAnalysisCircuitRef.current.enhancedRender = true;
    }
    refreshBackgroundAnalysisNotice();
  };

  const analyzeQueuedTrack = async (job, generation) => {
    const { track, kind } = job;
    const needsBasicAnalysis = !hasCurrentBasicAnalysis(track);
    const needsProgramLevel = !normalizeProgramLevel(track.programLevel);
    const expectedContentIdentity = normalizeContentIdentity(track.contentIdentity);
    const ownsCurrentLibraryRow = (item) =>
      ownsQueuedAnalysisLibraryRow({
        expectedTrackId: track.id,
        expectedContentIdentity,
        currentTrackId: item.id,
        currentContentIdentity: item.contentIdentity,
        expectedFile: track.file,
        currentFile: item.file,
        removed: removedTrackIdsRef.current.has(track.id)
      });
    const lease = createBackgroundAnalysisLease({
      epoch: generation,
      operation: ++backgroundAnalysisOperationRef.current,
      trackId: track.id,
      contentIdentity: expectedContentIdentity,
      fileToken: track.file,
      kind
    });
    if (!lease) return;
    activeBackgroundAnalysisRef.current = lease;
    setAnalyzingIds((prev) => ({ ...prev, [track.id]: true }));
    let terminal = "cancelled";
    try {
      if (backgroundAnalysisCircuitRef.current.decode ||
        (kind === "enhanced" && backgroundAnalysisCircuitRef.current.enhancedRender)) {
        deferBackgroundAnalysis(track, kind,
          backgroundAnalysisCircuitRef.current.decode ? "decode" : "enhanced-render", true);
        terminal = "timed-out";
        return;
      }

      const readController = new AbortController();
      const read = await runBackgroundStage({
        lease,
        stage: "read",
        task: () => readBlobForBackgroundAnalysis(track.file, readController.signal),
        onTimeout: () => readController.abort(),
        onCancel: () => readController.abort()
      });
      if (read.outcome !== "completed") {
        terminal = read.outcome;
        if (read.outcome === "timed-out") deferBackgroundAnalysis(track, kind, "read", false);
        if (read.outcome === "failed" && kind === "basic-program") {
          publishLibrary((prev) => prev.map((item) => ownsCurrentLibraryRow(item)
            ? applyQueuedAnalysisFailure(item, needsBasicAnalysis, needsProgramLevel)
            : item), { routineDirty: true });
        } else if (read.outcome === "failed" && kind === "enhanced") {
          setEnhancedFailureByTrack((current) => ({ ...current, [track.id]: true }));
        }
        return;
      }

      let decodeRuntimeUnavailable = false;
      const decode = await runBackgroundStage({
        lease,
        stage: "decode",
        task: () => {
          let analysisCtx;
          try {
            analysisCtx = new OfflineAudioContext(1, 1, 44100);
          } catch (error) {
            decodeRuntimeUnavailable = true;
            throw error;
          }
          return analysisCtx.decodeAudioData(read.value.slice(0));
        },
        onTimeout: () => { backgroundAnalysisCircuitRef.current.decode = true; },
        onCancel: () => undefined
      });
      if (decode.outcome !== "completed") {
        terminal = decode.outcome;
        const policy = decideBackgroundDecodeFailure({
          outcome: decode.outcome,
          runtimeUnavailable: decodeRuntimeUnavailable
        });
        if (policy.deferStage) {
          deferBackgroundAnalysis(track, kind, policy.deferStage, policy.unabortable);
        } else if (decode.outcome === "failed" && kind === "basic-program") {
          publishLibrary((prev) => prev.map((item) => ownsCurrentLibraryRow(item)
            ? applyQueuedAnalysisFailure(item, needsBasicAnalysis, needsProgramLevel)
            : item), { routineDirty: true });
        } else if (decode.outcome === "failed" && kind === "enhanced") {
          setEnhancedFailureByTrack((current) => ({ ...current, [track.id]: true }));
        }
        return;
      }
      const decoded = decode.value;

      if (kind === "basic-program") {
        let clientRuntimeUnavailable = false;
        const basic = await runBackgroundStage({
          lease,
          stage: "basic-program",
          task: () => {
            try {
              if (!backgroundAnalysisClientRef.current) backgroundAnalysisClientRef.current = new AnalysisClient();
            } catch (error) {
              clientRuntimeUnavailable = true;
              throw error;
            }
            return backgroundAnalysisClientRef.current.analyzeAudioBuffer(decoded);
          },
          onTimeout: () => {
            try { backgroundAnalysisClientRef.current?.dispose?.(); } catch { /* Reset below remains authoritative. */ }
            backgroundAnalysisClientRef.current = null;
          },
          onCancel: () => {
            try { backgroundAnalysisClientRef.current?.dispose?.(); } catch { /* Reset below remains authoritative. */ }
            backgroundAnalysisClientRef.current = null;
          }
        });
        if (basic.outcome !== "completed") {
          terminal = basic.outcome;
          if (basic.outcome === "timed-out" || (basic.outcome === "failed" && clientRuntimeUnavailable)) {
            deferBackgroundAnalysis(track, kind, "basic-program", false);
          } else if (basic.outcome === "failed") {
            publishLibrary((prev) => prev.map((item) => ownsCurrentLibraryRow(item)
              ? applyQueuedAnalysisFailure(item, needsBasicAnalysis, needsProgramLevel)
              : item), { routineDirty: true });
          }
          return;
        }
        if (!ownsBackgroundAnalysisLease(activeBackgroundAnalysisRef.current, lease)) return;
        publishLibrary((prev) => prev.map((item) => {
          if (!ownsCurrentLibraryRow(item)) return item;
          if (needsBasicAnalysis) return { ...mergeGeneratedAnalysis(item, basic.value), programLevelStatus: "ready" };
          if (needsProgramLevel) return { ...item, programLevel: basic.value.programLevel, programLevelStatus: "ready" };
          return item;
        }), { routineDirty: true });
        terminal = "completed";
        return;
      }

      const rendered = await runBackgroundStage({
        lease,
        stage: "enhanced-render",
        task: () => canonicalizeForEnhancedRhythm(decoded),
        onTimeout: () => {
          backgroundAnalysisCircuitRef.current.enhancedRender = true;
          backgroundEnhancedAnalysisRef.current?.dispose?.();
          backgroundEnhancedAnalysisRef.current = null;
        },
        onCancel: () => {
          backgroundEnhancedAnalysisRef.current?.dispose?.();
          backgroundEnhancedAnalysisRef.current = null;
        }
      });
      if (rendered.outcome !== "completed") {
        terminal = rendered.outcome;
        if (rendered.outcome === "timed-out") deferBackgroundAnalysis(track, kind, "enhanced-render", true);
        if (rendered.outcome === "failed" && ownsCurrentLibraryRow(
          libraryRef.current.find((item) => item.id === track.id) ?? {}
        )) setEnhancedFailureByTrack((current) => ({ ...current, [track.id]: true }));
        return;
      }
      let enhancedSession = backgroundEnhancedAnalysisRef.current;
      const enhanced = await runBackgroundStage({
        lease,
        stage: "enhanced-inference",
        task: () => {
          if (!enhancedSession) enhancedSession = createEnhancedRhythmAnalysisSession();
          backgroundEnhancedAnalysisRef.current = enhancedSession;
          return enhancedSession.analyzePcm(
            rendered.value,
            decoded.sampleRate,
            decoded.duration,
            undefined,
            `${generation}:${track.id}`
          );
        },
        onTimeout: () => {
          backgroundEnhancedAnalysisRef.current?.dispose?.();
          backgroundEnhancedAnalysisRef.current = null;
        },
        onCancel: () => {
          backgroundEnhancedAnalysisRef.current?.dispose?.();
          backgroundEnhancedAnalysisRef.current = null;
        }
      });
      try { enhancedSession?.dispose?.(); } catch { /* This exact job no longer owns inference. */ }
      if (backgroundEnhancedAnalysisRef.current === enhancedSession) backgroundEnhancedAnalysisRef.current = null;
      if (enhanced.outcome !== "completed") {
        terminal = enhanced.outcome;
        if (enhanced.outcome === "timed-out") deferBackgroundAnalysis(track, kind, "enhanced-inference", true);
        if (enhanced.outcome === "failed" && ownsCurrentLibraryRow(
          libraryRef.current.find((item) => item.id === track.id) ?? {}
        )) setEnhancedFailureByTrack((current) => ({ ...current, [track.id]: true }));
        return;
      }
      if (!ownsBackgroundAnalysisLease(activeBackgroundAnalysisRef.current, lease)) return;
      setEnhancedFailureByTrack((current) => ({ ...current, [track.id]: false }));
      publishLibrary((prev) => prev.map((item) => ownsCurrentLibraryRow(item)
        ? mergeEnhancedRhythm(item, enhanced.value)
        : item), { routineDirty: true });
      terminal = "completed";
    } finally {
      const stillOwns = ownsBackgroundAnalysisLease(activeBackgroundAnalysisRef.current, lease);
      if (stillOwns) activeBackgroundAnalysisRef.current = null;
      const key = backgroundAnalysisJobKey(track.id, kind);
      queuedAnalysisIdsRef.current.delete(key);
      if (terminal === "completed") backgroundAnalysisDeferredRef.current.delete(key);
      if (generation === analysisGenerationRef.current) {
        setAnalyzingIds((prev) => ({ ...prev, [track.id]: false }));
        const replacement = libraryRef.current.find((item) => item.id === track.id);
        const replacementNeedsAnalysis = Boolean(replacement && analysisJobKindForTrack(replacement));
        if (terminal !== "timed-out" && shouldRequeueReplacementAnalysis({
          removed: removedTrackIdsRef.current.has(track.id),
          currentRowPresent: Boolean(replacement),
          previousJobStillOwnsRow: Boolean(replacement && ownsCurrentLibraryRow(replacement)),
          needsAnalysis: replacementNeedsAnalysis
        })) {
          queueMicrotask(() => {
            if (generation !== analysisGenerationRef.current || removedTrackIdsRef.current.has(track.id)) return;
            const currentReplacement = libraryRef.current.find((item) => item.id === track.id);
            if (!currentReplacement || currentReplacement.file !== replacement.file ||
              normalizeContentIdentity(currentReplacement.contentIdentity) !== normalizeContentIdentity(replacement.contentIdentity)) return;
            queueBackgroundAnalysis(currentReplacement);
          });
        }
      }
    }
  };

  const processAnalysisQueue = async () => {
    if (analysisQueueBusyRef.current) return;
    analysisQueueBusyRef.current = true;
    const generation = analysisGenerationRef.current;
    try {
      while (pendingAnalysisQueueRef.current.length) {
        pendingAnalysisQueueRef.current = sortBackgroundAnalysisJobs(
          pendingAnalysisQueueRef.current,
          analysisPriorityRef.current.loaded,
          analysisPriorityRef.current.queued
        );
        const nextJob = pendingAnalysisQueueRef.current.shift();
        if (generation !== analysisGenerationRef.current) break;
        if (nextJob) {
          try {
            await analyzeQueuedTrack(nextJob, generation);
          } catch {
            deferBackgroundAnalysis(
              nextJob.track,
              nextJob.kind,
              nextJob.kind === "enhanced" ? "enhanced-inference" : "basic-program",
              false
            );
          }
        }
      }
    } finally {
      analysisQueueBusyRef.current = false;
      if (pendingAnalysisQueueRef.current.length) queueMicrotask(() => void processAnalysisQueue());
    }
  };

  const queueBackgroundAnalysis = (track) => {
    const kind = analysisJobKindForTrack(track);
    if (!kind) return;
    const key = backgroundAnalysisJobKey(track.id, kind);
    const deferred = backgroundAnalysisDeferredRef.current.get(key);
    if (deferred) {
      const sameContent = ownsQueuedAnalysisLibraryRow({
        expectedTrackId: track.id,
        expectedContentIdentity: deferred.contentIdentity,
        currentTrackId: track.id,
        currentContentIdentity: track.contentIdentity,
        expectedFile: deferred.file,
        currentFile: track.file,
        removed: removedTrackIdsRef.current.has(track.id)
      });
      if (sameContent) return;
      backgroundAnalysisDeferredRef.current.delete(key);
    }
    if (queuedAnalysisIdsRef.current.has(key)) return;
    queuedAnalysisIdsRef.current.add(key);
    pendingAnalysisQueueRef.current.push({ id: track.id, track, kind });
    pendingAnalysisQueueRef.current = sortBackgroundAnalysisJobs(
      pendingAnalysisQueueRef.current,
      analysisPriorityRef.current.loaded,
      analysisPriorityRef.current.queued
    );
    void processAnalysisQueue();
  };

  const retryDeferredBackgroundAnalysis = () => {
    if (backgroundAnalysisRetryUsedRef.current || autoPilotEnabledRef.current || autoMixing || autoMixArming ||
      rehearsalActive || rehearsalPreparing || partyFirstSongLoadRef.current || libraryMutationBusyRef.current ||
      backgroundAnalysisCircuitRef.current.decode) return;
    backgroundAnalysisRetryUsedRef.current = true;
    for (const [key, entry] of backgroundAnalysisDeferredRef.current) {
      if (isRetryableBackgroundAnalysisDeferral({
        deferral: entry,
        decodeCircuitOpen: backgroundAnalysisCircuitRef.current.decode,
        enhancedRenderCircuitOpen: backgroundAnalysisCircuitRef.current.enhancedRender
      })) backgroundAnalysisDeferredRef.current.delete(key);
    }
    refreshBackgroundAnalysisNotice();
    for (const track of libraryRef.current) queueBackgroundAnalysis(track);
  };

  useEffect(() => {
    const dirtyUnpersisted = hasUnpersistedLibraryRoutineGeneration({
      dirtyGeneration: libraryRoutineDirtyGenerationRef.current,
      savedGeneration: libraryRoutineSavedGenerationRef.current
    });
    if (libraryRoutineSkipSnapshotRef.current === library && !dirtyUnpersisted) {
      libraryRoutineSkipSnapshotRef.current = null;
      setLibrarySaveStatus("saved");
      return;
    }
    if (!shouldQueueLibraryRoutineSnapshot({
      library,
      skipSnapshot: dirtyUnpersisted ? null : libraryRoutineSkipSnapshotRef.current,
      circuitOpen: libraryRoutineWriteCircuitOpen
    })) return;
    const queued = getLibraryRoutineWriteRuntime().enqueue(createLibraryRoutineSnapshotBatch(
      library.filter((track) => !removedTrackIdsRef.current.has(track.id)).map(persistedTrack),
      libraryRoutineDirtyGenerationRef.current
    ));
    if (libraryRoutineEnqueueOwnsPersistence(queued.status)) setLibrarySaveStatus("saving");
  }, [library, libraryRoutineWriteCircuitOpen]);

  useEffect(() => {
    let deferredChanged = false;
    for (const [key, deferred] of backgroundAnalysisDeferredRef.current) {
      const current = library.find((track) => track.id === deferred.trackId);
      const rowStillOwned = Boolean(current && ownsQueuedAnalysisLibraryRow({
        expectedTrackId: deferred.trackId,
        expectedContentIdentity: deferred.contentIdentity,
        currentTrackId: current.id,
        currentContentIdentity: current.contentIdentity,
        expectedFile: deferred.file,
        currentFile: current.file,
        removed: removedTrackIdsRef.current.has(deferred.trackId)
      }));
      const retain = shouldRetainBackgroundAnalysisDeferral({
        kind: deferred.kind,
        rowPresent: rowStillOwned,
        basicProgramComplete: Boolean(current && (current.analysisStatus === "failed" ||
          (hasCurrentBasicAnalysis(current) &&
            (normalizeProgramLevel(current.programLevel) || current.programLevelStatus === "failed")))),
        enhancedComplete: Boolean(current && hasCurrentEnhancedRhythm(current))
      });
      if (!retain) {
        backgroundAnalysisDeferredRef.current.delete(key);
        deferredChanged = true;
      }
    }
    if (deferredChanged) {
      refreshBackgroundAnalysisNotice();
    }
    library
      .filter(
        (track) =>
          (!hasCurrentBasicAnalysis(track) ||
            (!normalizeProgramLevel(track.programLevel) && track.programLevelStatus !== "failed") ||
            (enhancedTimingAvailable === true && !hasCurrentEnhancedRhythm(track))) &&
          track.analysisStatus !== "failed"
      )
      .forEach(queueBackgroundAnalysis);
  }, [library, enhancedTimingAvailable]);

  const handleImportFolder = async (event) => {
    releaseLibraryImportPickerSoon();
    if (libraryMembershipOwnerRef.current || libraryMembershipCircuitOpen ||
        libraryMutationBusyRef.current || partyCheckpointBusyRef.current ||
        playbackRecoveryLockedRef.current) {
      if (importRef.current) importRef.current.value = "";
      showToast("Local music is still updating · try again in a moment");
      return;
    }
    const files = Array.from(event.target.files || []);
    if (importRef.current) importRef.current.value = "";
    const audioFiles = files.filter((file) => {
      const lower = file.name.toLowerCase();
      return audioExt.some((ext) => lower.endsWith(ext));
    });
    if (!audioFiles.length) {
      if (importRef.current) importRef.current.value = "";
      showToast("No supported MP3, WAV, FLAC, AIFF, or M4A files were selected");
      return;
    }

    const mutationOwner = beginLibraryMembershipMutation("import");
    if (!mutationOwner) return;
    requestDeferredLibraryPickerReconciliation();
    const importGeneration = ++libraryImportGenerationRef.current;
    let routineWriteExclusive = false;
    let routineMembershipChanged = false;
    let commitStarted = false;
    setLibraryStorageError("");
    try {
      const importLibraryState = { ...libraryStateRef.current };
      const existingIdentities = new Set();
      const legacyIdentityById = new Map();
      const totalFiles = libraryRef.current.filter((track) => !normalizeContentIdentity(track.contentIdentity) && track.file?.arrayBuffer).length + audioFiles.length;
      let completedFiles = 0;
      setLibraryMembershipStatus({ kind: "import", state: "preparing", completed: 0, total: totalFiles });
      window.requestAnimationFrame(() => libraryMembershipCancelButtonRef.current?.focus?.());
      const identifyForImport = async (file) => {
        const read = await runLibraryMembershipStage(mutationOwner, "reading", (signal) =>
          readLocalFileBytes(file, { signal }));
        if (read.outcome !== "completed") throw Object.assign(new Error("Import preparation did not finish"), { membershipOutcome: read.outcome });
        const digest = await runLibraryMembershipStage(mutationOwner, "digesting", (signal) =>
          identifyLocalFile(file, { signal, bytes: read.value }));
        if (digest.outcome !== "completed") throw Object.assign(new Error("Import preparation did not finish"), { membershipOutcome: digest.outcome });
        completedFiles += 1;
        if (ownsLibraryMembership(mutationOwner)) {
          setLibraryMembershipStatus({ kind: "import", state: "preparing", completed: completedFiles, total: totalFiles });
        }
        return digest.value;
      };
      for (const track of libraryRef.current) {
        if (!ownsLibraryMembership(mutationOwner) || importGeneration !== libraryImportGenerationRef.current) return;
        let identity = normalizeContentIdentity(track.contentIdentity);
        if (!identity && track.file?.arrayBuffer) {
          identity = await identifyForImport(track.file);
          if (!existingIdentities.has(identity)) legacyIdentityById.set(track.id, identity);
        }
        if (identity) existingIdentities.add(identity);
      }

      const uniqueFiles = [];
      let duplicatesSkipped = 0;
      for (const file of audioFiles) {
        if (!ownsLibraryMembership(mutationOwner) || importGeneration !== libraryImportGenerationRef.current) return;
        const contentIdentity = await identifyForImport(file);
        if (existingIdentities.has(contentIdentity)) {
          duplicatesSkipped += 1;
          continue;
        }
        existingIdentities.add(contentIdentity);
        uniqueFiles.push({ file, contentIdentity });
      }
      if (!uniqueFiles.length && !legacyIdentityById.size) {
        setLibrarySaveStatus("saved");
        showToast(`${duplicatesSkipped} duplicate ${duplicatesSkipped === 1 ? "track was" : "tracks were"} already in this library`);
        finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
        return;
      }

      let storageEstimate = null;
      const estimate = await runLibraryMembershipStage(mutationOwner, "estimating", async () =>
        await navigator.storage?.estimate?.() ?? null);
      if (estimate.outcome === "completed") storageEstimate = estimate.value;
      if (!ownsLibraryMembership(mutationOwner) || importGeneration !== libraryImportGenerationRef.current) return;
      const capacity = assessImportCapacity(uniqueFiles.map(({ file }) => file.size), storageEstimate);
      setImportStorageStatus(capacity);
      if (capacity.status === "too-large") {
        showToast("Not enough browser storage · choose a smaller folder or remove saved music");
        setLibrarySaveStatus("idle");
        finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
        return;
      }

      const tracks = uniqueFiles.map(({ file, contentIdentity }) => ({
        id: crypto.randomUUID(),
        name: stripExt(file.name),
        file,
        duration: null,
        bpm: null,
        key: null,
        scale: null,
        schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
        analyzerVersion: null,
        bpmCandidates: [],
        beatsSeconds: [],
        downbeatsSeconds: [],
        meter: null,
        tempoConfidence: 0,
        beatConfidence: 0,
        downbeatConfidence: 0,
        keyConfidence: 0,
        energyByBeat: [],
        bandEnergyByBeat: [],
        vocalProbabilityByBeat: [],
        structureBoundaries: [],
        phraseCandidates: [],
        automaticRhythmTrust: null,
        programLevel: null,
        programLevelStatus: "pending",
        rhythmDetector: null,
        rhythmAnalysisVersion: null,
        rhythmModelSha256: null,
        rhythmBackend: null,
        sampleRate: null,
        analysisOverrides: emptyBeatGridOverrides(),
        timingReview: null,
        analysisStatus: "pending",
        contentIdentity,
        loaded: false
      }));

      await waitForLibraryReconciliationSettlement();
      if (!ownsLibraryMembership(mutationOwner) ||
          importGeneration !== libraryImportGenerationRef.current) return;
      if (!ownsLibraryMembership(mutationOwner) ||
          importLibraryState.epoch !== libraryStateRef.current.epoch ||
          importLibraryState.revision !== libraryStateRef.current.revision) {
        throw Object.assign(new Error("The local library changed during import preparation"), { staleLibrary: true });
      }
      const reconcileSnapshot = libraryReconcileRuntimeRef.current?.snapshot?.() ?? {
        mode: "running",
        active: false,
        pending: false
      };
      if (!mayClaimPreparedImportCommit({
        phase: libraryMembershipPhaseRef.current,
        globalMutationMode: libraryMutationModeRef.current,
        reconciliationMode: reconcileSnapshot.mode,
        reconciliationActive: reconcileSnapshot.active,
        reconciliationPending: reconcileSnapshot.pending,
        checkpointBusy: partyCheckpointBusyRef.current,
        checkpointClaimOwned: Boolean(partyCheckpointClaimOwnerRef.current),
        checkpointClearOwned: Boolean(partyCheckpointClearOwnerRef.current)
      })) {
        finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
        if (reconcileSnapshot.mode === "circuit-open" || libraryMutationModeRef.current === "reconcile-circuit") return;
        showToast("Mazzy is checking local changes · choose the folder again when that finishes");
        return;
      }
      setLibraryMutationLock(true, "importing");
      libraryMembershipPhaseRef.current = "waiting-exclusive";
      setLibraryMembershipStatus({ kind: "import", state: "committing", completed: completedFiles, total: totalFiles });
      window.requestAnimationFrame(() => {
        if (ownsLibraryMembership(mutationOwner) &&
            libraryMembershipPhaseRef.current !== "preparing") {
          libraryMembershipStatusRef.current?.focus?.();
        }
      });
      setLibrarySaveStatus("saving");
      routineWriteExclusive = await prepareLibraryRoutineWriteExclusive();
      if (!routineWriteExclusive) {
        throw new Error("Routine local storage did not become available");
      }
      if (!mayContinueLibraryMembershipAfterExclusive({
        ownerCurrent: ownsLibraryMembership(mutationOwner),
        expectedLibraryEpoch: mutationOwner.expectedLibraryEpoch,
        expectedLibraryRevision: mutationOwner.expectedLibraryRevision,
        currentLibraryEpoch: libraryStateRef.current.epoch,
        currentLibraryRevision: libraryStateRef.current.revision
      })) {
        if (!ownsLibraryMembership(mutationOwner)) return;
        throw Object.assign(new Error("The local library changed before import commit"), { staleLibrary: true });
      }
      commitStarted = true;
      libraryMembershipPhaseRef.current = "committing";
      const commitSettlement = await runLibraryMembershipStage(mutationOwner, "committing", (signal) =>
        saveImportedTracksToDb(
          tracks.map(persistedTrack),
          [...legacyIdentityById].map(([id, contentIdentity]) => ({ id, contentIdentity })),
          importLibraryState,
          { signal }
        ));
      if (commitSettlement.outcome !== "completed") {
        throw Object.assign(new Error("Import commit did not finish"), {
          membershipOutcome: commitSettlement.outcome,
          membershipError: commitSettlement.outcome === "failed" ? commitSettlement.error : null
        });
      }
      const importCommit = commitSettlement.value;
      if (importCommit.status !== "saved") {
        throw Object.assign(new Error("The local library changed in another tab"), {
          staleLibrary: true,
          staleResult: importCommit
        });
      }
      routineMembershipChanged = importCommit.libraryState.revision !== importLibraryState.revision ||
        importCommit.libraryState.epoch !== importLibraryState.epoch;
      libraryStateRef.current = importCommit.libraryState;
      if (!ownsLibraryMembership(mutationOwner) || importGeneration !== libraryImportGenerationRef.current) return;
      const committedTrackIds = new Set(importCommit.savedTrackIds);
      const committedTracks = tracks.filter((track) => committedTrackIds.has(track.id));
      duplicatesSkipped += tracks.length - committedTracks.length;
      for (const track of committedTracks) removedTrackIdsRef.current.delete(track.id);
      publishLibrary((current) => {
        const next = [
          ...current.map((track) => legacyIdentityById.has(track.id)
            ? { ...track, contentIdentity: legacyIdentityById.get(track.id) }
            : track),
          ...committedTracks
        ];
        libraryRef.current = next;
        libraryRoutineSkipSnapshotRef.current = next;
        return next;
      });
      setLibrarySaveStatus("saved");
      showToast(capacity.status === "fits"
        ? `Saved ${committedTracks.length} ${committedTracks.length === 1 ? "track" : "tracks"}${duplicatesSkipped ? ` · skipped ${duplicatesSkipped} duplicate${duplicatesSkipped === 1 ? "" : "s"}` : ""} · ${formatStorageSize(capacity.importBytes)} selected`
        : `Saved ${committedTracks.length} ${committedTracks.length === 1 ? "track" : "tracks"}${duplicatesSkipped ? ` · skipped ${duplicatesSkipped} duplicate${duplicatesSkipped === 1 ? "" : "s"}` : ""} · storage estimate unavailable`);
      finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
    } catch (error) {
      if (!ownsLibraryMembership(mutationOwner)) return;
      if (commitStarted && !error?.staleLibrary &&
          !membershipFailureHasDefiniteRollback(error?.membershipError)) {
        failLibraryMembershipCommitClosed(mutationOwner);
        return;
      }
      setLibrarySaveStatus("idle");
      setImportStorageStatus((current) => current ? { ...current, status: "unknown" } : current);
      const message = error?.staleLibrary
        ? "Local music changed in another Mazzy tab. Nothing was changed here; choose the folder again after Mazzy finishes checking storage."
        : error?.membershipOutcome === "timed-out"
          ? "Import preparation took too long. Nothing was saved; choose a smaller folder or try again."
          : error?.membershipOutcome === "cancelled"
            ? "Import preparation was cancelled. Nothing was saved."
        : error?.membershipError?.name === "QuotaExceededError" || error?.name === "QuotaExceededError"
        ? "Browser storage filled up. Nothing was added; remove saved music or choose a smaller folder."
        : "Music couldn't be saved. Nothing was added; try again or check this browser's site-storage settings.";
      setLibraryStorageError(message);
      showToast(message);
      finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
      if (error?.staleLibrary) requestLibraryMembershipReconciliation(error.staleResult);
      window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
    } finally {
      if (routineWriteExclusive) completeLibraryRoutineWriteExclusive({ membershipChanged: routineMembershipChanged });
      if (libraryMutationModeRef.current === "importing") {
        setLibraryMutationLock(false);
      }
    }
  };

  const formatDuration = (seconds) => {
    if (seconds == null) {
      return "--:--";
    }
    const safe = Math.max(0, Math.floor(seconds));
    const min = Math.floor(safe / 60);
    const sec = String(safe % 60).padStart(2, "0");
    return `${min}:${sec}`;
  };

  const onTrackLoaded = (deck, trackId, _fileName = null, loadAuthorityKey = null) => {
    const pending = partyPendingLoadByDeckRef.current[deck];
    if (trackId) {
      const identity = {
        trackId,
        trackOrdinal: partyTrackOrdinal(trackId),
        loadOrdinal: pending?.trackId === trackId ? pending.loadOrdinal : ++partyLoadOrdinalCounterRef.current
      };
      partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [deck]: identity };
    } else {
      partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [deck]: null };
    }
    partyPendingLoadByDeckRef.current = { ...partyPendingLoadByDeckRef.current, [deck]: null };
    setLoadedByDeck((prev) => ({ ...prev, [deck]: trackId }));
    setPartyFirstSongLoadStatus((current) => shouldClearPartyFirstSongReadyForLoad({
      readyOwner: current?.state === "ready" ? current.owner : null,
      deck,
      trackId,
      loadAuthorityKey
    }) ? null : current);
  };

  const onDeckTransportStart = (deck, trackId, loadAuthorityKey) => {
    setPartyFirstSongLoadStatus((current) => shouldClearPartyFirstSongReadyForTransportStart({
      readyOwner: current?.state === "ready" ? current.owner : null,
      deck,
      trackId,
      loadAuthorityKey
    }) ? null : current);
  };

  const onDeckLoadInvalidated = (deck, trackId, loadAuthorityKey) => {
    const startOwner = partyFirstSongStartOwnerRef.current;
    if (startOwner?.deck === deck && startOwner.trackId === trackId &&
        startOwner.loadAuthorityKey === loadAuthorityKey) {
      cancelPartyFirstSongStart({ message: "Starting stopped because the ready song changed." });
    }
    setPartyFirstSongLoadStatus((current) => shouldClearPartyFirstSongReadyForLoadInvalidation({
      readyOwner: current?.state === "ready" ? current.owner : null,
      deck,
      trackId,
      loadAuthorityKey
    }) ? null : current);
  };

  const onDeckPlayStart = (deck, playKind = "start") => {
    setPartySoundStopStatus(null);
    audioOutputWatchArmedRef.current = true;
    pauseAutoPilotForHostControl();
    setMasterDeck(deck);
    const deckRef = deck === "a" ? deckARef : deckBRef;
    const trackId = deckRef.current?.getDeckSnapshot?.()?.trackId ?? loadedByDeck[deck];
    if (trackId) {
      let identity = partyLoadIdentity(deck, trackId);
      if (identity && playKind === "restart") {
        identity = {
          trackId,
          trackOrdinal: identity.trackOrdinal,
          loadOrdinal: ++partyLoadOrdinalCounterRef.current
        };
        partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [deck]: identity };
      }
      const playedLoadKey = identity ? `${identity.trackOrdinal}:${identity.loadOrdinal}` : null;
      if (partyTraceRecorderRef.current && identity && playedLoadKey && !partyPlayedLoadsRef.current.has(playedLoadKey)) {
        partyPlayedLoadsRef.current.add(playedLoadKey);
        recordPartyEvent({
          type: "track-played",
          trackOrdinal: identity.trackOrdinal,
          loadOrdinal: identity.loadOrdinal,
          cause: "host"
        });
      }
      const committed = partyCommittedPreloadByDeckRef.current[deck];
      if (identity && committed?.trackId === identity.trackId &&
        committed.trackOrdinal === identity.trackOrdinal && committed.loadOrdinal === identity.loadOrdinal) {
        partyCommittedPreloadByDeckRef.current = {
          ...partyCommittedPreloadByDeckRef.current,
          [deck]: null
        };
      }
      setPlayedTrackIds((current) => current.includes(trackId) ? current : [...current, trackId]);
      setQueue((current) => current.filter((id) => id !== trackId));
    }
  };

  const onDeckPlaybackCompletion = (deck, event) => {
    const trackId = event?.trackId ?? null;
    if (!["a", "b"].includes(deck) || !trackId ||
      !Number.isSafeInteger(event?.operation) || event.operation < 1 ||
      !Number.isSafeInteger(event?.loadRevision) || event.loadRevision < 1 ||
      !["source-onended", "audio-clock", "reconcile"].includes(event?.settledBy) ||
      !["on-time", "recovered", "late", "premature"].includes(event?.outcome)) return;
    if (event?.channel !== deck ||
      (event.outcome === "premature" && event.settledBy !== "source-onended") ||
      (event.outcome === "on-time" && event.settledBy !== "source-onended") ||
      (event.outcome === "late" && event.settledBy !== "source-onended") ||
      (event.outcome === "recovered" && event.settledBy === "source-onended")) return;
    const endedIdentity = partyLoadByDeckRef.current[deck];
    const deckRef = deck === "a" ? deckARef : deckBRef;
    let completionSnapshot = null;
    try { completionSnapshot = deckRef.current?.getDeckSnapshot?.() ?? null; } catch { /* Fail closed below when session authority exists. */ }
    const activeTransition = activeTransitionScheduleRef.current;
    const decision = decidePartyDeckCompletion({
      callbackDeck: deck,
      event,
      snapshot: completionSnapshot,
      partyLoad: endedIdentity,
      masterDeck,
      autoPilotOwned: autoPilotEnabledRef.current,
      traceRunning: partyTraceRunningRef.current,
      finalOwner: finalTrackRef.current,
      activeTransition: activeTransition
        ? { source: activeTransition.source, target: activeTransition.target }
        : null,
      armOwned: transitionArmLeaseRef.current != null,
      preloadOwned: autoPilotPreloadLeaseRef.current != null
    });
    if (decision.kind === "ignore-stale") return;

    if (decision.kind === "settle-transition-source") {
      const completionRuntime = transitionCompletionRuntimeRef.current;
      const exactCompletionOwner = Boolean(activeTransition?.completionLease &&
        ownsAutoPilotTransitionCompletionLease(
          completionRuntime?.lease,
          activeTransition.completionLease
        ));
      if (exactCompletionOwner && typeof completionRuntime?.attempt === "function") {
        try {
          const signal = transitionCompletionSignalForDeckEvent(event);
          completionRuntime.attempt(signal);
          if (__MAZZY_DIAGNOSTICS_INCLUDED__) {
            try {
              window.dispatchEvent(new Event(signal === "primary"
                ? "mazzy:party-app-journey-native-transition-dispatch"
                : "mazzy:party-app-journey-recovered-transition-dispatch"));
            } catch { /* Diagnostics must never gain transition authority. */ }
          }
          return;
        } catch { /* The existing fail-closed transition branch below retains recovery ownership. */ }
      }
    }

    if (decision.kind === "pause-premature") {
      const traceWasRunning = partyTraceRunningRef.current;
      advancePartyAutopilotCoordinatorEpoch();
      autoPilotEnabledRef.current = false;
      const preloadCleanup = settleAutoPilotPreloadForPause("failed");
      let armCleanupConfirmed = preloadCleanup.cleanupConfirmed;
      try {
        const armRuntime = transitionArmLeaseRef.current;
        if (armRuntime && !cancelCurrentTransitionArm()) armCleanupConfirmed = false;
      } catch { armCleanupConfirmed = false; }
      if (transitionCompletionUncertainRef.current) armCleanupConfirmed = false;
      if (activeTransition) {
        const cancelCompletion = transitionCompletionCancelRef.current;
        transitionCompletionCancelRef.current = null;
        try { cancelCompletion?.(); } catch { /* Recovery lock below is authoritative. */ }
      }
      if (finalTrackRef.current) {
        finalTrackRef.current = null;
        if (traceWasRunning) recordPartyEvent({ type: "final-revoked" });
      }
      if (traceWasRunning) {
        recordPartyEvent({
          type: "deck-completion-failed",
          deck,
          trackOrdinal: endedIdentity.trackOrdinal,
          loadOrdinal: endedIdentity.loadOrdinal,
          nativeOwnerOrdinal: partyNativeCompletionOrdinal(deck, event.operation, event.loadRevision),
          settledBy: "source-onended",
          reason: "premature",
          pauseRequired: true
        });
      } else if (partyTraceRecorderRef.current) {
        // A host-paused transition can still own clock-scheduled audio. The
        // runtime must enter Stop/Rescue recovery, but the paused trace cannot
        // truthfully append a running-only completion failure.
        partyTraceRecorderRef.current.markInterrupted();
        updatePartyDiagnosticEvaluation();
      }
      setAutoPilotEnabled(false);
      setPartyEndingFinalTrack(false);
      setAutoPilotChoice(null);
      partyCheckpointPauseReasonRef.current = "safety";
      if (activeTransition || !armCleanupConfirmed) {
        transitionCompletionUncertainRef.current = true;
        setTransitionCompletionUncertain(true);
        refreshPlaybackRecoveryLock();
      }
      pausePartyClockFailClosed();
      pausePartyDiagnostic("deck-completion");
      try { void partyWakeLockRef.current?.release?.(); } catch { /* Authority is already revoked. */ }
      showAutoPilotArmIntervention(!preloadCleanup.cleanupConfirmed
        ? "preload-cleanup-uncertain"
        : activeTransition || !armCleanupConfirmed
          ? "deck-completion-transition"
          : "deck-completion-failure");
      return;
    }

    if (decision.kind === "finish-final") {
      if (partyTraceRunningRef.current) {
        recordPartyEvent({
          type: "deck-ended",
          deck,
          trackOrdinal: endedIdentity.trackOrdinal,
          loadOrdinal: endedIdentity.loadOrdinal,
          nativeOwnerOrdinal: partyNativeCompletionOrdinal(deck, event.operation, event.loadRevision),
          settledBy: event.settledBy,
          outcome: event.outcome
        });
      }
      advancePartyAutopilotCoordinatorEpoch();
      autoPilotEnabledRef.current = false;
      finalTrackRef.current = null;
      pausePartyClockFailClosed();
      setAutoPilotEnabled(false);
      setPartyEndingFinalTrack(false);
      setAutoPilotChoice(null);
      recordPartyEvent({ type: "session-ended", reason: "final-track-ended" });
      partyTraceRunningRef.current = false;
      try { void partyWakeLockRef.current?.release?.(); } catch { /* Terminal authority is already revoked. */ }
      void clearOwnedPartyCheckpoint("cleared", { terminalOnFailure: true }).then((cleared) => {
        showToast(cleared
          ? "Party finished · no unplayed tracks remain"
          : partyCheckpointTerminalClearPendingRef.current
            ? "Party finished · finishing saved recovery cleanup"
            : "Party finished · saved recovery still needs attention");
      });
      return;
    }

    let endedEventRecorded = false;
    let fallbackCleanupConfirmed = true;
    if (decision.kind === "pause-unexpected-source") {
      const targetDeck = deck === "a" ? "b" : "a";
      const targetRef = targetDeck === "a" ? deckARef : deckBRef;
      const committedTarget = partyCommittedPreloadByDeckRef.current[targetDeck];
      const targetPartyLoad = partyLoadByDeckRef.current[targetDeck];
      let targetSnapshot = null;
      let targetPlaying = false;
      let targetGainBeforeAttempt = null;
      try {
        targetSnapshot = targetRef.current?.getDeckSnapshot?.() ?? null;
        targetPlaying = Boolean(targetRef.current?.isPlaying?.());
        targetGainBeforeAttempt = getAudioEngine().getDeckGain(targetDeck);
      } catch { /* Eligibility fails closed below. */ }
      const engine = getAudioEngine();
      const continuationDecision = decidePartyCommittedTargetContinuation({
        sourceDeck: deck,
        targetDeck,
        autoPilotOwned: autoPilotEnabledRef.current,
        contextState: engine.context.state,
        playbackLocked: playbackRecoveryLockedRef.current || partySoundStopInProgressRef.current ||
          partyCheckpointBusyRef.current || partyCheckpointWriterLostRef.current ||
          !Number.isFinite(targetGainBeforeAttempt),
        conflictingOwner: Boolean(autoPilotPreloadLeaseRef.current || transitionArmLeaseRef.current ||
          activeTransition || rehearsalCancelRef.current || rehearsalActive || rehearsalPreparing ||
          libraryMutationBusyRef.current),
        targetSnapshot: targetSnapshot ? {
          channel: targetDeck,
          trackId: targetSnapshot.trackId ?? null,
          status: targetSnapshot.status,
          ready: Boolean(targetRef.current?.isReady?.()),
          playing: targetPlaying,
          playbackRate: targetSnapshot.playbackRate
        } : null,
        targetPartyLoad,
        committedTarget
      });
      if (continuationDecision.kind === "start-committed-target") {
        const operation = ++partyFallbackContinuationOperationRef.current;
        const lease = Object.freeze({
          operation,
          sourceDeck: deck,
          targetDeck,
          sourceTrackId: endedIdentity.trackId,
          sourceLoadOrdinal: endedIdentity.loadOrdinal,
          targetTrackId: committedTarget.trackId,
          targetLoadOrdinal: committedTarget.loadOrdinal
        });
        const ownsLease = () => {
          const current = partyFallbackContinuationRef.current;
          const currentTarget = partyLoadByDeckRef.current[targetDeck];
          const currentCommitted = partyCommittedPreloadByDeckRef.current[targetDeck];
          return current === lease && autoPilotEnabledRef.current &&
            engine.context.state === "running" && !playbackRecoveryLockedRef.current &&
            !partySoundStopInProgressRef.current && !partyCheckpointBusyRef.current &&
            !partyCheckpointWriterLostRef.current && !autoPilotPreloadLeaseRef.current &&
            !transitionArmLeaseRef.current && !activeTransitionScheduleRef.current &&
            currentTarget?.trackId === lease.targetTrackId &&
            currentTarget.loadOrdinal === lease.targetLoadOrdinal &&
            currentCommitted?.trackId === lease.targetTrackId &&
            currentCommitted.loadOrdinal === lease.targetLoadOrdinal;
        };
        partyFallbackContinuationRef.current = lease;
        advancePartyAutopilotCoordinatorEpoch();
        if (partyTraceRunningRef.current) {
          recordPartyEvent({
            type: "deck-ended",
            deck,
            trackOrdinal: endedIdentity.trackOrdinal,
            loadOrdinal: endedIdentity.loadOrdinal,
            nativeOwnerOrdinal: partyNativeCompletionOrdinal(deck, event.operation, event.loadRevision),
            settledBy: event.settledBy,
            outcome: event.outcome
          });
          recordPartyEvent({
            type: "fallback-started",
            operation,
            sourceTrackOrdinal: endedIdentity.trackOrdinal,
            sourceLoadOrdinal: endedIdentity.loadOrdinal,
            targetTrackOrdinal: committedTarget.trackOrdinal,
            targetLoadOrdinal: committedTarget.loadOrdinal,
            cause: "natural-eof"
          });
          endedEventRecorded = true;
        }
        const audioResult = runPartyCommittedTargetAudioTransaction({
          sampleRate: engine.context.sampleRate,
          now: () => engine.clock.now(),
          authority: ownsLease,
          revokeAuthority: () => {
            if (partyFallbackContinuationRef.current === lease) {
              partyFallbackContinuationRef.current = null;
            }
          },
          getSnapshot: () => targetRef.current?.getDeckSnapshot?.() ?? null,
          isActive: () => Boolean(targetRef.current?.isPlaying?.()),
          isExactTarget: (snapshot) => {
            const currentTarget = partyLoadByDeckRef.current[targetDeck];
            return snapshot?.trackId === lease.targetTrackId &&
              currentTarget?.trackId === lease.targetTrackId &&
              currentTarget.loadOrdinal === lease.targetLoadOrdinal;
          },
          getGain: () => engine.getDeckGain(targetDeck),
          setGain: (gain) => {
            if (!targetRef.current?.setGain) throw new Error("target gain unavailable");
            targetRef.current.setGain(gain);
          },
          playReadyAtIfRunning: (startTime, offsetSeconds, authority) =>
            targetRef.current?.playReadyAtIfRunning?.(startTime, offsetSeconds, authority) ?? null,
          scheduleGainCurve: (curve, startTime, durationSeconds, authority) =>
            engine.scheduleDeckGainCurve(targetDeck, curve, startTime, durationSeconds, authority),
          pause: () => {
            if (!targetRef.current?.pause) throw new Error("target pause unavailable");
            targetRef.current.pause();
          }
        });
        fallbackCleanupConfirmed = audioResult.cleanupConfirmed;
        if (audioResult.status === "scheduled") {
          partyPlayedLoadsRef.current.add(`${committedTarget.trackOrdinal}:${committedTarget.loadOrdinal}`);
          recordPartyEvent({ type: "fallback-settled", operation, outcome: "scheduled", pauseRequired: false });
          partyCommittedPreloadByDeckRef.current = {
            ...partyCommittedPreloadByDeckRef.current,
            [targetDeck]: null
          };
          partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [deck]: null };
          setLoadedByDeck((current) => ({ ...current, [deck]: null }));
          setPlayedTrackIds((current) => current.includes(lease.targetTrackId)
            ? current
            : [...current, lease.targetTrackId]);
          setMasterDeck(targetDeck);
          setFade(targetDeck === "b" ? 1 : 0);
          setAutoMixing(false);
          setAutoMixBeats(0);
          setAutoPilotChoice(null);
          showToast("Ready next song started · a short gap may have occurred");
          return;
        }
        recordPartyEvent({ type: "fallback-settled", operation, outcome: "failed", pauseRequired: true });
      }
    }

    const traceWasRunning = partyTraceRunningRef.current;
    advancePartyAutopilotCoordinatorEpoch();
    autoPilotEnabledRef.current = false;
    const preloadCleanup = settleAutoPilotPreloadForPause("superseded");
    let cleanupConfirmed = preloadCleanup.cleanupConfirmed && fallbackCleanupConfirmed;
    try {
      if (transitionArmLeaseRef.current && !cancelCurrentTransitionArm()) cleanupConfirmed = false;
    } catch { cleanupConfirmed = false; }
    if (activeTransition) {
      const cancelCompletion = transitionCompletionCancelRef.current;
      transitionCompletionCancelRef.current = null;
      try { cancelCompletion?.(); } catch { cleanupConfirmed = false; }
      transitionCompletionUncertainRef.current = true;
      setTransitionCompletionUncertain(true);
    }
    if (finalTrackRef.current) {
      finalTrackRef.current = null;
      if (traceWasRunning) recordPartyEvent({ type: "final-revoked" });
    }
    if (decision.kind === "pause-unexpected-source") {
      if (traceWasRunning && !endedEventRecorded) {
        recordPartyEvent({
          type: "deck-ended",
          deck,
          trackOrdinal: endedIdentity.trackOrdinal,
          loadOrdinal: endedIdentity.loadOrdinal,
          nativeOwnerOrdinal: partyNativeCompletionOrdinal(deck, event.operation, event.loadRevision),
          settledBy: event.settledBy,
          outcome: event.outcome
        });
      }
    } else if (partyTraceRecorderRef.current) {
      partyTraceRecorderRef.current.markInterrupted();
      updatePartyDiagnosticEvaluation();
    }
    setAutoPilotEnabled(false);
    setPartyEndingFinalTrack(false);
    setAutoPilotChoice(null);
    partyCheckpointPauseReasonRef.current = "safety";
    const completionOwnerUnobservable = decision.reason === "owner-unobservable";
    if (!cleanupConfirmed || activeTransition || completionOwnerUnobservable) {
      transitionCompletionUncertainRef.current = true;
      setTransitionCompletionUncertain(true);
      refreshPlaybackRecoveryLock();
    }
    pausePartyClockFailClosed();
    if (decision.kind === "pause-unexpected-source") pausePartyDiagnostic("source-stopped");
    else if (partyTraceRunningRef.current) pausePartyDiagnostic("deck-completion");
    try { void partyWakeLockRef.current?.release?.(); } catch { /* Session authority is already revoked. */ }
    showAutoPilotArmIntervention(!cleanupConfirmed
      ? "preload-cleanup-uncertain"
      : completionOwnerUnobservable
        ? "deck-completion-owner-unobservable"
      : activeTransition || decision.kind === "lock-transition"
        ? "deck-completion-transition"
        : decision.kind === "pause-unexpected-source"
          ? "unexpected-source-ended"
          : "deck-completion-conflict");
  };

  const onAnalysisDetected = (trackId, result) => {
    if (!trackId || libraryWritesBlocked() || removedTrackIdsRef.current.has(trackId)) return;
    publishLibrary(
      (prev) => prev.map((track) =>
        track.id === trackId && !removedTrackIdsRef.current.has(trackId)
          ? { ...mergeGeneratedAnalysis(track, result), programLevelStatus: "ready" }
          : track
      ),
      { routineDirty: true }
    );
  };

  const onEnhancedRhythmDetected = (trackId, enhanced) => {
    if (!trackId || libraryWritesBlocked() || removedTrackIdsRef.current.has(trackId)) return;
    publishLibrary(
      (previous) => previous.map((track) =>
        track.id === trackId ? mergeEnhancedRhythm(track, enhanced) : track
      ),
      { routineDirty: true }
    );
  };

  const onProgramLevelDetected = (trackId, programLevel) => {
    if (!trackId || libraryWritesBlocked() || removedTrackIdsRef.current.has(trackId)) return;
    const currentProgramLevel = normalizeProgramLevel(programLevel);
    if (!currentProgramLevel) return;
    publishLibrary(
      (previous) => previous.map((track) =>
        track.id === trackId ? { ...track, programLevel: currentProgramLevel, programLevelStatus: "ready" } : track
      ),
      { routineDirty: true }
    );
  };

  const onAnalysisOverrideChange = (trackId, overrides) => {
    if (!trackId || libraryWritesBlocked() || removedTrackIdsRef.current.has(trackId)) return;
    const analysisOverrides = normalizeBeatGridOverrides(overrides);
    publishLibrary(
      (prev) => prev.map((track) =>
        track.id === trackId
          ? { ...track, analysisOverrides, timingReview: null }
          : track
      ),
      { routineDirty: true }
    );
    void persistRoutineTrackPatch(trackId, { analysisOverrides, timingReview: null }).then(() => {
      setLibraryTimingSaveErrors((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
    }).catch(() => {
      setLibrarySaveStatus("error");
      setLibraryTimingSaveErrors((current) => ({
        ...current,
        [trackId]: "A timing change is visible now but could not be saved. Free browser storage and try that track again."
      }));
    });
  };

  const onTimingReviewSave = async (trackId, overrides, review) => {
    if (!trackId || libraryWritesBlocked() || removedTrackIdsRef.current.has(trackId)) return;
    const current = libraryRef.current.find((track) => track.id === trackId);
    if (!current) throw new Error("The reviewed track is no longer in the library");
    const next = {
      ...current,
      analysisOverrides: normalizeBeatGridOverrides(overrides),
      timingReview: normalizeTimingReview(review)
    };
    if (!next.timingReview) throw new Error("The timing answers were invalid");
    try {
      await persistRoutineTrackPatch(trackId, {
        analysisOverrides: next.analysisOverrides,
        timingReview: next.timingReview
      });
      setLibraryTimingSaveErrors((current) => {
        const nextErrors = { ...current };
        delete nextErrors[trackId];
        return nextErrors;
      });
    } catch (error) {
      setLibraryTimingSaveErrors((current) => ({
        ...current,
        [trackId]: "A timing review could not be saved. Free browser storage and try that track again."
      }));
      throw error;
    }
    if (removedTrackIdsRef.current.has(trackId) || libraryWritesBlocked() ||
      !libraryRef.current.some((track) => track.id === trackId)) return;
    publishLibrary((previous) => previous.map((track) => track.id === trackId
      ? { ...track, analysisOverrides: next.analysisOverrides, timingReview: next.timingReview }
      : track));
  };

  const onTimingReviewRemove = async (trackId) => {
    if (!trackId || libraryWritesBlocked() || removedTrackIdsRef.current.has(trackId)) return;
    const current = libraryRef.current.find((track) => track.id === trackId);
    if (!current) return;
    const next = { ...current, timingReview: null };
    try {
      await persistRoutineTrackPatch(trackId, { timingReview: null });
      setLibraryTimingSaveErrors((current) => {
        const nextErrors = { ...current };
        delete nextErrors[trackId];
        return nextErrors;
      });
    } catch (error) {
      setLibraryTimingSaveErrors((current) => ({
        ...current,
        [trackId]: "A timing review could not be removed from storage. Free browser storage and try that track again."
      }));
      throw error;
    }
    if (removedTrackIdsRef.current.has(trackId) || libraryWritesBlocked() ||
      !libraryRef.current.some((track) => track.id === trackId)) return;
    publishLibrary((previous) => previous.map((track) => track.id === trackId
      ? { ...track, timingReview: null }
      : track));
  };

  const removeLibraryTrack = async (trackId) => {
    if (libraryMembershipOwnerRef.current || libraryMembershipCircuitOpen ||
        libraryMutationBusyRef.current || partyCheckpointBusyRef.current ||
        playbackRecoveryLockedRef.current) return;
    if (autoMixing || autoMixArming || rehearsalActive || rehearsalPreparing) {
      showToast("Stop the transition or preview before removing music");
      return;
    }
    const track = library.find((candidate) => candidate.id === trackId);
    if (!track) return;
    const mutationOwner = beginLibraryMembershipMutation("delete");
    if (!mutationOwner) return;
    if (contextMenuTriggerRef.current) libraryMembershipTriggerRef.current = contextMenuTriggerRef.current;
    let routineWriteExclusive = false;
    let commitStarted = false;
    const analysisDeferralsBeforeRemoval = new Map(
      [...backgroundAnalysisDeferredRef.current].filter(([, deferred]) => deferred.trackId === trackId)
    );
    const analysisWorkWasOwned = activeBackgroundAnalysisRef.current?.trackId === trackId ||
      pendingAnalysisQueueRef.current.some((job) => job.id === trackId);
    try {
    if (partyFirstSongLoadRef.current?.trackId === trackId &&
      !cancelPartyFirstSongLoad({ keepStatus: false })) {
      finishLibraryMembershipMutation(mutationOwner);
      return;
    }
    if (partyFirstSongLoadStatus?.trackId === trackId) setPartyFirstSongLoadStatus(null);
    setLibraryMutationLock(true);
    routineWriteExclusive = await prepareLibraryRoutineWriteExclusive();
    if (!routineWriteExclusive) {
      finishLibraryMembershipMutation(mutationOwner);
      setLibraryMutationLock(false);
      return;
    }
    if (!mayContinueLibraryMembershipAfterExclusive({
      ownerCurrent: ownsLibraryMembership(mutationOwner),
      expectedLibraryEpoch: mutationOwner.expectedLibraryEpoch,
      expectedLibraryRevision: mutationOwner.expectedLibraryRevision,
      currentLibraryEpoch: libraryStateRef.current.epoch,
      currentLibraryRevision: libraryStateRef.current.revision
    })) {
      completeLibraryRoutineWriteExclusive();
      if (ownsLibraryMembership(mutationOwner)) finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
      if (libraryMutationModeRef.current === "destructive") setLibraryMutationLock(false);
      return;
    }
    removedTrackIdsRef.current.add(trackId);
    cancelBackgroundAnalysisForTrack(trackId);
    pauseAutoPilotForHostControl("Party Autopilot paused · library changed");
    commitStarted = true;
    libraryMembershipPhaseRef.current = "committing";
    const deletionSettlement = await runLibraryMembershipStage(mutationOwner, "committing", (signal) =>
      deleteTrackFromDb(trackId, {
        signal,
        expectedLibraryState: {
          epoch: mutationOwner.expectedLibraryEpoch,
          revision: mutationOwner.expectedLibraryRevision
        }
      }));
    if (!ownsLibraryMembership(mutationOwner)) {
      completeLibraryRoutineWriteExclusive();
      if (libraryMutationModeRef.current === "destructive") setLibraryMutationLock(false);
      return;
    }
    if (deletionSettlement.outcome !== "completed") {
      if (deletionSettlement.outcome === "failed" &&
          membershipFailureHasDefiniteRollback(deletionSettlement.error)) {
        removedTrackIdsRef.current.delete(trackId);
        restoreBackgroundAnalysisDeferrals(analysisDeferralsBeforeRemoval);
        queueMicrotask(() => {
          const surviving = backgroundAnalysisRowsAfterMutationRollback(
            libraryRef.current.filter((candidate) => candidate.id === trackId),
            removedTrackIdsRef.current
          )[0];
          if (surviving && analysisWorkWasOwned && analysisDeferralsBeforeRemoval.size === 0) {
            queueBackgroundAnalysis(surviving);
          }
        });
        completeLibraryRoutineWriteExclusive();
        finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
        setLibraryMutationLock(false);
        setLibraryStorageError("This song was not removed because browser storage rejected the change. Review the library and try again.");
        window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
        return;
      }
      completeLibraryRoutineWriteExclusive();
      failLibraryMembershipCommitClosed(mutationOwner);
      return;
    }
    const deletion = deletionSettlement.value;
    if (deletion.status === "stale-library") {
      removedTrackIdsRef.current.delete(trackId);
      restoreBackgroundAnalysisDeferrals(analysisDeferralsBeforeRemoval);
      queueMicrotask(() => {
        const surviving = backgroundAnalysisRowsAfterMutationRollback(
          libraryRef.current.filter((candidate) => candidate.id === trackId),
          removedTrackIdsRef.current
        )[0];
        if (surviving && analysisWorkWasOwned && analysisDeferralsBeforeRemoval.size === 0) {
          queueBackgroundAnalysis(surviving);
        }
      });
      completeLibraryRoutineWriteExclusive();
      finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
      setLibraryMutationLock(false);
      showToast("Local music changed in another Mazzy tab · review the library and remove the song again");
      requestLibraryMembershipReconciliation(deletion);
      return;
    }
    libraryStateRef.current = deletion.libraryState;
    partyCheckpointRevisionRef.current = deletion.checkpointRevision;
    partyCheckpointStoredRecordRef.current = {
      recordStatus: "invalidated",
      revision: deletion.checkpointRevision,
      sessionId: partyCheckpointSessionIdRef.current,
      writerToken: partyCheckpointWriterTokenRef.current
    };
    partyCheckpointWriteGenerationRef.current += 1;
    partyCheckpointWriteRuntimeRef.current?.reset?.();
    partyCheckpointLastFingerprintRef.current = "";
    partyCheckpointRecoveryRef.current = null;
    setPartyCheckpointRecovery(null);
    setRestoredPartyPlan(null);
    playedTrackIdsRef.current = playedTrackIdsRef.current.filter((id) => id !== trackId);
    setPlayedTrackIds((current) => current.filter((id) => id !== trackId));
    publishLibrary((current) => {
      const next = current.filter((candidate) => candidate.id !== trackId);
      libraryRef.current = next;
      libraryRoutineSkipSnapshotRef.current = next;
      return next;
    });
    setQueue((current) => current.filter((id) => id !== trackId));
    const deckACleanup = verifyDeckMembershipCleanup(deckARef.current, trackId);
    const deckBCleanup = verifyDeckMembershipCleanup(deckBRef.current, trackId);
    if (deckACleanup.affected && deckACleanup.confirmed) {
      setLoadedByDeck((current) => ({ ...current, a: null }));
    }
    if (deckBCleanup.affected && deckBCleanup.confirmed) {
      setLoadedByDeck((current) => ({ ...current, b: null }));
    }
    const deckCleanupConfirmed = deckACleanup.confirmed && deckBCleanup.confirmed;
    if (!deckCleanupConfirmed) retainPlaybackLockAfterMembershipCleanupFailure([
      ...(!deckACleanup.confirmed ? [{ deck: "a", trackId, exact: true }] : []),
      ...(!deckBCleanup.confirmed ? [{ deck: "b", trackId, exact: true }] : [])
    ]);
    completeLibraryRoutineWriteExclusive({ membershipChanged: true });
    finishLibraryMembershipMutation(mutationOwner);
    setLibraryMutationLock(false);
    showToast("Removed track and its saved analysis · saved party recovery cleared");
    if (deckCleanupConfirmed) focusLibraryAfterMembershipSuccess();
    } catch {
      if (!ownsLibraryMembership(mutationOwner)) return;
      if (routineWriteExclusive) completeLibraryRoutineWriteExclusive();
      if (commitStarted) {
        failLibraryMembershipCommitClosed(mutationOwner);
        return;
      }
      removedTrackIdsRef.current.delete(trackId);
      restoreBackgroundAnalysisDeferrals(analysisDeferralsBeforeRemoval);
      queueMicrotask(() => {
        const surviving = backgroundAnalysisRowsAfterMutationRollback(
          libraryRef.current.filter((candidate) => candidate.id === trackId),
          removedTrackIdsRef.current
        )[0];
        if (surviving && analysisWorkWasOwned && analysisDeferralsBeforeRemoval.size === 0) {
          queueBackgroundAnalysis(surviving);
        }
      });
      finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
      if (libraryMutationModeRef.current === "destructive") setLibraryMutationLock(false);
      setLibraryStorageError("This song was not removed because local storage preparation failed. Review the library and try again.");
      window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
    }
  };

  const clearLocalLibrary = async () => {
    if (libraryMembershipOwnerRef.current || libraryMembershipCircuitOpen ||
        libraryMutationBusyRef.current || partyCheckpointBusyRef.current ||
        playbackRecoveryLockedRef.current) return;
    if (autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing) {
      showToast("Stop Party Autopilot and any preview before clearing music");
      return;
    }
    if (!window.confirm("Remove every imported song, saved analysis, and saved party plan from this browser profile? Active enhanced timing may finish its current local step before memory is released.")) return;
    const mutationOwner = beginLibraryMembershipMutation("clear");
    if (!mutationOwner) return;
    let routineWriteExclusive = false;
    let commitStarted = false;
    const analysisDeferralsBeforeClear = new Map(backgroundAnalysisDeferredRef.current);
    const clearDeckOwners = [
      { deck: "a", handle: deckARef.current },
      { deck: "b", handle: deckBRef.current }
    ].map(({ deck, handle }) => {
      try {
        return Object.freeze({ deck, trackId: handle?.getTrackId?.() ?? null, exact: Boolean(handle) });
      } catch {
        return Object.freeze({ deck, trackId: null, exact: false });
      }
    });
    try {
    if (!cancelPartyFirstSongLoad({ keepStatus: false })) {
      finishLibraryMembershipMutation(mutationOwner);
      return;
    }
    setPartyFirstSongLoadStatus(null);
    setLibraryMutationLock(true);
    routineWriteExclusive = await prepareLibraryRoutineWriteExclusive();
    if (!routineWriteExclusive) {
      finishLibraryMembershipMutation(mutationOwner);
      setLibraryMutationLock(false);
      return;
    }
    if (!mayContinueLibraryMembershipAfterExclusive({
      ownerCurrent: ownsLibraryMembership(mutationOwner),
      expectedLibraryEpoch: mutationOwner.expectedLibraryEpoch,
      expectedLibraryRevision: mutationOwner.expectedLibraryRevision,
      currentLibraryEpoch: libraryStateRef.current.epoch,
      currentLibraryRevision: libraryStateRef.current.revision
    })) {
      completeLibraryRoutineWriteExclusive();
      if (ownsLibraryMembership(mutationOwner)) finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
      if (libraryMutationModeRef.current === "destructive") setLibraryMutationLock(false);
      return;
    }
    queuedAnalysisIdsRef.current.clear();
    pendingAnalysisQueueRef.current = [];
    backgroundAnalysisDeferredRef.current.clear();
    setBackgroundAnalysisNotice(null);
    for (const track of library) removedTrackIdsRef.current.add(track.id);
    analysisGenerationRef.current += 1;
    cancelActiveBackgroundAnalysis({ resetEnhanced: true });
    disposeAnalysisClient();
    disposeEnhancedRhythmClient();
    commitStarted = true;
    libraryMembershipPhaseRef.current = "committing";
    const clearSettlement = await runLibraryMembershipStage(mutationOwner, "committing", (signal) =>
      clearTracksFromDb({
        signal,
        expectedLibraryState: {
          epoch: mutationOwner.expectedLibraryEpoch,
          revision: mutationOwner.expectedLibraryRevision
        }
      }));
    if (!ownsLibraryMembership(mutationOwner)) {
      completeLibraryRoutineWriteExclusive();
      if (libraryMutationModeRef.current === "destructive") setLibraryMutationLock(false);
      return;
    }
    if (clearSettlement.outcome !== "completed") {
      if (clearSettlement.outcome === "failed" &&
          membershipFailureHasDefiniteRollback(clearSettlement.error)) {
        for (const track of library) removedTrackIdsRef.current.delete(track.id);
        restoreBackgroundAnalysisDeferrals(analysisDeferralsBeforeClear);
        queueMicrotask(() => {
          for (const track of backgroundAnalysisRowsAfterMutationRollback(
            libraryRef.current,
            removedTrackIdsRef.current
          )) {
            const hasRestoredDeferral = backgroundAnalysisDeferredRef.current.has(
              backgroundAnalysisJobKey(track.id, "basic-program")
            ) || backgroundAnalysisDeferredRef.current.has(backgroundAnalysisJobKey(track.id, "enhanced"));
            if (!hasRestoredDeferral) queueBackgroundAnalysis(track);
          }
        });
        completeLibraryRoutineWriteExclusive();
        finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
        setLibraryMutationLock(false);
        setLibraryStorageError("Local music was not removed because browser storage rejected the change. Review the library and try again.");
        window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
        return;
      }
      completeLibraryRoutineWriteExclusive();
      failLibraryMembershipCommitClosed(mutationOwner);
      return;
    }
    const cleared = clearSettlement.value;
    if (cleared.status === "stale-library") {
      for (const track of library) removedTrackIdsRef.current.delete(track.id);
      restoreBackgroundAnalysisDeferrals(analysisDeferralsBeforeClear);
      queueMicrotask(() => {
        for (const track of backgroundAnalysisRowsAfterMutationRollback(
          libraryRef.current,
          removedTrackIdsRef.current
        )) {
          const hasRestoredDeferral = backgroundAnalysisDeferredRef.current.has(
            backgroundAnalysisJobKey(track.id, "basic-program")
          ) || backgroundAnalysisDeferredRef.current.has(backgroundAnalysisJobKey(track.id, "enhanced"));
          if (!hasRestoredDeferral) queueBackgroundAnalysis(track);
        }
      });
      completeLibraryRoutineWriteExclusive();
      finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
      setLibraryMutationLock(false);
      showToast("Local music changed in another Mazzy tab · review it and choose Remove All again");
      requestLibraryMembershipReconciliation(cleared);
      return;
    }
    libraryStateRef.current = cleared.libraryState;
    partyCheckpointRevisionRef.current = cleared.checkpointRevision;
    partyCheckpointStoredRecordRef.current = {
      recordStatus: "invalidated",
      revision: cleared.checkpointRevision,
      sessionId: partyCheckpointSessionIdRef.current,
      writerToken: partyCheckpointWriterTokenRef.current
    };
    partyCheckpointWriteGenerationRef.current += 1;
    partyCheckpointWriteRuntimeRef.current?.reset?.();
    partyCheckpointTerminalRef.current = true;
    partyCheckpointSessionIdRef.current = null;
    partyCheckpointRecoveryRef.current = null;
    setPartyCheckpointRecovery(null);
    setRestoredPartyPlan(null);
    const deckACleanup = verifyDeckMembershipCleanup(deckARef.current);
    const deckBCleanup = verifyDeckMembershipCleanup(deckBRef.current);
    if (deckACleanup.confirmed) setLoadedByDeck((current) => ({ ...current, a: null }));
    if (deckBCleanup.confirmed) setLoadedByDeck((current) => ({ ...current, b: null }));
    const deckCleanupConfirmed = deckACleanup.confirmed && deckBCleanup.confirmed;
    if (!deckCleanupConfirmed) retainPlaybackLockAfterMembershipCleanupFailure(
      clearDeckOwners.filter((entry) => entry.deck === "a"
        ? !deckACleanup.confirmed
        : !deckBCleanup.confirmed)
    );
    setQueue([]);
    setPlayedTrackIds([]);
    libraryRef.current = [];
    libraryRoutineSkipSnapshotRef.current = libraryRef.current;
    publishLibrary(libraryRef.current);
    completeLibraryRoutineWriteExclusive({ membershipChanged: true });
    finishLibraryMembershipMutation(mutationOwner);
    setLibraryMutationLock(false);
    setAutoPilotChoice(null);
    showToast("All imported music, saved analysis, and saved party recovery were removed");
    if (deckCleanupConfirmed) focusLibraryAfterMembershipSuccess();
    } catch {
      if (!ownsLibraryMembership(mutationOwner)) return;
      if (routineWriteExclusive) completeLibraryRoutineWriteExclusive();
      if (commitStarted) {
        failLibraryMembershipCommitClosed(mutationOwner);
        return;
      }
      for (const track of library) removedTrackIdsRef.current.delete(track.id);
      restoreBackgroundAnalysisDeferrals(analysisDeferralsBeforeClear);
      queueMicrotask(() => {
        for (const track of backgroundAnalysisRowsAfterMutationRollback(
          libraryRef.current,
          removedTrackIdsRef.current
        )) {
          const hasRestoredDeferral = backgroundAnalysisDeferredRef.current.has(
            backgroundAnalysisJobKey(track.id, "basic-program")
          ) || backgroundAnalysisDeferredRef.current.has(backgroundAnalysisJobKey(track.id, "enhanced"));
          if (!hasRestoredDeferral) queueBackgroundAnalysis(track);
        }
      });
      finishLibraryMembershipMutation(mutationOwner, { restoreFocus: true });
      if (libraryMutationModeRef.current === "destructive") setLibraryMutationLock(false);
      setLibraryStorageError("Local music was not removed because browser storage preparation failed. Review the library and try again.");
      window.requestAnimationFrame(() => libraryStorageAlertRef.current?.focus?.());
    }
  };

  const clearPartyFirstSongLoadTimer = (owner = null) => {
    const timer = partyFirstSongLoadTimerRef.current;
    if (!timer || (owner && !ownsPartyFirstSongTimer(timer, owner))) return;
    window.clearTimeout(timer.id);
    partyFirstSongLoadTimerRef.current = null;
  };

  const cancelPartyFirstSongStart = ({ message = null, restoreFocus = false } = {}) => {
    const owner = partyFirstSongStartOwnerRef.current;
    if (!owner) return false;
    partyFirstSongStartOwnerRef.current = null;
    partyFirstSongStartAuthorityKeyRef.current = null;
    const runtime = partyFirstSongStartRuntimeRef.current;
    partyFirstSongStartRuntimeRef.current = null;
    try { runtime?.revoke?.(); } catch { /* Exact start authority is already revoked. */ }
    setPartyFirstSongStartStatus(message ? { state: "cancelled", message } : null);
    refreshPlaybackRecoveryLock();
    if (restoreFocus) window.requestAnimationFrame(() => partyFirstSongPlayButtonRef.current?.focus?.());
    return true;
  };

  const cancelPartyFirstSongLoad = ({
    message = "Opening cancelled. Choose a first song when you're ready.",
    keepStatus = true,
    restoreFocus = false
  } = {}) => {
    const owner = partyFirstSongLoadRef.current;
    if (!owner || !ownsPartyFirstSongLoad(partyFirstSongLoadRef.current, owner)) return true;
    partyFirstSongLoadRef.current = null;
    clearPartyFirstSongLoadTimer(owner);
    const handle = owner.deck === "a" ? deckARef.current : deckBRef.current;
    let cleanupConfirmed = false;
    try {
      const cancelled = handle?.cancelLoadIfOwned?.(owner.loadAuthorityKey);
      let snapshot = handle?.getDeckSnapshot?.() ?? null;
      if (cancelled?.owned && cancelled?.authorityRevoked && snapshot?.trackId === owner.trackId &&
        !handle?.isPlaying?.()) {
        handle?.eject?.();
        snapshot = handle?.getDeckSnapshot?.() ?? null;
        partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [owner.deck]: null };
        setLoadedByDeck((current) => ({ ...current, [owner.deck]: null }));
      }
      cleanupConfirmed = Boolean(cancelled?.owned && cancelled?.authorityRevoked &&
        snapshot?.trackId !== owner.trackId && !handle?.isPlaying?.());
    } catch {
      cleanupConfirmed = false;
    }
    if (!cleanupConfirmed) {
      transitionCompletionUncertainRef.current = true;
      setTransitionCompletionUncertain(true);
      refreshPlaybackRecoveryLock();
      setPartyFirstSongLoadStatus({
        state: "cleanup-error",
        trackId: owner.trackId,
        message: "Mazzy could not confirm that opening stopped. Use Stop All Sound, then choose a song again."
      });
      window.requestAnimationFrame(() => partyFirstSongLoadAlertRef.current?.focus?.());
      return false;
    }
    setPartyFirstSongLoadStatus(keepStatus ? {
      state: "cancelled",
      trackId: owner.trackId,
      message
    } : null);
    if (restoreFocus) window.requestAnimationFrame(() => partyFirstSongLoadTriggerRef.current?.focus?.());
    return true;
  };

  const loadTrackToDeck = async (
    deck,
    track,
    { autoPilotOwned = false, loadAuthorityKey = null, purpose = null } = {}
  ) => {
    const resolvedPurpose = purpose ?? (autoPilotOwned
      ? DECK_LOAD_PURPOSE.autoPilotPreload
      : DECK_LOAD_PURPOSE.manual);
    if (partyFirstSongLoadRef.current && resolvedPurpose !== DECK_LOAD_PURPOSE.partyFirstSong) {
      return DECK_LOAD_OUTCOME.cancelled;
    }
    if (partyFirstSongStartOwnerRef.current) return DECK_LOAD_OUTCOME.cancelled;
    if (playbackRecoveryLockedRef.current || partyCheckpointBusyRef.current || partyCheckpointWriterLostRef.current || audioRecoveryState || outputDeviceChanged || libraryMutationBusyRef.current || autoMixing || autoMixArming || rehearsalActive || rehearsalPreparing || rehearsalPlaybackLocked()) return DECK_LOAD_OUTCOME.cancelled;
    if (!autoPilotOwned) pauseAutoPilotForHostControl();
    const manuallyRestoringPlayability = !autoPilotOwned && autoPilotExcludedTrackIds.includes(track.id);
    const ref = deck === "a" ? deckARef : deckBRef;
    const outcome = await ref.current?.loadTrack?.(
      track.file,
      track.id,
      track,
      {
        isolatedAnalysis: autoPilotOwned,
        loadAuthorityKey,
        purpose: resolvedPurpose
      }
    ) ?? DECK_LOAD_OUTCOME.cancelled;
    if (outcome === DECK_LOAD_OUTCOME.loaded) {
      setLoadedByDeck((prev) => ({ ...prev, [deck]: track.id }));
      setUnavailableAutoPilotTrackIds((current) => current.includes(track.id)
        ? current.filter((id) => id !== track.id)
        : current);
      setTimedOutAutoPilotTrackIds((current) => current.includes(track.id)
        ? current.filter((id) => id !== track.id)
        : current);
      if (!autoPilotOwned) consecutiveAutoPilotPreloadTimeoutsRef.current = 0;
      if (manuallyRestoringPlayability) {
        const trackOrdinal = partyTrackOrdinal(track.id);
        if (
          trackOrdinal
          && partyTraceRecorderRef.current
          && evaluatePartyAutopilotTrace(partyTraceRecorderRef.current.snapshot()).status !== "valid-terminal"
        ) {
          recordPartyEvent({ type: "track-playability-restored", trackOrdinal });
        }
      }
    } else if (shouldAutoEjectDeckLoadFailure({ purpose: resolvedPurpose, outcome })) {
      ref.current?.eject?.();
      setLoadedByDeck((current) => ({ ...current, [deck]: null }));
      partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [deck]: null };
    }
    return outcome;
  };

  const openPartyFirstSong = async (track, trigger = null) => {
    if (partyFirstSongLoadRef.current || partyFirstSongStartOwnerRef.current || partyCheckpointBusyRef.current ||
      partyCheckpointWriterLostRef.current || libraryMutationBusyRef.current ||
      playbackRecoveryLockedRef.current || rehearsalPlaybackLocked() ||
      audioRecoveryState || outputDeviceChanged) return;
    const deck = masterDeck;
    const owner = createPartyFirstSongLoadOwner({
      operation: ++partyFirstSongLoadOperationRef.current,
      deck,
      trackId: track.id
    });
    partyFirstSongLoadRef.current = owner;
    partyFirstSongLoadTriggerRef.current = trigger;
    setPartyFirstSongStartStatus(null);
    setPartyFirstSongLoadStatus({
      state: "opening",
      trackId: track.id,
      message: "Opening the first song locally. Audio will not start until you press Play First Song."
    });
    window.requestAnimationFrame(() => {
      if (ownsPartyFirstSongLoad(partyFirstSongLoadRef.current, owner)) {
        partyFirstSongCancelRef.current?.focus?.();
      }
    });
    clearPartyFirstSongLoadTimer();
    const slowTimerId = window.setTimeout(() => {
      if (!ownsPartyFirstSongLoad(partyFirstSongLoadRef.current, owner)) return;
      setPartyFirstSongLoadStatus({
        state: "slow",
        trackId: track.id,
        message: "Still opening this song locally. Large files can take longer; you can keep waiting or cancel."
      });
    }, 12_000);
    partyFirstSongLoadTimerRef.current = { operation: owner.operation, id: slowTimerId };

    const outcome = await loadTrackToDeck(deck, track, {
      loadAuthorityKey: owner.loadAuthorityKey,
      purpose: DECK_LOAD_PURPOSE.partyFirstSong
    });
    clearPartyFirstSongLoadTimer(owner);
    const handle = deck === "a" ? deckARef.current : deckBRef.current;
    const snapshot = handle?.getDeckSnapshot?.() ?? null;
    const readinessCurrent = ownsDeckLoadReadiness({
      value: handle?.getLoadReadiness?.(),
      trackId: track.id,
      loadAuthorityKey: owner.loadAuthorityKey,
      appliedTrimDb: handle?.getDspSnapshot?.()?.trimDb
    });
    const currentRow = libraryRef.current.find((item) => item.id === track.id);
    const settlement = decidePartyFirstSongLoadSettlement({
      current: partyFirstSongLoadRef.current,
      expected: owner,
      outcome,
      currentTrackId: snapshot?.trackId ?? null,
      ready: Boolean(handle?.isReady?.()),
      playing: Boolean(handle?.isPlaying?.()),
      playbackRate: Number(snapshot?.playbackRate),
      readinessCurrent,
      contextRunning: getAudioEngine().context.state === "running",
      libraryCurrent: Boolean(currentRow && currentRow.file === track.file &&
        !removedTrackIdsRef.current.has(track.id)),
      recoveryLocked: playbackRecoveryLockedRef.current || partyCheckpointBusyRef.current ||
        partyCheckpointWriterLostRef.current || libraryMutationBusyRef.current
    });
    if (settlement === "ignore-stale") return;
    if (settlement === "ready") {
      partyFirstSongLoadRef.current = null;
      setPartyFirstSongLoadStatus({
        state: "ready",
        trackId: track.id,
        owner,
        message: partyFirstSongReadyActionMessage(false)
      });
      window.requestAnimationFrame(() => partyFirstSongPlayButtonRef.current?.focus?.());
      return;
    }
    if (settlement === "cancelled") {
      cancelPartyFirstSongLoad({
        message: "Opening stopped. Choose a first song when you're ready.",
        keepStatus: true
      });
      return;
    }
    if (settlement === "read-failed" || settlement === "audio-blocked") {
      const cleaned = cancelPartyFirstSongLoad({ keepStatus: false });
      if (cleaned) {
        setPartyFirstSongLoadStatus({
          state: "error",
          trackId: track.id,
          message: settlement === "audio-blocked"
            ? "Browser audio needs attention before this song can be opened. Resume audio, then try again."
            : "This song could not be read or decoded. Choose another song or try this one again."
        });
        window.requestAnimationFrame(() => partyFirstSongLoadAlertRef.current?.focus?.());
      }
      return;
    }
    cancelPartyFirstSongLoad({ keepStatus: false });
    if (!transitionCompletionUncertainRef.current) {
      setPartyFirstSongLoadStatus({
        state: "error",
        trackId: track.id,
        message: "Mazzy could not verify this first-song load. Choose another song and try again."
      });
      window.requestAnimationFrame(() => partyFirstSongLoadAlertRef.current?.focus?.());
    }
  };

  const addToQueue = (trackId, playNext = false) => {
    if (partyCheckpointBusyRef.current || partyCheckpointWriterLostRef.current ||
        partyFirstSongStartOwnerRef.current || partyFirstSongStartCircuitOpenRef.current) return;
    setQueue((prev) => {
      const filtered = prev.filter((id) => id !== trackId);
      return playNext ? [trackId, ...filtered] : [...filtered, trackId];
    });
  };

  const activateLibraryTrack = async (track, trigger = null) => {
    if (partyCheckpointBusyRef.current || partyFirstSongStartOwnerRef.current) return;
    if (autoPilotExcludedTrackIds.includes(track.id)) {
      showToast("Skipped earlier · pause Autopilot, then use More to try again");
      return;
    }
    const sourceRef = masterDeck === "a" ? deckARef : deckBRef;
    if (!sourceRef.current?.isReady?.()) {
      await openPartyFirstSong(track, trigger);
      return;
    }
    if (sourceRef.current?.getDeckSnapshot?.()?.trackId === track.id) return;
    const requestedNext = autoPilotEnabled || queue.includes(track.id);
    addToQueue(track.id, requestedNext);
    showToast(requestedNext ? "Requested next; Mazzy will use it after any song already prepared" : "Added to queue");
    setDeckFlash({ a: true, b: true });
    window.setTimeout(() => setDeckFlash({ a: false, b: false }), 260);
  };

  const deckATrack = library.find((t) => t.id === loadedByDeck.a);
  const deckAPlaying = !!deckARef.current?.isPlaying?.();
  const deckBPlaying = !!deckBRef.current?.isPlaying?.();
  const sourcePreviewRef = masterDeck === "a" ? deckARef : deckBRef;
  const targetPreviewRef = masterDeck === "a" ? deckBRef : deckARef;
  const readinessTargetId = targetPreviewRef.current?.getDeckSnapshot?.()?.trackId ?? null;
  const readinessTargetTrack = library.find((track) => track.id === readinessTargetId);
  const readinessTargetEligible = Boolean(targetPreviewRef.current?.isReady?.()) &&
    !playedTrackIds.includes(readinessTargetId) && !readinessTargetTrack?.analysisOverrides?.autoMixDisabled;
  const partyReadiness = assessPartyReadiness({
    sourcePlaying: !!sourcePreviewRef.current?.isPlaying?.(),
    sourceReady: !!sourcePreviewRef.current?.isReady?.(),
    targetReady: readinessTargetEligible,
    targetActive: !!targetPreviewRef.current?.isPlaying?.(),
    queuedTracks: queue.filter((id) => availableAutoPilotTrackIds.includes(id)).length,
    analyzedQueuedTracks: queueTracks.filter((track) => availableAutoPilotTrackIds.includes(track.id) && hasCurrentBasicAnalysis(track)).length,
    libraryFillTracks: availableAutoPilotTrackIds.filter((id) => !queue.includes(id)).length,
    unavailableTracks: autoPilotExcludedTrackIds.length,
    enhancedTimingReady: enhancedTimingAvailable === true
  });

  const planCurrentPair = () => {
    const sourceDeck = masterDeck;
    const targetDeck = sourceDeck === "a" ? "b" : "a";
    const sourceRef = sourceDeck === "a" ? deckARef : deckBRef;
    const targetRef = targetDeck === "a" ? deckARef : deckBRef;
    if (!sourceRef.current?.isReady?.()) return { status: "missing-source", sourceDeck, targetDeck };
    if (!targetRef.current?.isReady?.()) return { status: "missing-target", sourceDeck, targetDeck };
    if (targetRef.current?.isPlaying?.()) return { status: "target-active", sourceDeck, targetDeck };
    const sourceSnapshot = sourceRef.current.getDeckSnapshot?.();
    const targetSnapshot = targetRef.current.getDeckSnapshot?.();
    if (!sourceSnapshot || !targetSnapshot) return { status: "unavailable", sourceDeck, targetDeck };
    const sourceAnalysis = sourceRef.current.getAnalysisRecord?.();
    const targetAnalysis = targetRef.current.getAnalysisRecord?.();
    const sourceReadiness = sourceRef.current.getLoadReadiness?.();
    const targetReadiness = targetRef.current.getLoadReadiness?.();
    const plan = planAutomaticTransition({
      requestedAt: getAudioEngine().clock.now(),
      source: {
        ...(sourceAnalysis ?? {}),
        forceSafeFadeOnly: sourceReadiness?.safeFadeOnly === true,
        trackId: sourceSnapshot.trackId,
        duration: sourceSnapshot.durationSeconds
      },
      target: {
        ...(targetAnalysis ?? {}),
        forceSafeFadeOnly: targetReadiness?.safeFadeOnly === true,
        trackId: targetSnapshot.trackId,
        duration: targetSnapshot.durationSeconds
      },
      sourceDeck: {
        positionSeconds: sourceSnapshot.positionSeconds,
        playbackRate: sourceSnapshot.playbackRate
      }
    });
    return {
      status: sourceRef.current.isPlaying?.() ? "ready" : "source-paused",
      sourceDeck,
      targetDeck,
      plan
    };
  };

  const rehearseCurrentPair = async () => {
    if (
      partyCheckpointBusyRef.current
      || partyCheckpointWriterLostRef.current
      || playbackRecoveryLockedRef.current
      || rehearsalCircuitOpenRef.current
      || rehearsalPreparationOwnedRef.current
      || rehearsalRenderRuntimeRef.current
      || rehearsalCancelRef.current
      || partyFirstSongStartOwnerRef.current
      || autoMixing
      || autoMixArming
      || deckARef.current?.isPlaying?.()
      || deckBRef.current?.isPlaying?.()
    ) return;
    const preview = planCurrentPair();
    if (!preview.plan) return;
    const sourceTrackId = preview.sourceDeck === "a" ? loadedByDeck.a : loadedByDeck.b;
    const targetTrackId = preview.targetDeck === "a" ? loadedByDeck.a : loadedByDeck.b;
    const sourceTrack = library.find((track) => track.id === sourceTrackId);
    const targetTrack = library.find((track) => track.id === targetTrackId);
    if (!sourceTrack?.file || !targetTrack?.file) {
      setRehearsalStatus({ state: "error", message: "Preview needs two tracks from the local library." });
      return;
    }
    const generation = rehearsalGenerationRef.current + 1;
    rehearsalGenerationRef.current = generation;
    rehearsalCancelRef.current?.();
    rehearsalCancelRef.current = null;
    rehearsalPreparationOwnedRef.current = true;
    refreshPlaybackRecoveryLock();
    setRehearsalActive(false);
    setRehearsalStatus({ state: "rendering", message: "Preparing a short local preview…" });
    try {
      const engine = getAudioEngine();
      const sampleRate = engine.context.sampleRate;
      const sourceDeckRef = preview.sourceDeck === "a" ? deckARef : deckBRef;
      const targetDeckRef = preview.targetDeck === "a" ? deckARef : deckBRef;
      const sourceAnalysisAtStart = sourceDeckRef.current?.getAnalysisRecord?.();
      const targetAnalysisAtStart = targetDeckRef.current?.getAnalysisRecord?.();
      const pairStillCurrent = () => {
        return rehearsalGenerationRef.current === generation &&
          sourceDeckRef.current?.getDeckSnapshot?.()?.trackId === sourceTrackId &&
          targetDeckRef.current?.getDeckSnapshot?.()?.trackId === targetTrackId &&
          sourceDeckRef.current?.getAnalysisRecord?.() === sourceAnalysisAtStart &&
          targetDeckRef.current?.getAnalysisRecord?.() === targetAnalysisAtStart;
      };
      const sourceBuffer = sourceDeckRef.current?.getDecodedBufferForRehearsal?.();
      if (!sourceBuffer) throw new Error("The source deck buffer is unavailable");
      if (!pairStillCurrent()) throw new DOMException("Rehearsal pair changed", "AbortError");
      const sourceSnapshot = sourceDeckRef.current?.getDeckSnapshot?.();
      const sourceCueSeconds = deriveRehearsalSourceCueSeconds(
        Number(sourceSnapshot?.positionSeconds ?? 0),
        preview.plan.sourcePlaybackRate,
        preview.plan.schedule.requestedAt,
        preview.plan.schedule.startTime
      );
      const preRollSeconds = 2;
      const postRollSeconds = 2;
      const targetBuffer = targetDeckRef.current?.getDecodedBufferForRehearsal?.();
      if (!targetBuffer) throw new Error("The target deck buffer is unavailable");
      if (!pairStillCurrent()) throw new DOMException("Rehearsal pair changed", "AbortError");
      const sourceDspSnapshot = sourceDeckRef.current?.getDspSnapshot?.()
        ?? { trimDb: 0, eqDb: { low: 0, mid: 0, high: 0 } };
      const targetDspSnapshot = targetDeckRef.current?.getDspSnapshot?.()
        ?? { trimDb: 0, eqDb: { low: 0, mid: 0, high: 0 } };
      const rehearsalDsp = compileTransitionDsp(preview.plan, {
        sourceTrimDb: sourceDspSnapshot.trimDb,
        targetTrimDb: targetDspSnapshot.trimDb,
        sourceEqDb: sourceDspSnapshot.eqDb,
        targetEqDb: targetDspSnapshot.eqDb
      });
      const runtime = startTransitionRehearsalRuntime({
        operation: ++rehearsalRenderOperationRef.current,
        task: async (control) => {
          const rendered = await renderTransitionRehearsal(sourceBuffer, targetBuffer, rehearsalDsp, {
            sourceCueSeconds,
            preRollSeconds,
            postRollSeconds,
            outputSampleRate: sampleRate
          });
          if (!control.mayContinue()) return rendered;
          if (!pairStillCurrent() || playbackRecoveryLockedRef.current) {
            throw new DOMException("Rehearsal authority changed", "AbortError");
          }
          await engine.resume();
          if (!control.mayContinue()) return rendered;
          if (!pairStillCurrent() || playbackRecoveryLockedRef.current) {
            throw new DOMException("Rehearsal authority changed", "AbortError");
          }
          return rendered;
        }
      });
      rehearsalRenderRuntimeRef.current = runtime;
      const settlement = await runtime.settlement;
      if (rehearsalRenderRuntimeRef.current !== runtime) return;
      rehearsalRenderRuntimeRef.current = null;
      rehearsalPreparationOwnedRef.current = false;
      if (transitionRehearsalSettlementOpensCircuit(settlement.outcome)) {
        rehearsalGenerationRef.current += 1;
        rehearsalCircuitOpenRef.current = true;
        setRehearsalCircuitOpen(true);
        refreshPlaybackRecoveryLock();
        setRehearsalActive(false);
        setRehearsalStatus({
          state: "blocked",
          message: "The local rehearsal preparation did not finish. New playback is locked until Mazzy reloads."
        });
        window.requestAnimationFrame(() => rehearsalAlertRef.current?.focus?.());
        return;
      }
      if (settlement.outcome === "cancelled") {
        rehearsalGenerationRef.current += 1;
        refreshPlaybackRecoveryLock();
        setRehearsalActive(false);
        setRehearsalStatus({ state: "stopped", message: "Preview preparation cancelled. Nothing was saved." });
        return;
      }
      if (settlement.outcome === "failed") {
        refreshPlaybackRecoveryLock();
        setRehearsalActive(false);
        setRehearsalStatus({ state: "error", message: "The transition preview could not be rendered." });
        return;
      }
      const rendered = settlement.value;
      if (!pairStillCurrent() || playbackRecoveryLockedRef.current) {
        refreshPlaybackRecoveryLock();
        setRehearsalStatus({ state: "stopped", message: "Preview preparation stopped because playback authority changed." });
        return;
      }
      rehearsalCancelRef.current = engine.playProtectedPreview(rendered.preview, () => {
        if (rehearsalGenerationRef.current !== generation) return;
        rehearsalCancelRef.current = null;
        refreshPlaybackRecoveryLock();
        setRehearsalActive(false);
        setRehearsalStatus({ state: "complete", message: "Stereo transition rehearsal finished. Nothing was saved." });
      });
      refreshPlaybackRecoveryLock();
      setPartySoundStopStatus(null);
      audioOutputWatchArmedRef.current = true;
      setRehearsalActive(true);
      setRehearsalStatus({
        state: rendered.quality.passed ? "playing" : "warning",
        message: rendered.quality.passed
          ? `${transitionLabel(preview.plan.template)} · stereo pre-master rehearsal · listen to judge the handoff`
          : `Basic render warning · ${rendered.quality.reasons[0]}`
      });
    } catch {
      if (rehearsalGenerationRef.current !== generation) return;
      rehearsalPreparationOwnedRef.current = false;
      rehearsalRenderRuntimeRef.current = null;
      refreshPlaybackRecoveryLock();
      setRehearsalActive(false);
      setRehearsalStatus({ state: "error", message: "The transition preview could not be rendered." });
    } finally {
      if (rehearsalRenderRuntimeRef.current == null && rehearsalGenerationRef.current === generation) {
        rehearsalPreparationOwnedRef.current = false;
      }
      if (rehearsalGenerationRef.current !== generation) {
        setRehearsalStatus((current) => current?.state === "cancelling"
          ? { state: "stopped", message: "Preview preparation cancelled. Nothing was saved." }
          : current);
      }
    }
  };

  useEffect(() => {
    const updatePreview = () => {
      const next = planCurrentPair();
      setPairPreview((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    updatePreview();
    const timer = window.setInterval(updatePreview, 750);
    return () => window.clearInterval(timer);
  }, [masterDeck, loadedByDeck, library, autoMixing]);

  const currentArmPairIdentity = (runtime) => {
    const sourceSnapshot = runtime.sourceRef.current?.getDeckSnapshot?.();
    const targetSnapshot = runtime.targetRef.current?.getDeckSnapshot?.();
    const sourceLoad = partyLoadByDeckRef.current[runtime.lease.sourceDeck];
    const targetLoad = partyLoadByDeckRef.current[runtime.lease.targetDeck];
    return {
      sourceDeck: runtime.lease.sourceDeck,
      targetDeck: runtime.lease.targetDeck,
      sourceTrackId: sourceSnapshot?.trackId ?? runtime.sourceAudio.getTrackId(),
      targetTrackId: targetSnapshot?.trackId ?? runtime.targetAudio.getTrackId(),
      sourceLoadKey: sourceLoad ? `${sourceLoad.trackOrdinal}:${sourceLoad.loadOrdinal}` : null,
      targetLoadKey: targetLoad ? `${targetLoad.trackOrdinal}:${targetLoad.loadOrdinal}` : null
    };
  };

  const cleanupTransitionArmAudio = (runtime) => {
    let cleanupConfirmed = true;
    let pair;
    try {
      pair = currentArmPairIdentity(runtime);
    } catch {
      cleanupConfirmed = false;
      pair = {
        sourceTrackId: null,
        targetTrackId: null,
        sourceLoadKey: null,
        targetLoadKey: null
      };
    }
    const sourceStillOwned = pair.sourceTrackId === runtime.lease.sourceTrackId &&
      pair.sourceLoadKey === runtime.lease.sourceLoadKey;
    const targetStillOwned = pair.targetTrackId === runtime.lease.targetTrackId &&
      pair.targetLoadKey === runtime.lease.targetLoadKey;
    if (runtime.crossfadeSchedule &&
      (!activeTransitionScheduleRef.current || activeTransitionScheduleRef.current.id === runtime.crossfadeSchedule.id)) {
      const cancelCompletion = transitionCompletionCancelRef.current;
      transitionCompletionCancelRef.current = null;
      activeTransitionScheduleRef.current = null;
      try { cancelCompletion?.(); } catch { cleanupConfirmed = false; }
      try {
        if (!getAudioEngine().cancelCrossfade(
          runtime.crossfadeSchedule.id,
          runtime.eqSnapshot.sourceGain,
          runtime.eqSnapshot.targetGain
        )) cleanupConfirmed = false;
      } catch { cleanupConfirmed = false; }
    }
    if (sourceStillOwned) {
      try { runtime.sourceAudio.setGain(runtime.eqSnapshot.sourceGain); } catch { cleanupConfirmed = false; }
      try { runtime.sourceAudio.setEqBandGain("low", runtime.eqSnapshot.sourceLow); } catch { cleanupConfirmed = false; }
      try { runtime.sourceAudio.setFilterCutoff(runtime.eqSnapshot.sourceFilter); } catch { cleanupConfirmed = false; }
      try { runtime.sourceRef.current?.setEqBandGain?.("low", runtime.eqSnapshot.sourceLow); } catch { /* UI sync is optional. */ }
      try { runtime.sourceRef.current?.setFilterCutoff?.(runtime.eqSnapshot.sourceFilter); } catch { /* UI sync is optional. */ }
    }
    if (targetStillOwned) {
      try { runtime.targetAudio.setGain(runtime.eqSnapshot.targetGain); } catch { cleanupConfirmed = false; }
      try { runtime.targetAudio.setEqBandGain("low", runtime.eqSnapshot.targetLow); } catch { cleanupConfirmed = false; }
      try { runtime.targetAudio.setFilterCutoff(runtime.eqSnapshot.targetFilter); } catch { cleanupConfirmed = false; }
      try { runtime.targetAudio.pause(); } catch { cleanupConfirmed = false; }
      try { runtime.targetRef.current?.setEqBandGain?.("low", runtime.eqSnapshot.targetLow); } catch { /* UI sync is optional. */ }
      try { runtime.targetRef.current?.setFilterCutoff?.(runtime.eqSnapshot.targetFilter); } catch { /* UI sync is optional. */ }
    }
    if (!sourceStillOwned || !targetStillOwned) cleanupConfirmed = false;
    try {
      if (runtime.crossfadeSchedule && getAudioEngine().getActiveCrossfade() != null) cleanupConfirmed = false;
    } catch { cleanupConfirmed = false; }
    try {
      if (targetStillOwned && runtime.targetAudio.isActive()) cleanupConfirmed = false;
    } catch { cleanupConfirmed = false; }
    return { sourceStillOwned, targetStillOwned, cleanupConfirmed };
  };

  const settleTransitionArmRuntime = (runtime, outcome) => {
    if (!runtime || runtime.settled || !ownsAutoPilotArmLease(transitionArmLeaseRef.current?.lease, runtime.lease)) {
      return false;
    }
    // Revoke exact arm authority before any timer, node-disconnect, DSP, or
    // adapter cleanup that may throw. Failed cleanup can lock recovery, but it
    // must never leave an un-clearable settled lease behind.
    runtime.settled = true;
    transitionArmLeaseRef.current = null;
    transitionArmGenerationRef.current += 1;
    transitionArmRef.current = false;
    setAutoMixArming(false);
    let cleanupConfirmed = true;
    try { if (runtime.timeoutId) window.clearTimeout(runtime.timeoutId); }
    catch { cleanupConfirmed = false; }
    const cancelClockDeadline = runtime.clockDeadlineCancel;
    runtime.timeoutId = 0;
    runtime.clockDeadlineCancel = null;
    try { cancelClockDeadline?.(); } catch { cleanupConfirmed = false; }

    let sourceStillOwned = false;
    try { sourceStillOwned = currentArmPairIdentity(runtime).sourceTrackId === runtime.lease.sourceTrackId; }
    catch { /* Failure below becomes an explicit recovery lock. */ }
    if (outcome !== "scheduled") {
      const audioCleanup = cleanupTransitionArmAudio(runtime);
      sourceStillOwned = audioCleanup.sourceStillOwned;
      cleanupConfirmed = cleanupConfirmed && audioCleanup.cleanupConfirmed;
      if (autoPilotTransitionKeyRef.current === runtime.lease.transitionKey) {
        autoPilotTransitionKeyRef.current = null;
      }
      setAutoMixing(false);
      setAutoMixBeats(0);
      if (!cleanupConfirmed) {
        transitionCompletionUncertainRef.current = true;
        setTransitionCompletionUncertain(true);
        refreshPlaybackRecoveryLock();
      }
    }

    const countsAsFailure = runtime.origin === "autopilot" &&
      (outcome === "failed" || outcome === "timed-out") && sourceStillOwned;
    let pauseRequired = false;
    if (outcome === "scheduled") {
      consecutiveAutoPilotArmFailuresRef.current = 0;
      setAutoPilotIntervention(null);
    } else if (countsAsFailure) {
      let sourceSnapshot = null;
      try { sourceSnapshot = runtime.sourceRef.current?.getDeckSnapshot?.(); }
      catch { cleanupConfirmed = false; }
      const remainingSeconds = Math.max(0, (
        Number(sourceSnapshot?.durationSeconds ?? 0) - Number(sourceSnapshot?.positionSeconds ?? 0)
      ) / Math.max(Number(sourceSnapshot?.playbackRate ?? 1), 0.001));
      const failures = ++consecutiveAutoPilotArmFailuresRef.current;
      pauseRequired = !cleanupConfirmed ||
        decideAutoPilotArmFailure({ consecutiveFailures: failures, sourceRemainingSeconds: remainingSeconds }) === "pause";
    }

    if (runtime.traceStarted) {
      recordPartyEvent({
        type: "arm-settled",
        operation: runtime.lease.operation,
        outcome,
        pauseRequired
      });
    }

    if (pauseRequired && autoPilotEnabledRef.current) {
      const engine = getAudioEngine();
      const now = engine.clock.now();
      partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
      setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
      autoPilotEnabledRef.current = false;
      setAutoPilotEnabled(false);
      finalTrackRef.current = null;
      setPartyEndingFinalTrack(false);
      setAutoPilotChoice({ trackId: null, reason: "Transition preparation failed twice. The current song keeps playing." });
      showAutoPilotArmIntervention(outcome === "timed-out" ? "transition-arm-timeout" : "transition-arm-failed");
      pausePartyDiagnostic("transition-arm");
      void partyWakeLockRef.current?.release?.();
      showToast("Party paused · the next transition could not be prepared safely · the current song keeps playing");
    } else if (countsAsFailure) {
      showToast("The transition was not ready · Mazzy will retry once");
    }
    return true;
  };

  const cancelCurrentTransitionArm = () => {
    const runtime = transitionArmLeaseRef.current;
    if (!runtime) return false;
    return settleTransitionArmRuntime(runtime, "cancelled");
  };

  const scheduleTransitionArmExpiry = (runtime) => {
    const check = () => {
      if (!ownsAutoPilotArmLease(transitionArmLeaseRef.current?.lease, runtime.lease)) return;
      const engine = getAudioEngine();
      const now = engine.clock.now();
      if (!runtime.sourceRef.current?.isPlaying?.() ||
        libraryMutationBusyRef.current ||
        (runtime.origin === "autopilot" && (!autoPilotEnabledRef.current || playbackRecoveryLockedRef.current))) {
        settleTransitionArmRuntime(runtime, "cancelled");
        return;
      }
      const state = inspectAutoPilotArmLease({
        current: transitionArmLeaseRef.current?.lease ?? null,
        expected: runtime.lease,
        nowSeconds: now,
        pair: currentArmPairIdentity(runtime)
      });
      if (state === "superseded") {
        settleTransitionArmRuntime(runtime, "cancelled");
        return;
      }
      if (state === "expired") {
        settleTransitionArmRuntime(runtime, "timed-out");
        return;
      }
      runtime.timeoutId = window.setTimeout(check, Math.max(25, (runtime.lease.deadlineSeconds - now) * 1_000));
    };
    try {
      runtime.clockDeadlineCancel = getAudioEngine().onAudioClockDeadline(runtime.lease.deadlineSeconds, check);
    } catch {
      check();
    }
    runtime.timeoutId = window.setTimeout(check, Math.max(25, (runtime.lease.deadlineSeconds - getAudioEngine().clock.now()) * 1_000));
  };

  const startAutoMix = async (origin = "host") => {
    if (playbackRecoveryLockedRef.current || partyFirstSongStartOwnerRef.current || libraryMutationBusyRef.current || partyCheckpointBusyRef.current || partyCheckpointWriterLostRef.current || audioRecoveryState || outputDeviceChanged || getAudioEngine().context.state !== "running") return;
    if (autoMixing || transitionArmRef.current || rehearsalActive || rehearsalPreparing ||
        rehearsalPlaybackLocked()) {
      return;
    }
    const engine = getAudioEngine();
    const sourceDeck = masterDeck;
    const targetDeck = sourceDeck === "a" ? "b" : "a";
    const sourceRef = sourceDeck === "a" ? deckARef : deckBRef;
    const targetRef = targetDeck === "a" ? deckARef : deckBRef;
    if (!sourceRef.current?.isPlaying?.()) {
      setTransitionInfo({
        active: false,
        template: "safe-fade",
        confidence: 0,
        explanation: "Start the source deck before arming Auto Mix.",
        reasons: []
      });
      return;
    }
    if (!targetRef.current?.isReady?.() || targetRef.current?.isPlaying?.()) {
      setTransitionInfo({
        active: false,
        template: "safe-fade",
        confidence: 0,
        explanation: targetRef.current?.isPlaying?.()
          ? "Stop the other deck before starting an automatic transition."
          : "Load a target track before arming Auto Mix.",
        reasons: targetRef.current?.isPlaying?.() ? ["Mazzy will not restart a deck that is already playing."] : []
      });
      return;
    }
    const plannedPair = planCurrentPair();
    if (!plannedPair.plan) return;
    const plan = plannedPair.plan;
    const minimumArmLead = plan.template === "downbeat-cut" ? 0.12 : 0.08;
    const startedAtSeconds = engine.clock.now();
    const deadlineSeconds = deriveAutoPilotArmDeadline({
      nowSeconds: startedAtSeconds,
      scheduledStartSeconds: plan.schedule.startTime,
      minimumArmLeadSeconds: minimumArmLead
    });
    if (deadlineSeconds == null) {
      if (origin === "autopilot") {
        const failedOperation = transitionArmGenerationRef.current + 1;
        transitionArmGenerationRef.current = failedOperation;
        const sourceSnapshot = sourceRef.current?.getDeckSnapshot?.();
        const remainingSeconds = Math.max(0, (
          Number(sourceSnapshot?.durationSeconds ?? 0) - Number(sourceSnapshot?.positionSeconds ?? 0)
        ) / Math.max(Number(sourceSnapshot?.playbackRate ?? 1), 0.001));
        const failures = ++consecutiveAutoPilotArmFailuresRef.current;
        const pauseRequired = decideAutoPilotArmFailure({
          consecutiveFailures: failures,
          sourceRemainingSeconds: remainingSeconds
        }) === "pause";
        if (partyTraceRecorderRef.current && partyTraceRunningRef.current) {
          recordPartyEvent({ type: "arm-started", operation: failedOperation, origin: "autopilot" });
          recordPartyEvent({
            type: "arm-settled",
            operation: failedOperation,
            outcome: "timed-out",
            pauseRequired
          });
        }
        if (pauseRequired) {
          const now = engine.clock.now();
          partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
          setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
          autoPilotEnabledRef.current = false;
          setAutoPilotEnabled(false);
          pausePartyDiagnostic("transition-arm");
          showAutoPilotArmIntervention("transition-arm-timeout");
          void partyWakeLockRef.current?.release?.();
          showToast("Party paused · not enough time remains to retry the transition safely · the current song keeps playing");
        }
      }
      return;
    }
    const armGeneration = transitionArmGenerationRef.current + 1;
    transitionArmGenerationRef.current = armGeneration;
    const sourceSnapshot = sourceRef.current?.getDeckSnapshot?.();
    const targetSnapshot = targetRef.current?.getDeckSnapshot?.();
    const sourceLoad = partyLoadByDeckRef.current[sourceDeck];
    const targetLoad = partyLoadByDeckRef.current[targetDeck];
    const sourceLoadKey = sourceLoad ? `${sourceLoad.trackOrdinal}:${sourceLoad.loadOrdinal}` : null;
    const targetLoadKey = targetLoad ? `${targetLoad.trackOrdinal}:${targetLoad.loadOrdinal}` : null;
    if (!sourceSnapshot?.trackId || !targetSnapshot?.trackId || !sourceLoadKey || !targetLoadKey) return;
    const lease = createAutoPilotArmLease({
      operation: armGeneration,
      generation: armGeneration,
      transitionKey: `${sourceLoadKey}->${targetLoadKey}`,
      sourceDeck,
      targetDeck,
      sourceTrackId: sourceSnapshot.trackId,
      targetTrackId: targetSnapshot.trackId,
      sourceLoadKey,
      targetLoadKey,
      startedAtSeconds,
      deadlineSeconds
    });
    const traceArmStarted = Boolean(partyTraceRecorderRef.current && partyTraceRunningRef.current);
    if (traceArmStarted) {
      recordPartyEvent({
        type: "arm-started",
        operation: armGeneration,
        origin: origin === "autopilot" ? "autopilot" : "host"
      });
    }
    const eqSnapshot = {
      sourceGain: Number(engine.getDeckGain(sourceDeck)),
      targetGain: Number(engine.getDeckGain(targetDeck)),
      sourceLow: Number(sourceRef.current?.getEqBandGain?.("low") ?? 0),
      targetLow: Number(targetRef.current?.getEqBandGain?.("low") ?? 0),
      sourceFilter: Number(sourceRef.current?.getDspSnapshot?.()?.filterCutoffHz ?? 20_000),
      targetFilter: Number(targetRef.current?.getDspSnapshot?.()?.filterCutoffHz ?? 20_000)
    };
    const runtime = {
      lease,
      origin: origin === "autopilot" ? "autopilot" : "host",
      sourceRef,
      targetRef,
      sourceAudio: sourceRef.current.getOwnedArmAudioHandle(),
      targetAudio: targetRef.current.getOwnedArmAudioHandle(),
      eqSnapshot,
      crossfadeSchedule: null,
      traceStarted: traceArmStarted,
      settled: false,
      timeoutId: 0,
      clockDeadlineCancel: null
    };
    transitionArmLeaseRef.current = runtime;
    transitionArmRef.current = true;
    setAutoMixArming(true);
    scheduleTransitionArmExpiry(runtime);
    const armState = () => inspectAutoPilotArmLease({
      current: transitionArmLeaseRef.current?.lease ?? null,
      expected: lease,
      nowSeconds: engine.clock.now(),
      pair: currentArmPairIdentity(runtime)
    });
    const armIsCurrent = () => !libraryMutationBusyRef.current &&
      armState() === "active" && transitionArmGenerationRef.current === armGeneration;

    setTransitionInfo({
      active: true,
      template: plan.template,
      confidence: plan.confidence,
      explanation: plan.explanation[0],
      reasons: plan.eligibility.reasons
    });
    let crossfadeSchedule = null;

    try {
      await engine.resume();
      if (!armIsCurrent()) throw new Error("The transition arm expired while audio was resuming");
      contextReadyRef.current = true;
      if (plan.template === "phrase-blend" && plan.targetBpm) {
        await targetRef.current.syncToBpm?.(plan.targetBpm);
      } else {
        await targetRef.current.releaseSyncInstant?.();
      }
      if (!armIsCurrent() || !sourceRef.current?.isPlaying?.()) {
        throw new Error("The transition arm was cancelled");
      }
      const preparedPair = planCurrentPair();
      const preparedPlan = preparedPair.plan;
      if (!preparedPlan || preparedPlan.template !== plan.template ||
        preparedPlan.fromTrackId !== plan.fromTrackId || preparedPlan.toTrackId !== plan.toTrackId ||
        !armIsCurrent()) {
        throw new Error("The transition plan changed while it was being prepared");
      }
      const minimumArmLead = preparedPlan.template === "downbeat-cut" ? 0.12 : 0.08;
      if (preparedPlan.schedule.startTime - engine.clock.now() < minimumArmLead) {
        throw new Error("The selected musical cue passed before the transition was ready");
      }
      const sourceDspSnapshot = sourceRef.current?.getDspSnapshot?.() ?? { trimDb: 0, eqDb: { low: 0, mid: 0, high: 0 } };
      const targetDspSnapshot = targetRef.current?.getDspSnapshot?.() ?? { trimDb: 0, eqDb: { low: 0, mid: 0, high: 0 } };
      const transitionDsp = compileTransitionDsp(preparedPlan, {
        sourceTrimDb: sourceDspSnapshot.trimDb,
        targetTrimDb: targetDspSnapshot.trimDb,
        sourceEqDb: sourceDspSnapshot.eqDb,
        targetEqDb: targetDspSnapshot.eqDb
      });
      targetRef.current?.setGain?.(0);
      const targetStarted = await targetRef.current.playAt(
        preparedPlan.schedule.startTime,
        preparedPlan.schedule.targetCueSeconds,
        armIsCurrent
      );
      if (!targetStarted || !armIsCurrent() || !sourceRef.current?.isPlaying?.() ||
        preparedPlan.schedule.startTime - engine.clock.now() < minimumArmLead) {
        throw new Error("The transition arm was cancelled while the target was starting");
      }
      sourceRef.current?.setGain?.(1);
      if (transitionDsp.template === "phrase-blend") {
        targetRef.current?.setEqBandGain?.("low", transitionDsp.target.initialEqDb.low);
      }

      crossfadeSchedule = engine.scheduleCrossfade(
        sourceDeck,
        targetDeck,
        preparedPlan.schedule.startTime,
        preparedPlan.schedule.durationSeconds,
        {
          source: Float32Array.from(transitionDsp.source.gainCurve),
          target: Float32Array.from(transitionDsp.target.gainCurve)
        },
        armIsCurrent
      );
      runtime.crossfadeSchedule = crossfadeSchedule;
      for (const entry of transitionDsp.source.eqRamps) {
        sourceRef.current?.scheduleEqBandRamp?.(entry.band, entry.ramp.fromDb, entry.ramp.toDb,
          preparedPlan.schedule.startTime + entry.ramp.startOffsetSeconds, entry.ramp.durationSeconds);
      }
      for (const entry of transitionDsp.target.eqRamps) {
        targetRef.current?.scheduleEqBandRamp?.(entry.band, entry.ramp.fromDb, entry.ramp.toDb,
          preparedPlan.schedule.startTime + entry.ramp.startOffsetSeconds, entry.ramp.durationSeconds);
      }
      if (transitionDsp.source.filterSweep) {
        const sweep = transitionDsp.source.filterSweep;
        sourceRef.current?.scheduleFilterSweep?.(sweep.fromHz, sweep.toHz,
          preparedPlan.schedule.startTime + sweep.startOffsetSeconds, sweep.durationSeconds);
      }
      const sourceIdentity = partyLoadIdentity(sourceDeck, preparedPlan.fromTrackId);
      const targetIdentity = partyLoadIdentity(targetDeck, preparedPlan.toTrackId);
      if (sourceIdentity && targetIdentity) {
        autoPilotTransitionKeyRef.current =
          `${sourceIdentity.trackOrdinal}:${sourceIdentity.loadOrdinal}->${targetIdentity.trackOrdinal}:${targetIdentity.loadOrdinal}`;
      }
      const traceTransition = sourceIdentity && targetIdentity ? {
        transition: crossfadeSchedule.id,
        sourceTrackOrdinal: sourceIdentity.trackOrdinal,
        sourceLoadOrdinal: sourceIdentity.loadOrdinal,
        targetTrackOrdinal: targetIdentity.trackOrdinal,
        targetLoadOrdinal: targetIdentity.loadOrdinal
      } : null;
      const completionLease = createAutoPilotTransitionCompletionLease({
        operation: lease.operation,
        generation: lease.generation,
        scheduleId: crossfadeSchedule.id,
        transitionKey: lease.transitionKey,
        sourceDeck,
        targetDeck,
        sourceTrackId: lease.sourceTrackId,
        targetTrackId: lease.targetTrackId,
        sourceLoadKey: lease.sourceLoadKey,
        targetLoadKey: lease.targetLoadKey,
        registeredAtSeconds: engine.clock.now(),
        startTimeSeconds: crossfadeSchedule.startTime,
        endTimeSeconds: crossfadeSchedule.endTime
      });
      activeTransitionScheduleRef.current = {
        ...crossfadeSchedule,
        ...eqSnapshot,
        traceTransition,
        completionLease
      };
      const completionRuntime = {
        lease: completionLease,
        settled: false,
        primaryCancel: null,
        deadlineCancel: null,
        timeoutId: 0,
        attempt: null
      };
      const disposeCompletionSignals = () => {
        if (completionRuntime.timeoutId) window.clearTimeout(completionRuntime.timeoutId);
        completionRuntime.timeoutId = 0;
        const primaryCancel = completionRuntime.primaryCancel;
        const deadlineCancel = completionRuntime.deadlineCancel;
        completionRuntime.primaryCancel = null;
        completionRuntime.deadlineCancel = null;
        try { primaryCancel?.(); } catch { /* Exact runtime is already revoked. */ }
        try { deadlineCancel?.(); } catch { /* Exact runtime is already revoked. */ }
      };
      const revokeCompletionRuntime = () => {
        if (completionRuntime.settled) return false;
        completionRuntime.settled = true;
        disposeCompletionSignals();
        if (transitionCompletionRuntimeRef.current === completionRuntime) {
          transitionCompletionRuntimeRef.current = null;
        }
        if (transitionCompletionCancelRef.current === revokeCompletionRuntime) {
          transitionCompletionCancelRef.current = null;
        }
        return true;
      };
      const pauseAfterCompletionProblem = (message, uncertain, reason = "transition-completion-lost") => {
        transitionCompletionUncertainRef.current = uncertain;
        setTransitionCompletionUncertain(uncertain);
        refreshPlaybackRecoveryLock();
        autoPilotEnabledRef.current = false;
        setAutoPilotEnabled(false);
        finalTrackRef.current = null;
        setPartyEndingFinalTrack(false);
        void partyWakeLockRef.current?.release?.();
        const now = engine.clock.now();
        partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
        setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
        setAutoPilotChoice({ trackId: null, reason: message });
        pausePartyDiagnostic("transition-completion");
        showAutoPilotArmIntervention(reason);
      };
      const finishOwnedTransition = (settledBy, pauseRequired) => {
        if (!revokeCompletionRuntime()) return;
        let finishCleanupFailed = false;
        let finishSucceeded = false;
        try {
          finishSucceeded = engine.finishCrossfade(crossfadeSchedule.id);
        } catch {
          finishCleanupFailed = true;
          finishSucceeded = engine.getActiveCrossfade() == null;
        }
        if (!finishSucceeded) {
          if (traceTransition) {
            recordPartyEvent({
              type: "transition-completion-failed",
              transition: traceTransition.transition,
              reason: "ownership-lost",
              pauseRequired: true
            });
          } else if (partyTraceRecorderRef.current) {
            partyTraceRecorderRef.current.markInterrupted();
            updatePartyDiagnosticEvaluation();
          }
          pauseAfterCompletionProblem("Transition completion ownership was lost. Use Rescue or Stop All Sound before continuing.", true);
          return;
        }
        activeTransitionScheduleRef.current = null;
        autoPilotTransitionKeyRef.current = null;
        transitionCompletionUncertainRef.current = false;
        setTransitionCompletionUncertain(false);
        let cleanupFailed = finishCleanupFailed;
        try { sourceRef.current?.pause?.(); } catch { cleanupFailed = true; }
        try {
          sourceRef.current?.setEqBandGain?.("low", eqSnapshot.sourceLow);
          targetRef.current?.setEqBandGain?.("low", eqSnapshot.targetLow);
          sourceRef.current?.setFilterCutoff?.(eqSnapshot.sourceFilter);
          targetRef.current?.setFilterCutoff?.(eqSnapshot.targetFilter);
        } catch { cleanupFailed = true; }
        try { sourceRef.current?.eject?.(); } catch { cleanupFailed = true; }
        const mustPause = pauseRequired || cleanupFailed;
        if (traceTransition) {
          partyPlayedLoadsRef.current.add(`${traceTransition.targetTrackOrdinal}:${traceTransition.targetLoadOrdinal}`);
          recordPartyEvent({
            type: "transition-completed",
            transition: traceTransition.transition,
            targetTrackOrdinal: traceTransition.targetTrackOrdinal,
            targetLoadOrdinal: traceTransition.targetLoadOrdinal,
            settledBy,
            completionOutcome: cleanupFailed && pauseRequired
              ? "late-cleanup-degraded"
              : cleanupFailed
                ? "cleanup-degraded"
                : pauseRequired
                  ? "late"
                  : "on-time",
            pauseRequired: mustPause
          });
        }
        setFade(targetDeck === "b" ? 1 : 0);
        setAutoMixBeats(0);
        setAutoMixing(false);
        setTransitionInfo((current) => (current ? { ...current, active: false } : current));
        setMasterDeck(targetDeck);
        const completedTargetId = targetRef.current?.getDeckSnapshot?.()?.trackId;
        if (completedTargetId) {
          setPlayedTrackIds((current) => current.includes(completedTargetId) ? current : [...current, completedTargetId]);
        }
        if (autoPilotEnabledRef.current) setAutoPilotChoice(null);
        partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [sourceDeck]: null };
        partyCommittedPreloadByDeckRef.current = { ...partyCommittedPreloadByDeckRef.current, [targetDeck]: null };
        setLoadedByDeck((current) => ({ ...current, [sourceDeck]: null }));
        if (mustPause) {
          pauseAfterCompletionProblem(
            cleanupFailed
              ? "The next song was kept, but transition cleanup could not be fully confirmed. Autopilot is paused."
              : "The next song was kept, but transition completion arrived late. Autopilot is paused.",
            false,
            cleanupFailed ? "transition-completion-cleanup" : "transition-completion-late"
          );
        } else {
          refreshPlaybackRecoveryLock();
        }
      };
      const currentCompletionPair = () => {
        const sourceLoad = partyLoadByDeckRef.current[sourceDeck];
        const targetLoad = partyLoadByDeckRef.current[targetDeck];
        return {
          sourceDeck,
          targetDeck,
          sourceTrackId: sourceRef.current?.getDeckSnapshot?.()?.trackId ?? null,
          targetTrackId: targetRef.current?.getDeckSnapshot?.()?.trackId ?? null,
          sourceLoadKey: sourceLoad ? `${sourceLoad.trackOrdinal}:${sourceLoad.loadOrdinal}` : null,
          targetLoadKey: targetLoad ? `${targetLoad.trackOrdinal}:${targetLoad.loadOrdinal}` : null,
          targetPlaying: Boolean(targetRef.current?.isPlaying?.())
        };
      };
      let attemptTransitionCompletion;
      const scheduleWindowWake = () => {
        if (completionRuntime.settled) return;
        if (completionRuntime.timeoutId) window.clearTimeout(completionRuntime.timeoutId);
        const remainingMs = Math.max(25, (completionLease.deadlineSeconds - engine.clock.now()) * 1_000);
        completionRuntime.timeoutId = window.setTimeout(() => attemptTransitionCompletion("watchdog"), remainingMs);
      };
      attemptTransitionCompletion = (signal) => {
        if (completionRuntime.settled ||
          !ownsAutoPilotTransitionCompletionLease(transitionCompletionRuntimeRef.current?.lease, completionLease)) return;
        if (engine.context.state !== "running") {
          scheduleWindowWake();
          return;
        }
        const state = inspectAutoPilotTransitionCompletion({
          current: transitionCompletionRuntimeRef.current?.lease ?? null,
          expected: completionLease,
          nowSeconds: engine.clock.now(),
          engineSchedule: engine.getActiveCrossfade(),
          pair: currentCompletionPair(),
          signal,
          contextRunning: true,
          playbackLocked: playbackRecoveryLockedRef.current
        });
        if (state === "waiting") {
          scheduleWindowWake();
          return;
        }
        if (state === "superseded") return;
        if (state === "ownership-lost") {
          if (!revokeCompletionRuntime()) return;
          if (traceTransition) {
            recordPartyEvent({
              type: "transition-completion-failed",
              transition: traceTransition.transition,
              reason: "ownership-lost",
              pauseRequired: true
            });
          } else if (partyTraceRecorderRef.current) {
            partyTraceRecorderRef.current.markInterrupted();
            updatePartyDiagnosticEvaluation();
          }
          pauseAfterCompletionProblem("Transition completion ownership changed. Use Stop All Sound before continuing.", true);
          return;
        }
        finishOwnedTransition(signal, state === "late-ready");
      };
      completionRuntime.attempt = attemptTransitionCompletion;
      transitionCompletionRuntimeRef.current = completionRuntime;
      transitionCompletionCancelRef.current = revokeCompletionRuntime;
      completionRuntime.primaryCancel = engine.onCrossfadeComplete(
        crossfadeSchedule.id,
        () => {
          if (__MAZZY_DIAGNOSTICS_INCLUDED__) {
            try { window.dispatchEvent(new Event("mazzy:party-app-journey-crossfade-sentinel-dispatch")); }
            catch { /* Diagnostics must never gain transition authority. */ }
          }
          attemptTransitionCompletion("primary");
        }
      );
      completionRuntime.deadlineCancel = engine.onAudioClockDeadline(
        completionLease.deadlineSeconds,
        () => attemptTransitionCompletion("watchdog")
      );
      scheduleWindowWake();
      settleTransitionArmRuntime(runtime, "scheduled");
      if (traceTransition) {
        const committedTarget = partyCommittedPreloadByDeckRef.current[targetDeck];
        const targetOwnership = committedTarget?.trackOrdinal === targetIdentity.trackOrdinal &&
          committedTarget?.loadOrdinal === targetIdentity.loadOrdinal ? "autopilot" : "host";
        recordPartyEvent({
          type: "transition-scheduled",
          ...traceTransition,
          ownership: targetOwnership,
          template: preparedPlan.template
        });
      } else if (partyTraceRecorderRef.current) {
        partyTraceRecorderRef.current.markInterrupted();
        updatePartyDiagnosticEvaluation();
      }
      setAutoMixing(true);

      const uiTick = () => {
        const currentTime = engine.clock.now();
        if (preparedPlan.lengthBeats) {
          const transitionProgress = Math.min(
            Math.max((currentTime - preparedPlan.schedule.startTime) / preparedPlan.schedule.durationSeconds, 0),
            1
          );
          setAutoMixBeats(Math.ceil(preparedPlan.lengthBeats * (1 - transitionProgress)));
        } else {
          setAutoMixBeats(Math.max(0, crossfadeSchedule.endTime - currentTime));
        }

        const t = Math.min(
          Math.max((currentTime - preparedPlan.schedule.startTime) / preparedPlan.schedule.durationSeconds, 0),
          1
        );
        setFade(sourceDeck === "a" ? t : 1 - t);

        if (currentTime < crossfadeSchedule.endTime) {
          autoMixCountdownFrameRef.current = requestAnimationFrame(uiTick);
        }
      };
      autoMixCountdownFrameRef.current = requestAnimationFrame(uiTick);
    } catch (_err) {
      if (!ownsAutoPilotArmLease(transitionArmLeaseRef.current?.lease, lease)) return;
      const noLongerAuthorized = !sourceRef.current?.isPlaying?.() ||
        (runtime.origin === "autopilot" && (!autoPilotEnabledRef.current || playbackRecoveryLockedRef.current));
      const outcome = noLongerAuthorized
        ? "cancelled"
        : armState() === "expired"
          ? "timed-out"
          : armIsCurrent() ? "failed" : "cancelled";
      settleTransitionArmRuntime(runtime, outcome);
      setTransitionInfo({
        active: false,
        template: plan.template,
        confidence: 0,
        explanation: "The transition could not be armed safely.",
        reasons: plan.eligibility.reasons
      });
    }
  };

  const rescueTransition = () => {
    const engine = getAudioEngine();
    const schedule = activeTransitionScheduleRef.current;
    if (!schedule) return;
    const failRescue = (message) => {
      cancelAnimationFrame(autoMixCountdownFrameRef.current);
      transitionCompletionUncertainRef.current = true;
      setTransitionCompletionUncertain(true);
      refreshPlaybackRecoveryLock();
      autoPilotEnabledRef.current = false;
      setAutoPilotEnabled(false);
      void partyWakeLockRef.current?.release?.();
      const now = engine.clock.now();
      partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
      setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
      pausePartyDiagnostic("transition-completion");
      showAutoPilotArmIntervention("transition-completion-lost");
      setPartySoundStopStatus({ type: "error", message });
    };
    const completionLease = schedule.completionLease;
    const sourceRefForIdentity = schedule.source === "a" ? deckARef : deckBRef;
    const targetRefForIdentity = schedule.target === "a" ? deckARef : deckBRef;
    const sourceLoadForIdentity = partyLoadByDeckRef.current[schedule.source];
    const targetLoadForIdentity = partyLoadByDeckRef.current[schedule.target];
    const exactPairOwned = Boolean(completionLease &&
      sourceRefForIdentity.current?.getDeckSnapshot?.()?.trackId === completionLease.sourceTrackId &&
      targetRefForIdentity.current?.getDeckSnapshot?.()?.trackId === completionLease.targetTrackId &&
      sourceLoadForIdentity && `${sourceLoadForIdentity.trackOrdinal}:${sourceLoadForIdentity.loadOrdinal}` === completionLease.sourceLoadKey &&
      targetLoadForIdentity && `${targetLoadForIdentity.trackOrdinal}:${targetLoadForIdentity.loadOrdinal}` === completionLease.targetLoadKey);
    if (!exactPairOwned) {
      failRescue("Mazzy cannot safely choose a transition deck because its exact load ownership changed. Use Stop All Sound.");
      return;
    }
    const decision = decideRescueTransition(schedule, engine.clock.now());
    const preferredKeepRef = decision.keep === "a" ? deckARef : deckBRef;
    const preferredStopRef = decision.stop === "a" ? deckARef : deckBRef;
    const keepChannel = preferredKeepRef.current?.isPlaying?.()
      ? decision.keep
      : preferredStopRef.current?.isPlaying?.()
        ? decision.stop
        : decision.keep;
    const stopChannel = keepChannel === "a" ? "b" : "a";
    const keepRef = keepChannel === "a" ? deckARef : deckBRef;
    const stopRef = stopChannel === "a" ? deckARef : deckBRef;
    const completionCancel = transitionCompletionCancelRef.current;
    transitionCompletionCancelRef.current = null;
    transitionCompletionRuntimeRef.current = null;
    let cleanupFailed = false;
    try { completionCancel?.(); } catch { cleanupFailed = true; }
    let engineCancellationConfirmed = false;
    try {
      engineCancellationConfirmed = engine.cancelCrossfade(
        schedule.id,
        keepChannel === schedule.source ? 1 : 0,
        keepChannel === schedule.target ? 1 : 0
      );
    } catch { cleanupFailed = true; }
    if (!engineCancellationConfirmed) {
      try {
        engine.setDeckGain(keepChannel, 1);
        engine.setDeckGain(stopChannel, 0);
      } catch { cleanupFailed = true; }
    }
    const sourceRef = schedule.source === "a" ? deckARef : deckBRef;
    const targetRef = schedule.target === "a" ? deckARef : deckBRef;
    try {
      sourceRef.current?.setEqBandGain?.("low", schedule.sourceLow ?? 0);
      targetRef.current?.setEqBandGain?.("low", schedule.targetLow ?? 0);
      sourceRef.current?.setFilterCutoff?.(schedule.sourceFilter ?? 20_000);
      targetRef.current?.setFilterCutoff?.(schedule.targetFilter ?? 20_000);
    } catch { cleanupFailed = true; }
    try { stopRef.current?.pause?.(); } catch { cleanupFailed = true; }
    try { stopRef.current?.eject?.(); } catch { cleanupFailed = true; }
    if (engine.getActiveCrossfade() != null || stopRef.current?.isPlaying?.() || !keepRef.current?.isPlaying?.()) {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      failRescue("Mazzy could not confirm the automatic transition stopped. Use Stop All Sound; use system/device mute if sound remains.");
      return;
    }

    // Audio and exact load ownership are settled before the diagnostic or UI
    // records the Rescue as complete.
    cancelAnimationFrame(autoMixCountdownFrameRef.current);
    transitionArmGenerationRef.current += 1;
    activeTransitionScheduleRef.current = null;
    transitionCompletionUncertainRef.current = false;
    setTransitionCompletionUncertain(false);
    refreshPlaybackRecoveryLock();
    autoPilotTransitionKeyRef.current = null;
    partyCommittedPreloadByDeckRef.current = {
      ...partyCommittedPreloadByDeckRef.current,
      [schedule.target]: null
    };
    partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [stopChannel]: null };
    setLoadedByDeck((current) => ({ ...current, [stopChannel]: null }));
    if (schedule.traceTransition) {
      if (keepChannel === schedule.target) {
        partyPlayedLoadsRef.current.add(`${schedule.traceTransition.targetTrackOrdinal}:${schedule.traceTransition.targetLoadOrdinal}`);
      }
      recordPartyEvent({
        type: "transition-rescued",
        transition: schedule.traceTransition.transition,
        kept: keepChannel === schedule.target ? "target" : "source"
      });
    }
    autoPilotEnabledRef.current = false;
    partyCheckpointPauseReasonRef.current = "rescue";
    setAutoPilotEnabled(false);
    void partyWakeLockRef.current?.release?.();
    pausePartyDiagnostic("rescue");
    finalTrackRef.current = null;
    partySessionClockRef.current = pausePartySessionClock(
      partySessionClockRef.current,
      engine.clock.now()
    );
    setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, engine.clock.now()));
    setAutoMixing(false);
    transitionArmRef.current = false;
    setAutoMixArming(false);
    setAutoMixBeats(0);
    setMasterDeck(keepChannel);
    setFade(keepChannel === "a" ? 0 : 1);
    setTransitionInfo((current) => ({
      active: false,
      template: current?.template ?? "safe-fade",
      confidence: 0,
      explanation: `Rescue kept Deck ${keepChannel.toUpperCase()} playing and stopped the other deck.`,
      reasons: ["Party Autopilot is paused until you start it again."]
    }));
    if (keepChannel === schedule.target) {
      const retainedTargetId = completionLease.targetTrackId;
      if (retainedTargetId) {
        setPlayedTrackIds((current) => current.includes(retainedTargetId) ? current : [...current, retainedTargetId]);
      }
    }
    showToast(`Rescue complete · Deck ${keepChannel.toUpperCase()} kept playing`);
  };

  const stopAllSound = () => {
    invalidatePartyCheckpointClaim("Stop All Sound cancelled the saved-plan restore. Reload Mazzy to review recovery before continuing.");
    cancelPartyFirstSongStart({ message: "Starting cancelled by Stop All Sound." });
    const membershipCleanupPendingAtStart = Boolean(libraryMembershipDeckCleanupRef.current);
    const engine = getAudioEngine();
    let deckAStopConfirmed = false;
    let deckBStopConfirmed = false;
    let pendingTransitionCancellation = null;
    setPartySoundStopLocked(true);
    const result = runPartyStopAllSound((step) => {
      switch (step) {
        case "lock-new-starts":
          advancePartyAutopilotCoordinatorEpoch();
          partySoundStopInProgressRef.current = true;
          autoPilotEnabledRef.current = false;
          refreshPlaybackRecoveryLock();
          break;
        case "cancel-preload": { // Exact pending target only; committed plans stay intact.
          settleAutoPilotPreloadForPause("superseded");
          if (!cancelPartyFirstSongLoad({ keepStatus: false })) {
            throw new Error("first-song load cleanup is unverified");
          }
          break;
        }
        case "cancel-transition-arm": {
          transitionArmGenerationRef.current += 1;
          const hadArm = Boolean(transitionArmLeaseRef.current || transitionArmRef.current);
          if (transitionArmLeaseRef.current) cancelCurrentTransitionArm();
          transitionArmRef.current = false;
          setAutoMixArming(false);
          if (hadArm && (transitionArmLeaseRef.current || transitionArmRef.current)) {
            throw new Error("transition arm still owns audio");
          }
          break;
        }
        case "cancel-active-transition": { // Restore source ownership without consuming the handoff.
          const schedule = activeTransitionScheduleRef.current;
          const activeEngineSchedule = engine.getActiveCrossfade();
          const completionCancel = transitionCompletionCancelRef.current;
          const stableDeck = schedule?.source ?? activeEngineSchedule?.source ?? masterDeck;

          // Revoke every completion authority before any Web Audio or UI call
          // that may fail. A stale callback can no longer consume the target.
          transitionCompletionCancelRef.current = null;
          activeTransitionScheduleRef.current = null;
          autoPilotTransitionKeyRef.current = null;
          cancelAnimationFrame(autoMixCountdownFrameRef.current);

          let cleanupFailed = false;
          try { completionCancel?.(); } catch { cleanupFailed = true; }
          if (activeEngineSchedule) {
            try {
              const cancelled = engine.cancelCrossfade(
                activeEngineSchedule.id,
                activeEngineSchedule.source === stableDeck ? 1 : 0,
                activeEngineSchedule.target === stableDeck ? 1 : 0
              );
              if (!cancelled) cleanupFailed = true;
            } catch { cleanupFailed = true; }
          }
          try {
            engine.setDeckGain(stableDeck, 1);
            engine.setDeckGain(stableDeck === "a" ? "b" : "a", 0);
          } catch { cleanupFailed = true; }
          if (schedule) {
            const sourceRef = schedule.source === "a" ? deckARef : deckBRef;
            const targetRef = schedule.target === "a" ? deckARef : deckBRef;
            const completionLease = schedule.completionLease;
            const targetLoad = partyLoadByDeckRef.current[schedule.target];
            const exactTargetPreserved = Boolean(completionLease &&
              targetRef.current?.getDeckSnapshot?.()?.trackId === completionLease.targetTrackId &&
              targetLoad && `${targetLoad.trackOrdinal}:${targetLoad.loadOrdinal}` === completionLease.targetLoadKey);
            try {
              sourceRef.current?.setEqBandGain?.("low", schedule.sourceLow ?? 0);
              targetRef.current?.setEqBandGain?.("low", schedule.targetLow ?? 0);
              sourceRef.current?.setFilterCutoff?.(schedule.sourceFilter ?? 20_000);
              targetRef.current?.setFilterCutoff?.(schedule.targetFilter ?? 20_000);
            } catch { cleanupFailed = true; }
            if (schedule.traceTransition) {
              pendingTransitionCancellation = {
                transition: schedule.traceTransition.transition,
                targetPreserved: exactTargetPreserved
              };
            }
            if (!exactTargetPreserved && schedule.traceTransition) {
              const committedTarget = partyCommittedPreloadByDeckRef.current[schedule.target];
              if (committedTarget?.trackOrdinal === schedule.traceTransition.targetTrackOrdinal &&
                committedTarget?.loadOrdinal === schedule.traceTransition.targetLoadOrdinal) {
                partyCommittedPreloadByDeckRef.current = {
                  ...partyCommittedPreloadByDeckRef.current,
                  [schedule.target]: null
                };
              }
            }
          }
          setMasterDeck(stableDeck);
          setFade(stableDeck === "a" ? 0 : 1);
          setAutoMixing(false);
          setAutoMixBeats(0);
          if (schedule) {
            setTransitionInfo({
              active: false,
              template: transitionInfo?.template ?? "safe-fade",
              confidence: 0,
              explanation: "All sound stopped. The automatic transition was cancelled without consuming the next song.",
              reasons: ["The party plan is paused until the host starts playback again."]
            });
          }
          if (cleanupFailed || engine.getActiveCrossfade()) {
            throw new Error("transition audio could not be fully verified");
          }
          break;
        }
        case "cancel-auxiliary-audio":
          stopOrCancelRehearsal("Preview cancellation is finishing after Stop All Sound. Nothing was saved.");
          break;
        case "stop-deck-a":
          if (!deckARef.current?.stopAllSound) throw new Error("Deck A stop owner is unavailable");
          deckAStopConfirmed = deckARef.current.stopAllSound()?.auxiliaryStopped === true &&
            !deckARef.current.isPlaying?.();
          if (!deckAStopConfirmed) throw new Error("Deck A is still active");
          break;
        case "stop-deck-b":
          if (!deckBRef.current?.stopAllSound) throw new Error("Deck B stop owner is unavailable");
          deckBStopConfirmed = deckBRef.current.stopAllSound()?.auxiliaryStopped === true &&
            !deckBRef.current.isPlaying?.();
          if (!deckBStopConfirmed) throw new Error("Deck B is still active");
          break;
        case "pause-party-session": { // Preserve queue/history/checkpoint; revoke runtime authority only.
          const now = engine.clock.now();
          partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
          setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
          setAutoPilotEnabled(false);
          finalTrackRef.current = null;
          setPartyEndingFinalTrack(false);
          setAutoPilotChoice(null);
          setShowPartyReadiness(false);
          partyCheckpointPauseReasonRef.current = "host-paused";
          if (!pendingTransitionCancellation) pausePartyDiagnostic("stop-all-sound");
          break;
        }
        case "release-wake-lock":
          void partyWakeLockRef.current?.release?.();
          break;
      }
    });
    const membershipDeckCleanupConfirmed = retryMembershipDeckCleanupAfterStop();
    const verifiedStopped = result.passed && membershipDeckCleanupConfirmed && verifyPartyStopAllSound({
      deckAStopped: deckAStopConfirmed && Boolean(deckARef.current?.stopAllSound && !deckARef.current?.isPlaying?.()),
      deckBStopped: deckBStopConfirmed && Boolean(deckBRef.current?.stopAllSound && !deckBRef.current?.isPlaying?.()),
      crossfadeCleared: !engine.getActiveCrossfade(),
      transitionAuthorityCleared: !activeTransitionScheduleRef.current && !transitionCompletionCancelRef.current && !transitionCompletionRuntimeRef.current,
      preloadAuthorityCleared: !autoPilotPreloadLeaseRef.current,
      armAuthorityCleared: !transitionArmLeaseRef.current && !transitionArmRef.current,
      auxiliaryAuthorityCleared: !rehearsalCancelRef.current
    });
    if (verifiedStopped && pendingTransitionCancellation) {
      recordPartyEvent({
        type: "transition-cancelled",
        transition: pendingTransitionCancellation.transition,
        reason: "stop-all-sound",
        targetPreserved: pendingTransitionCancellation.targetPreserved
      });
      pausePartyDiagnostic("stop-all-sound");
    } else if (!verifiedStopped && pendingTransitionCancellation && partyTraceRecorderRef.current) {
      partyTraceRecorderRef.current.markInterrupted();
      updatePartyDiagnosticEvaluation();
    }
    partySoundStopInProgressRef.current = !verifiedStopped;
    if (verifiedStopped && !libraryMembershipDeckCleanupRef.current) {
      transitionCompletionUncertainRef.current = false;
      setTransitionCompletionUncertain(false);
      if (membershipCleanupPendingAtStart) {
        setAutoPilotIntervention((current) => current?.reason === "library-membership-cleanup" ? null : current);
      }
      setPartyFirstSongLoadStatus((current) => shouldClearPartyFirstSongStatusAfterStop({
        verifiedStopped,
        status: current?.state ?? null
      }) ? null : current);
    }
    setPartySoundStopLocked(!verifiedStopped);
    refreshPlaybackRecoveryLock();
    setPartySoundStopStatus(verifiedStopped
      ? { type: "success", message: membershipCleanupPendingAtStart
        ? "All sound stopped. Removed-song cleanup is confirmed; the saved local music change remains."
        : "All sound stopped. The party plan is paused. Stop All Sound did not change saved local music." }
      : { type: "error", message: "Mazzy could not confirm every sound stopped; retry and use system/device mute if sound remains." });
  };

  useEffect(() => {
    if (!autoPilotEnabled) {
      if (transitionArmLeaseRef.current?.origin === "autopilot") cancelCurrentTransitionArm();
      settleAutoPilotPreloadForPause("superseded");
      autoPilotTransitionKeyRef.current = null;
      setAutoPilotChoice(null);
      return undefined;
    }
    let cancelled = false;
    const handleCoordinatorFailure = (ticket, phase) => {
      if (!autoPilotEnabledRef.current) return;
      const claim = claimPartyAutopilotTickFailure(
        partyAutopilotTickBoundaryRef.current,
        ticket
      );
      partyAutopilotTickBoundaryRef.current = claim.boundary;
      if (!claim.claimed) return;
      autoPilotEnabledRef.current = false;

      const activeTransition = activeTransitionScheduleRef.current;
      const preloadCleanup = settleAutoPilotPreloadForPause("failed");
      let armCleanupConfirmed = preloadCleanup.cleanupConfirmed;
      try {
        const armRuntime = transitionArmLeaseRef.current;
        if (armRuntime && !cancelCurrentTransitionArm()) armCleanupConfirmed = false;
      } catch { armCleanupConfirmed = false; }
      if (transitionCompletionUncertainRef.current) armCleanupConfirmed = false;
      if (activeTransition) {
        const cancelCompletion = transitionCompletionCancelRef.current;
        transitionCompletionCancelRef.current = null;
        try { cancelCompletion?.(); } catch { /* The uncertainty lock below remains authoritative. */ }
      }
      recordPartyEvent({
        type: "coordinator-failed",
        operation: ticket.operation,
        phase,
        pauseRequired: true
      });
      setAutoPilotEnabled(false);
      finalTrackRef.current = null;
      setPartyEndingFinalTrack(false);
      setAutoPilotChoice(null);
      partyCheckpointPauseReasonRef.current = "safety";
      if (activeTransition || !armCleanupConfirmed) {
        transitionCompletionUncertainRef.current = true;
        setTransitionCompletionUncertain(true);
        refreshPlaybackRecoveryLock();
      }
      pausePartyClockFailClosed();
      pausePartyDiagnostic("coordinator-failure");
      try { void partyWakeLockRef.current?.release?.(); } catch { /* Autopilot authority is already revoked. */ }
      showAutoPilotArmIntervention(!preloadCleanup.cleanupConfirmed
        ? "preload-cleanup-uncertain"
        : activeTransition || !armCleanupConfirmed
          ? "coordinator-failure-transition"
          : "coordinator-failure");
    };
    const pauseForPreloadSafety = (now, reason, message) => {
      advancePartyAutopilotCoordinatorEpoch();
      partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
      setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
      autoPilotEnabledRef.current = false;
      setAutoPilotEnabled(false);
      finalTrackRef.current = null;
      setPartyEndingFinalTrack(false);
      setAutoPilotChoice(null);
      partyCheckpointPauseReasonRef.current = "safety";
      pausePartyDiagnostic(reason);
      void partyWakeLockRef.current?.release?.();
      showToast(message);
    };
    const supersedePreloadLease = (lease, now) => {
      if (!ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, lease)) return false;
      const cleanup = settleAutoPilotPreloadForPause("superseded");
      if (!cleanup.cleanupConfirmed) {
        pauseForPreloadSafety(
          now,
          "host-control",
          "Party paused · Mazzy could not confirm that the old next-song load stopped · use Stop All Sound before continuing"
        );
      }
      return cleanup.claimed;
    };
    const expirePreloadLease = (lease, now) => {
      if (!ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, lease)) return false;
      const cleanup = settleAutoPilotPreloadForPause("timed-out");
      setTimedOutAutoPilotTrackIds((current) => current.includes(lease.trackId)
        ? current
        : [...current, lease.trackId]);
      const consecutiveTimeouts = ++consecutiveAutoPilotPreloadTimeoutsRef.current;
      if (!cleanup.cleanupConfirmed) {
        pauseForPreloadSafety(
          now,
          "preload-timeout",
          "Party paused · Mazzy could not confirm that the timed-out song stopped loading · use Stop All Sound before continuing"
        );
      } else if (consecutiveTimeouts >= 2) {
        pauseForPreloadSafety(
          now,
          "preload-timeout",
          "Party paused · two songs took too long to prepare · the current song keeps playing"
        );
      } else {
        showToast("A song took too long to prepare · Mazzy is trying the next one");
      }
      return true;
    };
    const tick = async (ticket, setPhase) => {
      if (cancelled || libraryMutationBusyRef.current || !autoPilotEnabledRef.current ||
        !ownsPartyAutopilotTick(partyAutopilotTickBoundaryRef.current, ticket)) return;
      const sourceDeck = masterDeck;
      const targetDeck = sourceDeck === "a" ? "b" : "a";
      const sourceRef = sourceDeck === "a" ? deckARef : deckBRef;
      const targetRef = targetDeck === "a" ? deckARef : deckBRef;
      setPhase(autoMixing ? "transition-watchdog" : "decision");
      const engine = getAudioEngine();
      const now = engine.clock.now();
      partyAutopilotLastObservedNowRef.current = now;
      sourceRef.current?.reconcilePlaybackCompletion?.(now);
      if (libraryMutationBusyRef.current || !autoPilotEnabledRef.current ||
        !ownsPartyAutopilotTick(partyAutopilotTickBoundaryRef.current, ticket)) return;
      targetRef.current?.reconcilePlaybackCompletion?.(now);
      if (libraryMutationBusyRef.current || !autoPilotEnabledRef.current ||
        !ownsPartyAutopilotTick(partyAutopilotTickBoundaryRef.current, ticket)) return;
      if (autoMixing) {
        transitionCompletionRuntimeRef.current?.attempt?.("watchdog");
        return;
      }
      const sourceSnapshot = sourceRef.current?.getDeckSnapshot?.() ?? null;
      const targetSnapshot = targetRef.current?.getDeckSnapshot?.() ?? null;
      const sourceLoad = partyLoadByDeckRef.current[sourceDeck];
      const targetLoad = partyLoadByDeckRef.current[targetDeck];
      const sourceStillOwned = () => {
        const currentSnapshot = sourceRef.current?.getDeckSnapshot?.();
        const currentLoad = partyLoadByDeckRef.current[sourceDeck];
        return Boolean(sourceRef.current?.isPlaying?.()) &&
          currentSnapshot?.trackId === sourceSnapshot?.trackId &&
          (!sourceLoad || (currentLoad?.trackOrdinal === sourceLoad.trackOrdinal &&
            currentLoad?.loadOrdinal === sourceLoad.loadOrdinal));
      };
      const sessionProgress = partySessionClockSnapshot(
        partySessionClockRef.current,
        now
      ).energyProgress;
      const decision = decideAutoPilotSessionTick({
        nowSeconds: now,
        source: {
          deck: sourceDeck,
          trackId: sourceSnapshot?.trackId ?? null,
          loadKey: sourceLoad ? `${sourceLoad.trackOrdinal}:${sourceLoad.loadOrdinal}` : null,
          ready: Boolean(sourceRef.current?.isReady?.()),
          playing: Boolean(sourceRef.current?.isPlaying?.()),
          durationSeconds: Number(sourceSnapshot?.durationSeconds ?? 0),
          positionSeconds: Number(sourceSnapshot?.positionSeconds ?? 0),
          playbackRate: Number(sourceSnapshot?.playbackRate ?? 1),
          analysis: sourceRef.current?.getAnalysisRecord?.() ?? null,
          forceSafeFadeOnly: sourceRef.current?.getLoadReadiness?.()?.safeFadeOnly === true
        },
        target: {
          deck: targetDeck,
          trackId: targetSnapshot?.trackId ?? null,
          loadKey: targetLoad ? `${targetLoad.trackOrdinal}:${targetLoad.loadOrdinal}` : null,
          ready: Boolean(targetRef.current?.isReady?.()),
          playing: Boolean(targetRef.current?.isPlaying?.()),
          durationSeconds: Number(targetSnapshot?.durationSeconds ?? 0),
          positionSeconds: Number(targetSnapshot?.positionSeconds ?? 0),
          playbackRate: Number(targetSnapshot?.playbackRate ?? 1),
          analysis: targetRef.current?.getAnalysisRecord?.() ?? null,
          forceSafeFadeOnly: targetRef.current?.getLoadReadiness?.()?.safeFadeOnly === true
        },
        queueTrackIds: queue,
        library,
        playedTrackIds,
        unavailableTrackIds: autoPilotExcludedTrackIds,
        includeRestOfLibrary: autoPilotUseLibrary,
        energyCurve: shiftEnergyCurve(partyEnergyCurve(partyEnergyProfile), partyEnergyShift),
        sessionProgress,
        preloadLease: autoPilotPreloadLeaseRef.current,
        activeTransitionKey: autoPilotTransitionKeyRef.current
      });

      if (decision.kind === "pause-source-stopped") {
        advancePartyAutopilotCoordinatorEpoch();
        autoPilotEnabledRef.current = false;
        settleAutoPilotPreloadForPause("superseded");
        setAutoPilotEnabled(false);
        pausePartyClockFailClosed();
        void partyWakeLockRef.current?.release?.();
        finalTrackRef.current = null;
        setPartyEndingFinalTrack(false);
        setAutoPilotChoice(null);
        partyCheckpointPauseReasonRef.current = "source-stopped";
        pausePartyDiagnostic("source-stopped");
        showToast("Party paused · start a deck to continue");
        return;
      }
      if (decision.kind === "wait-preload" || decision.kind === "wait-target" ||
          decision.kind === "wait-owned-transition" || decision.kind === "wait-cue") return;

      if (decision.kind === "cancel-preload-source-changed") {
        supersedePreloadLease(decision.lease, now);
        return;
      }

      if (decision.kind === "expire-preload") {
        if (!autoPilotEnabledRef.current || playbackRecoveryLockedRef.current || !sourceStillOwned()) return;
        expirePreloadLease(decision.lease, now);
        return;
      }

      if (decision.kind === "pause-preload-runway") {
        pauseForPreloadSafety(
          now,
          "preload-runway",
          "Party paused · not enough time remains to prepare another song safely · the current song keeps playing"
        );
        return;
      }

      if (decision.kind === "eject-blocked-target") {
        if (targetRef.current?.getDeckSnapshot?.()?.trackId !== decision.targetTrackId || targetRef.current?.isPlaying?.()) return;
        targetRef.current?.eject?.();
        partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [targetDeck]: null };
        setLoadedByDeck((current) => ({ ...current, [targetDeck]: null }));
        return;
      }

      if (decision.kind === "declare-final") {
          const finalIdentity = partyLoadIdentity(sourceDeck, sourceSnapshot?.trackId ?? null);
          const previousFinal = finalTrackRef.current;
          finalTrackRef.current = {
            deck: sourceDeck,
            trackId: sourceSnapshot?.trackId ?? null,
            loadOrdinal: finalIdentity?.loadOrdinal ?? null
          };
          if (finalIdentity) {
            if (previousFinal?.deck !== sourceDeck || previousFinal?.trackId !== sourceSnapshot?.trackId ||
              previousFinal?.loadOrdinal !== finalIdentity.loadOrdinal) {
              recordPartyEvent({
                type: "final-declared",
                deck: sourceDeck,
                trackOrdinal: finalIdentity.trackOrdinal,
                loadOrdinal: finalIdentity.loadOrdinal
              });
            }
          } else if (partyTraceRecorderRef.current) {
            partyTraceRecorderRef.current.markInterrupted();
            updatePartyDiagnosticEvaluation();
          }
          setPartyEndingFinalTrack(true);
          setAutoPilotChoice({
            trackId: null,
            name: "No next song — this is the final track",
            afterNextId: null,
            afterNextName: null,
            reasons: ["The session will finish when this song ends."]
          });
          return;
      }

      if (decision.kind === "preload") {
        setPhase("preload");
        const nextTrack = library.find((track) => track.id === decision.trackId);
        if (!nextTrack) return;
        const nextId = nextTrack.id;
        if (autoPilotPreloadLeaseRef.current) return;
        const preloadGeneration = ++autoPilotPreloadGenerationRef.current;
        const preloadOperation = ++partyPreloadOperationRef.current;
        const preloadTrackOrdinal = partyTrackOrdinal(nextTrack.id);
        const preloadLoadOrdinal = ++partyLoadOrdinalCounterRef.current;
        const preloadLease = Object.freeze({
          operation: preloadOperation,
          generation: preloadGeneration,
          deck: targetDeck,
          trackId: nextTrack.id,
          loadOrdinal: preloadLoadOrdinal,
          sourceTrackId: sourceSnapshot?.trackId ?? null,
          sourceLoadKey: sourceLoad ? `${sourceLoad.trackOrdinal}:${sourceLoad.loadOrdinal}` : null,
          startedAtSeconds: now,
          deadlineSeconds: decision.preloadDeadlineSeconds
        });
        const preloadLoadAuthorityKey = autoPilotPreloadLoadAuthorityKey(preloadLease);
        autoPilotPreloadLeaseRef.current = preloadLease;
        partyPendingLoadByDeckRef.current = {
          ...partyPendingLoadByDeckRef.current,
          [targetDeck]: { trackId: nextTrack.id, loadOrdinal: preloadLoadOrdinal }
        };
        const selectionSource = decision.selectionSource;
        finalTrackRef.current = null;
        setPartyEndingFinalTrack(false);
        if (partyTraceRecorderRef.current && preloadTrackOrdinal) {
          recordPartyEvent({ type: "final-revoked" });
          recordPartyEvent({
            type: "preload-started",
            operation: preloadOperation,
            generation: preloadGeneration,
            deck: targetDeck,
            trackOrdinal: preloadTrackOrdinal,
            loadOrdinal: preloadLoadOrdinal,
            selectionSource
          });
        }
        let preloadSettlementRecorded = false;
        const recordPreloadSettlement = (outcome) => {
          if (!ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, preloadLease)) return false;
          autoPilotPreloadLeaseRef.current = null;
          const pending = partyPendingLoadByDeckRef.current[targetDeck];
          if (pending?.loadOrdinal === preloadLoadOrdinal) {
            partyPendingLoadByDeckRef.current = { ...partyPendingLoadByDeckRef.current, [targetDeck]: null };
          }
          preloadSettlementRecorded = true;
          recordPartyEvent({ type: "preload-settled", operation: preloadOperation, outcome });
          return true;
        };
        try {
          const loadOutcome = await loadTrackToDeck(targetDeck, nextTrack, {
            autoPilotOwned: true,
            loadAuthorityKey: preloadLoadAuthorityKey
          });
          if (libraryMutationBusyRef.current) {
            supersedePreloadLease(preloadLease, engine.clock.now());
            return;
          }
          if (!autoPilotEnabledRef.current ||
            !ownsPartyAutopilotTick(partyAutopilotTickBoundaryRef.current, ticket)) return;
          if (!ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, preloadLease)) return;
          const settledAtSeconds = engine.clock.now();
          const loaded = loadOutcome === DECK_LOAD_OUTCOME.loaded;
          const targetSnapshot = targetRef.current?.getDeckSnapshot?.();
          const targetReadiness = targetRef.current?.getLoadReadiness?.();
          const readinessCurrent = loaded && ownsDeckLoadReadiness({
            value: targetReadiness,
            trackId: nextTrack.id,
            loadAuthorityKey: preloadLoadAuthorityKey,
            appliedTrimDb: targetRef.current?.getDspSnapshot?.()?.trimDb
          });
          const stillEligible = buildAutoPilotPlanningIds(
            queueRef.current,
            libraryRef.current,
            playedTrackIdsRef.current,
            [sourceSnapshot?.trackId],
            autoPilotUseLibrary,
            autoPilotExcludedTrackIds
          ).includes(nextTrack.id);
          const settlement = {
            loaded,
            autoPilotEnabled: autoPilotEnabledRef.current && sourceStillOwned() &&
              !playbackRecoveryLockedRef.current,
            operationCurrent: ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, preloadLease),
            readinessCurrent,
            stillEligible,
            requestedTrackId: nextTrack.id,
            targetTrackId: targetSnapshot?.trackId ?? null,
            targetPlaying: Boolean(targetRef.current?.isPlaying?.())
          };
          if (!settlement.autoPilotEnabled) {
            supersedePreloadLease(preloadLease, settledAtSeconds);
            return;
          }
          if (settlement.autoPilotEnabled &&
            !maySettleAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, preloadLease, settledAtSeconds)) {
            expirePreloadLease(preloadLease, settledAtSeconds);
            return;
          }
          consecutiveAutoPilotPreloadTimeoutsRef.current = 0;
          if (shouldCommitAutoPilotPreload(settlement)) {
            const safeFadeOnly = targetReadiness?.version === "deck-load-readiness/v1" &&
              targetReadiness.safeFadeOnly === true;
            const neutralLevel = targetReadiness?.version === "deck-load-readiness/v1" &&
              targetReadiness.levelTrim === "neutral";
            partyCommittedPreloadByDeckRef.current = {
              ...partyCommittedPreloadByDeckRef.current,
              [targetDeck]: {
                trackId: nextTrack.id,
                trackOrdinal: preloadTrackOrdinal,
                loadOrdinal: preloadLoadOrdinal
              }
            };
            recordPreloadSettlement("committed");
            setQueue((current) => current[0] === nextId ? current.slice(1) : current.filter((id) => id !== nextId));
            setAutoPilotChoice({
              trackId: nextTrack.id,
              name: nextTrack.name,
              afterNextId: decision.afterNextTrackId,
              afterNextName: libraryRef.current.find((track) => track.id === decision.afterNextTrackId)?.name ?? null,
              reasons: safeFadeOnly
                ? [
                    "Next song ready with a conservative Safe Fade.",
                    ...decision.reasons
                  ]
                : neutralLevel
                  ? ["Next song ready with current timing · no loudness trim for this play.", ...decision.reasons]
                  : decision.reasons
            });
            showToast(safeFadeOnly
              ? "Next song ready · conservative Safe Fade"
              : neutralLevel
                ? "Next song ready · no loudness trim for this play"
                : `Autopilot planned two songs ahead · ${decision.reasons[0] ?? "Queue order preserved."}`);
          } else if (shouldDiscardSettledAutoPilotPreload(settlement)) {
            recordPreloadSettlement(settlement.operationCurrent ? "discarded" : "superseded");
            targetRef.current?.eject?.();
            setLoadedByDeck((current) => ({ ...current, [targetDeck]: null }));
            partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [targetDeck]: null };
          } else {
            recordPreloadSettlement(shouldQuarantineAutoPilotLoad({
                outcome: loadOutcome,
                autoPilotEnabled: settlement.autoPilotEnabled,
                operationCurrent: settlement.operationCurrent
              }) ? "unplayable" : loaded ? "superseded" : "failed");
            if (shouldQuarantineAutoPilotLoad({
              outcome: loadOutcome,
              autoPilotEnabled: settlement.autoPilotEnabled,
              operationCurrent: settlement.operationCurrent
            })) {
              setUnavailableAutoPilotTrackIds((current) => current.includes(nextTrack.id)
                ? current
                : [...current, nextTrack.id]);
              targetRef.current?.eject?.();
              setLoadedByDeck((current) => ({ ...current, [targetDeck]: null }));
              partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [targetDeck]: null };
              showToast(`${nextTrack.name} couldn't be opened · skipped for this party`);
            }
          }
        } catch {
          if (ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, preloadLease)) {
            handleCoordinatorFailure(ticket, "preload");
          } else if (preloadSettlementRecorded) {
            autoPilotEnabledRef.current = false;
            setAutoPilotEnabled(false);
            lockUnverifiedPreloadCleanup();
            pausePartyClockFailClosed();
            pausePartyDiagnostic("coordinator-failure");
            try { void partyWakeLockRef.current?.release?.(); } catch { /* Playback remains locked. */ }
          }
        } finally {
          if (ownsAutoPilotPreloadLease(autoPilotPreloadLeaseRef.current, preloadLease)) {
            if (!preloadSettlementRecorded) {
              settleAutoPilotPreloadForPause("superseded");
            }
          }
        }
        return;
      }

      if (decision.kind !== "arm" || !sourceSnapshot || !targetSnapshot) return;
      setPhase("arm");
      const actualTargetId = targetSnapshot.trackId ?? `session-${targetDeck}`;
      setAutoPilotChoice((current) => {
        if (current?.trackId === actualTargetId) return current;
        const actualTarget = library.find((track) => track.id === targetSnapshot.trackId);
        return {
          trackId: actualTargetId,
          name: actualTarget?.name ?? targetRef.current?.getTrackName?.() ?? `Deck ${targetDeck.toUpperCase()}`,
          afterNextId: null,
          afterNextName: null,
          reasons: ["Host-selected track is loaded next.", "The later track will be planned after this handoff."]
        };
      });
      await startAutoMix("autopilot");
    };
    const runTick = () => {
      if (cancelled || !autoPilotEnabledRef.current) return;
      const issued = issuePartyAutopilotTick(partyAutopilotTickBoundaryRef.current);
      partyAutopilotTickBoundaryRef.current = issued.boundary;
      void runPartyAutopilotTickTask({
        task: (setPhase) => tick(issued.ticket, setPhase),
        onFailure: (phase) => handleCoordinatorFailure(issued.ticket, phase)
      });
    };
    runTick();
    const timer = window.setInterval(runTick, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [autoPilotEnabled, autoMixing, masterDeck, queue, library, loadedByDeck, playedTrackIds, partyEnergyProfile, partyEnergyShift, autoPilotUseLibrary, unavailableAutoPilotTrackIds, timedOutAutoPilotTrackIds]);

  useEffect(() => {
    return () => {
      // Revoke every coordinator authority synchronously before any adapter,
      // node, or disposer that may throw. Host teardown must always reach both
      // native deck shutdowns, even when auxiliary cleanup is degraded.
      const completionCancel = transitionCompletionCancelRef.current;
      const activeSchedule = activeTransitionScheduleRef.current;
      const rehearsalCancel = rehearsalCancelRef.current;
      const rehearsalRenderRuntime = rehearsalRenderRuntimeRef.current;
      const firstSongStartRuntime = partyFirstSongStartRuntimeRef.current;
      const runtime = transitionArmLeaseRef.current;
      analysisGenerationRef.current += 1;
      partyCheckpointClearOperationRef.current += 1;
      partyCheckpointClearOwnerRef.current = null;
      try { partyCheckpointClearCancelRef.current?.(); } catch { /* Storage owner is already revoked. */ }
      partyCheckpointClearCancelRef.current = null;
      partyCheckpointClaimOperationRef.current += 1;
      partyCheckpointClaimOwnerRef.current = null;
      try { partyCheckpointClaimCancelRef.current?.(); } catch { /* Storage owner is already revoked. */ }
      partyCheckpointClaimCancelRef.current = null;
      libraryMembershipEpochRef.current += 1;
      libraryMembershipOwnerRef.current = null;
      try { libraryMembershipCancelRef.current?.(); } catch { /* Membership authority is already revoked. */ }
      libraryMembershipCancelRef.current = null;
      libraryMembershipTriggerRef.current = null;
      libraryMembershipPhaseRef.current = "idle";
      libraryMembershipDeckCleanupRef.current = null;
      libraryImportPickerOwnerRef.current = null;
      libraryImportPickerFocusDeferredRef.current = false;
      libraryImportPickerBlurredRef.current = false;
      libraryImportPickerTriggerRef.current = null;
      libraryImportPickerReconcileConsumedRef.current = false;
      if (libraryImportPickerReleaseTimerRef.current != null) {
        try { window.clearTimeout(libraryImportPickerReleaseTimerRef.current); } catch { /* Host teardown continues. */ }
      }
      libraryImportPickerReleaseTimerRef.current = null;
      partyCheckpointWriteRuntimeRef.current?.halt?.();
      libraryRoutineWriteRuntimeRef.current?.halt?.();
      cancelActiveBackgroundAnalysis({ resetEnhanced: true, announceUnabortable: false });
      try { disposeAnalysisClient(); } catch { /* Host teardown continues. */ }
      try { disposeEnhancedRhythmClient(); } catch { /* Host teardown continues. */ }
      partyFirstSongLoadRef.current = null;
      partyFirstSongStartOwnerRef.current = null;
      partyFirstSongStartAuthorityKeyRef.current = null;
      partyFirstSongStartRuntimeRef.current = null;
      try { if (partyFirstSongLoadTimerRef.current) window.clearTimeout(partyFirstSongLoadTimerRef.current.id); } catch { /* Host teardown continues. */ }
      partyFirstSongLoadTimerRef.current = null;
      transitionCompletionCancelRef.current = null;
      transitionCompletionRuntimeRef.current = null;
      activeTransitionScheduleRef.current = null;
      autoPilotTransitionKeyRef.current = null;
      rehearsalCancelRef.current = null;
      rehearsalRenderRuntimeRef.current = null;
      rehearsalPreparationOwnedRef.current = false;
      rehearsalGenerationRef.current += 1;
      transitionArmLeaseRef.current = null;
      transitionArmRef.current = false;
      transitionArmGenerationRef.current += 1;
      if (runtime) runtime.settled = true;

      let engine = null;
      try { engine = getAudioEngine(); } catch { /* No shared engine was available. */ }
      try { engine?.getDeck("a")?.shutdownForHostTeardown?.(); } catch { /* Continue with Deck B. */ }
      try { engine?.getDeck("b")?.shutdownForHostTeardown?.(); } catch { /* Both shutdowns are independent. */ }
      try { void partyWakeLockRef.current?.release?.(); } catch { /* The controller effect also releases. */ }

      try { cancelAnimationFrame(autoMixCountdownFrameRef.current); } catch { /* Host teardown continues. */ }
      try { advancePartyAutopilotCoordinatorEpoch(); } catch { /* Exact refs above are already revoked. */ }
      try { completionCancel?.(); } catch { /* Exact runtime is already revoked. */ }
      try { rehearsalRenderRuntime?.revoke?.(); } catch { /* Late offline rendering is inert after unmount. */ }
      try { rehearsalCancel?.(); } catch { /* Exact rehearsal authority is already revoked. */ }
      try { firstSongStartRuntime?.revoke?.(); } catch { /* Late browser-audio settlement is inert. */ }
      try { if (runtime?.timeoutId) window.clearTimeout(runtime.timeoutId); } catch { /* Continue cleanup. */ }
      const deadlineCancel = runtime?.clockDeadlineCancel;
      if (runtime) runtime.clockDeadlineCancel = null;
      try { deadlineCancel?.(); } catch { /* Exact arm authority is already revoked. */ }
      try { if (runtime) cleanupTransitionArmAudio(runtime); } catch { /* Deck shutdown remains authoritative. */ }
      try {
        if (activeSchedule) engine?.cancelCrossfade?.(activeSchedule.id);
      } catch { /* Deck transport gates are already muted and revoked. */ }
    };
  }, []);

  const masterPeakPercent = Number.isFinite(masterMeter.peakDb)
    ? Math.max(0, Math.min(100, ((masterMeter.peakDb + 60) / 60) * 100))
    : 0;
  const sourcePartyRef = masterDeck === "a" ? deckARef : deckBRef;
  const sourcePartyReady = !!sourcePartyRef.current?.isReady?.();
  const sourcePartyPlaying = !!sourcePartyRef.current?.isPlaying?.();
  const partyFirstSongReadyOwner = partyFirstSongLoadStatus?.state === "ready"
    ? partyFirstSongLoadStatus.owner
    : null;
  const partyFirstSongActionRef = partyFirstSongReadyOwner
    ? partyFirstSongReadyOwner.deck === "a" ? deckARef : deckBRef
    : sourcePartyRef;
  const partyFirstSongActionReady = !!partyFirstSongActionRef.current?.isReady?.();
  const partyFirstSongActionPlaying = !!partyFirstSongActionRef.current?.isPlaying?.();
  const partyFirstSongOtherDeckPlaying = Boolean(partyFirstSongReadyOwner &&
    (partyFirstSongReadyOwner.deck === "a" ? deckBRef : deckARef).current?.isPlaying?.());
  const partyFirstSongActionTrack = partyFirstSongReadyOwner
    ? library.find((track) => track.id === partyFirstSongReadyOwner.trackId) ?? null
    : nowPlayingTrack;
  const partyFirstSongAutopilotBlocked = partyFirstSongBlocksAutopilotStart({
    openingOwned: Boolean(partyFirstSongLoadRef.current),
    readyOwned: Boolean(partyFirstSongReadyOwner)
  });
  const pausePartyAutopilot = () => {
    advancePartyAutopilotCoordinatorEpoch();
    autoPilotEnabledRef.current = false;
    settleAutoPilotPreloadForPause("superseded");
    setAutoPilotEnabled(false);
    try { cancelCurrentTransitionArm(); } catch { /* Preload and Autopilot authority are already revoked. */ }
    transitionArmGenerationRef.current += 1;
    pausePartyClockFailClosed();
    finalTrackRef.current = null;
    setPartyEndingFinalTrack(false);
    setShowPartyReadiness(false);
    partyCheckpointPauseReasonRef.current = "host-paused";
    pausePartyDiagnostic("host-request");
    void partyWakeLockRef.current?.release?.();
  };
  const startPartyAutopilot = async () => {
    if (playbackRecoveryLockedRef.current || partyFirstSongStartOwnerRef.current || libraryMutationBusyRef.current || partyCheckpointBusyRef.current ||
        rehearsalPlaybackLocked()) return;
    if (partyFirstSongBlocksAutopilotStart({
      openingOwned: Boolean(partyFirstSongLoadRef.current),
      readyOwned: Boolean(partyFirstSongReadyOwner)
    })) {
      setShowPartyReadiness(false);
      window.requestAnimationFrame(() => partyFirstSongPlayButtonRef.current?.focus?.());
      return;
    }
    if (audioRecoveryState || outputDeviceChanged || getAudioEngine().context.state !== "running") return;
    if (partyCheckpointRecoveryRef.current?.status === "available" && !partyCheckpointSessionIdRef.current) {
      setPartyCheckpointCardVisible(true);
      window.requestAnimationFrame(() => partyCheckpointCardRef.current?.focus?.());
      return;
    }
    if (partyCheckpointWriterLostRef.current) {
      setPartyCheckpointError("This party's recovery copy moved to another tab. Reload this tab to review the current saved plan, or continue in the other Mazzy tab.");
      return;
    }
    advancePartyAutopilotCoordinatorEpoch();
    if (partyCheckpointTerminalRef.current || !partyCheckpointSessionIdRef.current) {
      const checkpointRuntime = partyCheckpointWriteRuntimeRef.current;
      const checkpointMode = checkpointRuntime?.snapshot?.().mode ?? "running";
      if (checkpointMode !== "running" || checkpointRuntime?.reset?.() === false) {
        if (checkpointMode === "circuit-open") setPartyCheckpointWriteCircuitOpen(true);
        setPartyCheckpointError("Party recovery updates are stopped in this tab. Reload Mazzy before starting a new party.");
        window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
        return;
      }
      partyCheckpointSessionIdRef.current = crypto.randomUUID();
      partyCheckpointTerminalRef.current = false;
      partyCheckpointPauseReasonRef.current = "active-periodic";
      partyCheckpointLastFingerprintRef.current = "";
    }
    const now = getAudioEngine().clock.now();
    consecutiveAutoPilotPreloadTimeoutsRef.current = 0;
    consecutiveAutoPilotArmFailuresRef.current = 0;
    partySessionClockRef.current = startPartySessionClock(partySessionClockRef.current, now);
    startOrResumePartyDiagnostic(masterDeck);
    autoPilotEnabledRef.current = true;
    setAutoPilotEnabled(true);
    setShowPartyReadiness(false);
  };
  const resetPartyAutopilot = async () => {
    if (partyCheckpointBusyRef.current || partyFirstSongStartOwnerRef.current || libraryMutationBusyRef.current || rehearsalPlaybackLocked()) return;
    if (libraryMembershipOwnerRef.current) {
      if (libraryMembershipOwnerRef.current.kind === "import" && libraryMutationModeRef.current === "idle") {
        cancelLibraryMembershipPreparation();
      } else {
        return;
      }
    }
    if (partyCheckpointWriterLostRef.current) {
      setPartyCheckpointError("Reload this tab to review the current saved party plan before starting a new party here.");
      window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
      return;
    }
    const checkpointMode = partyCheckpointWriteRuntimeRef.current?.snapshot?.().mode ?? "running";
    if (checkpointMode !== "running") {
      if (checkpointMode === "circuit-open") setPartyCheckpointWriteCircuitOpen(true);
      setPartyCheckpointError("Party recovery updates are stopped in this tab. Reload Mazzy before starting a new party.");
      window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
      return;
    }
    if (!cancelPartyFirstSongLoad({ keepStatus: false })) return;
    advancePartyAutopilotCoordinatorEpoch();
    if (!await clearOwnedPartyCheckpoint("cleared")) return;
    cancelCurrentTransitionArm();
    if (partyTraceRecorderRef.current && !partyDiagnosticEvaluation?.status?.startsWith("valid-terminal")) {
      partyTraceRecorderRef.current.markInterrupted();
    }
    partyTraceRecorderRef.current = null;
    partyTraceRunningRef.current = false;
    partyTrackOrdinalsRef.current = new Map();
    partyLoadByDeckRef.current = { a: null, b: null };
    partyPendingLoadByDeckRef.current = { a: null, b: null };
    partyCommittedPreloadByDeckRef.current = { a: null, b: null };
    partyTrackOrdinalCounterRef.current = 0;
    partyLoadOrdinalCounterRef.current = 0;
    partyNativeCompletionOrdinalsRef.current = new Map();
    partyNativeCompletionOrdinalCounterRef.current = 0;
    partyFallbackContinuationRef.current = null;
    partyFallbackContinuationOperationRef.current = 0;
    partyPreloadOperationRef.current = 0;
    partyQueueRevisionRef.current = 0;
    partyPlayedLoadsRef.current = new Set();
    setPartyDiagnosticEvaluation(null);
    setUnavailableAutoPilotTrackIds([]);
    setTimedOutAutoPilotTrackIds([]);
    setAutoPilotIntervention(null);
    consecutiveAutoPilotPreloadTimeoutsRef.current = 0;
    consecutiveAutoPilotArmFailuresRef.current = 0;
    partySessionClockRef.current = resetPartySessionClock(
      partySessionClockRef.current,
      partyDurationMinutes * 60
    );
    setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, getAudioEngine().clock.now()));
    setPlayedTrackIds([]);
    setAutoPilotChoice(null);
    finalTrackRef.current = null;
    setPartyEndingFinalTrack(false);
    setPartyEnergyShift(0);
  };

  const restoreSavedPartyPlan = async () => {
    const recovery = partyCheckpointRecoveryRef.current;
    const checkpoint = recovery?.status === "available" ? recovery.checkpoint : null;
    if (!checkpoint || partyCheckpointBusyRef.current || partyCheckpointClaimOwnerRef.current ||
        libraryMembershipOwnerRef.current ||
        partyFirstSongLoadRef.current || partyFirstSongStartOwnerRef.current || libraryMutationBusyRef.current) return;
    if (partyCheckpointWriterLostRef.current ||
        (partyCheckpointWriteRuntimeRef.current?.snapshot?.().mode ?? "running") !== "running") {
      setPartyCheckpointWriteCircuitOpen(true);
      setPartyCheckpointError("Party recovery needs to be reloaded before this saved plan can be restored.");
      window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
      return;
    }
    if (deckARef.current?.isPlaying?.() || deckBRef.current?.isPlaying?.() || autoMixing || autoMixArming ||
        transitionArmRef.current || transitionArmLeaseRef.current || activeTransitionScheduleRef.current ||
        transitionCompletionRuntimeRef.current || transitionCompletionCancelRef.current ||
        transitionCompletionUncertainRef.current || autoPilotPreloadLeaseRef.current ||
        partyFallbackContinuationRef.current || rehearsalPlaybackLocked() ||
        partySoundStopInProgressRef.current || audioRecoveryPendingRef.current ||
        outputDevicePendingRef.current) {
      setPartyCheckpointError("Stop current audio or the transition preview before restoring the saved party plan.");
      return;
    }
    const claimOwner = createPartyCheckpointClaimOwner({
      operation: ++partyCheckpointClaimOperationRef.current,
      sessionId: checkpoint.sessionId,
      checkpointRevision: checkpoint.revision,
      previousWriterToken: checkpoint.writerToken,
      nextWriterToken: partyCheckpointWriterTokenRef.current,
      libraryEpoch: libraryStateRef.current.epoch,
      libraryRevision: libraryStateRef.current.revision
    });
    partyCheckpointClaimOwnerRef.current = claimOwner;
    partyCheckpointBusyRef.current = true;
    refreshPlaybackRecoveryLock();
    setPartyCheckpointBusy(true);
    setPartyCheckpointError("");
    const ownsClaim = () => ownsPartyCheckpointClaim(partyCheckpointClaimOwnerRef.current, claimOwner) &&
      partyCheckpointRecoveryRef.current?.status === "available" &&
      partyCheckpointRecoveryRef.current.checkpoint === checkpoint &&
      libraryStateRef.current.epoch === claimOwner.libraryEpoch &&
      libraryStateRef.current.revision === claimOwner.libraryRevision &&
      !libraryMutationBusyRef.current && !partyFirstSongLoadRef.current &&
      (partyCheckpointWriteRuntimeRef.current?.snapshot?.().mode ?? "running") === "running" &&
      !deckARef.current?.isPlaying?.() && !deckBRef.current?.isPlaying?.() &&
      !autoMixing && !autoMixArming && !transitionArmRef.current &&
      !transitionArmLeaseRef.current && !activeTransitionScheduleRef.current &&
      !transitionCompletionRuntimeRef.current && !transitionCompletionCancelRef.current &&
      !transitionCompletionUncertainRef.current && !autoPilotPreloadLeaseRef.current &&
      !partyFallbackContinuationRef.current && !rehearsalPlaybackLocked() &&
      !partySoundStopInProgressRef.current &&
      !audioRecoveryPendingRef.current && !outputDevicePendingRef.current;
    try {
      const boundedClaim = startBoundedPartyCheckpointOperation({
        ownsAuthority: ownsClaim,
        task: (signal) => claimPartySessionCheckpoint(
          checkpoint.sessionId,
          checkpoint.revision,
          checkpoint.writerToken,
          claimOwner.nextWriterToken,
          {
            signal,
            expectedLibraryState: {
              epoch: claimOwner.libraryEpoch,
              revision: claimOwner.libraryRevision
            }
          }
        )
      });
      partyCheckpointClaimCancelRef.current = boundedClaim.cancel;
      const settlement = await boundedClaim.promise;
      if (!ownsClaim()) {
        if (ownsPartyCheckpointClaim(partyCheckpointClaimOwnerRef.current, claimOwner)) {
          getPartyCheckpointWriteRuntime().openCircuit();
          setPartyCheckpointWriteCircuitOpen(true);
          setPartyCheckpointError("The saved party plan could not be applied because local music or audio state changed during restore. Reload Mazzy to review recovery before continuing.");
          window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
        }
        return;
      }
      if (settlement.outcome !== "completed" || settlement.value.status !== "transferred" ||
          !isPartySessionCheckpointOwnershipTransfer({
            previous: checkpoint,
            next: settlement.value.checkpoint,
            nextWriterToken: claimOwner.nextWriterToken
          }) ||
          settlement.value.libraryState.epoch !== claimOwner.libraryEpoch ||
          settlement.value.libraryState.revision !== claimOwner.libraryRevision) {
        getPartyCheckpointWriteRuntime().openCircuit();
        setPartyCheckpointWriteCircuitOpen(true);
        setPartyCheckpointError(settlement.outcome === "timed-out"
          ? "The saved party plan could not be claimed because browser storage did not respond. Reload Mazzy to review recovery before continuing."
          : "The saved party plan changed or could not be claimed. Reload Mazzy to review the current local recovery copy.");
        window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
        return;
      }
      const result = settlement.value;
      const transferredCheckpoint = result.checkpoint;
      const restoredState = projectRestoredPausedPartyState(transferredCheckpoint);
      advancePartyAutopilotCoordinatorEpoch();
      autoPilotPreloadGenerationRef.current += 1;
      cancelCurrentTransitionArm();
      transitionArmGenerationRef.current += 1;
      if (activeTransitionScheduleRef.current) rescueTransition();
      stopRemoteLibraryPlayback();
      deckARef.current?.eject?.();
      deckBRef.current?.eject?.();
      setLoadedByDeck({ a: null, b: null });
      finalTrackRef.current = null;
      autoPilotEnabledRef.current = false;
      setAutoPilotEnabled(false);
      setAutoMixing(false);
      setAutoMixArming(false);
      setPartyEndingFinalTrack(false);
      setAutoPilotChoice(null);
      setAutoPilotIntervention(null);
      partyTraceRecorderRef.current = null;
      partyTraceRunningRef.current = false;
      setPartyDiagnosticEvaluation(null);
      consecutiveAutoPilotPreloadTimeoutsRef.current = 0;
      consecutiveAutoPilotArmFailuresRef.current = 0;
      setUnavailableAutoPilotTrackIds([]);
      setTimedOutAutoPilotTrackIds([]);
      const minutes = restoredState.plannedDurationSeconds / 60;
      partySessionClockRef.current = restorePausedPartySessionClock(
        restoredState.plannedDurationSeconds,
        restoredState.accumulatedActiveSeconds
      );
      setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, getAudioEngine().clock.now()));
      setPartyDurationMinutes(minutes);
      setPartyEnergyProfile(restoredState.energyProfile);
      setPartyEnergyShift(restoredState.energyShift);
      setAutoPilotUseLibrary(restoredState.includeRestOfLibrary);
      queueRef.current = [...restoredState.remainingTrackIds];
      playedTrackIdsRef.current = [...restoredState.playedTrackIds];
      setQueue([...restoredState.remainingTrackIds]);
      setPlayedTrackIds([...restoredState.playedTrackIds]);
      partyCheckpointSessionIdRef.current = transferredCheckpoint.sessionId;
      partyCheckpointRevisionRef.current = transferredCheckpoint.revision;
      partyCheckpointStoredRecordRef.current = transferredCheckpoint;
      libraryStateRef.current = result.libraryState;
      partyCheckpointTerminalRef.current = false;
      partyCheckpointWriteRuntimeRef.current?.reset?.();
      partyCheckpointWriterLostRef.current = false;
      setPartyCheckpointWriterLost(false);
      partyCheckpointPauseReasonRef.current = "host-paused";
      partyCheckpointLastFingerprintRef.current = "";
      partyCheckpointRecoveryRef.current = null;
      setPartyCheckpointRecovery(null);
      setRestoredPartyPlan({ lastStableSourceTrackId: restoredState.lastStableSourceTrackId });
      setPartyCheckpointCardVisible(true);
      window.requestAnimationFrame(() => partyCheckpointCardRef.current?.focus?.());
    } catch {
      if (ownsPartyCheckpointClaim(partyCheckpointClaimOwnerRef.current, claimOwner)) {
        getPartyCheckpointWriteRuntime().openCircuit();
        setPartyCheckpointWriteCircuitOpen(true);
        setPartyCheckpointError("The saved party plan changed or could not be claimed. Reload Mazzy to review the current local recovery copy.");
        window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
      }
    } finally {
      if (ownsPartyCheckpointClaim(partyCheckpointClaimOwnerRef.current, claimOwner)) {
        partyCheckpointClaimCancelRef.current = null;
        partyCheckpointClaimOwnerRef.current = null;
        partyCheckpointBusyRef.current = false;
        refreshPlaybackRecoveryLock();
        setPartyCheckpointBusy(false);
        resumeLibraryReconciliationAfterCheckpointOperation();
      }
    }
  };

  const discardSavedPartyPlan = async () => {
    if (partyFirstSongLoadRef.current || partyFirstSongStartOwnerRef.current || libraryMutationBusyRef.current ||
        libraryMembershipOwnerRef.current) return;
    const recovery = partyCheckpointRecoveryRef.current;
    const checkpoint = recovery?.status === "available" ? recovery.checkpoint : null;
    const stored = partyCheckpointStoredRecordRef.current;
    const checkpointRuntime = getPartyCheckpointWriteRuntime();
    const expectedCheckpoint = resolvePartySessionCheckpointDiscardTarget({
      recoveryCheckpoint: checkpoint,
      storedCheckpoint: stored,
      localSessionId: partyCheckpointSessionIdRef.current,
      localWriterToken: partyCheckpointWriterTokenRef.current,
      writerLost: partyCheckpointWriterLostRef.current,
      runtimeMode: checkpointRuntime.snapshot().mode,
      unownedFallbackRevision: partyCheckpointRevisionRef.current
    });
    if (!expectedCheckpoint) {
      checkpointRuntime.openCircuit();
      setPartyCheckpointWriteCircuitOpen(true);
      setPartyCheckpointError("The saved party plan is owned by another tab or its storage state changed. Reload Mazzy to review the current recovery copy; nothing was deleted here.");
      window.requestAnimationFrame(() => partyCheckpointAlertRef.current?.focus?.());
      return;
    }
    setPartyCheckpointError("");
    const cleared = await clearOwnedPartyCheckpoint("cleared", {
      terminalOnFailure: true,
      expectedCheckpoint,
      refreshOwnedExpectedCheckpoint: Boolean(partyCheckpointSessionIdRef.current)
    });
    if (cleared) {
      setRestoredPartyPlan(null);
      setPartyCheckpointCardVisible(false);
      window.requestAnimationFrame(() => partyModeTitleRef.current?.focus?.());
    }
  };
  const startCurrentSong = async () => {
    const readyOwner = partyFirstSongReadyOwner;
    const actionRef = partyFirstSongActionRef;
    if (partyFirstSongStartOwnerRef.current || partyFirstSongStartCircuitOpenRef.current) return;
    const observeAction = () => {
      try {
        const action = actionRef.current;
        return action ? {
          ready: Boolean(action.isReady?.()),
          playing: Boolean(action.isPlaying?.()),
          snapshot: action.getDeckSnapshot?.() ?? null,
          readiness: action.getLoadReadiness?.() ?? null
        } : null;
      } catch { return null; }
    };
    let otherDeckPlaying = false;
    try {
      otherDeckPlaying = Boolean(readyOwner &&
        (readyOwner.deck === "a" ? deckBRef : deckARef).current?.isPlaying?.());
    } catch {
      setPartyFirstSongStartStatus({ state: "error", message: "The ready song could not be checked. Try Play First Song again." });
      window.requestAnimationFrame(() => partyFirstSongPlayButtonRef.current?.focus?.());
      return;
    }
    if (playbackRecoveryLockedRef.current || libraryMutationBusyRef.current ||
      partyCheckpointBusyRef.current || partyCheckpointWriterLostRef.current ||
      rehearsalPlaybackLocked() ||
      audioRecoveryState || outputDeviceChanged || getAudioEngine().context.state === "closed" ||
      otherDeckPlaying || autoPilotEnabled) return;
    const initialObservation = observeAction();
    if (!initialObservation) {
      setPartyFirstSongStartStatus({ state: "error", message: "The ready song could not be checked. Try Play First Song again." });
      window.requestAnimationFrame(() => partyFirstSongPlayButtonRef.current?.focus?.());
      return;
    }
    const actionSnapshot = initialObservation.snapshot;
    const actionReadiness = initialObservation.readiness;
    const exactReadyOwner = !readyOwner || (actionSnapshot?.trackId === readyOwner.trackId &&
      actionReadiness?.loadAuthorityKey === readyOwner.loadAuthorityKey);
    if (!exactReadyOwner || !initialObservation.ready || initialObservation.playing) return;
    const actionDeck = readyOwner?.deck ?? masterDeck;
    const trackId = actionSnapshot?.trackId ?? null;
    const loadAuthorityKey = actionReadiness?.loadAuthorityKey ?? null;
    if (!trackId) return;
    let runtime = null;
    runtime = startPartyFirstSongStart({
      operation: ++partyFirstSongStartOperationRef.current,
      deck: actionDeck,
      trackId,
      loadAuthorityKey,
      task: async (control) => actionRef.current?.play?.(
        () => control.mayContinue() && runtime != null && partyFirstSongStartMayContinue({
          current: partyFirstSongStartOwnerRef.current,
          expected: runtime.owner,
          startAuthorityKey: partyFirstSongStartAuthorityKeyRef.current,
          nowMilliseconds: performance.now(),
          blocked: playbackRecoveryLockedRef.current || libraryMutationBusyRef.current ||
            partyCheckpointBusyRef.current || partyCheckpointWriterLostRef.current || rehearsalPlaybackLocked(),
          trackId: actionRef.current?.getDeckSnapshot?.()?.trackId ?? null,
          loadAuthorityKey: actionRef.current?.getLoadReadiness?.()?.loadAuthorityKey ?? null
        }),
        runtime.owner.startAuthorityKey,
        control.claimCommit
      ) ?? false
    });
    partyFirstSongStartOwnerRef.current = runtime.owner;
    partyFirstSongStartRuntimeRef.current = runtime;
    partyFirstSongStartAuthorityKeyRef.current = runtime.owner.startAuthorityKey;
    setPartyFirstSongStartStatus({ state: "starting", message: "Asking the browser to start the ready song…" });
    const settlement = await runtime.settlement;
    if (partyFirstSongStartRuntimeRef.current !== runtime ||
        !ownsPartyFirstSongStart(partyFirstSongStartOwnerRef.current, runtime.owner)) return;
    partyFirstSongStartRuntimeRef.current = null;
    if (settlement.outcome === "timed-out") {
      partyFirstSongStartOwnerRef.current = null;
      partyFirstSongStartAuthorityKeyRef.current = null;
      partyFirstSongStartCircuitOpenRef.current = true;
      setPartyFirstSongStartCircuitOpen(true);
      refreshPlaybackRecoveryLock();
      let cleanupConfirmed = false;
      try {
        const currentSnapshot = actionRef.current?.getDeckSnapshot?.() ?? null;
        const currentReadiness = actionRef.current?.getLoadReadiness?.() ?? null;
        const exactTimedOutOwner = currentSnapshot?.trackId === runtime.owner.trackId &&
          (currentReadiness?.loadAuthorityKey ?? null) === runtime.owner.loadAuthorityKey;
        if (exactTimedOutOwner && actionRef.current?.isPlaying?.()) actionRef.current?.pause?.();
        const afterSnapshot = actionRef.current?.getDeckSnapshot?.() ?? null;
        const afterReadiness = actionRef.current?.getLoadReadiness?.() ?? null;
        const sameOwnerAfter = afterSnapshot?.trackId === runtime.owner.trackId &&
          (afterReadiness?.loadAuthorityKey ?? null) === runtime.owner.loadAuthorityKey;
        cleanupConfirmed = !sameOwnerAfter || !actionRef.current?.isPlaying?.();
      } catch { /* The reload-only playback circuit remains authoritative. */ }
      if (!cleanupConfirmed) {
        transitionCompletionUncertainRef.current = true;
        setTransitionCompletionUncertain(true);
        refreshPlaybackRecoveryLock();
      }
      setPartyFirstSongStartStatus({
        state: "blocked",
        message: cleanupConfirmed
          ? "Browser audio did not respond. No new playback can start until Mazzy reloads."
          : "Mazzy could not confirm that the attempted start is silent. Use Stop All Sound or your device mute, then reload Mazzy."
      });
      window.requestAnimationFrame(() => partyFirstSongStartAlertRef.current?.focus?.());
      return;
    }
    const started = settlement.outcome === "completed" && settlement.value === true;
    const finalObservation = observeAction();
    const exactStartedOwner = finalObservation?.snapshot?.trackId === runtime.owner.trackId &&
      (finalObservation?.readiness?.loadAuthorityKey ?? null) === runtime.owner.loadAuthorityKey;
    const acceptedStart = started && exactStartedOwner && finalObservation?.playing &&
      !playbackRecoveryLockedRef.current && !rehearsalPlaybackLocked();
    const committedStartNeedsCircuit = partyFirstSongStartRequiresRecoveryCircuit({
      commitClaimed: runtime.snapshot().commitClaimed,
      accepted: Boolean(acceptedStart)
    });
    partyFirstSongStartOwnerRef.current = null;
    partyFirstSongStartAuthorityKeyRef.current = null;
    refreshPlaybackRecoveryLock();
    if (committedStartNeedsCircuit) {
      let cleanupConfirmed = false;
      try {
        if (exactStartedOwner && finalObservation?.playing) actionRef.current?.pause?.();
        const afterCleanup = observeAction();
        const sameOwnerAfterCleanup = afterCleanup?.snapshot?.trackId === runtime.owner.trackId &&
          (afterCleanup?.readiness?.loadAuthorityKey ?? null) === runtime.owner.loadAuthorityKey;
        cleanupConfirmed = Boolean(afterCleanup) && (!sameOwnerAfterCleanup || !afterCleanup.playing);
      } catch { /* The fixed reload and Stop intervention remains authoritative. */ }
      partyFirstSongStartCircuitOpenRef.current = true;
      setPartyFirstSongStartCircuitOpen(true);
      if (!cleanupConfirmed) {
        transitionCompletionUncertainRef.current = true;
        setTransitionCompletionUncertain(true);
      }
      refreshPlaybackRecoveryLock();
      setPartyFirstSongStartStatus({
        state: "blocked",
        message: cleanupConfirmed
          ? "Mazzy could not confirm the complete first-song start. New playback is locked until Mazzy reloads."
          : "Mazzy could not confirm that the attempted start is silent. Use Stop All Sound or your device mute, then reload Mazzy."
      });
      window.requestAnimationFrame(() => partyFirstSongStartAlertRef.current?.focus?.());
      return;
    }
    if (acceptedStart) {
      setPartyFirstSongStartStatus(null);
      audioOutputWatchArmedRef.current = true;
      return;
    }
    if (finalObservation?.playing && exactStartedOwner) {
      try { actionRef.current?.pause?.(); } catch { /* Existing recovery locks remain fail closed. */ }
    }
    setPartyFirstSongStartStatus({
      state: settlement.outcome === "cancelled" ? "cancelled" : "error",
      message: settlement.outcome === "cancelled"
        ? "Starting was cancelled. The ready song did not change."
        : "The ready song did not start. Try Play First Song again."
    });
    window.requestAnimationFrame(() => partyFirstSongPlayButtonRef.current?.focus?.());
    if (!started && getAudioEngine().context.state !== "running") onAudioStartError(getAudioEngine().context.state);
  };
  const resumeBrowserAudio = async () => {
    const recoveryGeneration = audioRecoveryGenerationRef.current;
    try {
      await getAudioEngine().resume();
      if (
        getAudioEngine().context.state === "running"
        && recoveryGeneration === audioRecoveryGenerationRef.current
      ) {
        contextReadyRef.current = true;
        setAudioRecoveryState(null);
        audioRecoveryPendingRef.current = false;
        refreshPlaybackRecoveryLock();
      }
    } catch {
      setAudioRecoveryState(getAudioEngine().context.state);
    }
  };
  const confirmOutputDeviceAndResume = async () => {
    const checkedGeneration = outputDeviceGenerationRef.current;
    try {
      await getAudioEngine().resume();
      if (getAudioEngine().context.state === "running" && checkedGeneration === outputDeviceGenerationRef.current) {
        contextReadyRef.current = true;
        setOutputDeviceChanged(false);
        outputDevicePendingRef.current = false;
        refreshPlaybackRecoveryLock();
      }
    } catch {
      setAudioRecoveryState(getAudioEngine().context.state);
    }
  };
  const onAudioStartError = (state) => {
    invalidatePartyCheckpointClaim("Browser audio changed while the saved plan was being restored. Reload Mazzy to review recovery before continuing.");
    audioRecoveryPendingRef.current = true;
    refreshPlaybackRecoveryLock();
    setAudioRecoveryState(needsHostAudioRecovery(state) ? state : "suspended");
  };
  const partyModeStatus = partyEndingFinalTrack
    ? "Final song is playing. The session will finish when it ends."
    : libraryReconcileBusy
      ? "Checking saved local changes. The current song may continue; new automatic planning waits."
    : partyFirstSongOpening
      ? partyFirstSongLoadStatus.message
    : autoMixing
    ? `Changing songs with ${transitionInfo?.template === "downbeat-cut" ? "a short timed handoff" : transitionInfo?.template === "filtered-fade" ? "an intentional filtered fade" : "a conservative fade"}.`
    : autoPilotEnabled
      ? "Party Autopilot is choosing and preparing the next song."
      : sourcePartyPlaying
        ? "Music is playing. Start Party Autopilot when your queue is ready."
        : sourcePartyReady
          ? "Your first song is loaded and ready to play."
          : library.length
            ? "Choose a song from your library below to begin."
            : "Import a music folder to begin.";
  const recoverablePartyCheckpoint = partyCheckpointRecovery?.status === "available"
    ? partyCheckpointRecovery.checkpoint
    : null;
  const recoveredSourceTrackId = recoverablePartyCheckpoint?.lastStableSourceTrackId ??
    restoredPartyPlan?.lastStableSourceTrackId ?? null;
  const recoveredSourceName = recoveredSourceTrackId
    ? library.find((track) => track.id === recoveredSourceTrackId)?.name ?? "the last saved song"
    : null;
  const checkpointNeedsAttention = partyCheckpointRecovery &&
    partyCheckpointRecovery.status !== "available";

  return (
    <main className="app">
      <section className="party-mode" aria-labelledby="party-mode-title">
        <div className="party-mode-heading">
          <div>
            <span>MAZZY PARTY MODE</span>
            <h1 ref={partyModeTitleRef} tabIndex={-1} id="party-mode-title">Run the music without DJ skills</h1>
          </div>
          <button type="button" onClick={() => setShowAdvancedMixer((value) => !value)} aria-expanded={showAdvancedMixer} aria-controls="advanced-mixer">
            {showAdvancedMixer ? "HIDE ADVANCED MIXER" : "SHOW ADVANCED MIXER"}
          </button>
        </div>
        <p className="party-mode-status" role="status">{partyModeStatus}</p>
        {libraryMutationBusy && libraryMutationModeRef.current === "hydrating" && !libraryStorageError && (
          <div
            ref={libraryHydrationStatusRef}
            tabIndex={-1}
            className="party-mode-readiness"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>OPENING SAVED LOCAL MUSIC</strong>
            <span>Import and new playback stay unavailable until browser storage finishes.</span>
          </div>
        )}
        {libraryReconcileBusy && !libraryReconcileCircuitOpen && (
          <div className="party-mode-readiness" role="status" aria-live="polite" aria-atomic="true">
            <strong>CHECKING SAVED LOCAL CHANGES</strong>
            <span>New playback and library changes wait while Mazzy checks browser storage. Audio already playing may continue; Stop All Sound stays available.</span>
          </div>
        )}
        {libraryMembershipStatus && !libraryMembershipCircuitOpen && (
          <div ref={libraryMembershipStatusRef} tabIndex={-1} className="party-mode-readiness" role="status" aria-live="polite" aria-atomic="true" aria-busy="true">
            <strong>{libraryMembershipStatus.state === "preparing" ? "CHECKING SELECTED LOCAL MUSIC" : "SAVING LOCAL MUSIC CHANGE"}</strong>
            <span>{libraryMembershipStatus.state === "preparing"
              ? `${libraryMembershipStatus.completed} of ${libraryMembershipStatus.total} local files checked. Music already playing may continue.`
              : "New playback and library changes wait while browser storage finishes. Audio already playing may continue; Stop All Sound stays available."}</span>
            {libraryMembershipStatus.kind === "import" && libraryMembershipStatus.state === "preparing" && (
              <button ref={libraryMembershipCancelButtonRef} type="button" onClick={cancelLibraryMembershipPreparation}>CANCEL IMPORT</button>
            )}
          </div>
        )}
        {libraryMembershipCircuitOpen && (
          <div ref={libraryMembershipAlertRef} tabIndex={-1} className="library-storage-error" role="alert">
            <p>{libraryStorageError}</p>
            <button type="button" onClick={() => window.location.reload()}>RELOAD LOCAL MUSIC</button>
          </div>
        )}
        {partyCheckpointBusy && (
          <div className="party-mode-readiness" role="status" aria-live="polite" aria-atomic="true">
            <strong>UPDATING SAVED PARTY RECOVERY</strong>
            <span>Mazzy will not start new audio while browser storage finishes. Audio already playing may continue; Stop All Sound stays available.</span>
          </div>
        )}
        {audioRecoveryState && (
          <div className="library-storage-error" role="alert">
            <p>{audioRecoveryMessage(audioRecoveryState)}</p>
            {audioRecoveryState !== "closed" && (
              <button type="button" onClick={() => void resumeBrowserAudio()}>RESUME AUDIO</button>
            )}
          </div>
        )}
        {outputDeviceChanged && !audioRecoveryState && (
          <div className="library-storage-error" role="alert">
            <p>{OUTPUT_DEVICE_RECOVERY_MESSAGE}</p>
            <button type="button" onClick={() => void confirmOutputDeviceAndResume()}>I CHECKED · CONTINUE</button>
          </div>
        )}
        {partyFirstSongLoadStatus && (
          <section
            ref={partyFirstSongLoadAlertRef}
            tabIndex={partyFirstSongLoadStatus.state === "error" || partyFirstSongLoadStatus.state === "cleanup-error" ? -1 : undefined}
            className={`party-mode-readiness party-first-song-load ${partyFirstSongLoadStatus.state}`}
            role={partyFirstSongLoadStatus.state === "error" || partyFirstSongLoadStatus.state === "cleanup-error" ? "alert" : undefined}
            aria-live={partyFirstSongLoadStatus.state === "error" || partyFirstSongLoadStatus.state === "cleanup-error" ? "assertive" : undefined}
            aria-atomic="true"
            aria-busy={partyFirstSongOpening}
          >
            <h2>{partyFirstSongOpening ? "OPENING FIRST SONG LOCALLY" : partyFirstSongLoadStatus.state === "ready" ? "FIRST SONG READY" : partyFirstSongLoadStatus.state === "cancelled" ? "OPENING STOPPED" : "FIRST SONG NEEDS ATTENTION"}</h2>
            <p
              role={partyFirstSongLoadStatus.state === "error" || partyFirstSongLoadStatus.state === "cleanup-error" ? undefined : "status"}
              aria-live={partyFirstSongLoadStatus.state === "error" || partyFirstSongLoadStatus.state === "cleanup-error" ? undefined : "polite"}
              aria-atomic="true"
            >{partyFirstSongLoadStatus.state === "ready"
              ? partyFirstSongReadyActionMessage(partyFirstSongOtherDeckPlaying)
              : partyFirstSongLoadStatus.message}</p>
            <div>
              {partyFirstSongOpening && (
                <button ref={partyFirstSongCancelRef} type="button" onClick={() => cancelPartyFirstSongLoad({ restoreFocus: true })}>
                  CANCEL OPENING
                </button>
              )}
              {partyFirstSongLoadStatus.state === "error" && (
                <button type="button" onClick={() => {
                  const track = libraryRef.current.find((item) => item.id === partyFirstSongLoadStatus.trackId);
                  if (track) void openPartyFirstSong(track, partyFirstSongLoadTriggerRef.current);
                }}>
                  TRY THIS SONG AGAIN
                </button>
              )}
              {!partyFirstSongOpening && partyFirstSongLoadStatus.state !== "ready" &&
                partyFirstSongLoadStatus.state !== "cleanup-error" && (
                <button type="button" onClick={() => {
                  setPartyFirstSongLoadStatus(null);
                  document.querySelector(".library-section")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                  window.requestAnimationFrame(() => partyFirstSongLoadTriggerRef.current?.focus?.());
                }}>
                  CHOOSE ANOTHER SONG
                </button>
              )}
            </div>
          </section>
        )}
        {partyCheckpointError && (
          <div ref={partyCheckpointAlertRef} tabIndex={-1} className="library-storage-error" role="alert">
            <p>{partyCheckpointError}</p>
            {(partyCheckpointWriterLost || partyCheckpointWriteCircuitOpen) && (
              <button type="button" onClick={() => window.location.reload()}>RELOAD RECOVERY STATE</button>
            )}
          </div>
        )}
        {partyCheckpointCardVisible && (recoverablePartyCheckpoint || checkpointNeedsAttention) && (
          <section
            ref={partyCheckpointCardRef}
            tabIndex={-1}
            className={`party-mode-readiness party-checkpoint-recovery ${checkpointNeedsAttention ? "caution" : ""}`}
            aria-labelledby="party-checkpoint-title"
            aria-busy={partyCheckpointBusy}
          >
            <h2 id="party-checkpoint-title">
              {recoverablePartyCheckpoint ? "PAUSED PARTY PLAN FOUND" : "SAVED PARTY PLAN NEEDS ATTENTION"}
            </h2>
            {recoverablePartyCheckpoint ? (
              <>
                <p>
                  A paused party plan saved in this browser profile is available. Restoring rebuilds the remaining order and active-party progress.
                </p>
                <p>
                  Audio stays stopped. Exact playback position is not recovered, and the saved progress may be several seconds behind.
                </p>
                <p>{`${Math.floor(recoverablePartyCheckpoint.accumulatedActiveSeconds / 60)} active minutes saved${recoveredSourceName ? ` after ${recoveredSourceName}` : ""}.`}</p>
              </>
            ) : (
              <p>
                The saved plan cannot be restored safely because its data is malformed or the music library changed. No partial plan was applied.
              </p>
            )}
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {partyCheckpointBusy ? "Updating the saved party plan." : ""}
            </p>
            <div>
              <button type="button" disabled={partyCheckpointBusy || partyFirstSongOpening || partyFirstSongStarting} onClick={() => {
                setPartyCheckpointCardVisible(false);
                window.requestAnimationFrame(() => partyCheckpointShowButtonRef.current?.focus?.());
              }}>NOT NOW</button>
              <button type="button" disabled={partyCheckpointBusy || libraryMutationBusy || !!libraryMembershipStatus ||
                partyFirstSongOpening || partyFirstSongStarting || partyCheckpointWriteCircuitOpen || partyCheckpointWriterLost}
                onClick={() => void discardSavedPartyPlan()}>
                DELETE SAVED PLAN
              </button>
              {recoverablePartyCheckpoint && (
                <button type="button" disabled={partyCheckpointBusy || libraryMutationBusy || !!libraryMembershipStatus || partyFirstSongOpening || partyFirstSongStarting || partyCheckpointWriteCircuitOpen || partyCheckpointWriterLost} onClick={() => void restoreSavedPartyPlan()}>
                  RESTORE PAUSED PLAN
                </button>
              )}
            </div>
          </section>
        )}
        {!partyCheckpointCardVisible && partyCheckpointRecovery && (
          <button
            ref={partyCheckpointShowButtonRef}
            type="button"
            className="party-checkpoint-show"
            onClick={() => {
              setPartyCheckpointCardVisible(true);
              window.requestAnimationFrame(() => partyCheckpointCardRef.current?.focus?.());
            }}
          >
            SHOW SAVED PARTY PLAN
          </button>
        )}
        {restoredPartyPlan && (
          <section
            ref={partyCheckpointCardRef}
            tabIndex={-1}
            className="party-mode-readiness party-checkpoint-recovery restored"
            aria-labelledby="party-checkpoint-restored-title"
            aria-live="polite"
            aria-atomic="true"
          >
            <h2 id="party-checkpoint-restored-title">PARTY PLAN RESTORED · PAUSED</h2>
            <p>
              Remaining order and active-party progress are back. Audio is stopped. Choose and play a song, then start Autopilot.
            </p>
            <p>
              The minimized paused recovery copy remains saved in this browser across refreshes until you remove it, start a New Party, or finish the party.
            </p>
            {recoveredSourceName && <p>{`The last saved song was ${recoveredSourceName}.`}</p>}
            <div>
              <button type="button" onClick={() => {
                document.querySelector(".library-section")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                window.requestAnimationFrame(() => document.querySelector(".library-row button:not([disabled])")?.focus?.());
              }}>CHOOSE A SONG</button>
              <button type="button" onClick={() => {
                setRestoredPartyPlan(null);
                window.requestAnimationFrame(() => partyModeTitleRef.current?.focus?.());
              }}>DISMISS</button>
              <button
                type="button"
                disabled={partyCheckpointBusy || libraryMutationBusy || !!libraryMembershipStatus ||
                  partyCheckpointWriteCircuitOpen || partyCheckpointWriterLost}
                onClick={() => void discardSavedPartyPlan()}
              >REMOVE SAVED RECOVERY COPY</button>
            </div>
          </section>
        )}
        <div className="party-mode-flow" aria-label="Party setup steps">
          <button type="button" disabled={transitionCompletionUncertain || partyCheckpointBusy || libraryMutationBusy || !!libraryMembershipStatus || partyFirstSongOpening || partyFirstSongStarting} onClick={openLibraryImportPicker}>
            <span>1</span><strong>IMPORT MUSIC</strong><small>Saved only in this browser</small>
          </button>
          <button ref={partyFirstSongPlayButtonRef} type="button" aria-busy={partyFirstSongStarting}
            onClick={() => void startCurrentSong()} disabled={partySoundStopLocked || transitionCompletionUncertain || partyCheckpointBusy || libraryMutationBusy || partyCheckpointWriterLost || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongOpening || partyFirstSongStarting || partyFirstSongStartCircuitOpen || !!audioRecoveryState || outputDeviceChanged || !partyFirstSongActionReady || partyFirstSongActionPlaying || partyFirstSongOtherDeckPlaying || autoPilotEnabled}>
            <span>2</span><strong>{partyFirstSongStarting ? "STARTING…" : partyFirstSongActionPlaying ? "FIRST SONG PLAYING" : "PLAY FIRST SONG"}</strong><small>{partyFirstSongStartStatus?.message ?? (partyFirstSongActionReady ? partyFirstSongActionTrack?.name ?? "Loaded track" : "Choose a song below")}</small>
          </button>
          <button ref={partyStartButtonRef} type="button" onClick={() => autoPilotEnabled ? pausePartyAutopilot() : setShowPartyReadiness(true)} disabled={partySoundStopLocked || transitionCompletionUncertain || partyCheckpointBusy || (libraryMutationBusy && !autoPilotEnabled) || partyCheckpointWriterLost || (!autoPilotEnabled && (rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen)) || !!audioRecoveryState || outputDeviceChanged || (!!partyFirstSongReadyOwner && !autoPilotEnabled) || (!sourcePartyPlaying && !autoPilotEnabled)}>
            <span>3</span><strong>{autoPilotEnabled ? "PAUSE AUTOPILOT" : "START AUTOPILOT"}</strong><small>{autoPilotEnabled ? "Music keeps playing" : "Mazzy handles later songs"}</small>
          </button>
        </div>
        <div className="party-stop-all-panel">
          <button className="party-stop-all" type="button" onClick={stopAllSound}>
            <strong>STOP ALL SOUND</strong>
            <small>Stops both songs, previews, and clicks · keeps the party plan</small>
          </button>
          {partySoundStopStatus && (
            <p
              className={`party-stop-all-status ${partySoundStopStatus.type}`}
              role={partySoundStopStatus.type === "error" ? "alert" : "status"}
              aria-live={partySoundStopStatus.type === "error" ? "assertive" : "polite"}
              aria-atomic="true"
            >
              {partySoundStopStatus.message}
            </p>
          )}
        </div>
        {!autoPilotEnabled && (
          <div className="party-mode-options" aria-label="Party playback choices">
            <label htmlFor="party-mode-duration">
              Planned party length
              <select
                id="party-mode-duration"
                disabled={partyCheckpointBusy}
                value={partyDurationMinutes}
                onChange={(event) => {
                  const minutes = Number(event.target.value);
                  setPartyDurationMinutes(minutes);
                  partySessionClockRef.current = setPartySessionDuration(partySessionClockRef.current, minutes * 60);
                  setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, getAudioEngine().clock.now()));
                }}
              >
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
                <option value="180">3 hours</option>
                <option value="240">4 hours</option>
                <option value="360">6 hours</option>
              </select>
            </label>
            <label>
              <input type="checkbox" disabled={partyCheckpointBusy} checked={autoPilotUseLibrary} onChange={(event) => setAutoPilotUseLibrary(event.target.checked)} />
              Continue with unqueued library songs when the queue ends
            </label>
            <label>
              <input
                type="checkbox"
                checked={partyDiagnosticEnabled}
                disabled={partyCheckpointBusy || partyTraceRecorderRef.current !== null}
                onChange={(event) => setPartyDiagnosticEnabled(event.target.checked)}
              />
              Keep a private Autopilot activity check in this tab
            </label>
            <small>No music or song names are recorded. This checks session state only, not sound quality.</small>
          </div>
        )}
        {showPartyReadiness && !autoPilotEnabled && (
          <section ref={partyReadinessRef} tabIndex={-1} className={`party-mode-readiness ${partyReadiness.level}`} aria-live="polite" aria-labelledby="party-readiness-title">
            <h2 id="party-readiness-title">{partyReadiness.headline}</h2>
            {partyReadiness.details.map((detail) => <p key={detail}>{detail}</p>)}
            <div>
              <button type="button" onClick={() => {
                setShowPartyReadiness(false);
                window.requestAnimationFrame(() => partyStartButtonRef.current?.focus?.());
              }}>NOT YET</button>
              <button type="button" disabled={partySoundStopLocked || partyCheckpointBusy || libraryMutationBusy || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen || partyFirstSongAutopilotBlocked || !!audioRecoveryState || outputDeviceChanged || !partyReadiness.canStart} onClick={() => {
                void startPartyAutopilot();
                window.requestAnimationFrame(() => partyStartButtonRef.current?.focus?.());
              }}>START PARTY AUTOPILOT</button>
            </div>
          </section>
        )}
        {autoPilotIntervention && !autoPilotEnabled && (
          <section
            ref={partyInterventionRef}
            tabIndex={-1}
            className="party-mode-readiness caution"
            role="alert"
            aria-labelledby="party-arm-intervention-title"
          >
            <h2 id="party-arm-intervention-title">AUTOPILOT NEEDS YOUR HELP</h2>
            <p>{autoPilotIntervention.message}</p>
            <p>{transitionCompletionUncertain
              ? "Use Stop All Sound before continuing. New playback stays locked until Mazzy confirms every sound owner is inactive."
              : autoPilotIntervention.reason === "unexpected-source-ended"
                ? "Choose and play a song below, then start Autopilot again."
              : "Retry Autopilot, or choose another song below and use More → Load on the idle deck."}</p>
            <div>
              <button type="button" disabled={transitionCompletionUncertain} onClick={() => {
                document.querySelector(".library-section")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                window.requestAnimationFrame(() => document.querySelector(".library-row button:not([disabled])")?.focus?.());
              }}>{autoPilotIntervention.reason === "unexpected-source-ended" ? "CHOOSE A SONG" : "CHOOSE ANOTHER SONG"}</button>
              <button
                type="button"
                disabled={partySoundStopLocked || transitionCompletionUncertain || libraryMutationBusy || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen || partyFirstSongAutopilotBlocked || !!audioRecoveryState || outputDeviceChanged || !sourcePartyReady || !sourcePartyPlaying}
                onClick={() => void startPartyAutopilot()}
              >RETRY AUTOPILOT</button>
            </div>
          </section>
        )}
        {autoPilotEnabled && (
          <section className="party-mode-now-next" aria-label="Current party plan">
            <div><span>NOW</span><strong>{nowPlayingTrack?.name ?? `Deck ${masterDeck.toUpperCase()}`}</strong></div>
            <div><span>NEXT</span><strong>{autoPilotChoice?.name ?? "Choosing the next song…"}</strong></div>
            <div><span>LATER · TENTATIVE</span><strong>{autoPilotChoice?.afterNextName ?? "Will replan after the handoff"}</strong></div>
          </section>
        )}
        {(autoPilotEnabled || autoMixing) && (
          <div className="party-mode-controls">
            <button type="button" onClick={() => setPartyEnergyShift((value) => Math.max(-0.3, value - 0.1))} disabled={!autoPilotEnabled || partyEnergyShift <= -0.3}>PREFER CALMER LATER SONGS</button>
            <button type="button" onClick={() => setPartyEnergyShift((value) => Math.min(0.3, value + 0.1))} disabled={!autoPilotEnabled || partyEnergyShift >= 0.3}>PREFER MORE ENERGETIC LATER SONGS</button>
            <span className="sr-only" role="status">{`Later-song activity preference ${Math.round(partyEnergyShift * 100)} percent`}</span>
            <button type="button" onClick={() => void startAutoMix()} disabled={partySoundStopLocked || transitionCompletionUncertain || libraryMutationBusy || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen || !autoPilotEnabled || autoMixing || autoMixArming || !pairPreview?.plan}>CHANGE SONG NOW</button>
            {autoMixing && <button className="party-emergency" type="button" disabled={partySoundStopLocked} onClick={rescueTransition}>STOP AUTOMATIC TRANSITION</button>}
          </div>
        )}
        <p className="party-tab-note">
          Mazzy keeps one local paused party-plan checkpoint in this browser profile while a party is in progress. Restoring never starts audio; browser storage may evict it, and recent seconds may repeat.
        </p>
        {autoPilotEnabled && (
          <p className="party-tab-note" role="status" aria-live="polite">
            {partyWakeLockStatus === "active"
              ? "Mazzy asked this screen to stay awake while Autopilot runs."
              : partyWakeLockStatus === "unavailable"
                ? "This browser could not keep the screen awake; keep the computer powered and awake."
                : "Asking the browser to keep this screen awake…"}
          </p>
        )}
        {partyDiagnosticEnabled && partyDiagnosticEvaluation && (
          <p className="party-tab-note" role="status">
            {partyDiagnosticEvaluation.status === "invalid"
              ? `PRIVATE ACTIVITY CHECK · NEEDS ATTENTION · ${partyDiagnosticEvaluation.failureCodes[0]}`
              : partyDiagnosticEvaluation.status === "valid-terminal"
                ? "PRIVATE ACTIVITY CHECK · SESSION STATE PASSED"
                : "PRIVATE ACTIVITY CHECK · HEALTHY SO FAR"}
          </p>
        )}
      </section>

      {rehearsalCircuitOpen && (
        <section className="rehearsal-control" ref={rehearsalAlertRef} tabIndex={-1}
          role="alert" aria-labelledby="rehearsal-timeout-title">
          <strong id="rehearsal-timeout-title">LOCAL REHEARSAL NEEDS A RELOAD</strong>
          <small>
            The browser did not finish the local rehearsal preparation. No preview was started or saved. New playback is locked; Stop All Sound remains available.
          </small>
          <button type="button" onClick={() => window.location.reload()}>RELOAD MAZZY</button>
        </section>
      )}
      {partyFirstSongStartCircuitOpen && (
        <section className="rehearsal-control" ref={partyFirstSongStartAlertRef} tabIndex={-1}
          role="alert" aria-labelledby="first-song-start-timeout-title">
          <strong id="first-song-start-timeout-title">BROWSER AUDIO NEEDS A RELOAD</strong>
          <small>
            {partyFirstSongStartStatus?.message ?? "The browser did not finish the first-song start. No new playback can start in this tab."} Stop All Sound remains available.
          </small>
          <button type="button" onClick={() => window.location.reload()}>RELOAD MAZZY</button>
        </section>
      )}

      <section id="advanced-mixer" className={`decks-section ${showAdvancedMixer ? "" : "advanced-hidden"}`} aria-hidden={!showAdvancedMixer}>
        <div className="mixer-layout">
          <Deck
            ref={deckARef}
            title="Deck A"
            channel="a"
            color="#4a9eff"
            contextReadyRef={contextReadyRef}
            ownBpm={bpmByDeck.a}
            otherBpm={bpmByDeck.b}
            onBpmChange={onBpmChange}
            onTrackLoaded={onTrackLoaded}
            onAnalysisDetected={onAnalysisDetected}
            onEnhancedRhythmDetected={onEnhancedRhythmDetected}
            onProgramLevelDetected={onProgramLevelDetected}
            enhancedTimingAvailable={enhancedTimingAvailable}
            onAnalysisOverrideChange={onAnalysisOverrideChange}
            onTimingReviewSave={onTimingReviewSave}
            onTimingReviewRemove={onTimingReviewRemove}
            librarySaveStatus={librarySaveStatus}
            onDeckPlayStart={onDeckPlayStart}
            onDeckTransportStart={onDeckTransportStart}
            onDeckLoadInvalidated={onDeckLoadInvalidated}
            onAuxAudioStart={() => setPartySoundStopStatus(null)}
            onStopAllSound={stopAllSound}
            onDeckPlaybackCompletion={onDeckPlaybackCompletion}
            onAudioStartError={onAudioStartError}
            playbackStartLocked={partySoundStopLocked || transitionCompletionUncertain || libraryMutationBusy || partyCheckpointBusy || partyCheckpointWriterLost || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStartCircuitOpen || !!audioRecoveryState || outputDeviceChanged}
            playbackStartLockRef={deckPlaybackStartLockedRef}
            playbackStartOwnerRef={partyFirstSongStartAuthorityKeyRef}
            flash={deckFlash.a}
            transitionLocked={autoMixing || autoMixArming || autoPilotEnabled}
            rehearsalLocked={rehearsalActive || rehearsalPreparing}
            partySetupLocked={partyFirstSongOpening || partyFirstSongStarting || libraryMutationBusy}
          />

          <section className="crossfader-panel">
            <div className="wordmark">MAZZY</div>
            <div className="direction-indicator">{getDirectionLabel()}</div>
            <div className="master-meter" aria-label="Master output meter">
              <div className="master-meter-header">
                <span>Master</span>
                <span>{Number.isFinite(masterMeter.peakDb) ? `${masterMeter.peakDb.toFixed(1)} dB` : "−∞ dB"}</span>
              </div>
              <div className="master-meter-track">
                <div className="master-meter-fill" style={{ width: `${masterPeakPercent}%` }} />
              </div>
              <div className="master-meter-reduction">
                {masterMeter.limiterReductionDb < -0.5
                  ? `Limiter ${masterMeter.limiterReductionDb.toFixed(1)} dB`
                  : "Limiter ready · −6 dB headroom"}
              </div>
            </div>
            <label htmlFor="crossfader">Crossfader</label>
            <input
              id="crossfader"
              className="crossfader"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={fade}
              onChange={onCrossFade}
              disabled={autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing || partyFirstSongStarting || partyFirstSongStartCircuitOpen}
            />
            <button className="auto-mix-btn" type="button" onClick={startAutoMix} disabled={partySoundStopLocked || libraryMutationBusy || !!audioRecoveryState || outputDeviceChanged || autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen}>
              {autoMixArming
                ? "ARMING SAFE TRANSITION…"
                : autoMixing
                ? transitionInfo?.template === "phrase-blend"
                  ? `PHRASE BLEND: ${autoMixBeats ?? 0} beats`
                  : `${transitionInfo?.template === "downbeat-cut" ? "BAR HANDOFF" : transitionInfo?.template === "filtered-fade" ? "FILTERED FADE" : "SAFE FADE"}: ${Number(autoMixBeats ?? 0).toFixed(1)}s`
                : pairPreview?.status === "source-paused"
                  ? `START DECK ${String(pairPreview.sourceDeck).toUpperCase()} TO AUTO MIX`
                  : pairPreview?.plan
                    ? transitionButtonLabel(pairPreview.plan.template)
                    : "AUTO MIX"}
            </button>
            {autoMixing && (
              <button
                className="rescue-btn"
                type="button"
                onClick={rescueTransition}
                disabled={partySoundStopLocked}
                aria-describedby="rescue-mix-help"
              >
                STOP TRANSITION SAFELY
              </button>
            )}
            {autoMixing && (
              <small id="rescue-mix-help" className="rescue-help">
                Keeps the deck currently carrying more of the mix and pauses Party Autopilot.
              </small>
            )}
            <button
              className={`auto-pilot-toggle ${autoPilotEnabled ? "enabled" : ""}`}
              type="button"
              aria-pressed={autoPilotEnabled}
              disabled={rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen || (libraryMutationBusy && !autoPilotEnabled) || partyFirstSongAutopilotBlocked}
              onClick={() => {
                if (autoPilotEnabled) {
                  pausePartyAutopilot();
                  return;
                }
                setShowPartyReadiness(true);
              }}
            >
              {autoPilotEnabled ? "PARTY AUTOPILOT ON" : "START PARTY AUTOPILOT"}
            </button>
            <a className="device-check-link" href={`${import.meta.env.BASE_URL}device-soak.html`} target="_blank" rel="noreferrer">
              RUN LOCAL DEVICE PARTY CHECK
            </a>
            <div className="party-energy-control">
              <label htmlFor="party-energy-profile">Party energy</label>
              <select
                id="party-energy-profile"
                value={partyEnergyProfile}
                disabled={autoPilotEnabled}
                onChange={(event) => setPartyEnergyProfile(event.target.value)}
              >
                <option value="steady">Steady</option>
                <option value="build">Build to a peak</option>
                <option value="journey">Warm up · peak · cool down</option>
              </select>
            </div>
            <div className="party-energy-control">
              <label htmlFor="party-duration">Party length</label>
              <select
                id="party-duration"
                value={partyDurationMinutes}
                disabled={autoPilotEnabled}
                onChange={(event) => {
                  const minutes = Number(event.target.value);
                  setPartyDurationMinutes(minutes);
                  partySessionClockRef.current = setPartySessionDuration(
                    partySessionClockRef.current,
                    minutes * 60
                  );
                  setPartyClockDisplay(partySessionClockSnapshot(
                    partySessionClockRef.current,
                    getAudioEngine().clock.now()
                  ));
                }}
              >
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
                <option value="180">3 hours</option>
                <option value="240">4 hours</option>
                <option value="360">6 hours</option>
              </select>
            </div>
            <label className="auto-pilot-library-option">
              <input
                type="checkbox"
                checked={autoPilotUseLibrary}
                disabled={autoPilotEnabled}
                onChange={(event) => setAutoPilotUseLibrary(event.target.checked)}
              />
              Continue from the rest of my library after queued songs
            </label>
            <div className="auto-pilot-status" aria-live="polite">
              {autoPilotEnabled
                ? autoPilotChoice
                  ? `Next: ${autoPilotChoice.name}${autoPilotChoice.afterNextName ? ` · After that: ${autoPilotChoice.afterNextName}` : ""} · ${autoPilotChoice.reasons.filter(Boolean).join(" · ")}`
                  : "Mazzy will choose the safest queued track, preload it, and transition near the end."
                : "Opt in for hands-off queue playback. You can stop it at any time."}
            </div>
            {autoPilotEnabled && (
              <section className="party-cockpit" aria-label="Party Autopilot plan">
                <div>
                  <span>NOW</span>
                  <strong>{nowPlayingTrack?.name ?? `Deck ${masterDeck.toUpperCase()}`}</strong>
                </div>
                <div>
                  <span>NEXT</span>
                  <strong>{autoPilotChoice?.name ?? "Choosing the safest next track…"}</strong>
                </div>
                <div>
                  <span>AFTER THAT</span>
                  <strong>{autoPilotChoice?.afterNextName ? `Tentative · ${autoPilotChoice.afterNextName}` : "Replans after the next handoff"}</strong>
                </div>
                {autoPilotChoice?.reasons?.length ? (
                  <p>{autoPilotChoice.reasons.filter(Boolean).join(" · ")}</p>
                ) : null}
              </section>
            )}
            {autoPilotEnabled && (
              <div className="live-energy-controls" aria-label="Change party energy">
                <button
                  type="button"
                  onClick={() => setPartyEnergyShift((value) => Math.max(-0.3, value - 0.1))}
                  disabled={partyEnergyShift <= -0.3}
                >
                  ENERGY DOWN
                </button>
                <span>{partyEnergyShift === 0 ? "ON PLAN" : partyEnergyShift > 0 ? `+${Math.round(partyEnergyShift * 100)}% FUTURE SELECTION ACTIVITY` : `${Math.round(partyEnergyShift * 100)}% FUTURE SELECTION ACTIVITY`}</span>
                <button
                  type="button"
                  onClick={() => setPartyEnergyShift((value) => Math.min(0.3, value + 0.1))}
                  disabled={partyEnergyShift >= 0.3}
                >
                  ENERGY UP
                </button>
              </div>
            )}
            {autoPilotEnabled && (
              <button
                className="skip-current-btn"
                type="button"
                disabled={partySoundStopLocked || libraryMutationBusy || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen || autoMixing || autoMixArming || !pairPreview?.plan}
                onClick={() => void startAutoMix()}
              >
                SKIP CURRENT SONG SAFELY
              </button>
            )}
            {partyClockDisplay.status !== "not-started" && (
              <div className="party-clock-status" role="status">
                <span>{partyClockDisplay.status === "complete" ? `${partyClockDisplay.isRunning ? "PARTY RUNNING" : "PARTY PAUSED"} · OVERTIME` : partyClockDisplay.status === "running" ? "PARTY RUNNING" : "PARTY PAUSED"}</span>
                <strong>{`${Math.floor(partyClockDisplay.elapsedActiveSeconds / 3600)}h ${Math.floor((partyClockDisplay.elapsedActiveSeconds % 3600) / 60)}m active · ${Math.round(partyClockDisplay.energyProgress * 100)}% through energy journey`}</strong>
                {!autoPilotEnabled && (
                  <button
                    type="button"
                    disabled={partyCheckpointBusy || libraryMutationBusy || partyCheckpointWriteCircuitOpen || partyCheckpointWriterLost || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen}
                    onClick={() => {
                      void resetPartyAutopilot();
                    }}
                  >
                    NEW PARTY
                  </button>
                )}
              </div>
            )}
            {showPartyReadiness && !autoPilotEnabled && (
              <section className={`party-readiness ${partyReadiness.level}`} aria-live="polite">
                <strong>{partyReadiness.headline}</strong>
                {partyReadiness.details.map((detail) => <span key={detail}>{detail}</span>)}
                <div className="party-readiness-actions">
                  <button type="button" onClick={() => setShowPartyReadiness(false)}>CANCEL</button>
                  <button
                    type="button"
                    disabled={partySoundStopLocked || libraryMutationBusy || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen || partyFirstSongAutopilotBlocked || !partyReadiness.canStart}
                    onClick={() => {
                      void startPartyAutopilot();
                    }}
                  >
                    START AUTOPILOT
                  </button>
                </div>
              </section>
            )}
            {!autoMixing && pairPreview?.plan && (
              <div className={`pair-plan-preview ${pairPreview.plan.template === "downbeat-cut" ? "handoff" : pairPreview.plan.template === "phrase-blend" ? "phrase" : pairPreview.plan.template === "filtered-fade" ? "filtered" : "safe"}`} aria-live="polite">
                <span>{`NEXT · ${transitionLabel(pairPreview.plan.template)}`}</span>
                <small>
                  {pairPreview.plan.template === "downbeat-cut"
                    ? pairPreview.plan.explanation[0]
                    : pairPreview.plan.template === "phrase-blend"
                      ? "This pair passed the calibrated long-blend gate."
                      : pairPreview.plan.template === "filtered-fade"
                        ? "Local analysis found a suitable section for briefly softening the outgoing song without beat matching."
                      : previewReason(pairPreview.plan)}
                </small>
              </div>
            )}
            {!rehearsalCircuitOpen && !autoPilotEnabled && !autoMixing && pairPreview?.plan && (
              <div className="rehearsal-control" aria-live="polite">
                {rehearsalActive ? (
                  <button type="button" onClick={() => stopRehearsal()}>STOP PREVIEW</button>
                ) : rehearsalStatus?.state === "rendering" ? (
                  <button type="button" onClick={cancelRehearsalPreparation}>CANCEL PREPARATION</button>
                ) : rehearsalStatus?.state === "cancelling" ? (
                  <button type="button" disabled>CANCELLING…</button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void rehearseCurrentPair()}
                    disabled={partySoundStopLocked || transitionCompletionUncertain || partyCheckpointBusy || libraryMutationBusy ||
                      !!audioRecoveryState || outputDeviceChanged || autoMixArming || rehearsalCircuitOpen || partyFirstSongStarting || partyFirstSongStartCircuitOpen ||
                      deckARef.current?.isPlaying?.() || deckBRef.current?.isPlaying?.()}
                  >
                    {rehearsalPreparing ? "PREPARING REHEARSAL…" : "HEAR TRANSITION REHEARSAL"}
                  </button>
                )}
                <small>{rehearsalStatus?.message ?? "A short stereo rehearsal using the planned rates, levels, EQ, and fade. Both decks must be stopped; audio stays local and is not saved."}</small>
              </div>
            )}
            {transitionInfo && (
              <section
                className={`transition-inspector ${
                  transitionInfo.template === "phrase-blend" ? "phrase" : transitionInfo.template === "downbeat-cut" ? "handoff" : transitionInfo.template === "filtered-fade" ? "filtered" : "safe"
                }`}
                aria-live="polite"
              >
                <div className="transition-inspector-header">
                  <span>
                    {transitionInfo.active ? "ACTIVE" : "LAST"} ·{" "}
                    {transitionLabel(transitionInfo.template)}
                  </span>
                  <span>
                    {transitionInfo.template === "phrase-blend"
                      ? `${Math.round(transitionInfo.confidence * 100)}% CONF`
                      : "PROTECTED"}
                  </span>
                </div>
                <p>{transitionInfo.explanation}</p>
                {transitionInfo.reasons?.[0] && (
                  <div className="transition-reason">WHY: {transitionInfo.reasons[0]}</div>
                )}
              </section>
            )}
            <div className="crossfader-labels">
              <span>A</span>
              <span>B</span>
            </div>
          </section>

          <Deck
            ref={deckBRef}
            title="Deck B"
            channel="b"
            color="#ff4a6e"
            contextReadyRef={contextReadyRef}
            ownBpm={bpmByDeck.b}
            otherBpm={bpmByDeck.a}
            onBpmChange={onBpmChange}
            onTrackLoaded={onTrackLoaded}
            onAnalysisDetected={onAnalysisDetected}
            onEnhancedRhythmDetected={onEnhancedRhythmDetected}
            onProgramLevelDetected={onProgramLevelDetected}
            enhancedTimingAvailable={enhancedTimingAvailable}
            onAnalysisOverrideChange={onAnalysisOverrideChange}
            onTimingReviewSave={onTimingReviewSave}
            onTimingReviewRemove={onTimingReviewRemove}
            librarySaveStatus={librarySaveStatus}
            onDeckPlayStart={onDeckPlayStart}
            onDeckTransportStart={onDeckTransportStart}
            onDeckLoadInvalidated={onDeckLoadInvalidated}
            onAuxAudioStart={() => setPartySoundStopStatus(null)}
            onStopAllSound={stopAllSound}
            onDeckPlaybackCompletion={onDeckPlaybackCompletion}
            onAudioStartError={onAudioStartError}
            playbackStartLocked={partySoundStopLocked || transitionCompletionUncertain || libraryMutationBusy || partyCheckpointBusy || partyCheckpointWriterLost || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || partyFirstSongStartCircuitOpen || !!audioRecoveryState || outputDeviceChanged}
            playbackStartLockRef={deckPlaybackStartLockedRef}
            playbackStartOwnerRef={partyFirstSongStartAuthorityKeyRef}
            flash={deckFlash.b}
            transitionLocked={autoMixing || autoMixArming || autoPilotEnabled}
            rehearsalLocked={rehearsalActive || rehearsalPreparing}
            partySetupLocked={partyFirstSongOpening || partyFirstSongStarting || libraryMutationBusy}
          />
        </div>
      </section>

      <section className="library-section">
        <section className="library-panel">
          <div className="queue-header">
            <div className="queue-title">{`QUEUE (${queue.length} tracks)`}</div>
            <div className="library-top-spacer" />
            <button className="library-top-btn" type="button" disabled={transitionCompletionUncertain || partyCheckpointBusy || libraryMutationBusy || !!libraryMembershipStatus || partyFirstSongOpening || partyFirstSongStarting} onClick={openLibraryImportPicker}>
              IMPORT
            </button>
            <input ref={importRef} type="file" multiple accept=".mp3,.wav,.flac,.aiff,.m4a" onChange={handleImportFolder} onCancel={releaseLibraryImportPickerSoon} hidden />
            <button className="library-top-btn" type="button" disabled={partyCheckpointBusy} onClick={() => setQueue([])}>
              CLEAR
            </button>
          </div>

          <p className="library-storage-notice">
            Imported music and analysis are saved in this browser profile until you remove them. Nothing is uploaded.
            {importStorageStatus?.status === "too-large"
              ? ` The last selection needed about ${formatStorageSize(importStorageStatus.requiredBytes)}, but only ${formatStorageSize(importStorageStatus.availableBytes)} was available.`
              : importStorageStatus?.status === "fits"
                ? ` The last selection was ${formatStorageSize(importStorageStatus.importBytes)}; Mazzy kept a storage reserve.`
                : importStorageStatus?.status === "unknown"
                  ? " This browser did not provide a storage estimate, so import capacity could not be checked in advance."
                  : " Mazzy checks browser capacity before adding a folder when the browser provides an estimate."}
          </p>
          {unavailableAutoPilotTrackIds.length > 0 && (
            <p className="library-storage-error" role="status">
              {`${unavailableAutoPilotTrackIds.length} ${unavailableAutoPilotTrackIds.length === 1 ? "song couldn't" : "songs couldn't"} be opened and will be skipped for this party. Try loading one manually to retry it, or choose New Party to clear the skipped list.`}
            </p>
          )}
          {timedOutAutoPilotTrackIds.length > 0 && (
            <p className="library-storage-error" role="status">
              {`${timedOutAutoPilotTrackIds.length} ${timedOutAutoPilotTrackIds.length === 1 ? "song took" : "songs took"} too long to prepare and will be skipped for this party. Pause Autopilot and load one manually to retry it, or choose New Party to clear the skipped list.`}
            </p>
          )}
          {libraryStorageError && !libraryMembershipCircuitOpen && (
            <div ref={libraryStorageAlertRef} tabIndex={-1} className="library-storage-error" role="alert">
              <p>{libraryStorageError}</p>
              {libraryHydrationCircuitOpen || libraryMembershipCircuitOpen ? (
                <button type="button" onClick={() => window.location.reload()}>RELOAD LOCAL MUSIC</button>
              ) : libraryMutationModeRef.current === "hydrating" && (
                <button type="button" onClick={() => {
                  setLibraryStorageError("");
                  libraryHydrationRetryRequestedRef.current = true;
                  setLibraryRestoreAttempt((value) => value + 1);
                  window.requestAnimationFrame(() => libraryHydrationStatusRef.current?.focus?.());
                }}>RETRY OPENING LOCAL MUSIC</button>
              )}
              {!libraryHydrationCircuitOpen && libraryMutationModeRef.current === "idle" && (
                <button type="button" onClick={() => {
                  setLibraryStorageError("");
                  openLibraryImportPicker();
                }}>CHOOSE MUSIC AGAIN</button>
              )}
            </div>
          )}
          {libraryAnalysisSaveError && (
            <div ref={libraryRoutineWriteAlertRef} tabIndex={-1} className="library-storage-error" role="alert">
              <p>{libraryAnalysisSaveError}</p>
              {libraryRoutineWriteCircuitOpen && (
                <button type="button" onClick={() => window.location.reload()}>RELOAD MAZZY</button>
              )}
            </div>
          )}
          {backgroundAnalysisNotice && (
            <div className="library-storage-error" role="status" aria-live="polite" aria-atomic="true">
              <p>{backgroundAnalysisNotice.message}</p>
              {backgroundAnalysisNotice.retryable && (
                <button
                  type="button"
                  disabled={libraryMutationBusy || autoPilotEnabled || autoMixing || autoMixArming || rehearsalActive || rehearsalPreparing || partyFirstSongOpening || partyFirstSongStarting}
                  onClick={retryDeferredBackgroundAnalysis}
                >RETRY LOCAL ANALYSIS</button>
              )}
            </div>
          )}
          {Object.values(libraryTimingSaveErrors).map((message, index) => (
            <p key={`${message}-${index}`} className="library-storage-error" role="alert">{message}</p>
          ))}

          <div className="queue-panel">
            {queueTracks.length ? (
              queueTracks.map((track, index) => (
                <div
                  key={`${track.id}-${index}`}
                  className="queue-item"
                  draggable={!partyCheckpointBusy}
                  onDragStart={() => {
                    if (partyCheckpointBusyRef.current) return;
                    setDragIndex(index);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (partyCheckpointBusyRef.current || dragIndex == null || dragIndex === index) return;
                    setQueue((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(dragIndex, 1);
                      next.splice(index, 0, moved);
                      return next;
                    });
                    setDragIndex(null);
                  }}
                >
                  <span className="queue-pos">{index + 1}.</span>
                  <span className="queue-name">{`${track.name}${unavailableAutoPilotTrackIds.includes(track.id) ? " · COULDN'T OPEN · SKIPPED" : timedOutAutoPilotTrackIds.includes(track.id) ? " · TOOK TOO LONG · SKIPPED" : ""}`}</span>
                  <span className="queue-meta">
                    {getEffectiveBpm(track) != null ? getEffectiveBpm(track).toFixed(1) : "--"} BPM
                  </span>
                  <span className="queue-meta">
                    {track.keyLabel || (track.key && track.scale ? `${track.key} ${track.scale === "major" ? "maj" : "min"}` : "--")}
                  </span>
                  <button
                    type="button"
                    className="queue-order"
                    aria-label={`Move ${track.name} earlier in queue`}
                    disabled={partyCheckpointBusy || index === 0}
                    onClick={() => setQueue((current) => {
                      const next = [...current];
                      [next[index - 1], next[index]] = [next[index], next[index - 1]];
                      return next;
                    })}
                  >↑</button>
                  <button
                    type="button"
                    className="queue-order"
                    aria-label={`Move ${track.name} later in queue`}
                    disabled={partyCheckpointBusy || index === queueTracks.length - 1}
                    onClick={() => setQueue((current) => {
                      const next = [...current];
                      [next[index], next[index + 1]] = [next[index + 1], next[index]];
                      return next;
                    })}
                  >↓</button>
                  <button
                    type="button"
                    className="queue-remove"
                    aria-label={`Remove ${track.name} from queue`}
                    disabled={partyCheckpointBusy}
                    onClick={() => setQueue((prev) => prev.filter((_, idx) => idx !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))
            ) : (
              <div className="queue-empty">QUEUE EMPTY - click tracks to add</div>
            )}
          </div>

          <div ref={libraryHeadingRef} tabIndex={-1} className="library-title">LIBRARY ({library.length} tracks)</div>

          {library.length > 0 && (
            <div className="library-data-controls">
              <span>Music and analysis are stored only in this browser profile.</span>
              <button type="button" disabled={transitionCompletionUncertain || partyCheckpointBusy || libraryMutationBusy || !!libraryMembershipStatus} onClick={() => void clearLocalLibrary()}>{libraryMutationBusy || libraryMembershipStatus ? "UPDATING LOCAL MUSIC…" : "REMOVE ALL LOCAL MUSIC"}</button>
            </div>
          )}

          <div className={`enhanced-timing-banner ${enhancedTimingAvailable ? "ready" : "basic"}`}>
            <span>
              {enhancedTimingState === "checking"
                ? "CHECKING AUTOMATIC TIMING TOOLS…"
                : enhancedTimingAvailable
                  ? enhancedTimingState === "ready"
                    ? "TIMING MODEL FILES CHECKED · READY TO ANALYZE"
                    : "TIMING MODEL IS CACHED · IT WILL BE CHECKED DURING ANALYSIS"
                  : enhancedTimingState === "offline"
                    ? "CONNECT TO DOWNLOAD THE TIMING MODEL · CONSERVATIVE FADE IS AVAILABLE NOW"
                    : enhancedTimingState === "stored-unavailable"
                      ? __MAZZY_ENHANCED_TIMING_INCLUDED__
                        ? "TIMING MODEL IS STORED · CONNECT TO THIS APP BEFORE USING IT · SAFE FADE IS READY"
                        : "A TIMING MODEL IS STORED FROM ANOTHER BUILD · THIS BUILD WILL NOT USE IT"
                    : enhancedTimingState === "not-included"
                      ? "THIS BUILD DOES NOT INCLUDE ENHANCED TIMING · SAFE FADE IS READY"
                    : enhancedTimingState === "error"
                      ? "TIMING TOOL COULDN'T BE VERIFIED · IT WAS NOT USED · SAFE FADE IS READY"
                      : enhancedTimingState.startsWith("inferring") || enhancedTimingState.includes("model") || enhancedTimingState === "downloading"
                        ? "PREPARING THE 109 MB AUTOMATIC TIMING TOOL…"
                        : "OPTIONAL: DOWNLOAD THE ~109 MB TIMING MODEL · BROWSER STORAGE MAY CLEAR IT"}
            </span>
            {enhancedTimingAvailable || enhancedTimingState === "stored-unavailable" ? (
              <button type="button" onClick={() => void removeTimingModel()}>REMOVE TIMING MODEL</button>
            ) : (
              <button type="button" onClick={() => void prepareTimingModel()} disabled={enhancedTimingState === "downloading" || enhancedTimingState.includes("model") || enhancedTimingState.startsWith("inferring") || enhancedTimingState === "offline" || enhancedTimingState === "not-included"}>
                {enhancedTimingState === "error" ? "RETRY" : "DOWNLOAD TIMING MODEL (~109 MB)"}
              </button>
            )}
          </div>

          <div className="mix-readiness-summary" aria-live="polite">
            <span>{`${library.filter((track) => hasCurrentEnhancedRhythm(track) && ["bar-cut-candidate", "short-sync-candidate", "long-candidate"].includes(track.automaticRhythmTrust?.tier)).length} bar handoff candidates`}</span>
            <span>{`${library.filter((track) => !analyzingIds[track.id] && hasCurrentBasicAnalysis(track) && !(hasCurrentEnhancedRhythm(track) && ["bar-cut-candidate", "short-sync-candidate", "long-candidate"].includes(track.automaticRhythmTrust?.tier))).length} safe-transition tracks`}</span>
            <span>{`${library.filter((track) => analyzingIds[track.id]).length} analyzing`}</span>
            <span>{`${library.filter((track) => {
              const level = normalizeProgramLevel(track.programLevel);
              return track.programLevelStatus === "failed" || (level && level.measurement.status !== "measured");
            }).length} level checks unavailable · neutral trim`}</span>
          </div>

          <div className="library-grid">
            <div className="library-header-row">
              <div className="library-head">TRACK NAME</div>
              <div className="library-head">DURATION</div>
              <div className="library-head">BPM</div>
              <div className="library-head">KEY</div>
              <div className="library-head">MIX READINESS</div>
            </div>

            {library.map((track, index) => {
              const loadedA = loadedByDeck.a === track.id;
              const loadedB = loadedByDeck.b === track.id;
              const analyzing = !!analyzingIds[track.id];
              const enhancedFailed = !!enhancedFailureByTrack[track.id];
              const analysisDeferred = backgroundAnalysisDeferredRef.current.has(backgroundAnalysisJobKey(track.id, "basic-program")) ||
                backgroundAnalysisDeferredRef.current.has(backgroundAnalysisJobKey(track.id, "enhanced"));
              const programLevel = normalizeProgramLevel(track.programLevel);
              const levelUnavailable = track.programLevelStatus === "failed" ||
                (programLevel && programLevel.measurement.status !== "measured");
              const keyCompatible =
                deckAPlaying &&
                deckATrack?.key &&
                deckATrack?.scale &&
                track.key &&
                track.scale &&
                deckATrack.key === track.key &&
                deckATrack.scale === track.scale;
              return (
                <div
                  key={track.id}
                  className={`library-row ${index % 2 ? "odd" : "even"} ${loadedA || loadedB ? "selected" : ""} ${
                    loadedA ? "loaded-a" : loadedB ? "loaded-b" : ""
                  } ${keyCompatible ? "key-compatible" : ""}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (partyCheckpointBusyRef.current || partyFirstSongLoadRef.current) return;
                    contextMenuTriggerRef.current = null;
                    setContextMenu({ x: event.clientX, y: event.clientY, trackId: track.id });
                  }}
                >
                  <div className="cell name-cell">
                  {loadedA && <span className="row-indicator row-a">[A]</span>}
                  {loadedB && <span className="row-indicator row-b">[B]</span>}
                    {!loadedA && !loadedB && queuePositionMap.has(track.id) && (
                    <span className="row-indicator row-q">{`[${queuePositionMap.get(track.id)}]`}</span>
                    )}
                    {track.name}
                    {levelUnavailable && (
                      <span className="level-unavailable">
                        {track.programLevelStatus === "failed"
                          ? " · LEVEL CHECK FAILED · LOAD TO RETRY"
                          : " · LEVEL TRIM OFF"}
                      </span>
                    )}
                    <button
                      className="library-track-action"
                      type="button"
                      disabled={partyCheckpointBusy || libraryMutationBusy || partyFirstSongOpening || partyFirstSongStarting || partyFirstSongStartCircuitOpen || loadedA || loadedB || autoMixing || autoMixArming || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || autoPilotExcludedTrackIds.includes(track.id) || (partySoundStopLocked && !sourcePartyReady)}
                      aria-label={`${loadedA || loadedB ? "Ready" : unavailableAutoPilotTrackIds.includes(track.id) ? autoPilotEnabled ? "Couldn't open; pause Autopilot, then use More actions to retry" : "Couldn't open; use More actions to retry" : timedOutAutoPilotTrackIds.includes(track.id) ? autoPilotEnabled ? "Took too long to prepare; pause Autopilot, then use More actions to retry" : "Took too long to prepare; use More actions to retry" : !sourcePartyReady ? "Choose first song" : autoPilotEnabled || queuePositionMap.has(track.id) ? "Request next" : "Add to queue"}: ${track.name}`}
                      onClick={(event) => void activateLibraryTrack(track, event.currentTarget)}
                    >
                      {loadedA || loadedB
                        ? "READY"
                        : unavailableAutoPilotTrackIds.includes(track.id)
                          ? "USE MORE TO RETRY"
                        : timedOutAutoPilotTrackIds.includes(track.id)
                          ? "USE MORE TO RETRY"
                        : !sourcePartyReady
                          ? "CHOOSE FIRST"
                          : autoPilotEnabled || queuePositionMap.has(track.id)
                            ? "REQUEST NEXT"
                              : "ADD TO QUEUE"}
                    </button>
                    <button
                      className="library-track-more"
                      type="button"
                      disabled={transitionCompletionUncertain || partyCheckpointBusy || libraryMutationBusy || partyFirstSongOpening || partyFirstSongStarting || partyFirstSongStartCircuitOpen}
                      aria-label={`More actions for ${track.name}`}
                      aria-haspopup="menu"
                      aria-expanded={contextMenu?.trackId === track.id}
                      aria-controls={contextMenu?.trackId === track.id ? "track-actions-menu" : undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        contextMenuTriggerRef.current = event.currentTarget;
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setContextMenu({
                          x: Math.max(8, Math.min(bounds.left, window.innerWidth - 178)),
                          y: Math.max(8, Math.min(bounds.bottom, window.innerHeight - 228)),
                          trackId: track.id
                        });
                      }}
                    >
                      MORE
                    </button>
                  </div>
                  <div className="cell">{formatDuration(track.duration)}</div>
                  <div className="cell">
                    {analyzing ? (
                      <span className="spin">○</span>
                    ) : track.analysisStatus === "failed" ? (
                      "--"
                    ) : getEffectiveBpm(track) != null ? (
                      getEffectiveBpm(track).toFixed(1)
                    ) : hasCurrentBasicAnalysis(track) ? (
                      "LOW CONF"
                    ) : (
                      "--"
                    )}
                  </div>
                  <div className="cell">
                    {track.keyLabel ||
                      (track.key && track.scale
                        ? `${track.key} ${track.scale === "major" ? "maj" : "min"}`
                        : hasCurrentBasicAnalysis(track)
                          ? "--"
                          : "--")}
                  </div>
                  <div className="cell mix-readiness-cell">
                    {analyzing
                      ? "FINDING THE BEAT…"
                      : analysisDeferred
                        ? "ANALYSIS DEFERRED THIS SESSION · PLAYBACK NOT YET CHECKED"
                      : unavailableAutoPilotTrackIds.includes(track.id)
                        ? "COULDN’T OPEN · SKIPPED FOR THIS PARTY"
                      : timedOutAutoPilotTrackIds.includes(track.id)
                        ? "TOOK TOO LONG · SKIPPED FOR THIS PARTY"
                      : track.analysisStatus === "failed"
                        ? "FILE COULDN’T BE READ · TRY ANOTHER FORMAT"
                        : enhancedFailed
                          ? "ENHANCED TIMING UNAVAILABLE · SAFE TRANSITION"
                        : hasCurrentBasicAnalysis(track)
                          ? hasCurrentEnhancedRhythm(track) && ["bar-cut-candidate", "short-sync-candidate", "long-candidate"].includes(track.automaticRhythmTrust?.tier)
                            ? "BAR HANDOFF CANDIDATE"
                            : "SAFE TRANSITION READY"
                          : "WAITING"}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </section>
      {contextMenu && (
        <div id="track-actions-menu" ref={contextMenuRef} className="context-menu" role="menu" aria-label="Track actions" onKeyDown={onContextMenuKeyDown} onClick={(event) => event.stopPropagation()} style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            type="button"
            role="menuitem"
            disabled={partySoundStopLocked || partyCheckpointBusy || partyFirstSongStarting || partyFirstSongStartCircuitOpen || autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || deckAPlaying}
            onClick={() => {
              const track = library.find((t) => t.id === contextMenu.trackId);
              if (track && !libraryMutationBusy) {
                void loadTrackToDeck("a", track);
              }
              dismissContextMenu();
            }}
          >
            {deckAPlaying ? "Deck A is playing · keep current song" : "Load to Deck A"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={partySoundStopLocked || partyCheckpointBusy || partyFirstSongStarting || partyFirstSongStartCircuitOpen || autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing || rehearsalCircuitOpen || deckBPlaying}
            onClick={() => {
              const track = library.find((t) => t.id === contextMenu.trackId);
              if (track && !libraryMutationBusy) {
                void loadTrackToDeck("b", track);
              }
              dismissContextMenu();
            }}
          >
            {deckBPlaying ? "Deck B is playing · keep current song" : "Load to Deck B"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={partyCheckpointBusy || partyFirstSongStarting || partyFirstSongStartCircuitOpen || autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing}
            onClick={() => {
              if (!libraryMutationBusy) addToQueue(contextMenu.trackId);
              dismissContextMenu();
            }}
          >
            Add to Queue
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={partyCheckpointBusy || partyFirstSongStarting || partyFirstSongStartCircuitOpen}
            onClick={() => {
              if (!libraryMutationBusy) addToQueue(contextMenu.trackId, true);
              dismissContextMenu();
            }}
          >
            Request Next
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={transitionCompletionUncertain || partyCheckpointBusy || partyFirstSongStarting || partyFirstSongStartCircuitOpen || !!libraryMembershipStatus}
            onClick={() => {
              const trackId = contextMenu.trackId;
              setContextMenu(null);
              void removeLibraryTrack(trackId).catch(() => showToast("Could not remove this track"));
            }}
          >
            Remove from Library
          </button>
        </div>
      )}
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
