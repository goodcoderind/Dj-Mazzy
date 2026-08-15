export const ENHANCED_TIMING_REMOVAL_VERSION = "enhanced-timing-removal/v1" as const;
export const ENHANCED_TIMING_REMOVAL_TIMEOUT_MS = 10_000;

export type EnhancedTimingRemovalOwner = Readonly<{
  version: typeof ENHANCED_TIMING_REMOVAL_VERSION;
  operation: number;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type EnhancedTimingRemovalSettlement = Readonly<{
  outcome: "completed" | "failed" | "timed-out" | "cancelled";
  absent?: boolean;
}>;

export const enhancedTimingRemovalDisposition = (
  settlement: EnhancedTimingRemovalSettlement
) => settlement.outcome === "completed" && settlement.absent === true
  ? "verified-removed" as const
  : settlement.outcome === "cancelled"
    ? "cancelled" as const
    : "reload-required" as const;

type TimerHandle = ReturnType<typeof setTimeout>;

export const ownsEnhancedTimingRemoval = (
  current: EnhancedTimingRemovalOwner | null | undefined,
  expected: EnhancedTimingRemovalOwner | null | undefined
) => Boolean(current && expected &&
  current.version === ENHANCED_TIMING_REMOVAL_VERSION &&
  current.operation === expected.operation &&
  current.startedAtMilliseconds === expected.startedAtMilliseconds &&
  current.deadlineMilliseconds === expected.deadlineMilliseconds);

export const startEnhancedTimingRemoval = ({
  operation,
  task,
  now = () => performance.now(),
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  clearScheduledTimeout = (handle) => clearTimeout(handle),
  timeoutMilliseconds = ENHANCED_TIMING_REMOVAL_TIMEOUT_MS
}: {
  operation: number;
  task: () => Promise<boolean>;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearScheduledTimeout?: (handle: TimerHandle) => void;
  timeoutMilliseconds?: number;
}) => {
  const startedAtMilliseconds = now();
  if (!Number.isSafeInteger(operation) || operation < 1 ||
      !Number.isFinite(startedAtMilliseconds) ||
      !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("Invalid enhanced timing removal owner");
  }
  const owner: EnhancedTimingRemovalOwner = Object.freeze({
    version: ENHANCED_TIMING_REMOVAL_VERSION,
    operation,
    startedAtMilliseconds,
    deadlineMilliseconds: startedAtMilliseconds + timeoutMilliseconds
  });
  let active = true;
  let timer: TimerHandle | null = null;
  let resolveSettlement!: (settlement: EnhancedTimingRemovalSettlement) => void;
  const settlement = new Promise<EnhancedTimingRemovalSettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  const settle = (next: EnhancedTimingRemovalSettlement) => {
    if (!active) return false;
    active = false;
    if (timer != null) clearScheduledTimeout(timer);
    timer = null;
    resolveSettlement(Object.freeze(next));
    return true;
  };
  const checkDeadline = () => {
    if (!active) return;
    const current = now();
    if (!Number.isFinite(current) || current >= owner.deadlineMilliseconds) {
      settle({ outcome: "timed-out" });
      return;
    }
    timer = scheduleTimeout(checkDeadline, Math.max(0, owner.deadlineMilliseconds - current));
  };
  timer = scheduleTimeout(checkDeadline, timeoutMilliseconds);
  void Promise.resolve().then(task).then(
    (absent) => {
      if (!active) return;
      const current = now();
      if (!Number.isFinite(current) || current >= owner.deadlineMilliseconds) {
        settle({ outcome: "timed-out" });
        return;
      }
      if (absent !== true) {
        settle({ outcome: "failed" });
        return;
      }
      settle({ outcome: "completed", absent: true });
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
