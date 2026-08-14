import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { getAudioEngine } from "../audioContext";
import { DECK_LOAD_OUTCOME } from "../audio/deckLoadOutcome";
import { AnalysisClient, getAnalysisClient } from "../analysis/AnalysisClient";
import { hasCurrentBasicAnalysis } from "../analysis/analysisVersion";
import { normalizeProgramLevel } from "../analysis/programLevel";
import { programLevelFailurePolicy } from "../analysis/programLevelRuntime";
import {
  buildEffectiveBeatGrid,
  emptyBeatGridOverrides,
  nudgeBeatGrid,
  normalizeBeatGridOverrides,
  scaleCorrectedBpm,
  setBeatAtTime,
  setDownbeatAtTime
} from "../analysis/beatGridCorrections";
import BeatGridOverlay from "./BeatGridOverlay";
import { startBeatGridAudition } from "../audio/BeatGridAudition";
import {
  captureDeckTransportAuthority,
  createDeckTransportAuthority,
  invalidateDeckTransportAuthority,
  ownsDeckTransportAuthority
} from "../audio/deckTransportAuthority";
import { appendTap, applyTapTempo, estimateTapTempo, MIN_TAP_COUNT } from "../analysis/tapTempo";
import { createTimingReview, isTimingReviewCurrent } from "../domain/timingReview";
import { analyzeEnhancedRhythm } from "@mazzy/enhanced-rhythm";
import { mergeEnhancedRhythm } from "../analysis/mergeEnhancedRhythm";
import { hasCurrentEnhancedRhythm } from "../analysis/enhancedRhythmVersion";

const clampTempo = (value) => Math.max(0.5, Math.min(1.5, value));
const manualGridFields = (overrides) => ({
  correctedBpm: overrides.correctedBpm ?? null,
  firstBeatSeconds: overrides.firstBeatSeconds ?? null,
  firstDownbeatBeatIndex: overrides.firstDownbeatBeatIndex ?? null
});
const manualGridChanged = (before, after) =>
  JSON.stringify(manualGridFields(before)) !== JSON.stringify(manualGridFields(after));

const readFileAsArrayBuffer = (file, signal) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      try { reader.abort(); } catch { /* reader already settled */ }
      finish(reject, new Error("Audio file read cancelled"));
    };
    reader.onload = () => finish(resolve, reader.result);
    reader.onerror = () => finish(reject, new Error("Failed to read audio file"));
    reader.onabort = () => finish(reject, new Error("Audio file read cancelled"));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    reader.readAsArrayBuffer(file);
  });

const formatTime = (seconds) => {
  const safe = Math.max(0, Math.floor(seconds));
  const min = Math.floor(safe / 60);
  const sec = String(safe % 60).padStart(2, "0");
  return `${min}:${sec}`;
};

const parseTimeToSeconds = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const sec = Number(parts[0]);
    return Number.isFinite(sec) ? sec : null;
  }
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!Number.isFinite(min) || !Number.isFinite(sec)) {
      return null;
    }
    return min * 60 + sec;
  }
  return null;
};

