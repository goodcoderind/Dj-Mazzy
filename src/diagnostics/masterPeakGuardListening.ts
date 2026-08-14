import { analyzeProgramLevel } from "../analysis/programLevel";
import { MASTER_DSP_V1 } from "../audio/masterDsp";
import type { AudioHealthSnapshot } from "../audio/AudioEngine";
import { assessPostMasterPeak } from "./postMasterPeak";
import {
  MASTER_PEAK_GUARD_CANDIDATE,
  MASTER_PEAK_GUARD_COMPARISON_VERSION,
  deriveMasterPeakGuardComparisonMetrics,
  type MasterPeakGuardListeningComparison
} from "./masterPeakGuardCandidate";

export const MASTER_PEAK_GUARD_LISTENING_SCHEMA_VERSION =
  "master-peak-guard-private-listening/v2" as const;
export const MASTER_PEAK_GUARD_AUDITION_POLICY_VERSION =
  "master-peak-guard-ab-audition/v2" as const;
export const MASTER_PEAK_GUARD_LISTENING_PLAYBACK_PEAK_DBTP = -6;
export const MASTER_PEAK_GUARD_BLIND_BLOCK_SIZE = 8;

export type MasterPeakGuardVariant = "current-master" | "peak-guard-candidate";
export type MasterPeakGuardBlindLabel = "a" | "b";
export type MasterPeakGuardListeningRating =
  | "a-cleaner"
  | "b-cleaner"
  | "no-difference"
  | "both-rough"
  | "unsure";
export type MasterPeakGuardListeningOutcome =
  | "current-master-cleaner"
  | "peak-guard-candidate-cleaner"
  | "no-difference"
  | "both-rough"
  | "unsure";
export type MasterPeakGuardArtifactReason =
  | "harsh-transients"
  | "dull-or-soft"
  | "pumping"
  | "stereo-change"
  | "click-or-dropout";
export type MasterPeakGuardRejectionReason =
  | "audio-initialization"
  | "file-read-or-decode"
  | "preview-construction"
  | "paired-render"
  | "incompatible-evidence"
  | "current-master-not-overloaded"
  | "candidate-did-not-contain-peak"
  | "identity-branch-colors-output"
  | "peak-guard-not-engaged"
  | "level-match-or-native-rate";

export type MasterPeakGuardBlindOrder = Readonly<Record<
  MasterPeakGuardBlindLabel,
  MasterPeakGuardVariant
>>;

export type MasterPeakGuardTrialPlan = Readonly<{
  trialOrdinal: number;
  kind: "comparison" | "aa-control";
  order: MasterPeakGuardBlindOrder;
}>;

export type MasterPeakGuardListeningCounts = Record<MasterPeakGuardListeningOutcome, number> & {
  attempted: number;
  technicallyEligible: number;
  technicallyRejected: number;
  preparationAborted: number;
  pendingEligible: number;
  healthyCompletedPairs: number;
  eligibleAbortedOrUnhealthy: number;
  currentFirstCompleted: number;
  candidateFirstCompleted: number;
  controlsCompleted: number;
  controlNoDifference: number;
  controlBothRough: number;
  controlUnsure: number;
  controlDifferenceReported: number;
  artifactReasons: Record<MasterPeakGuardArtifactReason, number>;
  rejectionReasons: Record<MasterPeakGuardRejectionReason, number>;
};

const OUTCOMES: readonly MasterPeakGuardListeningOutcome[] = Object.freeze([
  "current-master-cleaner",
  "peak-guard-candidate-cleaner",
  "no-difference",
  "both-rough",
  "unsure"
]);
const REASONS: readonly MasterPeakGuardArtifactReason[] = Object.freeze([
  "harsh-transients",
  "dull-or-soft",
  "pumping",
  "stereo-change",
  "click-or-dropout"
]);
const REJECTIONS: readonly MasterPeakGuardRejectionReason[] = Object.freeze([
  "audio-initialization",
  "file-read-or-decode",
  "preview-construction",
  "paired-render",
  "incompatible-evidence",
  "current-master-not-overloaded",
  "candidate-did-not-contain-peak",
  "identity-branch-colors-output",
  "peak-guard-not-engaged",
  "level-match-or-native-rate"
]);

