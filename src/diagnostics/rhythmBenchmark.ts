export const DEFAULT_EVENT_TOLERANCE_SECONDS = 0.07;
export const DEFAULT_TEMPO_TOLERANCE_RATIO = 0.04;
export const RHYTHM_BENCHMARK_VERSION = "rhythm-benchmark/v1" as const;

export type RhythmEstimate = {
  bpm: number | null;
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  tempoConfidence: number;
  beatConfidence: number;
  downbeatConfidence: number;
};

export type RhythmExample = {
  id: string;
  description: string;
  provenance: "procedurally-generated";
  sampleRate: number;
  pcm: Float32Array;
  reference: {
    bpm: number | null;
    beatsSeconds: number[];
    downbeatsSeconds: number[];
  };
};

export type RhythmDetector = {
  id: string;
  licence: string;
  distribution: "runtime-candidate" | "research-only";
  analyze: (pcm: Float32Array, sampleRate: number) => RhythmEstimate | Promise<RhythmEstimate>;
};

export type EventMetrics = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  fMeasure: number;
  meanAbsoluteErrorMs: number | null;
};

export type RhythmCaseResult = {
  exampleId: string;
  estimate: RhythmEstimate;
  tempoCorrect: boolean;
  octaveAwareTempoError: number | null;
  beat: EventMetrics;
  downbeat: EventMetrics;
  confidenceBrier: number;
  runtimeMs: number;
};

export type RhythmDetectorResult = {
  detector: Pick<RhythmDetector, "id" | "licence" | "distribution">;
  cases: RhythmCaseResult[];
  aggregate: {
    tempoAccuracy: number;
    beatFMeasure: number;
    downbeatFMeasure: number;
    nonRhythmicRejectionRate: number;
    confidenceBrier: number;
    meanRuntimeMs: number;
  };
};

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const octaveAwareTempoError = (estimatedBpm: number | null, referenceBpm: number | null) => {
  if (estimatedBpm === null || referenceBpm === null || estimatedBpm <= 0 || referenceBpm <= 0) {
    return null;
  }
  return Math.min(
    ...[-1, 0, 1].map((octave) =>
      Math.abs(Math.log2((estimatedBpm * 2 ** octave) / referenceBpm))
    )
  );
};

export const isTempoCorrect = (
  estimatedBpm: number | null,
  referenceBpm: number | null,
  toleranceRatio = DEFAULT_TEMPO_TOLERANCE_RATIO
) => {
  if (estimatedBpm === null || referenceBpm === null) return estimatedBpm === referenceBpm;
  const error = octaveAwareTempoError(estimatedBpm, referenceBpm);
  return error !== null && error <= Math.log2(1 + toleranceRatio);
};

export const scoreEvents = (
  estimatedSeconds: number[],
  referenceSeconds: number[],
  toleranceSeconds = DEFAULT_EVENT_TOLERANCE_SECONDS
): EventMetrics => {
  if (!estimatedSeconds.every(Number.isFinite) || !referenceSeconds.every(Number.isFinite)) {
    throw new Error("Rhythm events must contain only finite timestamps.");
  }
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new Error("Rhythm event tolerance must be a finite non-negative number.");
  }
  const estimated = [...estimatedSeconds].sort((left, right) => left - right);
  const reference = [...referenceSeconds].sort((left, right) => left - right);

  const columns = estimated.length + 1;
  const cells = (reference.length + 1) * columns;
  const matches = new Uint32Array(cells);
  const totalError = new Float64Array(cells);
  const action = new Uint8Array(cells); // 1 = skip reference, 2 = skip estimate, 3 = match.
  const isBetter = (candidateMatches: number, candidateError: number, index: number) =>
    candidateMatches > matches[index] ||
    (candidateMatches === matches[index] && candidateError < totalError[index]);

  for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
    for (let estimatedIndex = 1; estimatedIndex <= estimated.length; estimatedIndex += 1) {
      const index = referenceIndex * columns + estimatedIndex;
      const above = index - columns;
      const left = index - 1;
      matches[index] = matches[above];
      totalError[index] = totalError[above];
      action[index] = 1;
      if (isBetter(matches[left], totalError[left], index)) {
        matches[index] = matches[left];
        totalError[index] = totalError[left];
        action[index] = 2;
      }
      const pairError = Math.abs(estimated[estimatedIndex - 1] - reference[referenceIndex - 1]);
      if (pairError <= toleranceSeconds) {
        const diagonal = above - 1;
        const candidateMatches = matches[diagonal] + 1;
        const candidateError = totalError[diagonal] + pairError;
        if (isBetter(candidateMatches, candidateError, index)) {
          matches[index] = candidateMatches;
          totalError[index] = candidateError;
          action[index] = 3;
        }
      }
    }
  }
  const errors: number[] = [];
  let referenceIndex = reference.length;
  let estimatedIndex = estimated.length;
  while (referenceIndex > 0 && estimatedIndex > 0) {
    const selected = action[referenceIndex * columns + estimatedIndex];
    if (selected === 3) {
      errors.push(Math.abs(estimated[estimatedIndex - 1] - reference[referenceIndex - 1]));
      referenceIndex -= 1;
      estimatedIndex -= 1;
    } else if (selected === 2) estimatedIndex -= 1;
    else referenceIndex -= 1;
  }

  const truePositives = errors.length;
  const falsePositives = estimated.length - truePositives;
  const falseNegatives = reference.length - truePositives;
  const precision = estimated.length === 0 ? (reference.length === 0 ? 1 : 0) : truePositives / estimated.length;
  const recall = reference.length === 0 ? (estimated.length === 0 ? 1 : 0) : truePositives / reference.length;
  const fMeasure = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    fMeasure,
    meanAbsoluteErrorMs: errors.length ? mean(errors) * 1000 : null
  };
};

