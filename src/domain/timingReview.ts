import {
  BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
  TIMING_REVIEW_SCHEMA_VERSION
} from "./versions";

export type TimingVerdict = "matches" | "drifts" | "not_sure" | "not_checked";

export type TimingReviewV1 = {
  schemaVersion: typeof TIMING_REVIEW_SCHEMA_VERSION;
  reviewedAgainst: {
    analysisSchemaVersion: string;
    analyzerVersion: string;
    overrideSchemaVersion: typeof BEAT_GRID_OVERRIDE_SCHEMA_VERSION;
  };
  initialVerdict: "matched" | "felt_wrong" | "not_sure" | "pulse_missing";
  tempoAction: "unchanged" | "halved" | "doubled" | "tapped" | "not_available";
  tapSummary?: {
    tapCount: number;
    bpm: number;
    quality: "steady" | "rough";
    variationBucket: "low" | "medium";
  };
  beatAction: "aligned" | "kept" | "skipped";
  downbeatAction: "marked" | "kept" | "skipped";
  beginningVerdict: TimingVerdict;
  laterVerdict: TimingVerdict;
  finalOutcome: "saved_adjustment" | "kept_existing_safe_fade" | "disabled_auto_mix";
  reviewedOn: string;
};

type ReviewableAnalysis = {
  schemaVersion?: unknown;
  analyzerVersion?: unknown;
  analysisOverrides?: { schemaVersion?: unknown } | null;
};

type TapEstimateSummary = {
  tapCount: number;
  bpm: number;
  quality: "steady" | "rough";
  timingVariation: number;
};

type CreateTimingReviewInput = {
  analysis: ReviewableAnalysis;
  initialVerdict: TimingReviewV1["initialVerdict"];
  tempoAction: TimingReviewV1["tempoAction"];
  tapEstimate?: TapEstimateSummary | null;
  beatAction: TimingReviewV1["beatAction"];
  downbeatAction: TimingReviewV1["downbeatAction"];
  beginningVerdict: TimingVerdict;
  laterVerdict: TimingVerdict;
  manualAdjustmentChanged: boolean;
  autoMixWasNewlyDisabled: boolean;
  reviewedOn?: string;
};

const INITIAL_VERDICTS = new Set(["matched", "felt_wrong", "not_sure", "pulse_missing"]);
const TEMPO_ACTIONS = new Set(["unchanged", "halved", "doubled", "tapped", "not_available"]);
const BEAT_ACTIONS = new Set(["aligned", "kept", "skipped"]);
const DOWNBEAT_ACTIONS = new Set(["marked", "kept", "skipped"]);
const TIMING_VERDICTS = new Set(["matches", "drifts", "not_sure", "not_checked"]);
const FINAL_OUTCOMES = new Set(["saved_adjustment", "kept_existing_safe_fade", "disabled_auto_mix"]);
const REVIEW_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const localCalendarDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !REVIEW_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day;
};

const normalizeTapSummary = (value: unknown): TimingReviewV1["tapSummary"] | null => {
  if (!isRecord(value)) return null;
  const tapCount = Number(value.tapCount);
  const bpm = Number(value.bpm);
  if (
    !Number.isInteger(tapCount) || tapCount < 8 || tapCount > 16 ||
    !Number.isFinite(bpm) || bpm < 40 || bpm > 250 ||
    (value.quality !== "steady" && value.quality !== "rough") ||
    (value.variationBucket !== "low" && value.variationBucket !== "medium")
  ) return null;
  return {
    tapCount,
    bpm: Math.round(bpm * 10) / 10,
    quality: value.quality,
    variationBucket: value.variationBucket
  };
};