const artifactReasonCounts = (): Record<MasterPeakGuardArtifactReason, number> => ({
  "harsh-transients": 0,
  "dull-or-soft": 0,
  pumping: 0,
  "stereo-change": 0,
  "click-or-dropout": 0
});
const rejectionReasonCounts = (): Record<MasterPeakGuardRejectionReason, number> => ({
  "audio-initialization": 0,
  "file-read-or-decode": 0,
  "preview-construction": 0,
  "paired-render": 0,
  "incompatible-evidence": 0,
  "current-master-not-overloaded": 0,
  "candidate-did-not-contain-peak": 0,
  "identity-branch-colors-output": 0,
  "peak-guard-not-engaged": 0,
  "level-match-or-native-rate": 0
});

export const emptyMasterPeakGuardListeningCounts = (): MasterPeakGuardListeningCounts => ({
  attempted: 0,
  technicallyEligible: 0,
  technicallyRejected: 0,
  preparationAborted: 0,
  pendingEligible: 0,
  healthyCompletedPairs: 0,
  eligibleAbortedOrUnhealthy: 0,
  currentFirstCompleted: 0,
  candidateFirstCompleted: 0,
  controlsCompleted: 0,
  controlNoDifference: 0,
  controlBothRough: 0,
  controlUnsure: 0,
  controlDifferenceReported: 0,
  "current-master-cleaner": 0,
  "peak-guard-candidate-cleaner": 0,
  "no-difference": 0,
  "both-rough": 0,
  unsure: 0,
  artifactReasons: artifactReasonCounts(),
  rejectionReasons: rejectionReasonCounts()
});

export const buildMasterPeakGuardBlindOrder = (candidateFirst: boolean): MasterPeakGuardBlindOrder =>
  Object.freeze(candidateFirst
    ? { a: "peak-guard-candidate", b: "current-master" }
    : { a: "current-master", b: "peak-guard-candidate" });

export const buildMasterPeakGuardTrialPlan = (
  trialOrdinal: number,
  initialCandidateFirst: boolean,
  controlVariant: MasterPeakGuardVariant
): MasterPeakGuardTrialPlan => {
  if (!Number.isSafeInteger(trialOrdinal) || trialOrdinal <= 0) {
    throw new RangeError("trial ordinal must be a positive safe integer");
  }
  if (trialOrdinal % 4 === 0) {
    const controlIndex = trialOrdinal / 4;
    const selectedControl = controlIndex % 2 === 1
      ? controlVariant
      : controlVariant === "current-master" ? "peak-guard-candidate" : "current-master";
    return Object.freeze({
      trialOrdinal,
      kind: "aa-control" as const,
      order: Object.freeze({ a: selectedControl, b: selectedControl })
    });
  }
  const comparisonOrdinal = trialOrdinal - Math.floor(trialOrdinal / 4);
  const candidateFirst = comparisonOrdinal % 2 === 1 ? initialCandidateFirst : !initialCandidateFirst;
  return Object.freeze({
    trialOrdinal,
    kind: "comparison" as const,
    order: buildMasterPeakGuardBlindOrder(candidateFirst)
  });
};

export const mapMasterPeakGuardRating = (
  rating: MasterPeakGuardListeningRating,
  plan: MasterPeakGuardTrialPlan
): MasterPeakGuardListeningOutcome | "control-no-difference" | "control-both-rough" |
  "control-unsure" | "control-difference-reported" => {
  if (plan.kind === "aa-control") {
    if (rating === "no-difference") return "control-no-difference";
    if (rating === "both-rough") return "control-both-rough";
    if (rating === "unsure") return "control-unsure";
    return "control-difference-reported";
  }
  if (rating === "a-cleaner" || rating === "b-cleaner") {
    const label = rating === "a-cleaner" ? "a" : "b";
    return plan.order[label] === "peak-guard-candidate"
      ? "peak-guard-candidate-cleaner"
      : "current-master-cleaner";
  }
  return rating;
};

const validBoundRender = (
  comparison: MasterPeakGuardListeningComparison,
  render: MasterPeakGuardListeningComparison["currentMaster"],
  expectedVariant: typeof render.variant,
  expectedStage: typeof render.outputStage,
  expectedCandidateVersion: typeof render.peakGuardCandidateVersion
) => render.kind === "master-peak-guard-listening-render/v2" &&
  render.variant === expectedVariant && render.outputStage === expectedStage &&
  render.peakGuardCandidateVersion === expectedCandidateVersion &&
  render.comparisonOrdinal === comparison.comparisonOrdinal &&
  render.sampleRate === comparison.sampleRate && render.frameCount === comparison.frameCount &&
  render.channels.length === 2 && render.channels[0].length === comparison.frameCount &&
  render.channels[1].length === comparison.frameCount &&
  render.peak.schemaVersion === "post-master-peak-check/v2" &&
  render.peak.requiredMasterVersion === MASTER_DSP_V1.version &&
  render.peak.sampleRate === comparison.sampleRate && render.peak.channelCount === 2;

