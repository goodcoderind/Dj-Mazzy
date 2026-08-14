export type AutoPilotPreloadSettlement = Readonly<{
  loaded: boolean;
  autoPilotEnabled: boolean;
  operationCurrent: boolean;
  stillEligible: boolean;
  requestedTrackId: string;
  targetTrackId: string | null;
  targetPlaying: boolean;
}>;

export type AutoPilotPreloadLeaseIdentity = Readonly<{
  operation: number;
  generation: number;
  deck: "a" | "b";
  trackId: string;
  loadOrdinal: number;
  sourceTrackId: string | null;
  sourceLoadKey: string | null;
}>;

export const ownsAutoPilotPreloadLease = (
  current: AutoPilotPreloadLeaseIdentity | null,
  expected: AutoPilotPreloadLeaseIdentity
) => Boolean(current) && current!.operation === expected.operation &&
  current!.generation === expected.generation && current!.deck === expected.deck &&
  current!.trackId === expected.trackId && current!.loadOrdinal === expected.loadOrdinal &&
  current!.sourceTrackId === expected.sourceTrackId && current!.sourceLoadKey === expected.sourceLoadKey;

export const maySettleAutoPilotPreloadLease = (
  current: AutoPilotPreloadLeaseIdentity | null,
  expected: AutoPilotPreloadLeaseIdentity & Readonly<{ deadlineSeconds: number }>,
  settledAtSeconds: number
) => ownsAutoPilotPreloadLease(current, expected) && Number.isFinite(settledAtSeconds) &&
  settledAtSeconds < expected.deadlineSeconds;

export const shouldCommitAutoPilotPreload = (settlement: AutoPilotPreloadSettlement) =>
  settlement.loaded &&
  settlement.autoPilotEnabled &&
  settlement.operationCurrent &&
  settlement.stillEligible &&
  settlement.targetTrackId === settlement.requestedTrackId &&
  !settlement.targetPlaying;

export const shouldDiscardSettledAutoPilotPreload = (settlement: AutoPilotPreloadSettlement) =>
  settlement.loaded &&
  !shouldCommitAutoPilotPreload(settlement) &&
  settlement.targetTrackId === settlement.requestedTrackId &&
  !settlement.targetPlaying;
