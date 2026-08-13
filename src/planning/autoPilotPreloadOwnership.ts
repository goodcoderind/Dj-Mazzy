export type AutoPilotPreloadSettlement = Readonly<{
  loaded: boolean;
  autoPilotEnabled: boolean;
  operationCurrent: boolean;
  stillEligible: boolean;
  requestedTrackId: string;
  targetTrackId: string | null;
  targetPlaying: boolean;
}>;

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
