import { useEffect, useMemo, useRef, useState } from "react";
import Deck from "./components/Deck";
import { getAudioEngine } from "./audioContext";
import { clearTracksFromDb, deleteTrackFromDb, loadLibraryFromDb, saveTrackToDb, saveTracksToDb } from "./libraryDb";
import { equalPowerGains } from "./planning/transitionMath";
import { disposeAnalysisClient, getAnalysisClient } from "./analysis/AnalysisClient";
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
import { isTimingReviewCurrent, normalizeTimingReview } from "./domain/timingReview";
import {
  analyzeEnhancedRhythm,
  disposeEnhancedRhythmClient,
  getEnhancedRhythmAssetState,
  prepareEnhancedRhythm,
  removeEnhancedRhythmModel
} from "./analysis/enhancedRhythmRuntime";
import { mergeEnhancedRhythm } from "./analysis/mergeEnhancedRhythm";
import { hasCurrentEnhancedRhythm } from "./analysis/enhancedRhythmVersion";
import { sortAnalysisQueue } from "./analysis/analysisQueuePriority";
import { deriveRehearsalSourceCueSeconds, renderTransitionRehearsal } from "./diagnostics/transitionRehearsal";
import { partyEnergyCurve, shiftEnergyCurve } from "./planning/energyProfiles";
import { buildAutoPilotCandidateIds, buildAutoPilotPlanningIds } from "./planning/autoPilotCrate";
import { decideAutoPilotSessionTick } from "./planning/autoPilotSessionDecision";
import {
  shouldCommitAutoPilotPreload,
  shouldDiscardSettledAutoPilotPreload
} from "./planning/autoPilotPreloadOwnership";
import { compileTransitionDsp } from "./audio/transitionDsp";
import {
  createPartySessionClock,
  partySessionClockSnapshot,
  pausePartySessionClock,
  resetPartySessionClock,
  setPartySessionDuration,
  startPartySessionClock
} from "./planning/PartySessionClock";
import {
  createPartyAutopilotTraceRecorder,
  evaluatePartyAutopilotTrace
} from "./diagnostics/partyAutopilotTrace";

const audioExt = [".mp3", ".wav", ".flac", ".aiff", ".m4a"];
const stripExt = (name) => name.replace(/\.[^/.]+$/, "");
const transitionLabel = (template) => template === "phrase-blend"
  ? "SMOOTH PHRASE BLEND"
  : template === "downbeat-cut"
    ? "SHORT BAR-ALIGNED HANDOFF"
    : "SAFE FADE";
const transitionButtonLabel = (template) => template === "phrase-blend"
  ? "AUTO MIX · PHRASE BLEND"
  : template === "downbeat-cut"
    ? "AUTO MIX · BAR HANDOFF"
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
  programLevel: track.programLevel ?? null,
  rhythmDetector: track.rhythmDetector ?? null,
  rhythmAnalysisVersion: track.rhythmAnalysisVersion ?? null,
  rhythmModelSha256: track.rhythmModelSha256 ?? null,
  rhythmBackend: track.rhythmBackend ?? null,
  sampleRate: track.sampleRate ?? null,
  analysisOverrides: normalizeBeatGridOverrides(track.analysisOverrides),
  timingReview: normalizeTimingReview(track.timingReview),
  analysisStatus: track.analysisStatus ?? "pending"
});

