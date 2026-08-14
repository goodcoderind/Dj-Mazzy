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

export const AUTO_PILOT_PRELOAD_PAUSE_VERSION = "auto-pilot-preload-pause/v1" as const;

export type AutoPilotPreloadPauseDecision = Readonly<{
  version: typeof AUTO_PILOT_PRELOAD_PAUSE_VERSION;
  kind: "none" | "supersede";
  cleanupTarget: boolean;
  observationConfirmed: boolean;
}>;

const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

const validLease = (lease: AutoPilotPreloadLeaseIdentity | null) => Boolean(lease &&
  positiveSafeInteger(lease.operation) && positiveSafeInteger(lease.generation) &&
  ["a", "b"].includes(lease.deck) && typeof lease.trackId === "string" && lease.trackId.length > 0 &&
  positiveSafeInteger(lease.loadOrdinal) &&
  (lease.sourceTrackId == null || (typeof lease.sourceTrackId === "string" && lease.sourceTrackId.length > 0)) &&
  (lease.sourceLoadKey == null || (typeof lease.sourceLoadKey === "string" && lease.sourceLoadKey.length > 0)));

export const autoPilotPreloadLoadAuthorityKey = (lease: AutoPilotPreloadLeaseIdentity) => {
  if (!validLease(lease)) throw new RangeError("invalid preload lease");
  return `auto-pilot-preload:${lease.operation}:${lease.generation}:${lease.deck}:${lease.loadOrdinal}`;
};

export const decideAutoPilotPreloadPause = (input: Readonly<{
  lease: AutoPilotPreloadLeaseIdentity | null;
  pendingLoadOrdinal: number | null;
  targetTrackId: string | null;
  targetLoadOrdinal: number | null;
  targetPlaying: boolean;
}>): AutoPilotPreloadPauseDecision => {
  if (!input.lease) {
    return Object.freeze({
      version: AUTO_PILOT_PRELOAD_PAUSE_VERSION,
      kind: "none",
      cleanupTarget: false,
      observationConfirmed: true
    });
  }
  if (!validLease(input.lease) ||
    (input.pendingLoadOrdinal != null && !positiveSafeInteger(input.pendingLoadOrdinal)) ||
    (input.targetLoadOrdinal != null && !positiveSafeInteger(input.targetLoadOrdinal)) ||
    (input.targetTrackId != null && (typeof input.targetTrackId !== "string" || input.targetTrackId.length === 0)) ||
    typeof input.targetPlaying !== "boolean") {
    throw new RangeError("invalid paused preload observation");
  }
  const pendingOwned = input.pendingLoadOrdinal === input.lease.loadOrdinal;
  const loadedOwned = input.targetTrackId === input.lease.trackId &&
    input.targetLoadOrdinal === input.lease.loadOrdinal;
  const unpublishedOwned = pendingOwned &&
    (input.targetTrackId == null || input.targetTrackId === input.lease.trackId) &&
    (input.targetLoadOrdinal == null || input.targetLoadOrdinal === input.lease.loadOrdinal);
  const replacementConfirmed = (input.targetLoadOrdinal != null &&
    input.targetLoadOrdinal !== input.lease.loadOrdinal) ||
    (input.targetTrackId != null && input.targetTrackId !== input.lease.trackId);
  const cleanupTarget = loadedOwned || unpublishedOwned;
  return Object.freeze({
    version: AUTO_PILOT_PRELOAD_PAUSE_VERSION,
    kind: "supersede",
    cleanupTarget,
    observationConfirmed: cleanupTarget || replacementConfirmed
  });
};

export const runAutoPilotPreloadPauseCleanup = (input: Readonly<{
  lease: AutoPilotPreloadLeaseIdentity;
  pendingLoadOrdinal: number | null;
  observe: () => Readonly<{
    targetTrackId: string | null;
    targetLoadOrdinal: number | null;
    targetPlaying: boolean;
  }>;
  cancelLoadIfOwned: () => Readonly<{ owned: boolean; authorityRevoked: boolean }>;
  stopAllSound: () => Readonly<{ cancelledLoad: boolean }>;
  eject: () => unknown;
}>): Readonly<{ cleanupConfirmed: boolean; preservedReplacement: boolean }> => {
  try {
    const initial = input.observe();
    const cancellation = input.cancelLoadIfOwned();
    if (typeof cancellation?.owned !== "boolean" || typeof cancellation?.authorityRevoked !== "boolean" ||
      (cancellation.owned && !cancellation.authorityRevoked)) {
      return Object.freeze({ cleanupConfirmed: false, preservedReplacement: false });
    }
    if (cancellation.owned) {
      const cancelled = input.observe();
      if (!cancelled.targetPlaying && cancelled.targetTrackId == null) {
        return Object.freeze({ cleanupConfirmed: true, preservedReplacement: false });
      }
    }
    const decision = decideAutoPilotPreloadPause({
      lease: input.lease,
      pendingLoadOrdinal: input.pendingLoadOrdinal,
      ...initial
    });
    if (!decision.observationConfirmed && !cancellation.owned) {
      return Object.freeze({ cleanupConfirmed: false, preservedReplacement: false });
    }
    if (!decision.cleanupTarget && !cancellation.owned) {
      return Object.freeze({ cleanupConfirmed: true, preservedReplacement: true });
    }
    const stopResult = input.stopAllSound();
    const pendingUnpublished = input.pendingLoadOrdinal === input.lease.loadOrdinal &&
      initial.targetTrackId == null && initial.targetLoadOrdinal == null;
    if (pendingUnpublished && stopResult?.cancelledLoad !== true) {
      return Object.freeze({ cleanupConfirmed: false, preservedReplacement: false });
    }
    const stopped = input.observe();
    if (stopped.targetLoadOrdinal != null && stopped.targetLoadOrdinal !== input.lease.loadOrdinal) {
      return Object.freeze({ cleanupConfirmed: true, preservedReplacement: true });
    }
    if (stopped.targetTrackId != null && stopped.targetTrackId !== input.lease.trackId) {
      return Object.freeze({ cleanupConfirmed: true, preservedReplacement: true });
    }
    if (stopped.targetTrackId === input.lease.trackId &&
      stopped.targetLoadOrdinal === input.lease.loadOrdinal) input.eject();
    const final = input.observe();
    return Object.freeze({
      cleanupConfirmed: !final.targetPlaying && final.targetTrackId !== input.lease.trackId,
      preservedReplacement: false
    });
  } catch {
    return Object.freeze({ cleanupConfirmed: false, preservedReplacement: false });
  }
};

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
