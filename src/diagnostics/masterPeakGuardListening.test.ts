import { describe, expect, it } from "vitest";
import type { AudioHealthSnapshot } from "../audio/AudioEngine";
import type { PostMasterPeakCheck } from "./postMasterPeak";
import type {
  MasterPeakGuardListeningComparison,
  MasterPeakGuardListeningRender
} from "./masterPeakGuardCandidate";
import { deriveMasterPeakGuardComparisonMetrics } from "./masterPeakGuardCandidate";
import {
  assessMasterPeakGuardListeningEligibility,
  buildMasterPeakGuardAuditionPair,
  buildMasterPeakGuardListeningSummary,
  buildMasterPeakGuardTrialPlan,
  emptyMasterPeakGuardListeningCounts,
  evaluateMasterPeakGuardAuditionHealth,
  mapMasterPeakGuardRating
} from "./masterPeakGuardListening";

const frames = 48_000;
const tone = (amplitude: number) => Float32Array.from(
  { length: frames },
  (_, frame) => amplitude * Math.sin(2 * Math.PI * 1_000 * frame / 48_000)
);
const channels = (amplitude: number) => Object.freeze([tone(amplitude), tone(amplitude)]) as
  readonly [Float32Array, Float32Array];

const render = (
  variant: MasterPeakGuardListeningRender["variant"],
  samples: readonly [Float32Array, Float32Array],
  check: PostMasterPeakCheck
): MasterPeakGuardListeningRender => Object.freeze({
  kind: "master-peak-guard-listening-render/v2",
  variant,
  outputStage: variant === "current-master"
    ? "post-current-master"
    : variant === "identity-4x"
      ? "post-identity-4x"
      : "post-peak-guard",
  peakGuardCandidateVersion: variant === "peak-guard-candidate"
    ? "mazzy-master-peak-guard-candidate/v1"
    : null,
  comparisonOrdinal: 1,
  sampleRate: 48_000,
  frameCount: frames,
  channels: samples,
  peak: check
});

const comparison = (): MasterPeakGuardListeningComparison => {
  const current = channels(0.9);
  const identity = channels(0.9);
  const candidate = channels(0.5);
  const metrics = deriveMasterPeakGuardComparisonMetrics(current, identity, candidate, 48_000);
  return Object.freeze({
    kind: "master-peak-guard-paired-render/v1",
    comparisonOrdinal: 1,
    currentMasterVersion: "mazzy-master/v1",
    peakGuardCandidateVersion: "mazzy-master-peak-guard-candidate/v1",
    sampleRate: 48_000,
    frameCount: frames,
    currentMaster: render("current-master", current, metrics.currentPeak),
    identity4x: render("identity-4x", identity, metrics.identityPeak),
    peakGuardCandidate: render("peak-guard-candidate", candidate, metrics.candidatePeak),
    identityMaximumDelta: metrics.identityMaximumDelta,
    identityRmsDeltaDb: metrics.identityRmsDeltaDb,
    identityPeakDeltaDb: metrics.identityPeakDeltaDb,
    identityResidualDb: metrics.identityResidualDb,
    identityAlignedMaximumDelta: metrics.identityAlignedMaximumDelta,
    guardMaximumDelta: metrics.guardMaximumDelta,
    peakReductionDb: metrics.peakReductionDb
  });
};

const health = (overrides: Partial<AudioHealthSnapshot> = {}): AudioHealthSnapshot => ({
  schemaVersion: "audio-health/v2",
  supported: true,
  expectedOutputActive: false,
  sampleRate: 48_000,
  renderedFrames: 48_000 * 9,
  expectedActiveFrames: 48_000 * 8,
  silentFrames: 0,
  renderQuanta: 3_375,
  nonFiniteSamples: 0,
  clippedSamples: 0,
  processorErrors: 0,
  peak: 0.5,
  longestUnexpectedSilentSeconds: 0,
  reports: 8,
  contextStates: ["running"],
  ...overrides
});