const confidenceBrier = (estimate: RhythmEstimate, tempoCorrect: boolean, beatFMeasure: number) => {
  const expected = tempoCorrect && beatFMeasure >= 0.7 ? 1 : 0;
  const confidence = clamp01(Math.min(estimate.tempoConfidence, estimate.beatConfidence));
  return (confidence - expected) ** 2;
};

export const benchmarkRhythmDetector = async (
  detector: RhythmDetector,
  examples: RhythmExample[]
): Promise<RhythmDetectorResult> => {
  const cases: RhythmCaseResult[] = [];
  for (const example of examples) {
    const startedAt = performance.now();
    const estimate = await detector.analyze(example.pcm.slice(), example.sampleRate);
    const runtimeMs = performance.now() - startedAt;
    const tempoCorrect = isTempoCorrect(estimate.bpm, example.reference.bpm);
    const beat = scoreEvents(estimate.beatsSeconds, example.reference.beatsSeconds);
    const downbeat = scoreEvents(estimate.downbeatsSeconds, example.reference.downbeatsSeconds);
    cases.push({
      exampleId: example.id,
      estimate,
      tempoCorrect,
      octaveAwareTempoError: octaveAwareTempoError(estimate.bpm, example.reference.bpm),
      beat,
      downbeat,
      confidenceBrier: confidenceBrier(estimate, tempoCorrect, beat.fMeasure),
      runtimeMs
    });
  }

  const nonRhythmicCases = cases.filter((result) => {
    const example = examples.find((candidate) => candidate.id === result.exampleId);
    return example?.reference.bpm === null;
  });
  const rhythmicCases = cases.filter((result) => {
    const example = examples.find((candidate) => candidate.id === result.exampleId);
    return example?.reference.bpm !== null;
  });
  return {
    detector: {
      id: detector.id,
      licence: detector.licence,
      distribution: detector.distribution
    },
    cases,
    aggregate: {
      tempoAccuracy: mean(rhythmicCases.map((result) => Number(result.tempoCorrect))),
      beatFMeasure: mean(rhythmicCases.map((result) => result.beat.fMeasure)),
      downbeatFMeasure: mean(rhythmicCases.map((result) => result.downbeat.fMeasure)),
      nonRhythmicRejectionRate: mean(
        nonRhythmicCases.map((result) =>
          Number(
            result.estimate.bpm === null &&
            result.estimate.beatsSeconds.length === 0 &&
            result.estimate.downbeatsSeconds.length === 0
          )
        )
      ),
      confidenceBrier: mean(cases.map((result) => result.confidenceBrier)),
      meanRuntimeMs: mean(cases.map((result) => result.runtimeMs))
    }
  };
};

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export const formatRhythmBenchmarkMarkdown = (results: RhythmDetectorResult[]) => {
  const rows = results.map(({ detector, aggregate }) =>
    `| ${detector.id} | ${detector.distribution} | ${percent(aggregate.tempoAccuracy)} | ${percent(aggregate.beatFMeasure)} | ${percent(aggregate.downbeatFMeasure)} | ${percent(aggregate.nonRhythmicRejectionRate)} | ${aggregate.confidenceBrier.toFixed(3)} | ${aggregate.meanRuntimeMs.toFixed(1)} |`
  );
  return [
    "| Detector | Distribution | Rhythmic tempo | Rhythmic beat F1 | Rhythmic downbeat F1 | Non-rhythmic rejection | Confidence Brier ↓ | Mean runtime ms |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...rows
  ].join("\n");
};

export const formatRhythmCasesMarkdown = (results: RhythmDetectorResult[]) => {
  const rows = results.flatMap((result) =>
    result.cases.map((caseResult) =>
      `| ${result.detector.id} | ${caseResult.exampleId} | ${caseResult.estimate.bpm?.toFixed(1) ?? "none"} | ${caseResult.tempoCorrect ? "yes" : "no"} | ${caseResult.beat.fMeasure.toFixed(3)} | ${caseResult.downbeat.fMeasure.toFixed(3)} | ${Math.min(caseResult.estimate.tempoConfidence, caseResult.estimate.beatConfidence).toFixed(3)} |`
    )
  );
  return [
    "| Detector | Example | Estimated BPM | Tempo correct | Beat F1 | Downbeat F1 | Gating confidence |",
    "|---|---|---:|:---:|---:|---:|---:|",
    ...rows
  ].join("\n");
};