export default function App() {
  const [fade, setFade] = useState(0.5);
  const [autoMixing, setAutoMixing] = useState(false);
  const [autoMixArming, setAutoMixArming] = useState(false);
  const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
  const [autoPilotChoice, setAutoPilotChoice] = useState(null);
  const [partyEnergyProfile, setPartyEnergyProfile] = useState("build");
  const [partyEnergyShift, setPartyEnergyShift] = useState(0);
  const [autoPilotUseLibrary, setAutoPilotUseLibrary] = useState(false);
  const [partyDurationMinutes, setPartyDurationMinutes] = useState(180);
  const [partyClockDisplay, setPartyClockDisplay] = useState(() =>
    partySessionClockSnapshot(createPartySessionClock(180 * 60), 0)
  );
  const [playedTrackIds, setPlayedTrackIds] = useState([]);
  const [showPartyReadiness, setShowPartyReadiness] = useState(false);
  const [autoMixBeats, setAutoMixBeats] = useState(null);
  const [transitionInfo, setTransitionInfo] = useState(null);
  const [pairPreview, setPairPreview] = useState(null);
  const [rehearsalStatus, setRehearsalStatus] = useState(null);
  const [rehearsalActive, setRehearsalActive] = useState(false);
  const [showAdvancedMixer, setShowAdvancedMixer] = useState(false);
  const [partyEndingFinalTrack, setPartyEndingFinalTrack] = useState(false);
  const [partyDiagnosticEnabled, setPartyDiagnosticEnabled] = useState(false);
  const [partyDiagnosticEvaluation, setPartyDiagnosticEvaluation] = useState(null);
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
  const [libraryMutationBusy, setLibraryMutationBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [masterMeter, setMasterMeter] = useState({ peakDb: -Infinity, limiterReductionDb: 0 });
  const contextReadyRef = useRef(false);
  const autoMixCountdownFrameRef = useRef(0);
  const masterMeterFrameRef = useRef(0);
  const lastMasterMeterUpdateRef = useRef(0);
  const deckARef = useRef(null);
  const deckBRef = useRef(null);
  const importRef = useRef(null);
  const queuedAnalysisIdsRef = useRef(new Set());
  const pendingAnalysisQueueRef = useRef([]);
  const analysisPriorityRef = useRef({ loaded: [], queued: [] });
  const analysisQueueBusyRef = useRef(false);
  const analysisGenerationRef = useRef(0);
  const removedTrackIdsRef = useRef(new Set());
  const autoPilotPreloadBusyRef = useRef(false);
  const autoPilotTransitionKeyRef = useRef(null);
  const autoPilotPreloadGenerationRef = useRef(0);
  const rehearsalCancelRef = useRef(null);
  const rehearsalGenerationRef = useRef(0);
  const activeTransitionScheduleRef = useRef(null);
  const transitionCompletionCancelRef = useRef(null);
  const transitionArmRef = useRef(false);
  const transitionArmGenerationRef = useRef(0);
  const autoPilotEnabledRef = useRef(false);
  const queueRef = useRef([]);
  const libraryRef = useRef([]);
  const playedTrackIdsRef = useRef([]);
  const partySessionClockRef = useRef(createPartySessionClock(180 * 60));
  const partyReadinessRef = useRef(null);
  const partyStartButtonRef = useRef(null);
  const finalTrackRef = useRef(null);
  const partyTraceRecorderRef = useRef(null);
  const partyTraceRunningRef = useRef(false);
  const partyTrackOrdinalsRef = useRef(new Map());
  const partyLoadByDeckRef = useRef({ a: null, b: null });
  const partyPendingLoadByDeckRef = useRef({ a: null, b: null });
  const partyCommittedPreloadByDeckRef = useRef({ a: null, b: null });
  const partyTrackOrdinalCounterRef = useRef(0);
  const partyLoadOrdinalCounterRef = useRef(0);
  const partyPreloadOperationRef = useRef(0);
  const partyQueueRevisionRef = useRef(0);
  const partyPlayedLoadsRef = useRef(new Set());
  const contextMenuRef = useRef(null);
  const contextMenuTriggerRef = useRef(null);
  const libraryMutationBusyRef = useRef(false);

  useEffect(() => {
    autoPilotEnabledRef.current = autoPilotEnabled;
    queueRef.current = queue;
    libraryRef.current = library;
    playedTrackIdsRef.current = playedTrackIds;
  }, [autoPilotEnabled, queue, library, playedTrackIds]);

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
      autoPilotUseLibrary
    ).includes(autoPilotChoice.afterNextId);
    if (!stillEligible) {
      setAutoPilotChoice((current) => current ? {
        ...current,
        afterNextId: null,
        afterNextName: null,
        reasons: [current.reasons[0], "The later horizon will be replanned.", current.reasons[2]].filter(Boolean)
      } : current);
    }
  }, [autoPilotChoice?.afterNextId, autoPilotUseLibrary, library, loadedByDeck, playedTrackIds, queue]);

  useEffect(() => {
    const update = () => setPartyClockDisplay(
      partySessionClockSnapshot(partySessionClockRef.current, getAudioEngine().clock.now())
    );
    update();
    if (!autoPilotEnabled) return undefined;
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [autoPilotEnabled, partyDurationMinutes]);

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
    autoPilotUseLibrary
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
    pendingAnalysisQueueRef.current = sortAnalysisQueue(
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
    void getEnhancedRhythmAssetState().then((assetState) => {
      const stored = assetState === "stored";
      setEnhancedTimingAvailable(stored);
      setEnhancedTimingState(stored ? "stored" : assetState === "downloadable" ? "not-downloaded" : assetState === "not-included" ? "not-included" : "offline");
    });
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
    await removeEnhancedRhythmModel();
    setEnhancedTimingAvailable(false);
    setEnhancedTimingState(navigator.onLine ? "not-downloaded" : "offline");
  };

  useEffect(() => {
    const engine = getAudioEngine();
    const gains = equalPowerGains(0.5);
    engine.setDeckGain("a", gains.source);
    engine.setDeckGain("b", gains.target);
  }, []);

  useEffect(() => {
    const restore = async () => {
      try {
        const records = await loadLibraryFromDb();
        if (!records.length) {
          return;
        }
        setLibrary(
          records.map((track) => {
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
            programLevel: track.programLevel ?? null,
            rhythmDetector: track.rhythmDetector ?? null,
            rhythmAnalysisVersion: track.rhythmAnalysisVersion ?? null,
            rhythmModelSha256: track.rhythmModelSha256 ?? null,
            rhythmBackend: track.rhythmBackend ?? null,
            sampleRate: track.sampleRate ?? null,
            analysisOverrides: normalizeBeatGridOverrides(track.analysisOverrides),
            timingReview: null,
            analysisStatus: hasCurrentBasicAnalysis(track) ? "ready" : "pending",
            loaded: false
            };
            return {
              ...restored,
              timingReview: timingReview && isTimingReviewCurrent(timingReview, restored)
                ? timingReview
                : null
            };
          })
        );
      } catch (_err) {
        // Ignore failed restore.
      }
    };
    void restore();
  }, []);

  const dismissContextMenu = () => {
    if (contextMenuRef.current?.contains(document.activeElement)) contextMenuTriggerRef.current?.focus?.();
    setContextMenu(null);
  };

  const setLibraryMutationLock = (locked) => {
    libraryMutationBusyRef.current = locked;
    setLibraryMutationBusy(locked);
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

  const activePartySecond = () => Math.max(0, Math.floor(
    partySessionClockSnapshot(partySessionClockRef.current, getAudioEngine().clock.now()).elapsedActiveSeconds
  ));

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
    if (!partyTraceRecorderRef.current || !partyTraceRunningRef.current) return;
    partyTraceRunningRef.current = false;
    recordPartyEvent({ type: "session-paused", reason });
  };

  const stopRehearsal = (message = "Preview stopped. Nothing was saved.") => {
    rehearsalGenerationRef.current += 1;
    rehearsalCancelRef.current?.();
    rehearsalCancelRef.current = null;
    setRehearsalActive(false);
    setRehearsalStatus({ state: "stopped", message });
  };

  const cancelRehearsalPreparation = () => {
    if (!rehearsalPreparing) return;
    rehearsalGenerationRef.current += 1;
    setRehearsalStatus({
      state: "cancelling",
      message: "Cancelling after the current local audio step…"
    });
  };

  const pauseAutoPilotForHostControl = (message = "Party Autopilot paused · you took control") => {
    if (!autoPilotEnabledRef.current) return;
    autoPilotPreloadGenerationRef.current += 1;
    transitionArmGenerationRef.current += 1;
    const now = getAudioEngine().clock.now();
    partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
    setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
    autoPilotEnabledRef.current = false;
    setAutoPilotEnabled(false);
    finalTrackRef.current = null;
    setPartyEndingFinalTrack(false);
    setAutoPilotChoice(null);
    pausePartyDiagnostic("host-control");
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

  const decodeForAnalysis = async (file) => {
    const arrayBuffer = await file.arrayBuffer();
    const analysisCtx = new OfflineAudioContext(1, 1, 44100);
    return analysisCtx.decodeAudioData(arrayBuffer.slice(0));
  };

  const analyzeQueuedTrack = async (track, generation) => {
    setAnalyzingIds((prev) => ({ ...prev, [track.id]: true }));
    try {
      const decoded = await decodeForAnalysis(track.file);
      if (generation !== analysisGenerationRef.current) return;
      let combined = track;
      if (!hasCurrentBasicAnalysis(track)) {
        const result = await getAnalysisClient().analyzeAudioBuffer(decoded);
        if (generation !== analysisGenerationRef.current) return;
        combined = mergeGeneratedAnalysis(track, result);
      }
      if (enhancedTimingAvailable) {
        try {
          const enhanced = await analyzeEnhancedRhythm(decoded, undefined, track.id);
          if (generation !== analysisGenerationRef.current) return;
          combined = mergeEnhancedRhythm(combined, enhanced);
          setEnhancedFailureByTrack((current) => ({ ...current, [track.id]: false }));
        } catch {
          setEnhancedFailureByTrack((current) => ({ ...current, [track.id]: true }));
          // Basic automatic analysis and Safe Fade remain available.
        }
      }
      if (generation !== analysisGenerationRef.current) return;
      setLibrary((prev) =>
        prev.map((item) =>
          item.id === track.id && !removedTrackIdsRef.current.has(track.id)
            ? { ...item, ...combined }
            : item
        )
      );
    } catch (_err) {
      if (generation !== analysisGenerationRef.current) return;
      setLibrary((prev) =>
        prev.map((item) =>
          item.id === track.id && !removedTrackIdsRef.current.has(track.id)
            ? { ...item, analysisStatus: "failed", bpm: null, key: null, scale: null }
            : item
        )
      );
    } finally {
      if (generation === analysisGenerationRef.current) {
        queuedAnalysisIdsRef.current.delete(track.id);
        setAnalyzingIds((prev) => ({ ...prev, [track.id]: false }));
      }
    }
  };

  const processAnalysisQueue = async () => {
    if (analysisQueueBusyRef.current) return;
    analysisQueueBusyRef.current = true;
    const generation = analysisGenerationRef.current;
    try {
      while (pendingAnalysisQueueRef.current.length) {
        pendingAnalysisQueueRef.current = sortAnalysisQueue(
          pendingAnalysisQueueRef.current,
          analysisPriorityRef.current.loaded,
          analysisPriorityRef.current.queued
        );
        const nextTrack = pendingAnalysisQueueRef.current.shift();
        if (generation !== analysisGenerationRef.current) break;
        if (nextTrack) await analyzeQueuedTrack(nextTrack, generation);
      }
    } finally {
      analysisQueueBusyRef.current = false;
      if (pendingAnalysisQueueRef.current.length) queueMicrotask(() => void processAnalysisQueue());
    }
  };

  const queueBackgroundAnalysis = (track) => {
    if (queuedAnalysisIdsRef.current.has(track.id)) return;
    queuedAnalysisIdsRef.current.add(track.id);
    pendingAnalysisQueueRef.current.push(track);
    pendingAnalysisQueueRef.current = sortAnalysisQueue(
      pendingAnalysisQueueRef.current,
      analysisPriorityRef.current.loaded,
      analysisPriorityRef.current.queued
    );
    void processAnalysisQueue();
  };

  useEffect(() => {
    if (!library.length) {
      return;
    }
    let active = true;
    setLibrarySaveStatus("saving");
    void saveTracksToDb(
      library.map(persistedTrack)
    ).then(() => {
      if (active) setLibrarySaveStatus("saved");
    }).catch(() => {
      if (active) setLibrarySaveStatus("error");
    });
    return () => { active = false; };
  }, [library]);

  useEffect(() => {
    library
      .filter(
        (track) =>
          (!hasCurrentBasicAnalysis(track) ||
            (enhancedTimingAvailable === true && !hasCurrentEnhancedRhythm(track))) &&
          track.analysisStatus !== "failed" &&
          !queuedAnalysisIdsRef.current.has(track.id)
      )
      .forEach(queueBackgroundAnalysis);
  }, [library, enhancedTimingAvailable]);

  const handleImportFolder = async (event) => {
    if (libraryMutationBusyRef.current) return;
    const files = Array.from(event.target.files || []);
    const audioFiles = files.filter((file) => {
      const lower = file.name.toLowerCase();
      return audioExt.some((ext) => lower.endsWith(ext));
    });

    const tracks = audioFiles.map((file) => ({
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
      rhythmDetector: null,
      rhythmAnalysisVersion: null,
      rhythmModelSha256: null,
      rhythmBackend: null,
      sampleRate: null,
      analysisOverrides: emptyBeatGridOverrides(),
      timingReview: null,
      analysisStatus: "pending",
      loaded: false
    }));

    for (const track of tracks) removedTrackIdsRef.current.delete(track.id);
    setLibrary((prev) => [...prev, ...tracks]);
    if (importRef.current) {
      importRef.current.value = "";
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

  const onTrackLoaded = (deck, trackId) => {
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
  };

  const onDeckPlayStart = (deck, playKind = "start") => {
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
      setPlayedTrackIds((current) => current.includes(trackId) ? current : [...current, trackId]);
      setQueue((current) => current.filter((id) => id !== trackId));
    }
  };

  const onDeckEnded = (deck, trackId) => {
    const endedIdentity = partyLoadByDeckRef.current[deck];
    if (endedIdentity?.trackId === trackId) {
      recordPartyEvent({
        type: "deck-ended",
        deck,
        trackOrdinal: endedIdentity.trackOrdinal,
        loadOrdinal: endedIdentity.loadOrdinal
      });
    }
    if (finalTrackRef.current?.deck !== deck || finalTrackRef.current?.trackId !== trackId ||
      finalTrackRef.current?.loadOrdinal !== endedIdentity?.loadOrdinal) return;
    const now = getAudioEngine().clock.now();
    partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
    setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
    autoPilotEnabledRef.current = false;
    setAutoPilotEnabled(false);
    finalTrackRef.current = null;
    setPartyEndingFinalTrack(false);
    setAutoPilotChoice(null);
    recordPartyEvent({ type: "session-ended", reason: "final-track-ended" });
    partyTraceRunningRef.current = false;
    showToast("Party finished · no unplayed tracks remain");
  };

  const onAnalysisDetected = (trackId, result) => {
    if (!trackId || libraryMutationBusyRef.current || removedTrackIdsRef.current.has(trackId)) return;
    setLibrary((prev) =>
      prev.map((track) =>
        track.id === trackId && !removedTrackIdsRef.current.has(trackId)
          ? mergeGeneratedAnalysis(track, result)
          : track
      )
    );
  };

  const onEnhancedRhythmDetected = (trackId, enhanced) => {
    if (!trackId || libraryMutationBusyRef.current || removedTrackIdsRef.current.has(trackId)) return;
    setLibrary((previous) => previous.map((track) =>
      track.id === trackId ? mergeEnhancedRhythm(track, enhanced) : track
    ));
  };

  const onProgramLevelDetected = (trackId, programLevel) => {
    if (!trackId || libraryMutationBusyRef.current || removedTrackIdsRef.current.has(trackId)) return;
    setLibrary((previous) => previous.map((track) =>
      track.id === trackId ? { ...track, programLevel } : track
    ));
  };

  const onAnalysisOverrideChange = (trackId, overrides) => {
    if (!trackId || libraryMutationBusyRef.current || removedTrackIdsRef.current.has(trackId)) return;
    setLibrary((prev) =>
      prev.map((track) =>
        track.id === trackId
          ? { ...track, analysisOverrides: normalizeBeatGridOverrides(overrides), timingReview: null }
          : track
      )
    );
  };

  const onTimingReviewSave = async (trackId, overrides, review) => {
    if (!trackId || libraryMutationBusyRef.current || removedTrackIdsRef.current.has(trackId)) return;
    const current = library.find((track) => track.id === trackId);
    if (!current) throw new Error("The reviewed track is no longer in the library");
    const next = {
      ...current,
      analysisOverrides: normalizeBeatGridOverrides(overrides),
      timingReview: normalizeTimingReview(review)
    };
    if (!next.timingReview) throw new Error("The timing answers were invalid");
    await saveTrackToDb(persistedTrack(next));
    setLibrary((previous) => previous.map((track) => track.id === trackId ? next : track));
  };

  const onTimingReviewRemove = async (trackId) => {
    if (!trackId || libraryMutationBusyRef.current || removedTrackIdsRef.current.has(trackId)) return;
    const current = library.find((track) => track.id === trackId);
    if (!current) return;
    const next = { ...current, timingReview: null };
    await saveTrackToDb(persistedTrack(next));
    setLibrary((previous) => previous.map((track) => track.id === trackId ? next : track));
  };

  const removeLibraryTrack = async (trackId) => {
    if (libraryMutationBusyRef.current) return;
    if (autoMixing || autoMixArming || rehearsalActive || rehearsalPreparing) {
      showToast("Stop the transition or preview before removing music");
      return;
    }
    const track = library.find((candidate) => candidate.id === trackId);
    if (!track) return;
    removedTrackIdsRef.current.add(trackId);
    queuedAnalysisIdsRef.current.delete(trackId);
    pendingAnalysisQueueRef.current = pendingAnalysisQueueRef.current.filter((candidate) => candidate.id !== trackId);
    pauseAutoPilotForHostControl("Party Autopilot paused · library changed");
    setLibraryMutationLock(true);
    try {
      await deleteTrackFromDb(trackId);
    } catch {
      removedTrackIdsRef.current.delete(trackId);
      showToast("Removal failed · this track is still stored · try again");
      return;
    } finally {
      setLibraryMutationLock(false);
    }
    setLibrary((current) => current.filter((candidate) => candidate.id !== trackId));
    setQueue((current) => current.filter((id) => id !== trackId));
    if (deckARef.current?.getTrackId?.() === trackId) {
      deckARef.current?.eject?.();
      setLoadedByDeck((current) => ({ ...current, a: null }));
    }
    if (deckBRef.current?.getTrackId?.() === trackId) {
      deckBRef.current?.eject?.();
      setLoadedByDeck((current) => ({ ...current, b: null }));
    }
    showToast("Removed track and its saved local analysis");
  };

  const clearLocalLibrary = async () => {
    if (libraryMutationBusyRef.current) return;
    if (autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing) {
      showToast("Stop Party Autopilot and any preview before clearing music");
      return;
    }
    if (!window.confirm("Remove every imported song and saved analysis from this browser profile? Active enhanced timing may finish its current local step before memory is released.")) return;
    queuedAnalysisIdsRef.current.clear();
    pendingAnalysisQueueRef.current = [];
    for (const track of library) removedTrackIdsRef.current.add(track.id);
    setLibraryMutationLock(true);
    analysisGenerationRef.current += 1;
    disposeAnalysisClient();
    disposeEnhancedRhythmClient();
    deckARef.current?.eject?.();
    deckBRef.current?.eject?.();
    setLoadedByDeck({ a: null, b: null });
    try {
      await clearTracksFromDb();
    } catch {
      for (const track of library) removedTrackIdsRef.current.delete(track.id);
      showToast("Removal failed · your music is still stored · try again");
      return;
    } finally {
      setLibraryMutationLock(false);
    }
    deckARef.current?.eject?.();
    deckBRef.current?.eject?.();
    setQueue([]);
    setPlayedTrackIds([]);
    setLibrary([]);
    setAutoPilotChoice(null);
    showToast("All imported music and saved analysis were removed");
  };

  const loadTrackToDeck = async (deck, track, { autoPilotOwned = false } = {}) => {
    if (libraryMutationBusyRef.current || autoMixing || autoMixArming || rehearsalActive || rehearsalPreparing) return false;
    if (!autoPilotOwned) pauseAutoPilotForHostControl();
    const ref = deck === "a" ? deckARef : deckBRef;
    const ok = await ref.current?.loadTrack?.(track.file, track.id, track);
    if (ok) {
      setLoadedByDeck((prev) => ({ ...prev, [deck]: track.id }));
    }
    return Boolean(ok);
  };

  const addToQueue = (trackId, playNext = false) => {
    setQueue((prev) => {
      const filtered = prev.filter((id) => id !== trackId);
      return playNext ? [trackId, ...filtered] : [...filtered, trackId];
    });
  };

  const activateLibraryTrack = async (track) => {
    const sourceRef = masterDeck === "a" ? deckARef : deckBRef;
    if (!sourceRef.current?.isReady?.()) {
      await loadTrackToDeck(masterDeck, track);
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
    const plan = planAutomaticTransition({
      requestedAt: getAudioEngine().clock.now(),
      source: {
        ...(sourceAnalysis ?? {}),
        trackId: sourceSnapshot.trackId,
        duration: sourceSnapshot.durationSeconds
      },
      target: {
        ...(targetAnalysis ?? {}),
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
    if (autoMixing || autoMixArming || deckARef.current?.isPlaying?.() || deckBRef.current?.isPlaying?.()) return;
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
      if (!pairStillCurrent()) return;
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
      if (!pairStillCurrent()) return;
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
      const rendered = await renderTransitionRehearsal(sourceBuffer, targetBuffer, rehearsalDsp, {
        sourceCueSeconds,
        preRollSeconds,
        postRollSeconds,
        outputSampleRate: sampleRate
      });
      await engine.resume();
      if (!pairStillCurrent()) return;
      rehearsalCancelRef.current = engine.playProtectedPreview(rendered.preview, () => {
        if (rehearsalGenerationRef.current !== generation) return;
        rehearsalCancelRef.current = null;
        setRehearsalActive(false);
        setRehearsalStatus({ state: "complete", message: "Stereo transition rehearsal finished. Nothing was saved." });
      });
      setRehearsalActive(true);
      setRehearsalStatus({
        state: rendered.quality.passed ? "playing" : "warning",
        message: rendered.quality.passed
          ? `${transitionLabel(preview.plan.template)} · stereo pre-master rehearsal · listen to judge the handoff`
          : `Basic render warning · ${rendered.quality.reasons[0]}`
      });
    } catch {
      if (rehearsalGenerationRef.current !== generation) return;
      setRehearsalActive(false);
      setRehearsalStatus({ state: "error", message: "The transition preview could not be rendered." });
    } finally {
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

  const startAutoMix = async (origin = "host") => {
    if (autoMixing || transitionArmRef.current || rehearsalActive) {
      return;
    }
    transitionArmRef.current = true;
    const armGeneration = transitionArmGenerationRef.current + 1;
    transitionArmGenerationRef.current = armGeneration;
    const armIsCurrent = () => transitionArmGenerationRef.current === armGeneration;
    const traceArmStarted = Boolean(partyTraceRecorderRef.current && partyTraceRunningRef.current);
    let traceArmSettled = false;
    if (traceArmStarted) {
      recordPartyEvent({
        type: "arm-started",
        operation: armGeneration,
        origin: origin === "autopilot" ? "autopilot" : "host"
      });
    }
    const settleTraceArm = (outcome) => {
      if (!traceArmStarted || traceArmSettled) return;
      traceArmSettled = true;
      recordPartyEvent({ type: "arm-settled", operation: armGeneration, outcome });
    };
    setAutoMixArming(true);
    const engine = getAudioEngine();
    try {
      await engine.resume();
    } catch {
      settleTraceArm("failed");
      transitionArmRef.current = false;
      setAutoMixArming(false);
      setTransitionInfo({
        active: false,
        template: "safe-fade",
        confidence: 0,
        explanation: "Audio could not start. Click Play and try again.",
        reasons: []
      });
      return;
    }
    if (!armIsCurrent()) {
      settleTraceArm("cancelled");
      transitionArmRef.current = false;
      setAutoMixArming(false);
      return;
    }
    contextReadyRef.current = true;

    const sourceDeck = masterDeck;
    const targetDeck = sourceDeck === "a" ? "b" : "a";
    const sourceRef = sourceDeck === "a" ? deckARef : deckBRef;
    const targetRef = targetDeck === "a" ? deckARef : deckBRef;

    if (!sourceRef.current?.isPlaying?.()) {
      settleTraceArm("cancelled");
      setTransitionInfo({
        active: false,
        template: "safe-fade",
        confidence: 0,
        explanation: "Start the source deck before arming Auto Mix.",
        reasons: []
      });
      transitionArmRef.current = false;
      setAutoMixArming(false);
      return;
    }

    if (!targetRef.current?.isReady?.()) {
      settleTraceArm("cancelled");
      setTransitionInfo({
        active: false,
        template: "safe-fade",
        confidence: 0,
        explanation: "Load a target track before arming Auto Mix.",
        reasons: []
      });
      transitionArmRef.current = false;
      setAutoMixArming(false);
      return;
    }
    if (targetRef.current?.isPlaying?.()) {
      settleTraceArm("cancelled");
      setTransitionInfo({
        active: false,
        template: "safe-fade",
        confidence: 0,
        explanation: "Stop the other deck before starting an automatic transition.",
        reasons: ["Mazzy will not restart a deck that is already playing."]
      });
      transitionArmRef.current = false;
      setAutoMixArming(false);
      return;
    }

    const plannedPair = planCurrentPair();
    if (!plannedPair.plan) {
      settleTraceArm("cancelled");
      transitionArmRef.current = false;
      setAutoMixArming(false);
      return;
    }
    const plan = plannedPair.plan;

    setTransitionInfo({
      active: true,
      template: plan.template,
      confidence: plan.confidence,
      explanation: plan.explanation[0],
      reasons: plan.eligibility.reasons
    });
    let crossfadeSchedule = null;
    const eqSnapshot = {
      sourceLow: Number(sourceRef.current?.getEqBandGain?.("low") ?? 0),
      targetLow: Number(targetRef.current?.getEqBandGain?.("low") ?? 0)
    };

    try {
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
        preparedPlan.schedule.targetCueSeconds
      );
      if (!targetStarted || !armIsCurrent() || !sourceRef.current?.isPlaying?.() ||
        preparedPlan.schedule.startTime - engine.clock.now() < minimumArmLead) {
        targetRef.current?.pause?.();
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
        }
      );
      for (const entry of transitionDsp.source.eqRamps) {
        sourceRef.current?.scheduleEqBandRamp?.(entry.band, entry.ramp.fromDb, entry.ramp.toDb,
          preparedPlan.schedule.startTime + entry.ramp.startOffsetSeconds, entry.ramp.durationSeconds);
      }
      for (const entry of transitionDsp.target.eqRamps) {
        targetRef.current?.scheduleEqBandRamp?.(entry.band, entry.ramp.fromDb, entry.ramp.toDb,
          preparedPlan.schedule.startTime + entry.ramp.startOffsetSeconds, entry.ramp.durationSeconds);
      }
      const completeTransition = () => {
        if (activeTransitionScheduleRef.current?.id !== crossfadeSchedule.id) return;
        if (!engine.finishCrossfade(crossfadeSchedule.id)) {
          partyTraceRecorderRef.current?.markInterrupted?.();
          updatePartyDiagnosticEvaluation();
          return;
        }
        const traceTransition = activeTransitionScheduleRef.current?.traceTransition;
        if (traceTransition) {
          partyPlayedLoadsRef.current.add(`${traceTransition.targetTrackOrdinal}:${traceTransition.targetLoadOrdinal}`);
          recordPartyEvent({
            type: "transition-completed",
            transition: traceTransition.transition,
            targetTrackOrdinal: traceTransition.targetTrackOrdinal,
            targetLoadOrdinal: traceTransition.targetLoadOrdinal
          });
        }
        transitionCompletionCancelRef.current = null;
        activeTransitionScheduleRef.current = null;
        sourceRef.current?.pause?.();
        sourceRef.current?.setEqBandGain?.("low", eqSnapshot.sourceLow);
        targetRef.current?.setEqBandGain?.("low", eqSnapshot.targetLow);
        setFade(targetDeck === "b" ? 1 : 0);
        setAutoMixBeats(0);
        setAutoMixing(false);
        setTransitionInfo((current) => (current ? { ...current, active: false } : current));
        setMasterDeck(targetDeck);
        const completedTargetId = targetRef.current?.getDeckSnapshot?.()?.trackId;
        if (completedTargetId) {
          setPlayedTrackIds((current) => current.includes(completedTargetId) ? current : [...current, completedTargetId]);
        }
        if (autoPilotEnabledRef.current) {
          setAutoPilotChoice(null);
        }
        sourceRef.current?.eject?.();
        partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [sourceDeck]: null };
        partyCommittedPreloadByDeckRef.current = { ...partyCommittedPreloadByDeckRef.current, [targetDeck]: null };
        setLoadedByDeck((current) => ({ ...current, [sourceDeck]: null }));
      };
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
      activeTransitionScheduleRef.current = { ...crossfadeSchedule, ...eqSnapshot, traceTransition };
      settleTraceArm("scheduled");
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
      transitionCompletionCancelRef.current = engine.onCrossfadeComplete(crossfadeSchedule.id, completeTransition);
      transitionArmRef.current = false;
      setAutoMixArming(false);
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
      settleTraceArm(armIsCurrent() ? "failed" : "cancelled");
      if (crossfadeSchedule) {
        transitionCompletionCancelRef.current?.();
        transitionCompletionCancelRef.current = null;
        engine.cancelCrossfade(crossfadeSchedule.id, 1, 0);
      }
      activeTransitionScheduleRef.current = null;
      transitionArmRef.current = false;
      setAutoMixArming(false);
      autoPilotTransitionKeyRef.current = null;
      sourceRef.current?.setEqBandGain?.("low", eqSnapshot.sourceLow);
      targetRef.current?.setEqBandGain?.("low", eqSnapshot.targetLow);
      targetRef.current?.pause?.();
      setAutoMixing(false);
      setAutoMixBeats(0);
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
    engine.cancelCrossfade(
      schedule.id,
      keepChannel === schedule.source ? 1 : 0,
      keepChannel === schedule.target ? 1 : 0
    );
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
    const sourceRef = schedule.source === "a" ? deckARef : deckBRef;
    const targetRef = schedule.target === "a" ? deckARef : deckBRef;
    sourceRef.current?.setEqBandGain?.("low", schedule.sourceLow ?? 0);
    targetRef.current?.setEqBandGain?.("low", schedule.targetLow ?? 0);
    stopRef.current?.pause?.();
    cancelAnimationFrame(autoMixCountdownFrameRef.current);
    transitionCompletionCancelRef.current?.();
    transitionCompletionCancelRef.current = null;
    transitionArmGenerationRef.current += 1;
    activeTransitionScheduleRef.current = null;
    autoPilotTransitionKeyRef.current = null;
    autoPilotEnabledRef.current = false;
    setAutoPilotEnabled(false);
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
      const retainedTargetId = keepRef.current?.getDeckSnapshot?.()?.trackId;
      if (retainedTargetId) {
        setPlayedTrackIds((current) => current.includes(retainedTargetId) ? current : [...current, retainedTargetId]);
      }
      stopRef.current?.eject?.();
      partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [stopChannel]: null };
      setLoadedByDeck((current) => ({ ...current, [stopChannel]: null }));
    } else {
      targetRef.current?.eject?.();
      partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [schedule.target]: null };
      setLoadedByDeck((current) => ({ ...current, [schedule.target]: null }));
    }
    showToast(`Rescue complete · Deck ${keepChannel.toUpperCase()} kept playing`);
  };

  useEffect(() => {
    if (!autoPilotEnabled) {
      autoPilotPreloadGenerationRef.current += 1;
      autoPilotTransitionKeyRef.current = null;
      setAutoPilotChoice(null);
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled || autoMixing) return;
      const sourceDeck = masterDeck;
      const targetDeck = sourceDeck === "a" ? "b" : "a";
      const sourceRef = sourceDeck === "a" ? deckARef : deckBRef;
      const targetRef = targetDeck === "a" ? deckARef : deckBRef;
      const engine = getAudioEngine();
      const now = engine.clock.now();
      const sourceSnapshot = sourceRef.current?.getDeckSnapshot?.() ?? null;
      const targetSnapshot = targetRef.current?.getDeckSnapshot?.() ?? null;
      const sourceLoad = partyLoadByDeckRef.current[sourceDeck];
      const targetLoad = partyLoadByDeckRef.current[targetDeck];
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
          analysis: sourceRef.current?.getAnalysisRecord?.() ?? null
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
          analysis: targetRef.current?.getAnalysisRecord?.() ?? null
        },
        queueTrackIds: queue,
        library,
        playedTrackIds,
        includeRestOfLibrary: autoPilotUseLibrary,
        energyCurve: shiftEnergyCurve(partyEnergyCurve(partyEnergyProfile), partyEnergyShift),
        sessionProgress,
        preloadBusy: autoPilotPreloadBusyRef.current,
        activeTransitionKey: autoPilotTransitionKeyRef.current
      });

      if (decision.kind === "pause-source-stopped") {
        partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
        setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
        autoPilotEnabledRef.current = false;
        setAutoPilotEnabled(false);
        finalTrackRef.current = null;
        setPartyEndingFinalTrack(false);
        setAutoPilotChoice(null);
        pausePartyDiagnostic("source-stopped");
        showToast("Party paused · start a deck to continue");
        return;
      }
      if (decision.kind === "wait-preload" || decision.kind === "wait-target" ||
          decision.kind === "wait-owned-transition" || decision.kind === "wait-cue") return;

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
        const nextTrack = library.find((track) => track.id === decision.trackId);
        if (!nextTrack) return;
        const nextId = nextTrack.id;
        if (autoPilotPreloadBusyRef.current) return;
        autoPilotPreloadBusyRef.current = true;
        const preloadGeneration = ++autoPilotPreloadGenerationRef.current;
        const preloadOperation = ++partyPreloadOperationRef.current;
        const preloadTrackOrdinal = partyTrackOrdinal(nextTrack.id);
        const preloadLoadOrdinal = ++partyLoadOrdinalCounterRef.current;
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
        try {
          const loaded = await loadTrackToDeck(targetDeck, nextTrack, { autoPilotOwned: true });
          const targetSnapshot = targetRef.current?.getDeckSnapshot?.();
          const stillEligible = buildAutoPilotPlanningIds(
            queueRef.current,
            libraryRef.current,
            playedTrackIdsRef.current,
            [sourceSnapshot?.trackId],
            autoPilotUseLibrary
          ).includes(nextTrack.id);
          const settlement = {
            loaded,
            autoPilotEnabled: autoPilotEnabledRef.current,
            operationCurrent: autoPilotPreloadGenerationRef.current === preloadGeneration,
            stillEligible,
            requestedTrackId: nextTrack.id,
            targetTrackId: targetSnapshot?.trackId ?? null,
            targetPlaying: Boolean(targetRef.current?.isPlaying?.())
          };
          if (shouldCommitAutoPilotPreload(settlement)) {
            partyCommittedPreloadByDeckRef.current = {
              ...partyCommittedPreloadByDeckRef.current,
              [targetDeck]: { trackOrdinal: preloadTrackOrdinal, loadOrdinal: preloadLoadOrdinal }
            };
            recordPartyEvent({ type: "preload-settled", operation: preloadOperation, outcome: "committed" });
            setQueue((current) => current[0] === nextId ? current.slice(1) : current.filter((id) => id !== nextId));
            setAutoPilotChoice({
              trackId: nextTrack.id,
              name: nextTrack.name,
              afterNextId: decision.afterNextTrackId,
              afterNextName: libraryRef.current.find((track) => track.id === decision.afterNextTrackId)?.name ?? null,
              reasons: decision.reasons
            });
            showToast(`Autopilot planned two songs ahead · ${decision.reasons[0] ?? "Queue order preserved."}`);
          } else if (shouldDiscardSettledAutoPilotPreload(settlement)) {
            recordPartyEvent({
              type: "preload-settled",
              operation: preloadOperation,
              outcome: settlement.operationCurrent ? "discarded" : "superseded"
            });
            targetRef.current?.eject?.();
            setLoadedByDeck((current) => ({ ...current, [targetDeck]: null }));
            partyLoadByDeckRef.current = { ...partyLoadByDeckRef.current, [targetDeck]: null };
          } else {
            recordPartyEvent({
              type: "preload-settled",
              operation: preloadOperation,
              outcome: loaded ? "superseded" : "failed"
            });
          }
        } finally {
          const pending = partyPendingLoadByDeckRef.current[targetDeck];
          if (pending?.loadOrdinal === preloadLoadOrdinal) {
            partyPendingLoadByDeckRef.current = { ...partyPendingLoadByDeckRef.current, [targetDeck]: null };
          }
          autoPilotPreloadBusyRef.current = false;
        }
        return;
      }

      if (decision.kind !== "arm" || !sourceSnapshot || !targetSnapshot) return;
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
    void tick();
    const timer = window.setInterval(() => void tick(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [autoPilotEnabled, autoMixing, masterDeck, queue, library, loadedByDeck, playedTrackIds, partyEnergyProfile, partyEnergyShift, autoPilotUseLibrary]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(autoMixCountdownFrameRef.current);
      transitionCompletionCancelRef.current?.();
      rehearsalGenerationRef.current += 1;
      rehearsalCancelRef.current?.();
    };
  }, []);

  const masterPeakPercent = Number.isFinite(masterMeter.peakDb)
    ? Math.max(0, Math.min(100, ((masterMeter.peakDb + 60) / 60) * 100))
    : 0;
  const sourcePartyRef = masterDeck === "a" ? deckARef : deckBRef;
  const sourcePartyReady = !!sourcePartyRef.current?.isReady?.();
  const sourcePartyPlaying = !!sourcePartyRef.current?.isPlaying?.();
  const pausePartyAutopilot = () => {
    autoPilotPreloadGenerationRef.current += 1;
    transitionArmGenerationRef.current += 1;
    const now = getAudioEngine().clock.now();
    partySessionClockRef.current = pausePartySessionClock(partySessionClockRef.current, now);
    setPartyClockDisplay(partySessionClockSnapshot(partySessionClockRef.current, now));
    autoPilotEnabledRef.current = false;
    setAutoPilotEnabled(false);
    finalTrackRef.current = null;
    setPartyEndingFinalTrack(false);
    setShowPartyReadiness(false);
    pausePartyDiagnostic("host-request");
  };
  const startPartyAutopilot = () => {
    const now = getAudioEngine().clock.now();
    partySessionClockRef.current = startPartySessionClock(partySessionClockRef.current, now);
    startOrResumePartyDiagnostic(masterDeck);
    autoPilotEnabledRef.current = true;
    setAutoPilotEnabled(true);
    setShowPartyReadiness(false);
  };
  const resetPartyAutopilot = () => {
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
    partyPreloadOperationRef.current = 0;
    partyQueueRevisionRef.current = 0;
    partyPlayedLoadsRef.current = new Set();
    setPartyDiagnosticEvaluation(null);
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
  const startCurrentSong = async () => {
    if (!sourcePartyReady || sourcePartyPlaying || autoPilotEnabled) return;
    await sourcePartyRef.current?.play?.();
  };
  const partyModeStatus = partyEndingFinalTrack
    ? "Final song is playing. The session will finish when it ends."
    : autoMixing
    ? `Changing songs with ${transitionInfo?.template === "downbeat-cut" ? "a short timed handoff" : "a conservative fade"}.`
    : autoPilotEnabled
      ? "Party Autopilot is choosing and preparing the next song."
      : sourcePartyPlaying
        ? "Music is playing. Start Party Autopilot when your queue is ready."
        : sourcePartyReady
          ? "Your first song is loaded and ready to play."
          : library.length
            ? "Choose a song from your library below to begin."
            : "Import a music folder to begin.";

  return (
    <main className="app">
      <section className="party-mode" aria-labelledby="party-mode-title">
        <div className="party-mode-heading">
          <div>
            <span>MAZZY PARTY MODE</span>
            <h1 id="party-mode-title">Run the music without DJ skills</h1>
          </div>
          <button type="button" onClick={() => setShowAdvancedMixer((value) => !value)} aria-expanded={showAdvancedMixer} aria-controls="advanced-mixer">
            {showAdvancedMixer ? "HIDE ADVANCED MIXER" : "SHOW ADVANCED MIXER"}
          </button>
        </div>
        <p className="party-mode-status" role="status">{partyModeStatus}</p>
        <div className="party-mode-flow" aria-label="Party setup steps">
          <button type="button" onClick={() => importRef.current?.click()}>
            <span>1</span><strong>IMPORT MUSIC</strong><small>Saved only in this browser</small>
          </button>
          <button type="button" onClick={() => void startCurrentSong()} disabled={!sourcePartyReady || sourcePartyPlaying || autoPilotEnabled}>
            <span>2</span><strong>{sourcePartyPlaying ? "FIRST SONG PLAYING" : "PLAY FIRST SONG"}</strong><small>{sourcePartyReady ? nowPlayingTrack?.name ?? "Loaded track" : "Choose a song below"}</small>
          </button>
          <button ref={partyStartButtonRef} type="button" onClick={() => autoPilotEnabled ? pausePartyAutopilot() : setShowPartyReadiness(true)} disabled={!sourcePartyPlaying && !autoPilotEnabled}>
            <span>3</span><strong>{autoPilotEnabled ? "PAUSE AUTOPILOT" : "START AUTOPILOT"}</strong><small>{autoPilotEnabled ? "Music keeps playing" : "Mazzy handles later songs"}</small>
          </button>
        </div>
        {!autoPilotEnabled && (
          <div className="party-mode-options" aria-label="Party playback choices">
            <label htmlFor="party-mode-duration">
              Planned party length
              <select
                id="party-mode-duration"
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
              <input type="checkbox" checked={autoPilotUseLibrary} onChange={(event) => setAutoPilotUseLibrary(event.target.checked)} />
              Continue with unqueued library songs when the queue ends
            </label>
            <label>
              <input
                type="checkbox"
                checked={partyDiagnosticEnabled}
                disabled={partyTraceRecorderRef.current !== null}
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
              <button type="button" disabled={!partyReadiness.canStart} onClick={() => {
                startPartyAutopilot();
                window.requestAnimationFrame(() => partyStartButtonRef.current?.focus?.());
              }}>START PARTY AUTOPILOT</button>
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
            <button type="button" onClick={() => void startAutoMix()} disabled={!autoPilotEnabled || autoMixing || autoMixArming || !pairPreview?.plan}>CHANGE SONG NOW</button>
            {autoMixing && <button className="party-emergency" type="button" onClick={rescueTransition}>STOP AUTOMATIC TRANSITION</button>}
          </div>
        )}
        <p className="party-tab-note">Party progress lives in this tab and resets if the page is refreshed.</p>
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
            onDeckEnded={onDeckEnded}
            flash={deckFlash.a}
            transitionLocked={autoMixing || autoMixArming || autoPilotEnabled}
            rehearsalLocked={rehearsalActive || rehearsalPreparing}
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
              disabled={autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing}
            />
            <button className="auto-mix-btn" type="button" onClick={startAutoMix} disabled={autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing}>
              {autoMixArming
                ? "ARMING SAFE TRANSITION…"
                : autoMixing
                ? transitionInfo?.template === "phrase-blend"
                  ? `PHRASE BLEND: ${autoMixBeats ?? 0} beats`
                  : `${transitionInfo?.template === "downbeat-cut" ? "BAR HANDOFF" : "SAFE FADE"}: ${Number(autoMixBeats ?? 0).toFixed(1)}s`
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
              disabled={rehearsalActive || rehearsalPreparing}
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
            <a className="device-check-link" href="/device-soak.html" target="_blank" rel="noreferrer">
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
                disabled={autoMixing || autoMixArming || !pairPreview?.plan}
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
                    onClick={() => {
                      resetPartyAutopilot();
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
                    disabled={!partyReadiness.canStart}
                    onClick={() => {
                      startPartyAutopilot();
                    }}
                  >
                    START AUTOPILOT
                  </button>
                </div>
              </section>
            )}
            {!autoMixing && pairPreview?.plan && (
              <div className={`pair-plan-preview ${pairPreview.plan.template === "downbeat-cut" ? "handoff" : pairPreview.plan.template === "phrase-blend" ? "phrase" : "safe"}`} aria-live="polite">
                <span>{`NEXT · ${transitionLabel(pairPreview.plan.template)}`}</span>
                <small>
                  {pairPreview.plan.template === "downbeat-cut"
                    ? pairPreview.plan.explanation[0]
                    : pairPreview.plan.template === "phrase-blend"
                      ? "This pair passed the calibrated long-blend gate."
                      : previewReason(pairPreview.plan)}
                </small>
              </div>
            )}
            {!autoPilotEnabled && !autoMixing && pairPreview?.plan && (
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
                    disabled={autoMixArming || deckARef.current?.isPlaying?.() || deckBRef.current?.isPlaying?.()}
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
                  transitionInfo.template === "phrase-blend" ? "phrase" : transitionInfo.template === "downbeat-cut" ? "handoff" : "safe"
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
            onDeckEnded={onDeckEnded}
            flash={deckFlash.b}
            transitionLocked={autoMixing || autoMixArming || autoPilotEnabled}
            rehearsalLocked={rehearsalActive || rehearsalPreparing}
          />
        </div>
      </section>

      <section className="library-section">
        <section className="library-panel">
          <div className="queue-header">
            <div className="queue-title">{`QUEUE (${queue.length} tracks)`}</div>
            <div className="library-top-spacer" />
            <button className="library-top-btn" type="button" onClick={() => importRef.current?.click()}>
              IMPORT
            </button>
            <input ref={importRef} type="file" multiple accept=".mp3,.wav,.flac" onChange={handleImportFolder} hidden />
            <button className="library-top-btn" type="button" onClick={() => setQueue([])}>
              CLEAR
            </button>
          </div>

          <p className="library-storage-notice">
            Imported music and analysis are saved in this browser profile until you remove them. Nothing is uploaded.
          </p>

          <div className="queue-panel">
            {queueTracks.length ? (
              queueTracks.map((track, index) => (
                <div
                  key={`${track.id}-${index}`}
                  className="queue-item"
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragIndex == null || dragIndex === index) return;
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
                  <span className="queue-name">{track.name}</span>
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
                    disabled={index === 0}
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
                    disabled={index === queueTracks.length - 1}
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

          <div className="library-title">LIBRARY ({library.length} tracks)</div>

          {library.length > 0 && (
            <div className="library-data-controls">
              <span>Music and analysis are stored only in this browser profile.</span>
              <button type="button" disabled={libraryMutationBusy} onClick={() => void clearLocalLibrary()}>{libraryMutationBusy ? "UPDATING LOCAL MUSIC…" : "REMOVE ALL LOCAL MUSIC"}</button>
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
                    : enhancedTimingState === "not-included"
                      ? "THIS BUILD DOES NOT INCLUDE ENHANCED TIMING · SAFE FADE IS READY"
                    : enhancedTimingState === "error"
                      ? "TIMING TOOL COULDN'T BE VERIFIED · IT WAS NOT USED · SAFE FADE IS READY"
                      : enhancedTimingState.startsWith("inferring") || enhancedTimingState.includes("model") || enhancedTimingState === "downloading"
                        ? "PREPARING THE 109 MB AUTOMATIC TIMING TOOL…"
                        : "OPTIONAL: DOWNLOAD THE ~109 MB TIMING MODEL · BROWSER STORAGE MAY CLEAR IT"}
            </span>
            {enhancedTimingAvailable ? (
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
                    <button
                      className="library-track-action"
                      type="button"
                      disabled={libraryMutationBusy || loadedA || loadedB || autoMixing || autoMixArming || rehearsalActive || rehearsalPreparing}
                      aria-label={`${loadedA || loadedB ? "Ready" : !sourcePartyReady ? "Choose first song" : autoPilotEnabled || queuePositionMap.has(track.id) ? "Request next" : "Add to queue"}: ${track.name}`}
                      onClick={() => void activateLibraryTrack(track)}
                    >
                      {loadedA || loadedB
                        ? "READY"
                        : !sourcePartyReady
                          ? "CHOOSE FIRST"
                          : autoPilotEnabled || queuePositionMap.has(track.id)
                            ? "REQUEST NEXT"
                              : "ADD TO QUEUE"}
                    </button>
                    <button
                      className="library-track-more"
                      type="button"
                      disabled={libraryMutationBusy}
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
                      : track.analysisStatus === "failed"
                        ? "SAFE TRANSITION"
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
            disabled={autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing}
            onClick={() => {
              const track = library.find((t) => t.id === contextMenu.trackId);
              if (track && !libraryMutationBusy) {
                void loadTrackToDeck("a", track);
              }
              dismissContextMenu();
            }}
          >
            Load to Deck A
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing}
            onClick={() => {
              const track = library.find((t) => t.id === contextMenu.trackId);
              if (track && !libraryMutationBusy) {
                void loadTrackToDeck("b", track);
              }
              dismissContextMenu();
            }}
          >
            Load to Deck B
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={autoMixing || autoMixArming || autoPilotEnabled || rehearsalActive || rehearsalPreparing}
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