const Deck = forwardRef(function Deck(
  {
    title,
    channel,
    color,
    contextReadyRef,
    otherBpm,
    onBpmChange,
    onTrackLoaded,
    onAnalysisDetected,
    onEnhancedRhythmDetected,
    onProgramLevelDetected,
    enhancedTimingAvailable,
    onAnalysisOverrideChange,
    onTimingReviewSave,
    onTimingReviewRemove,
    librarySaveStatus,
    onDeckPlayStart,
    onAuxAudioStart,
    onStopAllSound,
    onDeckEnded,
    onAudioStartError,
    playbackStartLocked = false,
    playbackStartLockRef,
    flash,
    transitionLocked = false,
    rehearsalLocked = false
  },
  ref
) {
  const waveformRef = useRef(null);
  const fileInputRef = useRef(null);
  const wavesurferRef = useRef(null);
  const lastObjectUrlRef = useRef(null);
  const rafRef = useRef(0);
  const releaseRafRef = useRef(0);
  const currentTrackIdRef = useRef(null);
  const loadGenerationRef = useRef(0);
  const transportAuthorityRef = useRef(createDeckTransportAuthority());
  const loadAbortControllerRef = useRef(null);
  const isolatedAnalysisClientRef = useRef(null);
  const metronomeCancelRef = useRef(null);
  const metronomeUiTimerRef = useRef(0);
  const clickPulseTimersRef = useRef([]);
  const timingWizardTriggerRef = useRef(null);
  const timingWizardDialogRef = useRef(null);
  const timingWizardCloseRef = useRef(null);
  const timingWizardTitleId = useId();
  const timingWizardDescriptionId = useId();
  const deckEngineRef = useRef(null);
  const interactionLocked = transitionLocked || rehearsalLocked;
  const startOrLoadLocked = interactionLocked || playbackStartLocked || playbackStartLockRef?.current;
  const interactionLockedRef = useRef(interactionLocked);
  const previousDeckStatusRef = useRef("idle");
  const onDeckEndedRef = useRef(onDeckEnded);
  interactionLockedRef.current = interactionLocked;
  onDeckEndedRef.current = onDeckEnded;
  if (!deckEngineRef.current) {
    deckEngineRef.current = getAudioEngine().getDeck(channel);
  }
  const deckEngine = deckEngineRef.current;

  const [fileReady, setFileReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [timeInput, setTimeInput] = useState("");
  const [trackName, setTrackName] = useState("NO TRACK LOADED");
  const [bpmLabel, setBpmLabel] = useState("--");
  const [keyLabel, setKeyLabel] = useState("--");
  const [tempo, setTempo] = useState(1);
  const [originalBpm, setOriginalBpm] = useState(null);
  const [syncActive, setSyncActive] = useState(false);
  const [syncTargetBpm, setSyncTargetBpm] = useState(null);
  const [scratch, setScratch] = useState(false);
  const [rotationDuration, setRotationDuration] = useState(1.8);
  const [eq, setEq] = useState({ low: 0, mid: 0, high: 0 });
  const [eqKill, setEqKill] = useState({ low: false, mid: false, high: false });
  const [deckStatus, setDeckStatus] = useState(deckEngine.getSnapshot().status);
  const [analysisRecord, setAnalysisRecord] = useState(null);
  const [programLevelRuntimeStatus, setProgramLevelRuntimeStatus] = useState("pending");
  const [metronomeActive, setMetronomeActive] = useState(false);
  const [clickPulse, setClickPulse] = useState(null);
  const [timingWizard, setTimingWizard] = useState(null);
  const [tapTimes, setTapTimes] = useState([]);
  const [timingReviewSaveStatus, setTimingReviewSaveStatus] = useState("idle");
  const eqBeforeKillRef = useRef({ low: 0, mid: 0, high: 0 });

  const effectiveGrid = useMemo(
    () =>
      analysisRecord
        ? buildEffectiveBeatGrid(analysisRecord)
        : {
            bpm: null,
            beatsSeconds: [],
            downbeatsSeconds: [],
            meter: 4,
            overrides: emptyBeatGridOverrides(),
            isManual: false
          },
    [analysisRecord]
  );
  const previewAnalysis = timingWizard && analysisRecord
    ? { ...analysisRecord, analysisOverrides: timingWizard.draftOverrides }
    : analysisRecord;
  const previewGrid = useMemo(
    () => previewAnalysis ? buildEffectiveBeatGrid(previewAnalysis) : effectiveGrid,
    [previewAnalysis, effectiveGrid]
  );
  const tapEstimate = useMemo(() => estimateTapTempo(tapTimes), [tapTimes]);
  const savedTimingReview = analysisRecord?.timingReview &&
    isTimingReviewCurrent(analysisRecord.timingReview, analysisRecord)
    ? analysisRecord.timingReview
    : null;
  const automaticTrust = analysisRecord?.automaticRhythmTrust ?? null;
  const currentProgramLevel = normalizeProgramLevel(analysisRecord?.programLevel);
  const programLevelRangeLabel = currentProgramLevel?.measurement.loudnessRangeLu == null
    ? "level range unavailable"
    : `level range ${currentProgramLevel.measurement.loudnessRangeLu.toFixed(1)} LU${currentProgramLevel.measurement.loudnessRangeStatus === "provisional" ? " · early estimate" : ""}`;
  const programLevelLabel = programLevelRuntimeStatus === "failed"
    ? "level check failed · no trim"
    : !currentProgramLevel
    ? "automatic loudness trim pending"
    : currentProgramLevel.measurement.status === "measured"
      ? `automatic loudness trim ${currentProgramLevel.normalization.trimDb > 0 ? "+" : ""}${currentProgramLevel.normalization.trimDb.toFixed(1)} dB · ${programLevelRangeLabel}`
      : currentProgramLevel.measurement.status === "unsupported-channels"
        ? "loudness matching unavailable for this file · no trim"
        : currentProgramLevel.measurement.status === "silence"
          ? "loudness not measured · no trim"
          : "loudness analysis unavailable · no trim";
  const currentEnhancedTiming = hasCurrentEnhancedRhythm(analysisRecord);
  const automaticBarHandoff = currentEnhancedTiming &&
    ["bar-cut-candidate", "short-sync-candidate", "long-candidate"].includes(automaticTrust?.tier);
  const automaticTimingLabel = !analysisRecord
    ? "Waiting for automatic analysis"
    : effectiveGrid.isManual
      ? "Manual timing — safe transitions only"
      : automaticBarHandoff
        ? "Automatic bar timing found"
      : automaticTrust?.tier === "reject"
        ? "Timing uncertain — Safe transition ready"
        : "Automatic timing checked — Safe transition ready";

  const ensureGraphReady = async () => {
    const engine = getAudioEngine();
    await engine.resume();
    contextReadyRef.current = true;
    return engine.context;
  };

  const getCurrentTime = () => deckEngine.getPosition();

  const play = async (offset = null, when = null, notifyMaster = true, startAuthority = null) => {
    if (playbackStartLocked || playbackStartLockRef?.current) return false;
    const transportRevision = captureDeckTransportAuthority(transportAuthorityRef.current);
    try {
      await ensureGraphReady();
    } catch {
      onAudioStartError?.(getAudioEngine().context.state);
      return false;
    }
    if (!ownsDeckTransportAuthority(transportAuthorityRef.current, transportRevision) ||
      playbackStartLockRef?.current || (startAuthority && !startAuthority())) return false;
    if (!deckEngine.isReady()) {
      return false;
    }

    const statusBeforePlay = deckEngine.getSnapshot().status;
    const startAt = when == null ? getAudioEngine().clock.now() : when;
    if (!ownsDeckTransportAuthority(transportAuthorityRef.current, transportRevision) ||
      (startAuthority && !startAuthority())) return false;
    deckEngine.play(offset ?? undefined, startAt);
    if (when == null) {
      if (notifyMaster) {
        onDeckPlayStart?.(
          channel,
          statusBeforePlay === "ended" ? "restart" : statusBeforePlay === "paused" ? "resume" : "start"
        );
      }
    }
    return true;
  };

  const pause = () => {
    invalidateDeckTransportAuthority(transportAuthorityRef.current);
    stopMetronomeAudition();
    return deckEngine.pause();
  };

  const seek = async (seconds) => {
    if (interactionLocked || playbackStartLocked || playbackStartLockRef?.current) return false;
    stopMetronomeAudition();
    if (timingWizard?.step === 2) setTapTimes([]);
    const snapshot = deckEngine.getSnapshot();
    if (!deckEngine.isReady()) {
      return;
    }
    const safeOffset = Math.max(0, Math.min(seconds, Math.max(snapshot.durationSeconds - 0.01, 0)));
    deckEngine.seek(safeOffset);

    setScratch(true);
    window.setTimeout(() => setScratch(false), 140);

    wavesurferRef.current?.seekTo(safeOffset / snapshot.durationSeconds);
    setCurrentTimeSec(safeOffset);
    return true;
  };

  const applyAnalysis = (result, trackId, reportToLibrary = true) => {
    const nextRecord = {
      ...result,
      analysisStatus: "ready",
      analysisOverrides: normalizeBeatGridOverrides(result.analysisOverrides)
    };
    const grid = buildEffectiveBeatGrid(nextRecord);
    setAnalysisRecord(nextRecord);
    setOriginalBpm(grid.bpm);
    setBpmLabel(grid.bpm == null ? "n/a" : String(Math.round(grid.bpm * 10) / 10));
    onBpmChange(channel, grid.bpm);
    const keyString =
      result.key && result.scale
        ? `${result.key} ${result.scale === "major" ? "maj" : "min"}`
        : "--";
    setKeyLabel(keyString);
    if (trackId && reportToLibrary) onAnalysisDetected?.(trackId, result);
  };

  const commitGridOverrides = (overrides) => {
    if (!analysisRecord) return;
    const normalized = normalizeBeatGridOverrides(overrides);
    const nextRecord = { ...analysisRecord, analysisOverrides: normalized, timingReview: null };
    const grid = buildEffectiveBeatGrid(nextRecord);
    setAnalysisRecord(nextRecord);
    setOriginalBpm(grid.bpm);
    setBpmLabel(grid.bpm == null ? "n/a" : String(Math.round(grid.bpm * 10) / 10));
    onBpmChange(channel, grid.bpm);
    onAnalysisOverrideChange?.(currentTrackIdRef.current, normalized);
  };

  const stopMetronomeAudition = () => {
    metronomeCancelRef.current?.();
    metronomeCancelRef.current = null;
    window.clearTimeout(metronomeUiTimerRef.current);
    clickPulseTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    clickPulseTimersRef.current = [];
    setClickPulse(null);
    setMetronomeActive(false);
  };

  const auditionBeatGrid = async () => {
    if (metronomeActive) {
      stopMetronomeAudition();
      return;
    }
    if (playbackStartLocked || playbackStartLockRef?.current || !deckEngine.isActive() || !previewGrid.beatsSeconds.length) return;
    const transportRevision = captureDeckTransportAuthority(transportAuthorityRef.current);
    const engine = getAudioEngine();
    await engine.resume();
    if (!ownsDeckTransportAuthority(transportAuthorityRef.current, transportRevision) ||
      playbackStartLocked || playbackStartLockRef?.current) return;
    const audition = startBeatGridAudition(engine, {
      beatsSeconds: previewGrid.beatsSeconds,
      downbeatsSeconds: previewGrid.downbeatsSeconds,
      playbackRate: deckEngine.getPlaybackRate(),
      getTrackPosition: (audioTime) => deckEngine.getPosition(audioTime),
      maxBeats: 16
    });
    if (!audition.events.length) return;
    onAuxAudioStart?.();
    metronomeCancelRef.current = audition.cancel;
    setMetronomeActive(true);
    clickPulseTimersRef.current = audition.events.flatMap((event) => {
      const delayMs = Math.max(0, (event.audioTime - engine.clock.now()) * 1000);
      const showTimer = window.setTimeout(
        () => setClickPulse(event.downbeat ? "one" : "beat"),
        delayMs
      );
      const hideTimer = window.setTimeout(() => setClickPulse(null), delayMs + 110);
      return [showTimer, hideTimer];
    });
    const finalEvent = audition.events[audition.events.length - 1];
    const remainingMs = Math.max(100, (finalEvent.audioTime - engine.clock.now() + 0.1) * 1000);
    metronomeUiTimerRef.current = window.setTimeout(stopMetronomeAudition, remainingMs);
  };

  useEffect(() => {
    if (playbackStartLocked) stopMetronomeAudition();
  }, [playbackStartLocked]);

  const openTimingWizard = () => {
    if (!analysisRecord) return;
    stopMetronomeAudition();
    setTapTimes([]);
    setTimingWizard({
      step: 0,
      trackId: currentTrackIdRef.current,
      loadGeneration: loadGenerationRef.current,
      originalOverrides: normalizeBeatGridOverrides(analysisRecord.analysisOverrides),
      draftOverrides: normalizeBeatGridOverrides(analysisRecord.analysisOverrides),
      changed: false,
      adjustmentChanged: false,
      initialVerdict: null,
      tempoAction: previewGrid.bpm ? "unchanged" : "not_available",
      tapEstimate: null,
      beatAction: "kept",
      downbeatAction: previewGrid.downbeatsSeconds.length ? "kept" : "skipped",
      beginningAuditioned: false,
      laterAuditioned: false,
      beginningVerdict: "not_checked",
      laterVerdict: "not_checked"
    });
    setTimingReviewSaveStatus("idle");
  };

  const playTimingCheckAt = async (positionSeconds) => {
    if (playbackStartLocked || playbackStartLockRef?.current) return;
    stopMetronomeAudition();
    if (!await seek(positionSeconds)) return;
    if (!deckEngine.isActive()) await play(positionSeconds);
    await auditionBeatGrid();
  };

  const closeTimingWizard = () => {
    stopMetronomeAudition();
    setTapTimes([]);
    setTimingWizard(null);
    window.setTimeout(() => timingWizardTriggerRef.current?.focus(), 0);
  };

  const updateTimingDraft = (draftOverrides, responses = {}) => {
    setTimingWizard((current) => current ? {
      ...current,
      draftOverrides: normalizeBeatGridOverrides({ ...draftOverrides, autoMixDisabled: true }),
      changed: true,
      adjustmentChanged: true,
      ...responses
    } : current);
  };

  const draftAnalysis = () => analysisRecord && timingWizard
    ? { ...analysisRecord, analysisOverrides: timingWizard.draftOverrides }
    : analysisRecord;

  const chooseTempoInterpretation = (factor) => {
    if (!analysisRecord || !timingWizard) return;
    const original = { ...analysisRecord, analysisOverrides: timingWizard.originalOverrides };
    updateTimingDraft({
      ...timingWizard.draftOverrides,
      ...scaleCorrectedBpm(original, factor)
    }, { tempoAction: factor < 1 ? "halved" : "doubled", step: 3 });
  };

  const tapNaturalBeat = () => {
    if (!timingWizard || !isPlaying) return;
    const audioTime = getAudioEngine().clock.now();
    setTapTimes((current) => appendTap(current, deckEngine.getPosition(audioTime)));
  };

  const applyTappedPulse = () => {
    const source = draftAnalysis();
    if (!source || !tapEstimate) return;
    updateTimingDraft(applyTapTempo(source, tapEstimate), {
      tempoAction: "tapped",
      tapEstimate,
      beatAction: "aligned"
    });
  };

  const saveTimingWizard = async () => {
    if (!timingWizard || !analysisRecord) return;
    if (
      timingWizard.loadGeneration !== loadGenerationRef.current ||
      timingWizard.trackId !== currentTrackIdRef.current
    ) {
      setTimingReviewSaveStatus("error");
      return;
    }
    const overrides = normalizeBeatGridOverrides({
      ...timingWizard.draftOverrides,
      autoMixDisabled: true
    });
    let review;
    try {
      review = createTimingReview({
        analysis: { ...analysisRecord, analysisOverrides: overrides },
        initialVerdict: timingWizard.initialVerdict ?? (previewGrid.bpm ? "not_sure" : "pulse_missing"),
        tempoAction: timingWizard.tempoAction,
        tapEstimate: timingWizard.tapEstimate,
        beatAction: timingWizard.beatAction,
        downbeatAction: timingWizard.downbeatAction,
        beginningVerdict: timingWizard.beginningVerdict,
        laterVerdict: timingWizard.laterVerdict,
        manualAdjustmentChanged: manualGridChanged(timingWizard.originalOverrides, overrides),
        autoMixWasNewlyDisabled: timingWizard.originalOverrides.autoMixDisabled !== true
      });
      setTimingReviewSaveStatus("saving");
      if (timingWizard.trackId) {
        if (!onTimingReviewSave) throw new Error("Timing review storage is unavailable");
        await onTimingReviewSave(timingWizard.trackId, overrides, review);
      }
      const nextRecord = { ...analysisRecord, analysisOverrides: overrides, timingReview: review };
      const grid = buildEffectiveBeatGrid(nextRecord);
      setAnalysisRecord(nextRecord);
      setOriginalBpm(grid.bpm);
      setBpmLabel(grid.bpm == null ? "n/a" : String(Math.round(grid.bpm * 10) / 10));
      onBpmChange(channel, grid.bpm);
      setTimingReviewSaveStatus("saved");
      closeTimingWizard();
    } catch (_error) {
      setTimingReviewSaveStatus("error");
    }
  };

  const removeTimingReview = async () => {
    if (!analysisRecord?.timingReview) return;
    const trackId = currentTrackIdRef.current;
    setTimingReviewSaveStatus("saving");
    try {
      if (trackId) {
        if (!onTimingReviewRemove) throw new Error("Timing review storage is unavailable");
        await onTimingReviewRemove(trackId);
      }
      setAnalysisRecord((current) => current ? { ...current, timingReview: null } : current);
      setTimingReviewSaveStatus("saved");
    } catch (_error) {
      setTimingReviewSaveStatus("error");
    }
  };

  useEffect(() => {
    if (!timingWizard) return undefined;
    const dialog = timingWizardDialogRef.current;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTimingWizard();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    window.setTimeout(() => timingWizardCloseRef.current?.focus(), 0);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [timingWizard?.trackId]);

  const createWaveSurfer = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }
    wavesurferRef.current = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: `${color}88`,
      progressColor: color,
      cursorColor: "#f3f5ff",
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      height: 120,
      interact: true
    });
    wavesurferRef.current.on("click", (progress) => {
      const duration = deckEngine.getSnapshot().durationSeconds;
      if (!duration || interactionLockedRef.current || playbackStartLockRef?.current) return;
      void seek(progress * duration);
    });
  };

  useEffect(() => {
    createWaveSurfer();
    const unsubscribe = deckEngine.subscribe((snapshot) => {
      if (snapshot.status === "ended" && previousDeckStatusRef.current !== "ended") {
        onDeckEndedRef.current?.(channel, snapshot.trackId);
      }
      previousDeckStatusRef.current = snapshot.status;
      setDeckStatus(snapshot.status);
      setFileReady(
        snapshot.durationSeconds > 0 &&
          snapshot.status !== "preparing" &&
          snapshot.status !== "recoverable-error"
      );
      setIsPlaying(snapshot.status === "scheduled" || snapshot.status === "playing");
    });

    const updateDisplay = () => {
      const snapshot = deckEngine.getSnapshot();
      setDeckStatus(snapshot.status);
      if (snapshot.durationSeconds > 0) {
        const bounded = Math.min(snapshot.positionSeconds, snapshot.durationSeconds);
        setCurrentTimeSec(bounded);
        wavesurferRef.current?.seekTo(bounded / snapshot.durationSeconds);
        setTempo((currentTempo) => {
          if (Math.abs(currentTempo - snapshot.playbackRate) < 0.001) return currentTempo;
          wavesurferRef.current?.setPlaybackRate(snapshot.playbackRate);
          return snapshot.playbackRate;
        });
      } else {
        setCurrentTimeSec(0);
      }
      rafRef.current = requestAnimationFrame(updateDisplay);
    };
    rafRef.current = requestAnimationFrame(updateDisplay);

    return () => {
      invalidateDeckTransportAuthority(transportAuthorityRef.current);
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(releaseRafRef.current);
      metronomeCancelRef.current?.();
      window.clearTimeout(metronomeUiTimerRef.current);
      clickPulseTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      loadAbortControllerRef.current?.abort?.();
      isolatedAnalysisClientRef.current?.dispose?.();
      unsubscribe();
      wavesurferRef.current?.destroy();
      if (lastObjectUrlRef.current) {
        URL.revokeObjectURL(lastObjectUrlRef.current);
      }
    };
  }, [color]);

  const loadFileToDeck = async (file, trackId = null, knownAnalysis = null, { isolatedAnalysis = false } = {}) => {
    if (playbackStartLocked || playbackStartLockRef?.current) {
      return DECK_LOAD_OUTCOME.cancelled;
    }
    if (!(file instanceof Blob)) return DECK_LOAD_OUTCOME.unplayableFile;

    invalidateDeckTransportAuthority(transportAuthorityRef.current);
    loadAbortControllerRef.current?.abort?.();
    isolatedAnalysisClientRef.current?.dispose?.();
    isolatedAnalysisClientRef.current = null;
    const loadAbortController = new AbortController();
    loadAbortControllerRef.current = loadAbortController;
    loadGenerationRef.current += 1;
    const loadGeneration = loadGenerationRef.current;
    let audioContext;
    try {
      audioContext = await ensureGraphReady();
    } catch {
      onAudioStartError?.(getAudioEngine().context.state);
      return DECK_LOAD_OUTCOME.audioBlocked;
    }
    if (loadGenerationRef.current !== loadGeneration || playbackStartLockRef?.current) return DECK_LOAD_OUTCOME.cancelled;
    try {
      const objectUrl = URL.createObjectURL(file);
      if (lastObjectUrlRef.current) URL.revokeObjectURL(lastObjectUrlRef.current);
      lastObjectUrlRef.current = objectUrl;
      createWaveSurfer();
      void wavesurferRef.current?.load(objectUrl)?.catch?.(() => undefined);
      setFileReady(false);
      setBpmLabel("...");
      setTrackName(file.name || "LOCAL AUDIO");
      setSyncActive(false);
      setTempo(1);
      stopMetronomeAudition();
      setTimingWizard(null);
      setTapTimes([]);
      currentTrackIdRef.current = trackId;
      setAnalysisRecord(null);
      setProgramLevelRuntimeStatus("pending");
      deckEngine.beginPreparing(trackId);
    } catch {
      return DECK_LOAD_OUTCOME.cancelled;
    }
    let decoded;
    const hadCurrentBasicAnalysis = !!knownAnalysis && hasCurrentBasicAnalysis(knownAnalysis);
    try {
      const arrayBuffer = await readFileAsArrayBuffer(file, loadAbortController.signal);
      decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) {
        return DECK_LOAD_OUTCOME.cancelled;
      }
    } catch (error) {
      if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) {
        return DECK_LOAD_OUTCOME.cancelled;
      }
      if (playbackStartLockRef?.current) return DECK_LOAD_OUTCOME.cancelled;
      if (audioContext.state !== "running") {
        onAudioStartError?.(audioContext.state);
        return DECK_LOAD_OUTCOME.audioBlocked;
      }
      deckEngine.fail(error);
      setFileReady(false);
      setBpmLabel("n/a");
      onBpmChange(channel, null);
      return DECK_LOAD_OUTCOME.unplayableFile;
    }

    let isolatedAnalysisClient = null;
    const analysisClient = () => {
      if (!isolatedAnalysis) return getAnalysisClient();
      if (!isolatedAnalysisClient) {
        isolatedAnalysisClient = new AnalysisClient();
        isolatedAnalysisClientRef.current = isolatedAnalysisClient;
      }
      return isolatedAnalysisClient;
    };
    try {
      if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) return DECK_LOAD_OUTCOME.cancelled;
      let generatedAnalysis = null;
      if (hadCurrentBasicAnalysis) {
        applyAnalysis(
          {
            ...knownAnalysis,
            durationSeconds: decoded.duration,
            analyzerVersion: knownAnalysis.analyzerVersion
          },
          trackId,
          false
        );
      } else {
        generatedAnalysis = await analysisClient().analyzeAudioBuffer(decoded);
        if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) return DECK_LOAD_OUTCOME.cancelled;
        applyAnalysis(
          { ...generatedAnalysis, analysisOverrides: knownAnalysis?.analysisOverrides },
          trackId
        );
      }
      const activeProgramLevel = normalizeProgramLevel(generatedAnalysis?.programLevel) ??
        normalizeProgramLevel(knownAnalysis?.programLevel);
      if (activeProgramLevel) {
        deckEngine.setTrackTrimDb(activeProgramLevel.normalization.trimDb);
        setProgramLevelRuntimeStatus("ready");
      } else {
        const current = await analysisClient().analyzeAudioBuffer(decoded);
        if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) return DECK_LOAD_OUTCOME.cancelled;
        deckEngine.setTrackTrimDb(current.programLevel.normalization.trimDb);
        setProgramLevelRuntimeStatus("ready");
        setAnalysisRecord((record) => record ? { ...record, programLevel: current.programLevel } : record);
        if (trackId) onProgramLevelDetected?.(trackId, current.programLevel);
      }
      if (
        enhancedTimingAvailable &&
        !hasCurrentEnhancedRhythm(knownAnalysis)
      ) {
        void analyzeEnhancedRhythm(decoded, undefined, trackId).then((enhanced) => {
          if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) return;
          setAnalysisRecord((current) => {
            if (!current) return current;
            const next = mergeEnhancedRhythm(current, enhanced);
            const grid = buildEffectiveBeatGrid(next);
            setOriginalBpm(grid.bpm);
            setBpmLabel(grid.bpm == null ? "n/a" : String(Math.round(grid.bpm * 10) / 10));
            onBpmChange(channel, grid.bpm);
            return next;
          });
          onEnhancedRhythmDetected?.(trackId, enhanced);
        }).catch(() => {
          // Playback and the basic Safe Fade analysis remain available.
        });
      }
    } catch {
      if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) return DECK_LOAD_OUTCOME.cancelled;
      const failure = programLevelFailurePolicy(hadCurrentBasicAnalysis);
      deckEngine.setTrackTrimDb(failure.trimDb);
      setProgramLevelRuntimeStatus(failure.levelStatus);
      if (!failure.preserveBasicAnalysis) {
        setOriginalBpm(null);
        setBpmLabel("n/a");
        setKeyLabel("--");
        onBpmChange(channel, null);
      }
    } finally {
      if (isolatedAnalysisClientRef.current === isolatedAnalysisClient) {
        isolatedAnalysisClientRef.current = null;
      }
      isolatedAnalysisClient?.dispose();
    }
    if (loadGenerationRef.current !== loadGeneration || currentTrackIdRef.current !== trackId) return DECK_LOAD_OUTCOME.cancelled;
    // Publish deck readiness only after the current track has either a valid
    // v2 trim or an explicit neutral fallback. Manual Play cannot observe a
    // ready buffer and then receive a late multi-decibel trim step.
    deckEngine.loadBuffer(decoded, trackId);
    onTrackLoaded?.(channel, trackId, file.name);
    return DECK_LOAD_OUTCOME.loaded;
  };

  const onFileChange = async (event) => {
    const file = event.target.files?.[0];
    await loadFileToDeck(file, null);
  };

  const onPlayPause = async () => {
    if (!deckEngine.isReady() || !fileReady) {
      return;
    }
    if (deckEngine.isActive()) {
      if (timingWizard?.step === 2) setTapTimes([]);
      pause();
      return;
    }
    if (playbackStartLocked || playbackStartLockRef?.current) return;
    await play();
  };

  const onTempoChange = async (event) => {
    stopMetronomeAudition();
    const nextTempo = clampTempo(Number(event.target.value));
    setTempo(nextTempo);
    setSyncActive(false);
    setSyncTargetBpm(null);
    wavesurferRef.current?.setPlaybackRate(nextTempo);

    deckEngine.setPlaybackRate(nextTempo);

    if (originalBpm) {
      onBpmChange(channel, Math.round(originalBpm * nextTempo * 10) / 10);
    }
  };

  useEffect(() => {
    const bpmNow = originalBpm ? originalBpm * tempo : null;
    if (!bpmNow || bpmNow <= 0) {
      setRotationDuration(1.8);
      return;
    }
    setRotationDuration((60 / bpmNow) * 2);
  }, [originalBpm, tempo]);

  const syncToBpm = async (targetBpm) => {
    stopMetronomeAudition();
    if (!originalBpm || !targetBpm) {
      return null;
    }
    const syncedTempo = clampTempo(targetBpm / originalBpm);
    setTempo(syncedTempo);
    setSyncActive(true);
    setSyncTargetBpm(targetBpm);
    wavesurferRef.current?.setPlaybackRate(syncedTempo);

    deckEngine.setPlaybackRate(syncedTempo);

    const currentBpm = Math.round(originalBpm * syncedTempo * 10) / 10;
    onBpmChange(channel, currentBpm);
    return syncedTempo;
  };

  const onSync = () => {
    if (!originalBpm || !otherBpm) {
      return;
    }
    void syncToBpm(otherBpm);
  };

  const releaseSyncInstant = async () => {
    stopMetronomeAudition();
    setTempo(1);
    setSyncActive(false);
    setSyncTargetBpm(null);
    wavesurferRef.current?.setPlaybackRate(1);
    deckEngine.setPlaybackRate(1);
    if (originalBpm) {
      setBpmLabel(String(originalBpm));
      onBpmChange(channel, originalBpm);
    }
  };

  const startTempoRelease = (durationSeconds = 8) => {
    stopMetronomeAudition();
    const engine = getAudioEngine();
    const startedAt = engine.clock.now();
    const targetRate = 1;
    if (!deckEngine.schedulePlaybackRateRamp(targetRate, startedAt, durationSeconds)) {
      return false;
    }

    cancelAnimationFrame(releaseRafRef.current);
    const tick = () => {
      const now = engine.clock.now();
      const nextRate = deckEngine.getPlaybackRate(now);
      setTempo(nextRate);
      wavesurferRef.current?.setPlaybackRate(nextRate);
      if (now < startedAt + durationSeconds) {
        releaseRafRef.current = requestAnimationFrame(tick);
      } else {
        setTempo(targetRate);
        setSyncActive(false);
        setSyncTargetBpm(null);
        if (originalBpm) {
          setBpmLabel(String(originalBpm));
          onBpmChange(channel, originalBpm);
        }
      }
    };
    releaseRafRef.current = requestAnimationFrame(tick);
    return true;
  };

  const setGain = (value) => {
    const safe = Math.max(0, Math.min(1, Number(value)));
    getAudioEngine().setDeckGain(channel, safe);
  };

  const applyBandGain = (band, gainValue) => {
    const safe = Math.max(-12, Math.min(12, Number(gainValue)));
    deckEngine.setEqBandGain(band, safe);
  };

  const setEqBandGain = (band, gainValue) => {
    setEq((prev) => ({ ...prev, [band]: gainValue }));
    setEqKill((prev) => ({ ...prev, [band]: gainValue <= -12 }));
    applyBandGain(band, gainValue);
  };

  const toggleEqKill = (band) => {
    const nextEnabled = !eqKill[band];
    if (nextEnabled) {
      eqBeforeKillRef.current[band] = eq[band];
      setEq((prev) => ({ ...prev, [band]: -12 }));
      setEqKill((prev) => ({ ...prev, [band]: true }));
      applyBandGain(band, -12);
    } else {
      const restore = eqBeforeKillRef.current[band] ?? 0;
      setEq((prev) => ({ ...prev, [band]: restore }));
      setEqKill((prev) => ({ ...prev, [band]: false }));
      applyBandGain(band, restore);
    }
  };

  const scheduleEqBandRamp = (band, fromDb, toDb, startTime, duration) => {
    deckEngine.scheduleEqBandRamp(band, fromDb, toDb, startTime, duration);
    setEq((prev) => ({ ...prev, [band]: toDb }));
  };

  const scheduleGainCurve = (curve, startTime, duration) => {
    if (!curve?.length) {
      return;
    }
    getAudioEngine().scheduleDeckGainCurve(channel, curve, startTime, duration);
  };

  const stopAt = (when) => {
    return deckEngine.stopAt(when);
  };

  useImperativeHandle(
    ref,
    () => ({
      isPlaying: () => deckEngine.isActive(),
      isReady: () => deckEngine.isReady(),
      getTransportAnchorTime: () => deckEngine.getTransportAnchorTime(),
      getCurrentBpm: () => (originalBpm ? Math.round(originalBpm * tempo * 10) / 10 : null),
      play: async () => play(),
      playAt: async (startTime, offset = 0, startAuthority = null) => play(offset, startTime, false, startAuthority),
      loadTrack: async (file, trackId = null, knownAnalysis = null, options = undefined) =>
        loadFileToDeck(file, trackId, knownAnalysis, options),
      getTrackId: () => deckEngine.getSnapshot().trackId,
      getTrackName: () => trackName,
      getDeckSnapshot: () => deckEngine.getSnapshot(),
      getAnalysisRecord: () => analysisRecord,
      getDspSnapshot: () => ({
        trimDb: deckEngine.getTrackTrimDb(),
        eqDb: deckEngine.getEqSnapshot(),
        filterCutoffHz: deckEngine.getFilterCutoff()
      }),
      getOwnedArmAudioHandle: () => Object.freeze({
        getTrackId: () => deckEngine.getSnapshot().trackId,
        isActive: () => deckEngine.isActive(),
        setGain: (value) => getAudioEngine().setDeckGain(channel, value),
        setEqBandGain: (band, db) => deckEngine.setEqBandGain(band, db),
        setFilterCutoff: (hz) => deckEngine.setFilterCutoff(hz),
        pause: () => deckEngine.pause()
      }),
      getDecodedBufferForRehearsal: () => deckEngine.getDecodedBufferForRehearsal(),
      pause: () => pause(),
      stopAllSound: () => {
        invalidateDeckTransportAuthority(transportAuthorityRef.current);
        stopMetronomeAudition();
        loadAbortControllerRef.current?.abort?.();
        loadAbortControllerRef.current = null;
        isolatedAnalysisClientRef.current?.dispose?.();
        isolatedAnalysisClientRef.current = null;
        loadGenerationRef.current += 1;
        if (deckEngine.getSnapshot().status !== "preparing") {
          return { cancelledLoad: false, paused: deckEngine.pause(), auxiliaryStopped: !metronomeCancelRef.current };
        }
        wavesurferRef.current?.empty?.();
        if (lastObjectUrlRef.current) {
          URL.revokeObjectURL(lastObjectUrlRef.current);
          lastObjectUrlRef.current = null;
        }
        currentTrackIdRef.current = null;
        setAnalysisRecord(null);
        setFileReady(false);
        setTrackName("NO TRACK LOADED");
        setCurrentTimeSec(0);
        setTimingWizard(null);
        setTapTimes([]);
        setTimingReviewSaveStatus("idle");
        deckEngine.eject();
        return { cancelledLoad: true, paused: false, auxiliaryStopped: !metronomeCancelRef.current };
      },
      stopAt: (when) => stopAt(when),
      eject: () => {
        invalidateDeckTransportAuthority(transportAuthorityRef.current);
        stopMetronomeAudition();
        loadAbortControllerRef.current?.abort?.();
        loadAbortControllerRef.current = null;
        isolatedAnalysisClientRef.current?.dispose?.();
        isolatedAnalysisClientRef.current = null;
        loadGenerationRef.current += 1;
        wavesurferRef.current?.empty?.();
        if (lastObjectUrlRef.current) {
          URL.revokeObjectURL(lastObjectUrlRef.current);
          lastObjectUrlRef.current = null;
        }
        setTimingWizard(null);
        setTapTimes([]);
        setTimingReviewSaveStatus("idle");
        deckEngine.eject();
        currentTrackIdRef.current = null;
        setAnalysisRecord(null);
        setFileReady(false);
        setTrackName("NO TRACK LOADED");
        setCurrentTimeSec(0);
      },
      syncToBpm: async (targetBpm) => syncToBpm(targetBpm),
      startTempoRelease: (durationSeconds = 8) => startTempoRelease(durationSeconds),
      releaseSyncInstant: async () => releaseSyncInstant(),
      setGain: (value) => setGain(value),
      getEqBandGain: (band) => Number(eq[band] ?? 0),
      setTrackTrimDb: (value) => deckEngine.setTrackTrimDb(value),
      setFilterCutoff: (hz) => deckEngine.setFilterCutoff(hz),
      setEqBandGain: (band, db) => setEqBandGain(band, db),
      scheduleEqBandRamp: (band, fromDb, toDb, startTime, duration) =>
        scheduleEqBandRamp(band, fromDb, toDb, startTime, duration),
      scheduleGainCurve: (curve, startTime, duration) => scheduleGainCurve(curve, startTime, duration),
      scheduleFilterSweep: (fromHz, toHz, startTime, duration) =>
        deckEngine.scheduleFilterSweep(fromHz, toHz, startTime, duration)
    }),
    [analysisRecord, originalBpm, tempo, eq, playbackStartLocked]
  );

  const statusLabel =
    deckStatus === "recoverable-error"
      ? "RECOVERY NEEDED"
      : deckStatus === "preparing"
        ? "PREPARING"
        : deckStatus === "scheduled"
          ? "ARMED"
          : deckStatus.toUpperCase();
  const averageFeature = (values = []) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const averageEnergy = averageFeature(analysisRecord?.energyByBeat);
  const averageVocalProxy = averageFeature(analysisRecord?.vocalProbabilityByBeat);
  const structureBoundaryCount = analysisRecord?.structureBoundaries?.length ?? 0;

  return (
    <section className={`deck ${flash ? "deck-flash" : ""}`}>
      <div className="deck-header">
        <h2>{title}</h2>
        <div className="bpm-display">{bpmLabel}</div>
      </div>
      <div className="track-name" title={trackName}>
        {trackName}
      </div>
      <div className="deck-top-actions">
        <button className="text-control-btn" type="button" onClick={() => fileInputRef.current?.click()} disabled={startOrLoadLocked}>
          LOAD TRACK
        </button>
        <span className={`deck-engine-status status-${deckStatus}`}>{statusLabel}</span>
      </div>
      <input ref={fileInputRef} className="file-input-hidden" type="file" accept="audio/*" onChange={onFileChange} disabled={startOrLoadLocked} />

      <div className="wave-section">
        <div
          className={`platter ${isPlaying ? "playing" : ""} ${scratch ? "scratch" : ""}`}
          style={{ animationDuration: `${rotationDuration}s` }}
        >
          <div className="platter-label" />
          <div className="platter-marker" />
        </div>
        <div className="waveform-wrap">
          <div className="waveform" ref={waveformRef} />
          <BeatGridOverlay
            beatsSeconds={effectiveGrid.beatsSeconds}
            downbeatsSeconds={effectiveGrid.downbeatsSeconds}
            durationSeconds={deckEngine.getSnapshot().durationSeconds}
            color={color}
          />
          <div className="playhead-line" />
        </div>
      </div>
      <div className="time-row">
        <span>{`${formatTime(currentTimeSec)} / ${formatTime(deckEngine.getSnapshot().durationSeconds)}`}</span>
        <input
          className="time-input"
          type="text"
          placeholder="0:34"
          value={timeInput}
          onChange={(event) => setTimeInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const parsed = parseTimeToSeconds(timeInput);
              if (parsed != null) {
                void seek(parsed);
              }
            }
          }}
          disabled={!fileReady || startOrLoadLocked}
        />
      </div>

      <div className="grid-review-panel">
        <div className="grid-review-header">
          <span className={effectiveGrid.isManual ? "grid-status manual" : "grid-status automatic"}>
            {effectiveGrid.isManual ? "TIMING ADJUSTED" : automaticTimingLabel.toUpperCase()}
          </span>
          <span className="grid-lock">
            {effectiveGrid.isManual
              ? "LONG BLENDS LOCKED"
              : automaticBarHandoff
                ? "BAR HANDOFF CANDIDATE"
                : "SAFE TRANSITION AVAILABLE"}
          </span>
        </div>
        <p className="grid-review-explainer">
          Mazzy checks timing automatically. You do not need to count beats, know BPM, or approve a grid before using Auto Mix.
        </p>
        <details className="automatic-timing-details" onToggle={(event) => {
          if (interactionLocked && event.currentTarget.open) event.currentTarget.open = false;
        }}>
          <summary>Timing details and advanced review</summary>
          <div className="grid-review-meta">
            <span>{`${effectiveGrid.beatsSeconds.length} beats · ${effectiveGrid.downbeatsSeconds.length} bar starts`}</span>
            <span>{automaticTrust ? `machine check ${automaticTrust.trustIndex}/100 · ${automaticTrust.tier.replaceAll("-", " ")}` : "machine check pending"}</span>
            <span>{automaticTrust?.reasons?.[0] ?? "Long mixes require a calibrated detector."}</span>
            <span role="status" aria-live="polite">{programLevelLabel}</span>
            <span>
              {currentTrackIdRef.current
                ? librarySaveStatus === "saving" ? "SAVING…" : librarySaveStatus === "error" ? "COULDN'T SAVE" : "STORED IN THIS BROWSER PROFILE"
                : "SESSION ONLY"}
            </span>
            <span title="Vocal Proxy is an uncalibrated spectral estimate, not a stem or verified vocal detector">
              {averageEnergy == null ? "FEATURES --" : `ENERGY ${Math.round(averageEnergy * 100)}% · VOCAL PROXY ${Math.round((averageVocalProxy ?? 0) * 100)}% · ${structureBoundaryCount} CHANGES`}
            </span>
          </div>
          {savedTimingReview && (
            <div className="saved-timing-review" aria-live="polite">
              <span>{`ADVANCED REVIEW SAVED ${savedTimingReview.reviewedOn} · BEGINNING ${savedTimingReview.beginningVerdict.replace("_", " ")} · LATER ${savedTimingReview.laterVerdict.replace("_", " ")}`}</span>
              <button type="button" onClick={() => void removeTimingReview()} disabled={timingReviewSaveStatus === "saving"}>REMOVE SAVED TIMING REVIEW</button>
            </div>
          )}
          {timingReviewSaveStatus === "error" && <p className="timing-review-error" role="alert">YOUR TIMING ANSWERS COULDN'T BE SAVED. TRY AGAIN.</p>}
          <button ref={timingWizardTriggerRef} className="check-timing-button" type="button" onClick={openTimingWizard} disabled={!analysisRecord || interactionLocked}>
            REVIEW TIMING (ADVANCED)
          </button>
        </details>
      </div>

      {timingWizard && (
        <div className="timing-wizard-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeTimingWizard();
        }}>
          <div
            ref={timingWizardDialogRef}
            className="timing-wizard"
            role="dialog"
            aria-modal="true"
            aria-labelledby={timingWizardTitleId}
            aria-describedby={timingWizardDescriptionId}
          >
            <div className="timing-wizard-header">
              <div>
                <span className="timing-wizard-kicker">TIMING CHECK · {timingWizard.step + 1} OF 6</span>
                <h3 id={timingWizardTitleId}>Make the clicks follow the song</h3>
              </div>
              <button ref={timingWizardCloseRef} type="button" className="wizard-close" onClick={closeTimingWizard} aria-label="Cancel timing check">×</button>
            </div>
            <p id={timingWizardDescriptionId} className="timing-wizard-privacy">
              Your audio and adjustments stay in this browser profile on this device. Nothing is uploaded.
            </p>
            <button
              className="timing-stop-all"
              type="button"
              onClick={() => {
                onStopAllSound?.();
                closeTimingWizard();
              }}
            >STOP ALL SOUND</button>
            <div className="wizard-progress" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => <span key={index} className={index <= timingWizard.step ? "done" : ""} />)}
            </div>

            {timingWizard.step === 0 && (
              <div className="wizard-step">
                <h4>First, listen</h4>
                <p>Start the song, then play 16 clicks. Do the clicks land with the rhythm you naturally feel?</p>
                <div className="wizard-actions two">
                  <button type="button" onClick={onPlayPause} disabled={!isPlaying && startOrLoadLocked}>{isPlaying ? "PAUSE SONG" : "PLAY SONG"}</button>
                  <button type="button" aria-pressed={metronomeActive} onClick={() => void auditionBeatGrid()} disabled={!isPlaying || !previewGrid.beatsSeconds.length || (!metronomeActive && startOrLoadLocked)}>
                    {metronomeActive ? "STOP CLICKS" : "PLAY 16 CLICKS"}
                  </button>
                </div>
                <div className={`click-visual ${clickPulse ? `pulse-${clickPulse}` : ""}`} aria-live="polite" aria-atomic="true">
                  <span aria-hidden="true" />
                  {clickPulse === "one" ? "STRONG CLICK · ONE" : clickPulse === "beat" ? "CLICK" : "CLICK INDICATOR"}
                </div>
                {!previewGrid.bpm && <p className="wizard-warning">Mazzy couldn't find a steady pulse. Continue to tap along, or keep Safe Fade.</p>}
                <div className="wizard-choice-list">
                  <button type="button" onClick={() => setTimingWizard((current) => ({ ...current, initialVerdict: "matched", tempoAction: "unchanged", step: 4 }))}>THEY MATCH</button>
                  <button type="button" onClick={() => setTimingWizard((current) => ({ ...current, initialVerdict: previewGrid.bpm ? "felt_wrong" : "pulse_missing", step: 1 }))}>THEY FEEL WRONG</button>
                  <button type="button" onClick={() => setTimingWizard((current) => ({ ...current, initialVerdict: previewGrid.bpm ? "not_sure" : "pulse_missing", tempoAction: previewGrid.bpm ? "unchanged" : "not_available", draftOverrides: normalizeBeatGridOverrides({ ...current.draftOverrides, autoMixDisabled: true }), changed: true, step: 4 }))}>NOT SURE — KEEP SAFE FADE</button>
                </div>
              </div>
            )}

            {timingWizard.step === 1 && (
              <div className="wizard-step">
                <h4>Choose what sounds closest</h4>
                <p>Preview a slower or faster pulse. This only changes the draft until you save.</p>
                {previewGrid.bpm ? (
                  <div className="wizard-tempo-options">
                    <button type="button" onClick={() => chooseTempoInterpretation(0.5)}>CLICKS TWICE TOO FAST<br/><strong>{(effectiveGrid.bpm / 2).toFixed(1)} BPM</strong></button>
                    <button type="button" onClick={() => chooseTempoInterpretation(2)}>CLICKS TWICE TOO SLOW<br/><strong>{(effectiveGrid.bpm * 2).toFixed(1)} BPM</strong></button>
                  </div>
                ) : <p className="wizard-warning">There is no reliable starting pulse to adjust. Tap with the song instead.</p>}
                <button className="wizard-primary" type="button" onClick={() => setTimingWizard((current) => ({ ...current, step: 2 }))}>TAP WITH THE SONG</button>
              </div>
            )}

            {timingWizard.step === 2 && (
              <div className="wizard-step">
                <h4>Tap the beat eight times</h4>
                <p>While the song plays, press the big button or Space whenever you would naturally tap your foot.</p>
                <button
                  className="tap-beat-button"
                  type="button"
                  disabled={!isPlaying}
                  onPointerDown={(event) => { event.preventDefault(); tapNaturalBeat(); }}
                  onKeyDown={(event) => {
                    if ((event.code === "Space" || event.code === "Enter") && !event.repeat) {
                      event.preventDefault();
                      tapNaturalBeat();
                    }
                  }}
                >
                  TAP BEAT
                  <span>{tapTimes.length} / {MIN_TAP_COUNT} minimum</span>
                </button>
                <p className="tap-quality" aria-live="polite">
                  {tapEstimate ? `${tapEstimate.quality === "steady" ? "STEADY" : "ROUGH"} TAP · ${tapEstimate.bpm.toFixed(1)} BPM · MANUAL REPAIR` : tapTimes.length ? "KEEP TAPPING — NO CHANGE YET" : "PLAY THE SONG, THEN START TAPPING"}
                </p>
                <div className="wizard-actions two">
                  <button type="button" onClick={() => setTapTimes([])}>START TAPS AGAIN</button>
                  <button type="button" className="wizard-primary" disabled={!tapEstimate} onClick={() => { applyTappedPulse(); setTimingWizard((current) => ({ ...current, step: 3 })); }}>PREVIEW THIS PULSE</button>
                </div>
              </div>
            )}

            {timingWizard.step === 3 && (
              <div className="wizard-step">
                <h4>Line up one click</h4>
                <p>Pause on a clear drum hit, then choose “Put a click here.” Use Earlier or Later only if the clicks feel slightly behind or ahead.</p>
                <div className="wizard-actions three">
                  <button type="button" disabled={startOrLoadLocked} onClick={() => void seek(Math.max(0, currentTimeSec - 2))}>− 2 SECONDS</button>
                  <button type="button" onClick={onPlayPause} disabled={!isPlaying && startOrLoadLocked}>{isPlaying ? "PAUSE" : "PLAY"}</button>
                  <button type="button" disabled={startOrLoadLocked} onClick={() => void seek(Math.min(deckEngine.getSnapshot().durationSeconds, currentTimeSec + 2))}>+ 2 SECONDS</button>
                </div>
                <button className="wizard-primary" type="button" disabled={!previewGrid.bpm} onClick={() => updateTimingDraft(setBeatAtTime(draftAnalysis(), deckEngine.getPosition()), { beatAction: "aligned" })}>PUT A CLICK HERE</button>
                <details className="wizard-advanced">
                  <summary>Small timing adjustment</summary>
                  <div className="wizard-actions two">
                    <button type="button" onClick={() => updateTimingDraft(nudgeBeatGrid(draftAnalysis(), -0.01), { beatAction: "aligned" })}>CLICKS EARLIER</button>
                    <button type="button" onClick={() => updateTimingDraft(nudgeBeatGrid(draftAnalysis(), 0.01), { beatAction: "aligned" })}>CLICKS LATER</button>
                  </div>
                </details>
                <div className="wizard-actions two">
                  <button type="button" onClick={() => setTimingWizard((current) => ({ ...current, beatAction: "skipped", step: 4 }))}>SKIP — I'M NOT SURE</button>
                  <button type="button" className="wizard-primary" onClick={() => setTimingWizard((current) => ({ ...current, step: 4 }))}>NEXT</button>
                </div>
              </div>
            )}

            {timingWizard.step === 4 && (
              <div className="wizard-step">
                <h4>Optional: mark the strongest first beat</h4>
                <p>Many songs repeat in groups of four. Pause on the “ONE” that begins a group, then mark it. Mazzy will use a stronger click there. Skip this if you are unsure.</p>
                <div className="wizard-actions three">
                  <button type="button" disabled={startOrLoadLocked} onClick={() => void seek(Math.max(0, currentTimeSec - 2))}>− 2 SECONDS</button>
                  <button type="button" onClick={onPlayPause} disabled={!isPlaying && startOrLoadLocked}>{isPlaying ? "PAUSE" : "PLAY"}</button>
                  <button type="button" disabled={startOrLoadLocked} onClick={() => void seek(Math.min(deckEngine.getSnapshot().durationSeconds, currentTimeSec + 2))}>+ 2 SECONDS</button>
                </div>
                <button
                  className="wizard-primary"
                  type="button"
                  disabled={!previewGrid.beatsSeconds.length}
                  onClick={() => updateTimingDraft(setDownbeatAtTime(draftAnalysis(), deckEngine.getPosition()), { downbeatAction: "marked" })}
                >
                  MARK THE “ONE” HERE
                </button>
                <div className="wizard-actions two">
                  <button type="button" onClick={() => setTimingWizard((current) => ({ ...current, downbeatAction: "skipped", step: 5 }))}>SKIP — I'M NOT SURE</button>
                  <button type="button" className="wizard-primary" onClick={() => setTimingWizard((current) => ({ ...current, step: 5 }))}>NEXT</button>
                </div>
              </div>
            )}

            {timingWizard.step === 5 && (
              <div className="wizard-step">
                <h4>Check again later in the song</h4>
                <p>A repaired pulse can begin correctly but drift later. Check near the beginning and near the final third before saving.</p>
                <div className="wizard-actions two">
                  <button type="button" onClick={() => { setTimingWizard((current) => ({ ...current, beginningAuditioned: true, beginningVerdict: "not_checked" })); void playTimingCheckAt(Math.min(10, deckEngine.getSnapshot().durationSeconds * 0.1)); }}>CHECK BEGINNING</button>
                  <button type="button" onClick={() => { setTimingWizard((current) => ({ ...current, laterAuditioned: true, laterVerdict: "not_checked" })); void playTimingCheckAt(deckEngine.getSnapshot().durationSeconds * 0.67); }}>CHECK LATER</button>
                </div>
                {timingWizard.beginningAuditioned && (
                  <fieldset className="wizard-verdicts">
                    <legend>At the beginning, did the clicks follow the song?</legend>
                    <button type="button" className={timingWizard.beginningVerdict === "matches" ? "selected" : ""} onClick={() => { stopMetronomeAudition(); setTimingWizard((current) => ({ ...current, beginningVerdict: "matches" })); }}>YES, THEY MATCH</button>
                    <button type="button" className={timingWizard.beginningVerdict === "drifts" ? "selected" : ""} onClick={() => { stopMetronomeAudition(); setTimingWizard((current) => ({ ...current, beginningVerdict: "drifts" })); }}>NO, THEY FEEL OFF</button>
                    <button type="button" className={timingWizard.beginningVerdict === "not_sure" ? "selected" : ""} onClick={() => { stopMetronomeAudition(); setTimingWizard((current) => ({ ...current, beginningVerdict: "not_sure" })); }}>NOT SURE</button>
                  </fieldset>
                )}
                {timingWizard.laterAuditioned && (
                  <fieldset className="wizard-verdicts">
                    <legend>Later in the song, did the clicks still follow?</legend>
                    <button type="button" className={timingWizard.laterVerdict === "matches" ? "selected" : ""} onClick={() => { stopMetronomeAudition(); setTimingWizard((current) => ({ ...current, laterVerdict: "matches" })); }}>YES, THEY MATCH</button>
                    <button type="button" className={timingWizard.laterVerdict === "drifts" ? "selected" : ""} onClick={() => { stopMetronomeAudition(); setTimingWizard((current) => ({ ...current, laterVerdict: "drifts" })); }}>NO, THEY DRIFT</button>
                    <button type="button" className={timingWizard.laterVerdict === "not_sure" ? "selected" : ""} onClick={() => { stopMetronomeAudition(); setTimingWizard((current) => ({ ...current, laterVerdict: "not_sure" })); }}>NOT SURE</button>
                  </fieldset>
                )}
                <p className="wizard-safe-note">Manual adjustments never unlock long blends. Mazzy will keep using Safe Fade until detector confidence is professionally validated.</p>
                <dl className="wizard-summary">
                  <div><dt>Original pulse</dt><dd>{effectiveGrid.bpm ? `${effectiveGrid.bpm.toFixed(1)} BPM` : "Not found"}</dd></div>
                  <div><dt>Draft pulse</dt><dd>{previewGrid.bpm ? `${previewGrid.bpm.toFixed(1)} BPM` : "Not found"}</dd></div>
                  <div><dt>Safety</dt><dd>Safe Fade active</dd></div>
                </dl>
                <div className="wizard-actions two">
                  <button type="button" onClick={closeTimingWizard}>CANCEL</button>
                  <button
                    type="button"
                    className="wizard-primary"
                    disabled={timingReviewSaveStatus === "saving" || timingWizard.beginningVerdict === "not_checked" || timingWizard.laterVerdict === "not_checked"}
                    onClick={() => void saveTimingWizard()}
                  >
                    {timingReviewSaveStatus === "saving" ? "SAVING ANSWERS…" : timingWizard.trackId ? "SAVE ANSWERS ON THIS DEVICE" : "USE UNTIL UNLOADED"}
                  </button>
                </div>
                {(timingWizard.beginningVerdict === "not_checked" || timingWizard.laterVerdict === "not_checked") && (
                  <p className="wizard-save-help">Check both places and choose an answer. “Not sure” is a valid answer.</p>
                )}
              </div>
            )}

            <div className="wizard-footer" aria-live="polite">
              <button type="button" onClick={() => { stopMetronomeAudition(); setTimingWizard((current) => ({ ...current, step: Math.max(0, current.step - 1) })); }} disabled={timingWizard.step === 0}>BACK</button>
              <span>Adjusted is not the same as professionally verified.</span>
            </div>
          </div>
        </div>
      )}

      <div className="eq-panel">
        {["high", "mid", "low"].map((band) => (
          <div className="eq-band" key={band}>
            <label className="label-small">{band.toUpperCase()}</label>
            <div className="eq-track">
              <input
                className="eq-slider"
                type="range"
                min="-12"
                max="12"
                step="0.1"
                value={eq[band]}
                onChange={(event) => setEqBandGain(band, Number(event.target.value))}
                disabled={!fileReady || interactionLocked}
              />
            </div>
            <button
              type="button"
              className={`kill-btn ${eqKill[band] ? "kill-on" : ""}`}
              onClick={() => toggleEqKill(band)}
              disabled={!fileReady || interactionLocked}
            >
              K
            </button>
          </div>
        ))}
      </div>

      <div className="deck-row">
        <button className={`action-btn ${isPlaying ? "playing" : ""}`} type="button" onClick={onPlayPause} disabled={!fileReady || interactionLocked || (!isPlaying && startOrLoadLocked)}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          className={`secondary-btn ${syncActive ? "sync-active" : ""}`}
          type="button"
          onClick={onSync}
          disabled={!fileReady || !originalBpm || !otherBpm || interactionLocked}
        >
          SYNC
        </button>
        <span className="bpm-pill">BPM {bpmLabel} | {keyLabel}</span>
      </div>
      {syncActive && syncTargetBpm && (
        <div className="sync-meta">
          <span>{`SYNCED TO ${Math.round(syncTargetBpm * 10) / 10} BPM`}</span>
          <button type="button" className="sync-release-btn" onClick={() => void releaseSyncInstant()} disabled={interactionLocked}>
            X
          </button>
        </div>
      )}

      <label className="tempo">
        Tempo/Pitch: {tempo.toFixed(2)}x
        <div className="tempo-track">
          <input
            className="tempo-slider"
            type="range"
            min="0.5"
            max="1.5"
            step="0.01"
            value={tempo}
            onChange={onTempoChange}
            disabled={!fileReady || interactionLocked}
          />
        </div>
      </label>
    </section>
  );
});

export default Deck;