describe("private master peak-guard listening contract", () => {
  it("requires an exact bound, engaged paired render envelope", () => {
    expect(assessMasterPeakGuardListeningEligibility(comparison()))
      .toEqual({ eligible: true, reason: "engaged-overload" });
    const noOverloadChannels = channels(0.5);
    const noOverloadMetrics = deriveMasterPeakGuardComparisonMetrics(
      noOverloadChannels,
      noOverloadChannels,
      channels(0.4),
      48_000
    );
    const noOverload = {
      ...comparison(),
      currentMaster: render("current-master", noOverloadChannels, noOverloadMetrics.currentPeak),
      identity4x: render("identity-4x", noOverloadChannels, noOverloadMetrics.identityPeak),
      peakGuardCandidate: render("peak-guard-candidate", channels(0.4), noOverloadMetrics.candidatePeak),
      identityMaximumDelta: noOverloadMetrics.identityMaximumDelta,
      identityRmsDeltaDb: noOverloadMetrics.identityRmsDeltaDb,
      identityPeakDeltaDb: noOverloadMetrics.identityPeakDeltaDb,
      identityResidualDb: noOverloadMetrics.identityResidualDb,
      identityAlignedMaximumDelta: noOverloadMetrics.identityAlignedMaximumDelta,
      guardMaximumDelta: noOverloadMetrics.guardMaximumDelta,
      peakReductionDb: noOverloadMetrics.peakReductionDb
    };
    expect(assessMasterPeakGuardListeningEligibility(noOverload).reason)
      .toBe("current-master-not-overloaded");
    const noDelta = {
      ...comparison(),
      peakGuardCandidate: render(
        "peak-guard-candidate",
        comparison().currentMaster.channels,
        comparison().currentMaster.peak
      ),
      guardMaximumDelta: 0,
      peakReductionDb: 0
    };
    expect(assessMasterPeakGuardListeningEligibility(noDelta).reason)
      .toBe("candidate-did-not-contain-peak");
    const swapped = { ...comparison(), currentMaster: comparison().peakGuardCandidate };
    expect(assessMasterPeakGuardListeningEligibility(swapped).reason).toBe("incompatible-evidence");
    const wrongOrdinal = {
      ...comparison(),
      peakGuardCandidate: { ...comparison().peakGuardCandidate, comparisonOrdinal: 2 }
    };
    expect(assessMasterPeakGuardListeningEligibility(wrongOrdinal).reason).toBe("incompatible-evidence");
    expect(assessMasterPeakGuardListeningEligibility({
      ...comparison(),
      guardMaximumDelta: comparison().guardMaximumDelta + 0.1
    }).reason).toBe("incompatible-evidence");
    expect(assessMasterPeakGuardListeningEligibility({
      ...comparison(),
      currentMaster: {
        ...comparison().currentMaster,
        peak: { ...comparison().currentMaster.peak, passed: true }
      }
    }).reason).toBe("incompatible-evidence");
    expect(assessMasterPeakGuardListeningEligibility({
      ...comparison(),
      currentMaster: {
        ...comparison().currentMaster,
        peak: {
          ...comparison().currentMaster.peak,
          peakOversampleFactor: 2
        } as unknown as PostMasterPeakCheck
      }
    }).reason).toBe("incompatible-evidence");
    const invertedIdentity = Object.freeze(comparison().currentMaster.channels.map((channel) =>
      Float32Array.from(channel, (sample, frame) => frame % 20 === 0 ? -sample : sample)
    )) as readonly [Float32Array, Float32Array];
    const identityCorruptionMetrics = deriveMasterPeakGuardComparisonMetrics(
      comparison().currentMaster.channels,
      invertedIdentity,
      comparison().peakGuardCandidate.channels,
      48_000
    );
    expect(assessMasterPeakGuardListeningEligibility({
      ...comparison(),
      identity4x: render("identity-4x", invertedIdentity, identityCorruptionMetrics.identityPeak),
      identityMaximumDelta: identityCorruptionMetrics.identityMaximumDelta,
      identityRmsDeltaDb: identityCorruptionMetrics.identityRmsDeltaDb,
      identityPeakDeltaDb: identityCorruptionMetrics.identityPeakDeltaDb,
      identityResidualDb: identityCorruptionMetrics.identityResidualDb,
      identityAlignedMaximumDelta: identityCorruptionMetrics.identityAlignedMaximumDelta,
      guardMaximumDelta: identityCorruptionMetrics.guardMaximumDelta,
      peakReductionDb: identityCorruptionMetrics.peakReductionDb
    }).reason).toBe("identity-branch-colors-output");
  });

  it("matches by attenuation only and revalidates a -6 dBTP playback ceiling", () => {
    const audition = buildMasterPeakGuardAuditionPair(comparison());
    expect(audition.kind).toBe("master-peak-guard-level-matched-audition/v1");
    const currentPeak = audition.currentMaster[0]
      .reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
    const candidatePeak = audition.peakGuardCandidate[0]
      .reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
    expect(currentPeak).toBeLessThanOrEqual(10 ** (-6 / 20));
    expect(candidatePeak).toBeLessThanOrEqual(10 ** (-6 / 20));
    expect(currentPeak).toBeCloseTo(candidatePeak, 2);
  });

  it("counterbalances comparisons and inserts a hidden A/A control", () => {
    const plans = Array.from({ length: 8 }, (_, index) =>
      buildMasterPeakGuardTrialPlan(index + 1, true, "current-master"));
    const [first, second, , fourth] = plans;
    expect(first.order.a).toBe("peak-guard-candidate");
    expect(second.order.a).toBe("current-master");
    expect(fourth).toMatchObject({ kind: "aa-control", order: { a: "current-master", b: "current-master" } });
    expect(plans[7]).toMatchObject({
      kind: "aa-control",
      order: { a: "peak-guard-candidate", b: "peak-guard-candidate" }
    });
    expect(plans.filter((plan) => plan.kind === "comparison" && plan.order.a === "peak-guard-candidate"))
      .toHaveLength(3);
    expect(plans.filter((plan) => plan.kind === "comparison" && plan.order.a === "current-master"))
      .toHaveLength(3);
    expect(mapMasterPeakGuardRating("a-cleaner", first)).toBe("peak-guard-candidate-cleaner");
    expect(mapMasterPeakGuardRating("a-cleaner", fourth)).toBe("control-difference-reported");
    expect(mapMasterPeakGuardRating("no-difference", fourth)).toBe("control-no-difference");
    expect(mapMasterPeakGuardRating("both-rough", fourth)).toBe("control-both-rough");
    expect(mapMasterPeakGuardRating("unsure", fourth)).toBe("control-unsure");
  });

  it("fails closed on unsupported, interrupted, stale, or under-covered health evidence", () => {
    const baselineSnapshot = health({
      renderedFrames: 0,
      expectedActiveFrames: 0,
      renderQuanta: 0,
      reports: 0,
      peak: 0,
      contextStates: ["running"]
    });
    const baseline = { snapshot: baselineSnapshot, contextStateCount: 1 };
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, health(), 8, 8).passed).toBe(true);
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, health({ supported: false }), 8, 8).passed).toBe(false);
    expect(evaluateMasterPeakGuardAuditionHealth(
      baseline,
      health({ contextStates: ["running", "suspended", "running"] }),
      8,
      8
    ).passed).toBe(false);
    expect(evaluateMasterPeakGuardAuditionHealth(
      baseline,
      health({ expectedActiveFrames: 48_000 * 4 }),
      8,
      8
    ).passed).toBe(false);
    expect(evaluateMasterPeakGuardAuditionHealth(
      baseline,
      health({ expectedOutputActive: true }),
      8,
      8
    ).passed).toBe(false);
    const tenSecondHealth = health({
      renderedFrames: 48_000 * 11,
      expectedActiveFrames: 48_000 * 10,
      renderQuanta: (48_000 * 11) / 128,
      reports: 10
    });
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, tenSecondHealth, 10, 7.99).passed).toBe(false);
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, tenSecondHealth, 10, 8).passed).toBe(false);
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, tenSecondHealth, 10, 9).passed).toBe(false);
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, tenSecondHealth, 10, 10).passed).toBe(true);
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, tenSecondHealth, 10, 10.3).passed).toBe(true);
    expect(evaluateMasterPeakGuardAuditionHealth(baseline, tenSecondHealth, 10, 10.31).passed).toBe(false);
  });

  it("keeps arm outcomes hidden until the blinded block closes", () => {
    const hostile = Object.assign(emptyMasterPeakGuardListeningCounts(), {
      attempted: 1,
      technicallyEligible: 1,
      pendingEligible: 1,
      filename: "private-song.wav",
      order: { a: "current-master" }
    });
    const blinded = buildMasterPeakGuardListeningSummary(hostile, false);
    expect(JSON.stringify(blinded.counts)).not.toMatch(/private-song|filename|order|candidate-cleaner/);
    expect(blinded.blockStatus).toBe("blinded");
    expect(() => buildMasterPeakGuardListeningSummary(hostile, true)).toThrow(RangeError);
    const complete = emptyMasterPeakGuardListeningCounts();
    Object.assign(complete, {
      attempted: 8,
      technicallyEligible: 8,
      healthyCompletedPairs: 8,
      currentFirstCompleted: 3,
      candidateFirstCompleted: 3,
      controlsCompleted: 2,
      controlNoDifference: 2,
      "peak-guard-candidate-cleaner": 3,
      "current-master-cleaner": 3
    });
    const revealed = buildMasterPeakGuardListeningSummary(complete, true);
    expect(revealed.blockStatus).toBe("closed");
    expect(JSON.stringify(revealed)).toContain("peak-guard-candidate-cleaner");
    expect(JSON.stringify(revealed)).not.toMatch(/currentFirstCompleted|candidateFirstCompleted/);
    expect(() => buildMasterPeakGuardListeningSummary({
      ...complete,
      technicallyRejected: 1
    }, true)).toThrow(RangeError);
    expect(() => buildMasterPeakGuardListeningSummary({
      ...complete,
      currentFirstCompleted: 4,
      candidateFirstCompleted: 4,
      controlsCompleted: 0,
      controlNoDifference: 0,
      "peak-guard-candidate-cleaner": 4,
      "current-master-cleaner": 4
    }, true)).toThrow(RangeError);
    expect(() => buildMasterPeakGuardListeningSummary({
      ...complete,
      attempted: 9,
      technicallyEligible: 9,
      pendingEligible: 1
    }, true)).toThrow(RangeError);
    expect(() => buildMasterPeakGuardListeningSummary({
      ...complete,
      artifactReasons: { ...complete.artifactReasons, pumping: 9 }
    }, true)).toThrow(RangeError);
  });
});