export const normalizeTimingReview = (value: unknown): TimingReviewV1 | null => {
  if (!isRecord(value) || value.schemaVersion !== TIMING_REVIEW_SCHEMA_VERSION) return null;
  const reviewedAgainst = value.reviewedAgainst;
  if (
    !isRecord(reviewedAgainst) ||
    !isNonemptyString(reviewedAgainst.analysisSchemaVersion) ||
    !isNonemptyString(reviewedAgainst.analyzerVersion) ||
    reviewedAgainst.overrideSchemaVersion !== BEAT_GRID_OVERRIDE_SCHEMA_VERSION ||
    !INITIAL_VERDICTS.has(String(value.initialVerdict)) ||
    !TEMPO_ACTIONS.has(String(value.tempoAction)) ||
    !BEAT_ACTIONS.has(String(value.beatAction)) ||
    !DOWNBEAT_ACTIONS.has(String(value.downbeatAction)) ||
    !TIMING_VERDICTS.has(String(value.beginningVerdict)) ||
    !TIMING_VERDICTS.has(String(value.laterVerdict)) ||
    !FINAL_OUTCOMES.has(String(value.finalOutcome)) ||
    !isCalendarDate(value.reviewedOn)
  ) return null;

  const tapSummary = normalizeTapSummary(value.tapSummary);
  if ((value.tempoAction === "tapped") !== Boolean(tapSummary)) return null;
  const claimsAdjustment =
    value.tempoAction === "halved" ||
    value.tempoAction === "doubled" ||
    value.tempoAction === "tapped" ||
    value.beatAction === "aligned" ||
    value.downbeatAction === "marked";
  if (value.finalOutcome === "saved_adjustment" && !claimsAdjustment) return null;

  return {
    schemaVersion: TIMING_REVIEW_SCHEMA_VERSION,
    reviewedAgainst: {
      analysisSchemaVersion: reviewedAgainst.analysisSchemaVersion,
      analyzerVersion: reviewedAgainst.analyzerVersion,
      overrideSchemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION
    },
    initialVerdict: value.initialVerdict as TimingReviewV1["initialVerdict"],
    tempoAction: value.tempoAction as TimingReviewV1["tempoAction"],
    ...(tapSummary ? { tapSummary } : {}),
    beatAction: value.beatAction as TimingReviewV1["beatAction"],
    downbeatAction: value.downbeatAction as TimingReviewV1["downbeatAction"],
    beginningVerdict: value.beginningVerdict as TimingVerdict,
    laterVerdict: value.laterVerdict as TimingVerdict,
    finalOutcome: value.finalOutcome as TimingReviewV1["finalOutcome"],
    reviewedOn: value.reviewedOn
  };
};

export const isTimingReviewCurrent = (review: TimingReviewV1, analysis: ReviewableAnalysis) =>
  review.reviewedAgainst.analysisSchemaVersion === analysis.schemaVersion &&
  review.reviewedAgainst.analyzerVersion === analysis.analyzerVersion &&
  review.reviewedAgainst.overrideSchemaVersion ===
    (analysis.analysisOverrides?.schemaVersion ?? BEAT_GRID_OVERRIDE_SCHEMA_VERSION);

export const createTimingReview = (input: CreateTimingReviewInput): TimingReviewV1 => {
  if (!isNonemptyString(input.analysis.schemaVersion) || !isNonemptyString(input.analysis.analyzerVersion)) {
    throw new Error("A timing review requires a versioned analysis");
  }
  const tapSummary = input.tempoAction === "tapped" && input.tapEstimate
    ? {
        tapCount: input.tapEstimate.tapCount,
        bpm: Math.round(input.tapEstimate.bpm * 10) / 10,
        quality: input.tapEstimate.quality,
        variationBucket: input.tapEstimate.timingVariation <= 0.015 ? "low" as const : "medium" as const
      }
    : undefined;
  const finalOutcome = input.manualAdjustmentChanged
    ? "saved_adjustment"
    : input.autoMixWasNewlyDisabled
      ? "disabled_auto_mix"
      : "kept_existing_safe_fade";
  const candidate = {
    schemaVersion: TIMING_REVIEW_SCHEMA_VERSION,
    reviewedAgainst: {
      analysisSchemaVersion: input.analysis.schemaVersion,
      analyzerVersion: input.analysis.analyzerVersion,
      overrideSchemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION
    },
    initialVerdict: input.initialVerdict,
    tempoAction: input.tempoAction,
    ...(tapSummary ? { tapSummary } : {}),
    beatAction: input.beatAction,
    downbeatAction: input.downbeatAction,
    beginningVerdict: input.beginningVerdict,
    laterVerdict: input.laterVerdict,
    finalOutcome,
    reviewedOn: input.reviewedOn ?? localCalendarDate()
  };
  const normalized = normalizeTimingReview(candidate);
  if (!normalized) throw new Error("Invalid timing review response");
  return normalized;
};
