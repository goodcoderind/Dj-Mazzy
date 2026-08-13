import { buildEffectiveBeatGrid } from "../analysis/beatGridCorrections";
import type { BeatGridAnalysis } from "../domain/beatGrid";
import type { TransitionPlanV2 } from "../domain/transitionPlan";
import { TRANSITION_PLAN_SCHEMA_VERSION } from "../domain/versions";
import type { KeyLockCapability } from "../domain/keyLockCapability";
import { keyLockCapabilityCovers } from "../domain/keyLockCapability";
import { hasCurrentEnhancedRhythm } from "../analysis/enhancedRhythmVersion";
import { rankTrustedMusicalCuePairs } from "./musicalCueSelector";
import {
  createEqualPowerCurves,
  DEFAULT_PHRASE_BEATS,
  minimumConfidence,
  playbackRateForBpm,
  secondsForBeats,
  stretchSeverity
} from "./transitionMath";

export const PHRASE_BEAT_CONFIDENCE_THRESHOLD = 0.8;
export const PHRASE_DOWNBEAT_CONFIDENCE_THRESHOLD = 0.8;
export const SAFE_FADE_SECONDS = 3.5;
export const DOWNBEAT_CUT_SECONDS = 0.35;
// Enough time for the UI-side preparation pass to finish before Web Audio owns
// the immutable schedule. Musical cues may be later; Safe Fade uses this floor.
export const TRANSITION_SCHEDULE_LEAD_SECONDS = 0.25;

export type TransitionTrack = BeatGridAnalysis & {
  trackId: string | null;
  duration: number;
  beatConfidence?: number | null;
  downbeatConfidence?: number | null;
  automaticRhythmTrust?: {
    schemaVersion?: string;
    tier?: string;
    calibrationVersion?: string | null;
    calibratedSafeProbability?: number | null;
    usableCutBeatIndices?: number[];
  } | null;
  rhythmDetector?: string | null;
  rhythmAnalysisVersion?: string | null;
  rhythmModelSha256?: string | null;
  rhythmBackend?: string | null;
  energyByBeat?: number[];
  vocalProbabilityByBeat?: number[];
  structureBoundaries?: Array<{ beatIndex: number; confidence: number }>;
};

export type TransitionDeckState = {
  positionSeconds: number;
  playbackRate: number;
};

