export const PARTY_COMMITTED_TARGET_AUDIO_TRANSACTION_VERSION =
  "party-committed-target-audio-transaction/v1" as const;

export type CommittedTargetSnapshot = Readonly<{
  trackId: string | null;
  status: string;
  playbackRate: number;
}>;

export type CommittedTargetStartResult = Readonly<{
  scheduledStart: number;
  snapshot: CommittedTargetSnapshot;
}>;

export type PartyCommittedTargetAudioAdapter = Readonly<{
  sampleRate: number;
  now: () => number;
  authority: () => boolean;
  revokeAuthority: () => void;
  getSnapshot: () => CommittedTargetSnapshot | null;
  isActive: () => boolean;
  isExactTarget: (snapshot: CommittedTargetSnapshot | null) => boolean;
  getGain: () => number;
  setGain: (gain: number) => void;
  playReadyAtIfRunning: (
    startTime: number,
    offsetSeconds: number,
    authority: () => boolean
  ) => CommittedTargetStartResult | null;
  scheduleGainCurve: (
    curve: Float32Array,
    startTime: number,
    durationSeconds: number,
    authority: () => boolean
  ) => number;
  pause: () => unknown;
}>;

export type PartyCommittedTargetAudioResult = Readonly<{
  version: typeof PARTY_COMMITTED_TARGET_AUDIO_TRANSACTION_VERSION;
  status: "scheduled" | "failed";
  scheduledStart: number | null;
  priorGain: number | null;
  cleanupConfirmed: boolean;
  reason:
    | "scheduled"
    | "authority-expired"
    | "target-not-ready"
    | "gain-unobservable"
    | "start-failed"
    | "gain-schedule-failed"
    | "postcondition-failed";
}>;

const failure = (
  reason: Exclude<PartyCommittedTargetAudioResult["reason"], "scheduled">,
  priorGain: number | null,
  cleanupConfirmed: boolean
): PartyCommittedTargetAudioResult => Object.freeze({
  version: PARTY_COMMITTED_TARGET_AUDIO_TRANSACTION_VERSION,
  status: "failed",
  scheduledStart: null,
  priorGain,
  cleanupConfirmed,
  reason
});

export const runPartyCommittedTargetAudioTransaction = (
  adapter: PartyCommittedTargetAudioAdapter
): PartyCommittedTargetAudioResult => {
  const failBeforeMutation = (
    reason: Exclude<PartyCommittedTargetAudioResult["reason"], "scheduled">,
    priorGain: number | null,
    cleanupConfirmed: boolean
  ) => {
    try { adapter.revokeAuthority(); } catch { return failure(reason, priorGain, false); }
    return failure(reason, priorGain, cleanupConfirmed);
  };
  let priorGain: number | null = null;
  let reason: Exclude<PartyCommittedTargetAudioResult["reason"], "scheduled"> = "authority-expired";
  try {
    if (!adapter.authority()) return failBeforeMutation(reason, null, true);
    const before = adapter.getSnapshot();
    if (!before || !adapter.isExactTarget(before) || before.status !== "ready" ||
      before.playbackRate !== 1 || adapter.isActive()) {
      return failBeforeMutation("target-not-ready", null, true);
    }
    priorGain = adapter.getGain();
    if (!Number.isFinite(priorGain) || !Number.isFinite(adapter.sampleRate) || adapter.sampleRate <= 0) {
      return failBeforeMutation("gain-unobservable", priorGain, false);
    }
    adapter.setGain(0);
    if (!adapter.authority()) throw new Error("authority-expired");
    const startTime = adapter.now() + Math.max(0.03, 256 / adapter.sampleRate);
    reason = "start-failed";
    const started = adapter.playReadyAtIfRunning(startTime, 0, adapter.authority);
    if (!started || !adapter.authority()) throw new Error(reason);
    reason = "gain-schedule-failed";
    adapter.scheduleGainCurve(new Float32Array([0, 1]), started.scheduledStart, 0.08, adapter.authority);
    reason = "postcondition-failed";
    const after = adapter.getSnapshot();
    if (!adapter.authority() || !adapter.isExactTarget(after) || after?.playbackRate !== 1 || !adapter.isActive()) {
      throw new Error(reason);
    }
    adapter.revokeAuthority();
    return Object.freeze({
      version: PARTY_COMMITTED_TARGET_AUDIO_TRANSACTION_VERSION,
      status: "scheduled",
      scheduledStart: started.scheduledStart,
      priorGain,
      cleanupConfirmed: true,
      reason: "scheduled"
    });
  } catch (error) {
    if (error instanceof Error && error.message === "authority-expired") reason = "authority-expired";
    adapter.revokeAuthority();
    let cleanupConfirmed = false;
    try {
      const current = adapter.getSnapshot();
      if (!adapter.isExactTarget(current)) return failure(reason, priorGain, false);
      adapter.pause();
      if (priorGain != null) adapter.setGain(priorGain);
      const restored = adapter.getSnapshot();
      cleanupConfirmed = priorGain != null && adapter.isExactTarget(restored) &&
        restored?.playbackRate === 1 && !adapter.isActive() &&
        Math.abs(adapter.getGain() - priorGain) <= 1e-6;
    } catch { cleanupConfirmed = false; }
    return failure(reason, priorGain, cleanupConfirmed);
  }
};