export const assessMasterPeakGuardListeningEligibility = (
  comparison: MasterPeakGuardListeningComparison
) => {
  const envelopeValid = comparison.kind === MASTER_PEAK_GUARD_COMPARISON_VERSION &&
    Number.isSafeInteger(comparison.comparisonOrdinal) && comparison.comparisonOrdinal > 0 &&
    comparison.currentMasterVersion === MASTER_DSP_V1.version &&
    comparison.peakGuardCandidateVersion === MASTER_PEAK_GUARD_CANDIDATE.version &&
    Number.isFinite(comparison.sampleRate) && comparison.sampleRate >= 8_000 &&
    Number.isSafeInteger(comparison.frameCount) && comparison.frameCount > 0 &&
    validBoundRender(comparison, comparison.currentMaster, "current-master", "post-current-master", null) &&
    validBoundRender(comparison, comparison.identity4x, "identity-4x", "post-identity-4x", null) &&
    validBoundRender(
      comparison,
      comparison.peakGuardCandidate,
      "peak-guard-candidate",
      "post-peak-guard",
      MASTER_PEAK_GUARD_CANDIDATE.version
    );
  if (!envelopeValid) return Object.freeze({ eligible: false, reason: "incompatible-evidence" as const });
  let measured: ReturnType<typeof deriveMasterPeakGuardComparisonMetrics>;
  try {
    measured = deriveMasterPeakGuardComparisonMetrics(
      comparison.currentMaster.channels,
      comparison.identity4x.channels,
      comparison.peakGuardCandidate.channels,
      comparison.sampleRate
    );
  } catch {
    return Object.freeze({ eligible: false, reason: "incompatible-evidence" as const });
  }
  const exactPeak = (stored: typeof comparison.currentMaster.peak, actual: typeof stored) =>
    stored.schemaVersion === actual.schemaVersion && stored.outputStage === actual.outputStage &&
    stored.requiredMasterVersion === actual.requiredMasterVersion && stored.sampleRate === actual.sampleRate &&
    stored.channelCount === actual.channelCount && stored.samplePeakDbfs === actual.samplePeakDbfs &&
    stored.estimatedTruePeakDbtp === actual.estimatedTruePeakDbtp && stored.ceilingDbtp === actual.ceilingDbtp &&
    stored.peakEstimateAlgorithmVersion === actual.peakEstimateAlgorithmVersion &&
    stored.peakOversampleFactor === actual.peakOversampleFactor &&
    stored.passed === actual.passed && stored.failureCodes.length === actual.failureCodes.length &&
    stored.failureCodes.every((code, index) => code === actual.failureCodes[index]);
  const near = (stored: number | null, actual: number | null, tolerance = 1e-9) =>
    stored === actual || (stored != null && actual != null && Number.isFinite(stored) &&
      Number.isFinite(actual) && Math.abs(stored - actual) <= tolerance);
  const metricsBound = exactPeak(comparison.currentMaster.peak, measured.currentPeak) &&
    exactPeak(comparison.identity4x.peak, measured.identityPeak) &&
    exactPeak(comparison.peakGuardCandidate.peak, measured.candidatePeak) &&
    near(comparison.identityMaximumDelta, measured.identityMaximumDelta) &&
    near(comparison.identityRmsDeltaDb, measured.identityRmsDeltaDb) &&
    near(comparison.identityPeakDeltaDb, measured.identityPeakDeltaDb) &&
    near(comparison.identityResidualDb, measured.identityResidualDb) &&
    near(comparison.identityAlignedMaximumDelta, measured.identityAlignedMaximumDelta) &&
    near(comparison.guardMaximumDelta, measured.guardMaximumDelta) &&
    near(comparison.peakReductionDb, measured.peakReductionDb);
  if (!metricsBound) return Object.freeze({ eligible: false, reason: "incompatible-evidence" as const });
  if (!measured.currentPeak.failureCodes.includes("post-master-estimated-true-peak-overload")) {
    return Object.freeze({ eligible: false, reason: "current-master-not-overloaded" as const });
  }
  if (!measured.candidatePeak.passed) {
    return Object.freeze({ eligible: false, reason: "candidate-did-not-contain-peak" as const });
  }
  if (!Number.isFinite(measured.identityMaximumDelta) ||
    measured.identityRmsDeltaDb == null || !Number.isFinite(measured.identityRmsDeltaDb) ||
    measured.identityPeakDeltaDb == null || !Number.isFinite(measured.identityPeakDeltaDb) ||
    measured.identityResidualDb == null || !Number.isFinite(measured.identityResidualDb) ||
    measured.identityAlignedMaximumDelta == null ||
    !Number.isFinite(measured.identityAlignedMaximumDelta) ||
    measured.identityRmsDeltaDb > 0.1 || measured.identityPeakDeltaDb > 0.3 ||
    measured.identityResidualDb > -40 || measured.identityAlignedMaximumDelta > 0.02) {
    return Object.freeze({ eligible: false, reason: "identity-branch-colors-output" as const });
  }
  if (!Number.isFinite(measured.guardMaximumDelta) || measured.guardMaximumDelta < 1e-5 ||
    measured.peakReductionDb == null || !Number.isFinite(measured.peakReductionDb) ||
    measured.peakReductionDb < 0.2) {
    return Object.freeze({ eligible: false, reason: "peak-guard-not-engaged" as const });
  }
  return Object.freeze({ eligible: true, reason: "engaged-overload" as const });
};

