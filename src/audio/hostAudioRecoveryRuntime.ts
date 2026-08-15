export const HOST_AUDIO_RECOVERY_VERSION = "host-audio-recovery/v1" as const;
export const HOST_AUDIO_RECOVERY_TIMEOUT_MS = 10_000;

export type HostAudioRecoveryIntent = "context" | "device";

export type HostAudioRecoveryOwner = Readonly<{
  version: typeof HOST_AUDIO_RECOVERY_VERSION;
  operation: number;
  intent: HostAudioRecoveryIntent;
  audioGeneration: number;
  deviceGeneration: number;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type HostAudioRecoverySettlement = Readonly<{
  outcome: "completed" | "failed" | "timed-out" | "cancelled";
  contextRunning?: boolean;
}>;

export type HostAudioRecoverySettlementPlan =
  | "stale"
  | "cancelled"
  | "retry"
  | "block-timeout"
  | "block-cleanup"
  | "release-context-output"
  | "complete-device";

type TimerHandle = ReturnType<typeof setTimeout>;

export const ownsHostAudioRecovery = (
  current: HostAudioRecoveryOwner | null | undefined,
  expected: HostAudioRecoveryOwner | null | undefined
) => Boolean(current && expected &&
  current.version === HOST_AUDIO_RECOVERY_VERSION &&
  current.operation === expected.operation &&
  current.intent === expected.intent &&
  current.audioGeneration === expected.audioGeneration &&
  current.deviceGeneration === expected.deviceGeneration &&
  current.startedAtMilliseconds === expected.startedAtMilliseconds &&
  current.deadlineMilliseconds === expected.deadlineMilliseconds);

export const hostAudioRecoveryCanCommit = ({
  currentOwner,
  expectedOwner,
  audioGeneration,
  deviceGeneration
}: {
  currentOwner: HostAudioRecoveryOwner | null | undefined;
  expectedOwner: HostAudioRecoveryOwner;
  audioGeneration: number;
  deviceGeneration: number;
}) => ownsHostAudioRecovery(currentOwner, expectedOwner) &&
  expectedOwner.audioGeneration === audioGeneration &&
  expectedOwner.deviceGeneration === deviceGeneration;

export const hostAudioRecoveryMayStart = ({
  ownerActive,
  circuitOpen,
  cleanupSafe
}: {
  ownerActive: boolean;
  circuitOpen: boolean;
  cleanupSafe: boolean;
}) => !ownerActive && !circuitOpen && cleanupSafe;

export const planHostAudioRecoverySettlement = ({
  currentOwner,
  expectedOwner,
  audioGeneration,
  deviceGeneration,
  settlement,
  cleanupSafe
}: {
  currentOwner: HostAudioRecoveryOwner | null | undefined;
  expectedOwner: HostAudioRecoveryOwner;
  audioGeneration: number;
  deviceGeneration: number;
  settlement: HostAudioRecoverySettlement;
  cleanupSafe: boolean;
}): HostAudioRecoverySettlementPlan => {
  if (!hostAudioRecoveryCanCommit({
    currentOwner,
    expectedOwner,
    audioGeneration,
    deviceGeneration
  })) return "stale";
  if (settlement.outcome === "cancelled") return "cancelled";
  if (settlement.outcome === "timed-out") return "block-timeout";
  if (settlement.outcome !== "completed" || settlement.contextRunning !== true) return "retry";
  if (!cleanupSafe) return "block-cleanup";
  return expectedOwner.intent === "context" ? "release-context-output" : "complete-device";
};

export const hostAudioRecoveryPageHideDisposition = (ownerActive: boolean) =>
  ownerActive ? "block" as const : "unchanged" as const;

export const startHostAudioRecovery = ({
  operation,
  intent,
  audioGeneration,
  deviceGeneration,
  task,
  now = () => performance.now(),
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  clearScheduledTimeout = (handle) => clearTimeout(handle),
  timeoutMilliseconds = HOST_AUDIO_RECOVERY_TIMEOUT_MS
}: {
  operation: number;
  intent: HostAudioRecoveryIntent;
  audioGeneration: number;
  deviceGeneration: number;
  task: () => Promise<boolean>;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearScheduledTimeout?: (handle: TimerHandle) => void;
  timeoutMilliseconds?: number;
}) => {
  const startedAtMilliseconds = now();
  if (![operation, audioGeneration, deviceGeneration].every((value) =>
    Number.isSafeInteger(value) && value >= 0) || operation < 1 ||
    !["context", "device"].includes(intent) ||
    !Number.isFinite(startedAtMilliseconds) ||
    !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("Invalid host audio recovery owner");
  }
  const owner: HostAudioRecoveryOwner = Object.freeze({
    version: HOST_AUDIO_RECOVERY_VERSION,
    operation,
    intent,
    audioGeneration,
    deviceGeneration,
    startedAtMilliseconds,
    deadlineMilliseconds: startedAtMilliseconds + timeoutMilliseconds
  });
  let active = true;
  let timer: TimerHandle | null = null;
  let resolveSettlement!: (value: HostAudioRecoverySettlement) => void;
  const settlement = new Promise<HostAudioRecoverySettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  const settle = (value: HostAudioRecoverySettlement) => {
    if (!active) return false;
    active = false;
    if (timer !== null) clearScheduledTimeout(timer);
    timer = null;
    resolveSettlement(Object.freeze(value));
    return true;
  };
  const checkDeadline = () => {
    if (!active) return;
    const current = now();
    if (!Number.isFinite(current) || current >= owner.deadlineMilliseconds) {
      settle({ outcome: "timed-out" });
      return;
    }
    timer = scheduleTimeout(checkDeadline, owner.deadlineMilliseconds - current);
  };
  timer = scheduleTimeout(checkDeadline, timeoutMilliseconds);
  void Promise.resolve().then(task).then(
    (contextRunning) => {
      if (!active) return;
      const current = now();
      if (!Number.isFinite(current) || current >= owner.deadlineMilliseconds) {
        settle({ outcome: "timed-out" });
        return;
      }
      settle(contextRunning === true
        ? { outcome: "completed", contextRunning: true }
        : { outcome: "failed", contextRunning: false });
    },
    () => {
      if (!active) return;
      const current = now();
      settle(!Number.isFinite(current) || current >= owner.deadlineMilliseconds
        ? { outcome: "timed-out" }
        : { outcome: "failed" });
    }
  );
  return Object.freeze({
    owner,
    settlement,
    cancel: () => settle({ outcome: "cancelled" }),
    snapshot: () => Object.freeze({ active })
  });
};