export type TransitionPlanningInput = {
  requestedAt: number;
  source: TransitionTrack;
  target: TransitionTrack;
  sourceDeck: TransitionDeckState;
  keyLockCapability?: KeyLockCapability | null;
  keyLockRuntime?: Readonly<{
    contextSampleRate: number;
    sourceLoadKey: string;
    targetLoadKey: string;
    sourceBackend: string;
    targetBackend: string;
  }> | null;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

const nearestBeatIndex = (beats: number[], time: number) => {
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < beats.length; index += 1) {
    const distance = Math.abs(beats[index] - time);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
};

const transitionAutomation = () => {
  const curves = createEqualPowerCurves(128);
  return {
    sourceGain: Array.from(curves.source),
    targetGain: Array.from(curves.target),
    sourceEq: [
      { low: 0, mid: 0, high: 0 },
      { low: -12, mid: 0, high: 0 }
    ],
    targetEq: [
      { low: -12, mid: 0, high: 0 },
      { low: 0, mid: 0, high: 0 }
    ]
  };
};

const safeAutomation = () => {
  const curves = createEqualPowerCurves(128);
  return {
    sourceGain: Array.from(curves.source),
    targetGain: Array.from(curves.target),
    sourceEq: [{ low: 0, mid: 0, high: 0 }],
    targetEq: [{ low: 0, mid: 0, high: 0 }]
  };
};

const labelTrack = (track: TransitionTrack, fallback: string) => track.trackId ?? fallback;
const allowsAutomaticDownbeatCut = (track: TransitionTrack) =>
  hasCurrentEnhancedRhythm(track) &&
  (track.automaticRhythmTrust?.tier === "bar-cut-candidate" ||
    track.automaticRhythmTrust?.tier === "short-sync-candidate" ||
    track.automaticRhythmTrust?.tier === "long-candidate") &&
  Boolean(track.automaticRhythmTrust?.usableCutBeatIndices?.length);

export const planAutomaticTransition = (
  input: TransitionPlanningInput
): Readonly<TransitionPlanV2> => {
  const { source, target, sourceDeck, requestedAt } = input;
  const sourceGrid = buildEffectiveBeatGrid(source);
  const targetGrid = buildEffectiveBeatGrid(target);
  const reasons: string[] = [];
  const sourceNaturalBpm = sourceGrid.bpm;
  const targetNaturalBpm = targetGrid.bpm;
  const sourcePlaybackRate = Number.isFinite(sourceDeck.playbackRate) && sourceDeck.playbackRate > 0
    ? sourceDeck.playbackRate
    : 1;
  const sourcePerformanceBpm = sourceNaturalBpm
    ? sourceNaturalBpm * sourcePlaybackRate
    : null;
  const targetPlaybackRate =
    sourcePerformanceBpm && targetNaturalBpm
      ? playbackRateForBpm(targetNaturalBpm, sourcePerformanceBpm)
      : 1;

  if (source.analysisOverrides?.autoMixDisabled || target.analysisOverrides?.autoMixDisabled) {
    reasons.push("A track is disabled for Auto Mix.");
  }
  if (sourceGrid.isManual || targetGrid.isManual) {
    reasons.push("A manually repaired grid is not calibrated for long blends.");
  }
  if (
    source.automaticRhythmTrust?.calibrationVersion == null ||
    target.automaticRhythmTrust?.calibrationVersion == null
  ) {
    reasons.push("Automatic timing has not passed real-music calibration yet.");
  }
  if (!sourceNaturalBpm || !targetNaturalBpm) reasons.push("A reliable BPM is missing.");
  if (!sourceGrid.beatsSeconds.length || !targetGrid.beatsSeconds.length) {
    reasons.push("A beat grid is missing.");
  }
  if (!sourceGrid.downbeatsSeconds.length || !targetGrid.downbeatsSeconds.length) {
    reasons.push("A trusted downbeat grid is missing.");
  }

  const sourceBeatConfidence = clamp01(Number(source.beatConfidence ?? 0));
  const targetBeatConfidence = clamp01(Number(target.beatConfidence ?? 0));
  const sourceDownbeatConfidence = clamp01(Number(source.downbeatConfidence ?? 0));
  const targetDownbeatConfidence = clamp01(Number(target.downbeatConfidence ?? 0));
  if (
    sourceBeatConfidence < PHRASE_BEAT_CONFIDENCE_THRESHOLD ||
    targetBeatConfidence < PHRASE_BEAT_CONFIDENCE_THRESHOLD
  ) {
    reasons.push("Beat confidence is below the phrase-blend threshold.");
  }
  if (
    sourceDownbeatConfidence < PHRASE_DOWNBEAT_CONFIDENCE_THRESHOLD ||
    targetDownbeatConfidence < PHRASE_DOWNBEAT_CONFIDENCE_THRESHOLD
  ) {
    reasons.push("Downbeat confidence is below the phrase-blend threshold.");
  }
  if (sourcePerformanceBpm && targetNaturalBpm && stretchSeverity(targetPlaybackRate) === "reject") {
    reasons.push("Required tempo stretch exceeds the 10% hard limit.");
  }
  const tempoChangeNeedsKeyLock = Math.abs(sourcePlaybackRate - 1) > 0.001 || Math.abs(targetPlaybackRate - 1) > 0.001;
  if (tempoChangeNeedsKeyLock && !keyLockCapabilityCovers(
    input.keyLockCapability,
    [sourcePlaybackRate, targetPlaybackRate],
    input.keyLockRuntime ?? undefined
  )) {
    reasons.push("Pitch-preserving tempo sync is not ready on this device.");
  }

  let sourceCue = null as number | null;
  let targetCue = null as number | null;
  let phraseDuration = null as number | null;
  if (sourceNaturalBpm && targetNaturalBpm && sourcePerformanceBpm) {
    phraseDuration = secondsForBeats(DEFAULT_PHRASE_BEATS, sourcePerformanceBpm);
    const sourceTrackSpan = secondsForBeats(DEFAULT_PHRASE_BEATS, sourceNaturalBpm);
    const targetTrackSpan = secondsForBeats(DEFAULT_PHRASE_BEATS, targetNaturalBpm);
    const minimumSourcePosition =
      sourceDeck.positionSeconds + TRANSITION_SCHEDULE_LEAD_SECONDS * sourcePlaybackRate;
    sourceCue =
      sourceGrid.downbeatsSeconds.find(
        (downbeat) =>
          downbeat >= minimumSourcePosition && downbeat + sourceTrackSpan <= source.duration + 0.001
      ) ?? null;
    targetCue =
      targetGrid.downbeatsSeconds.find(
        (downbeat) => downbeat + targetTrackSpan <= target.duration + 0.001
      ) ?? null;
    if (sourceCue === null || targetCue === null) {
      reasons.push("A complete 32-beat downbeat window is unavailable.");
    }
  }

  if (!reasons.length && sourceCue !== null && targetCue !== null && phraseDuration && sourcePerformanceBpm) {
    const startTime = requestedAt + (sourceCue - sourceDeck.positionSeconds) / sourcePlaybackRate;
    const confidence = minimumConfidence([
      sourceBeatConfidence,
      targetBeatConfidence,
      sourceDownbeatConfidence,
      targetDownbeatConfidence
    ]);
    return deepFreeze({
      schemaVersion: TRANSITION_PLAN_SCHEMA_VERSION,
      fromTrackId: labelTrack(source, "untracked-source"),
      toTrackId: labelTrack(target, "untracked-target"),
      template: "phrase-blend",
      targetBpm: sourcePerformanceBpm,
      sourceStartBeat: nearestBeatIndex(sourceGrid.beatsSeconds, sourceCue),
      targetStartBeat: nearestBeatIndex(targetGrid.beatsSeconds, targetCue),
      lengthBeats: DEFAULT_PHRASE_BEATS,
      sourcePlaybackRate,
      targetPlaybackRate,
      score: confidence,
      confidence,
      scoreBreakdown: {
        beatConfidence: Math.min(sourceBeatConfidence, targetBeatConfidence),
        downbeatConfidence: Math.min(sourceDownbeatConfidence, targetDownbeatConfidence),
        stretch: Math.abs(targetPlaybackRate - 1)
      },
      eligibility: { longBlendEligible: true, reasons: [] },
      schedule: {
        requestedAt,
        startTime,
        endTime: startTime + phraseDuration,
        durationSeconds: phraseDuration,
        targetCueSeconds: targetCue
      },
      automation: transitionAutomation(),
      explanation: [
        `Qualified 32-beat phrase blend at ${sourcePerformanceBpm.toFixed(1)} BPM.`,
        "Both tracks have beat/downbeat confidence above the long-blend gate.",
        "Bass ownership transfers once during the overlap."
      ]
    });
  }

  const manualOrDisabled =
    source.analysisOverrides?.autoMixDisabled || target.analysisOverrides?.autoMixDisabled ||
    sourceGrid.isManual || targetGrid.isManual;
  if (
    !manualOrDisabled &&
    allowsAutomaticDownbeatCut(source) &&
    allowsAutomaticDownbeatCut(target) &&
    sourceGrid.downbeatsSeconds.length &&
    targetGrid.downbeatsSeconds.length
  ) {
    const minimumSourcePosition =
      sourceDeck.positionSeconds + TRANSITION_SCHEDULE_LEAD_SECONDS * sourcePlaybackRate;
    const cuePair = rankTrustedMusicalCuePairs(
      { ...source, beatsSeconds: sourceGrid.beatsSeconds },
      { ...target, beatsSeconds: targetGrid.beatsSeconds },
      { minimumTimeSeconds: minimumSourcePosition, maximumWaitSeconds: 12 }
    ).find((pair) => pair.target.timeSeconds + DOWNBEAT_CUT_SECONDS <= target.duration);
    const sourceCandidate = cuePair?.source;
    const targetCandidate = cuePair?.target;
    const cutSourceCue = sourceCandidate?.timeSeconds;
    const cutTargetCue = targetCandidate?.timeSeconds;
    if (sourceCandidate && targetCandidate && cutSourceCue !== undefined && cutTargetCue !== undefined) {
      const startTime = requestedAt + (cutSourceCue - sourceDeck.positionSeconds) / sourcePlaybackRate;
      return deepFreeze({
        schemaVersion: TRANSITION_PLAN_SCHEMA_VERSION,
        fromTrackId: labelTrack(source, "untracked-source"),
        toTrackId: labelTrack(target, "untracked-target"),
        template: "downbeat-cut",
        targetBpm: null,
        sourceStartBeat: nearestBeatIndex(sourceGrid.beatsSeconds, cutSourceCue),
        targetStartBeat: nearestBeatIndex(targetGrid.beatsSeconds, cutTargetCue),
        lengthBeats: null,
        sourcePlaybackRate,
        targetPlaybackRate: 1,
        score: 0,
        confidence: 0,
        scoreBreakdown: {
          beatConfidence: 0,
          downbeatConfidence: 0,
          stretch: 0,
          musicalCuePreference: clamp01(cuePair.score),
          energyContinuity: cuePair.energyDifference == null
            ? 0
            : clamp01(1 - cuePair.energyDifference),
          vocalClarity: cuePair.combinedVocalProxy == null
            ? 0
            : clamp01(1 - cuePair.combinedVocalProxy)
        },
        eligibility: { longBlendEligible: false, reasons: [...new Set(reasons)] },
        schedule: {
          requestedAt,
          startTime,
          endTime: startTime + DOWNBEAT_CUT_SECONDS,
          durationSeconds: DOWNBEAT_CUT_SECONDS,
          targetCueSeconds: cutTargetCue
        },
        automation: safeAutomation(),
        explanation: [
          `Automatic timing found matching bar starts for a short handoff. ${cuePair.reason}`,
          "No tempo stretch or long percussion overlap is applied.",
          "A long blend remains locked until real-music calibration passes."
        ]
      });
    }
    reasons.push("The next track has no trusted automatic bar cue in its opening section.");
  }

  if (!allowsAutomaticDownbeatCut(source) || !allowsAutomaticDownbeatCut(target)) {
    reasons.push("A locally trusted automatic bar handoff is unavailable for this pair.");
  }

  const sourceRemaining = Math.max(
    0.05,
    (source.duration - sourceDeck.positionSeconds) / sourcePlaybackRate
  );
  const schedulingLeadSeconds = Math.min(
    TRANSITION_SCHEDULE_LEAD_SECONDS,
    Math.max(0.01, sourceRemaining * 0.2)
  );
  const startTime = requestedAt + schedulingLeadSeconds;
  const durationSeconds = Math.max(
    0.01,
    Math.min(SAFE_FADE_SECONDS, sourceRemaining - schedulingLeadSeconds, Math.max(0.01, target.duration - 0.05))
  );
  return deepFreeze({
    schemaVersion: TRANSITION_PLAN_SCHEMA_VERSION,
    fromTrackId: labelTrack(source, "untracked-source"),
    toTrackId: labelTrack(target, "untracked-target"),
    template: "safe-fade",
    targetBpm: null,
    sourceStartBeat: null,
    targetStartBeat: null,
    lengthBeats: null,
    sourcePlaybackRate,
    targetPlaybackRate: 1,
    score: 0,
    confidence: 0,
    scoreBreakdown: {
      beatConfidence: Math.min(sourceBeatConfidence, targetBeatConfidence),
      downbeatConfidence: Math.min(sourceDownbeatConfidence, targetDownbeatConfidence),
      stretch: 0
    },
    eligibility: { longBlendEligible: false, reasons: [...new Set(reasons)] },
    schedule: {
      requestedAt,
      startTime,
      endTime: startTime + durationSeconds,
      durationSeconds,
      targetCueSeconds: 0
    },
    automation: safeAutomation(),
    explanation: [
      "Safe Fade selected because a qualified long blend is unavailable.",
      ...new Set(reasons),
      "No tempo stretch or long percussion overlap is applied."
    ]
  });
};