const applyGain = (channels: readonly [Float32Array, Float32Array], gainDb: number) => {
  const gain = 10 ** (gainDb / 20);
  return Object.freeze([
    Float32Array.from(channels[0], (sample) => sample * gain),
    Float32Array.from(channels[1], (sample) => sample * gain)
  ]) as readonly [Float32Array, Float32Array];
};

export type MasterPeakGuardAuditionPair = Readonly<{
  kind: "master-peak-guard-level-matched-audition/v1";
  comparisonOrdinal: number;
  sampleRate: number;
  frameCount: number;
  currentMaster: readonly [Float32Array, Float32Array];
  peakGuardCandidate: readonly [Float32Array, Float32Array];
}>;

export const buildMasterPeakGuardAuditionPair = (
  comparison: MasterPeakGuardListeningComparison
): MasterPeakGuardAuditionPair => {
  const eligibility = assessMasterPeakGuardListeningEligibility(comparison);
  if (!eligibility.eligible) throw new RangeError(eligibility.reason);
  const currentLevel = analyzeProgramLevel(comparison.currentMaster.channels, comparison.sampleRate);
  const candidateLevel = analyzeProgramLevel(comparison.peakGuardCandidate.channels, comparison.sampleRate);
  const currentLufs = currentLevel.measurement.integratedLufs;
  const candidateLufs = candidateLevel.measurement.integratedLufs;
  const currentPeak = comparison.currentMaster.peak.estimatedTruePeakDbtp;
  const candidatePeak = comparison.peakGuardCandidate.peak.estimatedTruePeakDbtp;
  if ([currentLufs, candidateLufs, currentPeak, candidatePeak]
    .some((value) => value == null || !Number.isFinite(value))) {
    throw new RangeError("comparison does not have finite loudness and peak evidence");
  }
  const targetLufs = Math.min(currentLufs as number, candidateLufs as number);
  const currentMatchDb = Math.min(0, targetLufs - (currentLufs as number));
  const candidateMatchDb = Math.min(0, targetLufs - (candidateLufs as number));
  const matchedMaximumPeak = Math.max(
    (currentPeak as number) + currentMatchDb,
    (candidatePeak as number) + candidateMatchDb
  );
  const sharedSafetyDb = Math.min(0, MASTER_PEAK_GUARD_LISTENING_PLAYBACK_PEAK_DBTP - matchedMaximumPeak);
  const currentChannels = applyGain(comparison.currentMaster.channels, currentMatchDb + sharedSafetyDb);
  const candidateChannels = applyGain(
    comparison.peakGuardCandidate.channels,
    candidateMatchDb + sharedSafetyDb
  );
  const currentCheck = assessPostMasterPeak(currentChannels, comparison.sampleRate);
  const candidateCheck = assessPostMasterPeak(candidateChannels, comparison.sampleRate);
  const matchedCurrentLufs = analyzeProgramLevel(currentChannels, comparison.sampleRate).measurement.integratedLufs;
  const matchedCandidateLufs = analyzeProgramLevel(candidateChannels, comparison.sampleRate).measurement.integratedLufs;
  if (
    currentCheck.estimatedTruePeakDbtp == null || candidateCheck.estimatedTruePeakDbtp == null ||
    currentCheck.estimatedTruePeakDbtp > MASTER_PEAK_GUARD_LISTENING_PLAYBACK_PEAK_DBTP ||
    candidateCheck.estimatedTruePeakDbtp > MASTER_PEAK_GUARD_LISTENING_PLAYBACK_PEAK_DBTP ||
    matchedCurrentLufs == null || matchedCandidateLufs == null ||
    Math.abs(matchedCurrentLufs - matchedCandidateLufs) > 0.1
  ) {
    throw new RangeError("attenuation-only audition matching did not meet its safety bounds");
  }
  return Object.freeze({
    kind: "master-peak-guard-level-matched-audition/v1",
    comparisonOrdinal: comparison.comparisonOrdinal,
    sampleRate: comparison.sampleRate,
    frameCount: comparison.frameCount,
    currentMaster: currentChannels,
    peakGuardCandidate: candidateChannels
  });
};

