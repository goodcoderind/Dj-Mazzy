import { scoreEvents, type EventMetrics } from "./rhythmBenchmark";

export const PRIVATE_RHYTHM_EVALUATION_VERSION = "private-rhythm-evaluation/v2" as const;
export const PUBLIC_RHYTHM_SUMMARY_VERSION = "public-rhythm-summary/v1" as const;
export const BEAT_THIS_FINAL0_BROWSER_DETECTOR = "beat-this/final0/browser-v1" as const;
const PUBLIC_DETECTORS = new Set<string>([BEAT_THIS_FINAL0_BROWSER_DETECTOR]);

export type PrivateRhythmPrediction = {
  trackHash: string;
  detector: string;
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  runtimeMs?: number;
};

export type PrivateRhythmAnnotation = {
  trackHash: string;
  reviewedByHuman: true;
  canonicalTimebase: "browser-web-audio/v1";
  regions: Array<{
    startSeconds: number;
    endSeconds: number;
    beatsSeconds: number[];
    downbeatsSeconds: number[];
  }>;
};

export type ScoredPrivateTrack = {
  trackHash: string;
  detector: string;
  annotatedDurationSeconds: number;
  beat: EventMetrics;
  downbeat: EventMetrics;
};

const isFiniteSorted = (events: readonly number[]) =>
  events.every(Number.isFinite) && events.every((value, index) => index === 0 || value > events[index - 1]);

export const validatePrivateAnnotation = (value: unknown): value is PrivateRhythmAnnotation => {
  if (!value || typeof value !== "object") return false;
  const annotation = value as Partial<PrivateRhythmAnnotation>;
  if (
    typeof annotation.trackHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(annotation.trackHash) ||
    annotation.reviewedByHuman !== true ||
    annotation.canonicalTimebase !== "browser-web-audio/v1" ||
    !Array.isArray(annotation.regions) ||
    annotation.regions.length === 0
  ) return false;
  return annotation.regions.every((region, index) => {
    if (
      !region ||
      !Number.isFinite(region.startSeconds) ||
      !Number.isFinite(region.endSeconds) ||
      region.startSeconds < 0 ||
      region.endSeconds <= region.startSeconds ||
      !Array.isArray(region.beatsSeconds) ||
      !Array.isArray(region.downbeatsSeconds) ||
      region.beatsSeconds.length === 0 ||
      region.downbeatsSeconds.length === 0 ||
      !isFiniteSorted(region.beatsSeconds) ||
      !isFiniteSorted(region.downbeatsSeconds)
    ) return false;
    if (index > 0 && region.startSeconds < annotation.regions![index - 1].endSeconds) return false;
    return (
      region.beatsSeconds.every((event) => event >= region.startSeconds && event < region.endSeconds) &&
      region.downbeatsSeconds.every(
        (event) => event >= region.startSeconds && event < region.endSeconds && region.beatsSeconds.includes(event)
      )
    );
  });
};

const validatePrediction = (prediction: PrivateRhythmPrediction) => {
  if (!/^[a-f0-9]{64}$/.test(prediction.trackHash)) throw new Error("Prediction track hash is invalid.");
  if (!prediction.detector.trim()) throw new Error("Prediction detector contract is required.");
  if (!isFiniteSorted(prediction.beatsSeconds) || prediction.beatsSeconds.some((event) => event < 0)) {
    throw new Error("Predicted beats must be finite, non-negative, and strictly increasing.");
  }
  if (!isFiniteSorted(prediction.downbeatsSeconds) || prediction.downbeatsSeconds.some((event) => event < 0)) {
    throw new Error("Predicted downbeats must be finite, non-negative, and strictly increasing.");
  }
  if (prediction.downbeatsSeconds.some((event) => !prediction.beatsSeconds.includes(event))) {
    throw new Error("Every predicted downbeat must also be a predicted beat.");
  }
  if (prediction.runtimeMs !== undefined && (!Number.isFinite(prediction.runtimeMs) || prediction.runtimeMs < 0)) {
    throw new Error("Prediction runtime must be finite and non-negative.");
  }
};

const eventsInsideRegion = (events: readonly number[], startSeconds: number, endSeconds: number) =>
  events.filter((event) => event >= startSeconds && event < endSeconds);

