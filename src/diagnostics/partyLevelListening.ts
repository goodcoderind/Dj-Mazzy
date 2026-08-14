import {
  deriveCandidateProgramTrim,
  normalizeProgramLevel,
  PARTY_DECODED_PEAK_CEILING_DBTP
} from "../analysis/programLevel";

export const PARTY_LEVEL_LISTENING_TARGETS = [-16, -14, -12] as const;
export type PartyLevelListeningTarget = typeof PARTY_LEVEL_LISTENING_TARGETS[number];

export type PartyLevelCandidateTrack = Readonly<{
  trimDb: number;
  predictedIntegratedLufs: number;
  predictedEstimatedTruePeakDbtp: number;
  targetConstrained: boolean;
}>;

export type PartyLevelListeningCandidate = Readonly<{
  schemaVersion: "party-level-listening-candidate/v1";
  targetLufs: PartyLevelListeningTarget;
  trackA: PartyLevelCandidateTrack;
  trackB: PartyLevelCandidateTrack;
  predictedDifferenceLu: number;
  warning: "none" | "one-or-more-tracks-cannot-reach-target";
}>;

const roundTenth = (value: number) => Math.round(value * 10) / 10;

const candidateTrack = (
  analysis: NonNullable<ReturnType<typeof normalizeProgramLevel>>,
  targetLufs: PartyLevelListeningTarget
): PartyLevelCandidateTrack => {
  const measurement = analysis.measurement;
  const trim = deriveCandidateProgramTrim(measurement, targetLufs);
  const integrated = measurement.integratedLufs!;
  const estimatedPeak = measurement.estimatedTruePeakDbtp!;
  const predictedIntegratedLufs = roundTenth(integrated + trim.trimDb);
  const predictedEstimatedTruePeakDbtp = roundTenth(estimatedPeak + trim.trimDb);
  return Object.freeze({
    trimDb: trim.trimDb,
    predictedIntegratedLufs,
    predictedEstimatedTruePeakDbtp,
    targetConstrained: Math.abs(predictedIntegratedLufs - targetLufs) > 0.11 ||
      predictedEstimatedTruePeakDbtp > PARTY_DECODED_PEAK_CEILING_DBTP + 0.01
  });
};

export const buildPartyLevelListeningCandidate = (
  rawTrackA: unknown,
  rawTrackB: unknown,
  targetLufs: number
): PartyLevelListeningCandidate | null => {
  if (!(PARTY_LEVEL_LISTENING_TARGETS as readonly number[]).includes(targetLufs)) return null;
  const analysisA = normalizeProgramLevel(rawTrackA);
  const analysisB = normalizeProgramLevel(rawTrackB);
  if (
    !analysisA || !analysisB ||
    analysisA.measurement.status !== "measured" || analysisB.measurement.status !== "measured" ||
    analysisA.measurement.integratedLufs == null || analysisB.measurement.integratedLufs == null ||
    analysisA.measurement.estimatedTruePeakDbtp == null || analysisB.measurement.estimatedTruePeakDbtp == null
  ) return null;
  const target = targetLufs as PartyLevelListeningTarget;
  const trackA = candidateTrack(analysisA, target);
  const trackB = candidateTrack(analysisB, target);
  return Object.freeze({
    schemaVersion: "party-level-listening-candidate/v1",
    targetLufs: target,
    trackA,
    trackB,
    predictedDifferenceLu: roundTenth(Math.abs(
      trackA.predictedIntegratedLufs - trackB.predictedIntegratedLufs
    )),
    warning: trackA.targetConstrained || trackB.targetConstrained
      ? "one-or-more-tracks-cannot-reach-target"
      : "none"
  });
};