export type MasterPeakGuardHealthBaseline = Readonly<{
  snapshot: AudioHealthSnapshot;
  contextStateCount: number;
}>;

export const evaluateMasterPeakGuardAuditionHealth = (
  baseline: MasterPeakGuardHealthBaseline,
  current: AudioHealthSnapshot,
  expectedActiveSeconds: number,
  actualElapsedSeconds: number
) => {
  const keys = ["renderedFrames", "expectedActiveFrames", "silentFrames", "renderQuanta",
    "nonFiniteSamples", "clippedSamples", "processorErrors", "reports"] as const;
  const delta = Object.fromEntries(keys.map((key) => [key, current[key] - baseline.snapshot[key]])) as
    Record<typeof keys[number], number>;
  const expectedFrames = expectedActiveSeconds * current.sampleRate;
  const frameSlack = current.sampleRate * 0.3;
  const states = current.contextStates.slice(Math.max(0, baseline.contextStateCount - 1));
  const passed = baseline.snapshot.schemaVersion === "audio-health/v2" &&
    current.schemaVersion === "audio-health/v2" && baseline.snapshot.supported && current.supported &&
    current.sampleRate === baseline.snapshot.sampleRate && Number.isFinite(current.sampleRate) &&
    current.sampleRate >= 8_000 && current.expectedOutputActive === false &&
    Number.isFinite(expectedActiveSeconds) && expectedActiveSeconds >= 8 &&
    Number.isFinite(actualElapsedSeconds) &&
    actualElapsedSeconds >= expectedActiveSeconds - 0.05 &&
    actualElapsedSeconds <= expectedActiveSeconds + 0.3 &&
    Object.values(delta).every((value) => Number.isSafeInteger(value) && value >= 0) &&
    delta.expectedActiveFrames >= expectedFrames - frameSlack &&
    delta.expectedActiveFrames <= expectedFrames + frameSlack &&
    delta.renderedFrames >= delta.expectedActiveFrames &&
    delta.renderedFrames <= delta.expectedActiveFrames + current.sampleRate * 1.5 &&
    delta.renderQuanta * 128 === delta.renderedFrames &&
    delta.reports >= Math.max(1, Math.floor(expectedActiveSeconds) - 1) &&
    delta.silentFrames <= current.sampleRate * 0.1 && delta.nonFiniteSamples === 0 &&
    delta.clippedSamples === 0 && delta.processorErrors === 0 &&
    current.peak > 0.001 && current.peak <= 1 && current.longestUnexpectedSilentSeconds <= 0.1 &&
    states.length >= 1 && states.every((state) => state === "running");
  return Object.freeze({ passed, delta: Object.freeze(delta) });
};