const combineEventMetrics = (metrics: EventMetrics[]): EventMetrics => {
  const truePositives = metrics.reduce((sum, metric) => sum + metric.truePositives, 0);
  const falsePositives = metrics.reduce((sum, metric) => sum + metric.falsePositives, 0);
  const falseNegatives = metrics.reduce((sum, metric) => sum + metric.falseNegatives, 0);
  const precision = truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);
  const weightedError = metrics.reduce(
    (sum, metric) => sum + (metric.meanAbsoluteErrorMs ?? 0) * metric.truePositives,
    0
  );
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    fMeasure: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    meanAbsoluteErrorMs: truePositives === 0 ? null : weightedError / truePositives
  };
};

export const scorePrivateRhythmPrediction = (
  prediction: PrivateRhythmPrediction,
  annotation: PrivateRhythmAnnotation,
  toleranceSeconds = 0.07
): ScoredPrivateTrack => {
  validatePrediction(prediction);
  if (prediction.trackHash !== annotation.trackHash) throw new Error("Prediction and annotation hashes differ.");
  if (!validatePrivateAnnotation(annotation)) throw new Error("Private rhythm annotation is invalid or not human-reviewed.");
  const scoreRegion = (key: "beatsSeconds" | "downbeatsSeconds") => annotation.regions.map((region) =>
    scoreEvents(
      eventsInsideRegion(prediction[key], region.startSeconds, region.endSeconds),
      region[key],
      toleranceSeconds
    )
  );
  return {
    trackHash: prediction.trackHash,
    detector: prediction.detector,
    annotatedDurationSeconds: annotation.regions.reduce(
      (sum, region) => sum + region.endSeconds - region.startSeconds,
      0
    ),
    beat: combineEventMetrics(scoreRegion("beatsSeconds")),
    downbeat: combineEventMetrics(scoreRegion("downbeatsSeconds"))
  };
};

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
};

export const aggregatePrivateRhythmScores = (tracks: ScoredPrivateTrack[]) => {
  if (tracks.length === 0) throw new Error("At least one scored private track is required.");
  if (new Set(tracks.map((track) => track.trackHash)).size !== tracks.length) {
    throw new Error("Private rhythm scores require one unique row per track hash.");
  }
  const detectors = [...new Set(tracks.map((track) => track.detector))];
  if (detectors.length > 1) throw new Error("Private rhythm scores cannot combine different detectors.");
  const aggregate = (key: "beat" | "downbeat") => {
    const micro = combineEventMetrics(tracks.map((track) => track[key]));
    const perTrack = tracks.map((track) => track[key].fMeasure);
    return {
      macroFMeasure: perTrack.reduce((sum, value) => sum + value, 0) / perTrack.length,
      medianFMeasure: percentile(perTrack, 0.5),
      p10FMeasure: percentile(perTrack, 0.1),
      micro
    };
  };
  return {
    schemaVersion: PRIVATE_RHYTHM_EVALUATION_VERSION,
    detector: detectors[0],
    scoredTrackCount: tracks.length,
    annotatedDurationSeconds: tracks.reduce((sum, track) => sum + track.annotatedDurationSeconds, 0),
    beat: aggregate("beat"),
    downbeat: aggregate("downbeat")
  };
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const cohortBucket = (count: number) => count < 20 ? "10-19" : count < 50 ? "20-49" : "50+";

export const toAnonymousPrivateRhythmSummary = (
  aggregate: ReturnType<typeof aggregatePrivateRhythmScores>
) => {
  if (aggregate.scoredTrackCount < 10) throw new Error("Public rhythm summaries require at least ten tracks.");
  if (!PUBLIC_DETECTORS.has(aggregate.detector)) throw new Error("Detector contract is not approved for public summaries.");
  const summarize = (metric: typeof aggregate.beat) => ({
    macroFMeasure: round3(metric.macroFMeasure),
    medianFMeasure: round3(metric.medianFMeasure),
    p10FMeasure: round3(metric.p10FMeasure)
  });
  return {
    schemaVersion: PUBLIC_RHYTHM_SUMMARY_VERSION,
    detector: aggregate.detector,
    cohortSize: cohortBucket(aggregate.scoredTrackCount),
    annotatedHoursRounded: Math.round(aggregate.annotatedDurationSeconds / 3600),
    beat: summarize(aggregate.beat),
    downbeat: summarize(aggregate.downbeat)
  };
};