export const buildMasterPeakGuardListeningSummary = (
  rawCounts: MasterPeakGuardListeningCounts,
  revealComparisonOutcomes: boolean
) => {
  const counts = emptyMasterPeakGuardListeningCounts();
  const scalarKeys = ["attempted", "technicallyEligible", "technicallyRejected", "preparationAborted",
    "pendingEligible", "healthyCompletedPairs", "eligibleAbortedOrUnhealthy",
    "currentFirstCompleted", "candidateFirstCompleted", "controlsCompleted", "controlNoDifference",
    "controlBothRough", "controlUnsure", "controlDifferenceReported", ...OUTCOMES] as const;
  for (const key of scalarKeys) {
    const value = rawCounts[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("listening counts must be non-negative safe integers");
    counts[key] = value;
  }
  for (const reason of REASONS) {
    const value = rawCounts.artifactReasons[reason];
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("artifact counts must be non-negative safe integers");
    counts.artifactReasons[reason] = value;
  }
  for (const reason of REJECTIONS) {
    const value = rawCounts.rejectionReasons[reason];
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("rejection counts must be non-negative safe integers");
    counts.rejectionReasons[reason] = value;
  }
  const comparisonJudgments = OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0);
  const controlJudgments = counts.controlNoDifference + counts.controlBothRough +
    counts.controlUnsure + counts.controlDifferenceReported;
  const rejectedByReason = REJECTIONS.reduce((sum, reason) => sum + counts.rejectionReasons[reason], 0);
  const orderBalanced = Math.abs(counts.currentFirstCompleted - counts.candidateFirstCompleted) <= 1;
  const expectedControls = Math.floor(counts.healthyCompletedPairs / 4);
  const artifactCountsPlausible = REASONS.every((reason) =>
    counts.artifactReasons[reason] <= counts.healthyCompletedPairs);
  const validRelations = counts.attempted === counts.technicallyEligible + counts.technicallyRejected +
      counts.preparationAborted &&
    counts.technicallyRejected === rejectedByReason &&
    counts.pendingEligible >= 0 && counts.pendingEligible <= 1 &&
    counts.technicallyEligible === counts.pendingEligible + counts.healthyCompletedPairs +
      counts.eligibleAbortedOrUnhealthy &&
    counts.healthyCompletedPairs === comparisonJudgments + controlJudgments &&
    counts.healthyCompletedPairs === counts.currentFirstCompleted + counts.candidateFirstCompleted +
      counts.controlsCompleted &&
    counts.controlsCompleted === controlJudgments && counts.controlsCompleted === expectedControls &&
    artifactCountsPlausible &&
    orderBalanced &&
    counts.healthyCompletedPairs <= MASTER_PEAK_GUARD_BLIND_BLOCK_SIZE &&
    (!revealComparisonOutcomes || (counts.healthyCompletedPairs === MASTER_PEAK_GUARD_BLIND_BLOCK_SIZE &&
      counts.pendingEligible === 0));
  if (!validRelations) throw new RangeError("listening counts violate the blinded trial lifecycle");
  const blindedCounts = Object.freeze({
    attempted: counts.attempted,
    technicallyEligible: counts.technicallyEligible,
    technicallyRejected: counts.technicallyRejected,
    preparationAborted: counts.preparationAborted,
    pendingEligible: counts.pendingEligible,
    healthyCompletedPairs: counts.healthyCompletedPairs,
    eligibleAbortedOrUnhealthy: counts.eligibleAbortedOrUnhealthy,
    judgmentsRecorded: comparisonJudgments + controlJudgments
  });
  const revealedCounts = Object.freeze({
    ...blindedCounts,
    orderBalanced,
    comparisonOutcomes: Object.freeze(Object.fromEntries(
      OUTCOMES.map((outcome) => [outcome, counts[outcome]])
    )),
    controlOutcomes: Object.freeze({
      noDifference: counts.controlNoDifference,
      bothRough: counts.controlBothRough,
      unsure: counts.controlUnsure,
      differenceReported: counts.controlDifferenceReported
    }),
    rejectionReasons: Object.freeze({ ...counts.rejectionReasons }),
    artifactReasons: Object.freeze({ ...counts.artifactReasons })
  });
  return Object.freeze({
    schemaVersion: MASTER_PEAK_GUARD_LISTENING_SCHEMA_VERSION,
    currentMasterVersion: MASTER_DSP_V1.version,
    candidateVersion: MASTER_PEAK_GUARD_CANDIDATE.version,
    auditionPolicyVersion: MASTER_PEAK_GUARD_AUDITION_POLICY_VERSION,
    status: "human-judgment-only" as const,
    candidatePromotionReady: false,
    blockStatus: revealComparisonOutcomes ? "closed" as const : "blinded" as const,
    privacy: "tab-memory aggregate counts only; no audio, filenames, measurements, order, timestamps, persistence, upload, or export" as const,
    evidenceScope: "private attenuation-matched current-master versus peak-guard-candidate engaged-overload artifact judgment; not production approval, unmatched level impact, or output-device proof" as const,
    counts: revealComparisonOutcomes ? revealedCounts : blindedCounts
  });
};
