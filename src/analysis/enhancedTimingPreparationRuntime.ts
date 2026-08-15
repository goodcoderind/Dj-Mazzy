export const ENHANCED_TIMING_PREPARATION_VERSION = "enhanced-timing-preparation/v1" as const;
export const ENHANCED_TIMING_PROBE_TIMEOUT_MS = 10_000;
export const ENHANCED_TIMING_PREPARATION_TIMEOUT_MS = 15 * 60_000;
export const ENHANCED_TIMING_CANCEL_DRAIN_TIMEOUT_MS = 10_000;

export type EnhancedTimingPreparationKind = "probe" | "prepare";

export type EnhancedTimingPreparationOwner = Readonly<{
  version: typeof ENHANCED_TIMING_PREPARATION_VERSION;
  operation: number;
  kind: EnhancedTimingPreparationKind;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type EnhancedTimingPreparationSettlement<T> =
  | Readonly<{ outcome: "completed"; value: T }>
  | Readonly<{ outcome: "failed" | "timed-out" | "cancelled" }>;

type TimerHandle = ReturnType<typeof setTimeout>;

const FIXED_PREPARATION_STAGES = new Set([
  "checking-capabilities",
  "loading-83mb-model",
  "running-zero-window",
  "loading-contract",
  "computing-log-mel"
]);

export const normalizeEnhancedTimingPreparationStage = (stage: unknown) =>
  typeof stage === "string" && (FIXED_PREPARATION_STAGES.has(stage) ||
    /^inferring-window-[1-9][0-9]*-of-[1-9][0-9]*$/.test(stage))
    ? stage
    : "downloading";

export const projectEnhancedTimingPreparationUiMode = ({
  preparationState,
  timingState
}: {
  preparationState?: string | null;
  timingState?: string | null;
}) => preparationState === "preparing"
  ? "preparing" as const
  : ["cancelling", "probe-cancelling", "cancel-timeout"].includes(preparationState ?? "") ||
      timingState === "preparation-unconfirmed"
    ? "unconfirmed" as const
  : timingState === "check-error" || timingState === "offline"
    ? "probe-retry" as const
    : timingState === "coordination-unavailable"
      ? "coordination-unavailable" as const
      : timingState === "partial"
        ? "partial" as const
        : "default" as const;

export const claimEnhancedTimingPreparationReady = ({
  observed,
  preparedAuthority,
  admissionCurrent,
  ownerCurrent,
  claimCommit
}: {
  observed: { authority: { epoch: number; token: string }; revoked: boolean } | null | undefined;
  preparedAuthority: { epoch: number; token: string } | null | undefined;
  admissionCurrent: boolean;
  ownerCurrent: boolean;
  claimCommit: () => boolean;
}) => Boolean(observed && preparedAuthority && ownerCurrent && admissionCurrent &&
  observed.revoked === false &&
  observed.authority.epoch === preparedAuthority.epoch &&
  observed.authority.token === preparedAuthority.token &&
  claimCommit());

export const ownsEnhancedTimingPreparation = (
  current: EnhancedTimingPreparationOwner | null | undefined,
  expected: EnhancedTimingPreparationOwner | null | undefined
) => Boolean(current && expected &&
  current.version === ENHANCED_TIMING_PREPARATION_VERSION &&
  current.operation === expected.operation &&
  current.kind === expected.kind &&
  current.startedAtMilliseconds === expected.startedAtMilliseconds &&
  current.deadlineMilliseconds === expected.deadlineMilliseconds);

export const startEnhancedTimingPreparation = <T>({
  operation,
  kind,
  task,
  now = () => performance.now(),
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  clearScheduledTimeout = (handle) => clearTimeout(handle),
  timeoutMilliseconds = kind === "probe"
    ? ENHANCED_TIMING_PROBE_TIMEOUT_MS
    : ENHANCED_TIMING_PREPARATION_TIMEOUT_MS
}: {
  operation: number;
  kind: EnhancedTimingPreparationKind;
  task: (signal: AbortSignal) => Promise<T>;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearScheduledTimeout?: (handle: TimerHandle) => void;
  timeoutMilliseconds?: number;
}) => {
  const startedAtMilliseconds = now();
  if (!Number.isSafeInteger(operation) || operation < 1 ||
      !["probe", "prepare"].includes(kind) ||
      !Number.isFinite(startedAtMilliseconds) ||
      !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("Invalid enhanced timing preparation owner");
  }
  const owner: EnhancedTimingPreparationOwner = Object.freeze({
    version: ENHANCED_TIMING_PREPARATION_VERSION,
    operation,
    kind,
    startedAtMilliseconds,
    deadlineMilliseconds: startedAtMilliseconds + timeoutMilliseconds
  });
  let active = true;
  let commitClaimed = false;
  const abortController = new AbortController();
  let timer: TimerHandle | null = null;
  let resolveSettlement!: (value: EnhancedTimingPreparationSettlement<T>) => void;
  const settlement = new Promise<EnhancedTimingPreparationSettlement<T>>((resolve) => {
    resolveSettlement = resolve;
  });
  const settle = (next: EnhancedTimingPreparationSettlement<T>) => {
    if (!active) return false;
    active = false;
    if (next.outcome === "timed-out" || next.outcome === "cancelled") {
      try { abortController.abort(); } catch { /* Publication authority is already revoked. */ }
    }
    if (timer != null) clearScheduledTimeout(timer);
    timer = null;
    resolveSettlement(Object.freeze(next));
    return true;
  };
  const checkDeadline = () => {
    if (!active || commitClaimed) return;
    const current = now();
    if (!Number.isFinite(current) || current >= owner.deadlineMilliseconds) {
      settle({ outcome: "timed-out" });
      return;
    }
    timer = scheduleTimeout(checkDeadline, Math.max(0, owner.deadlineMilliseconds - current));
  };
  timer = scheduleTimeout(checkDeadline, timeoutMilliseconds);
  const taskPromise = Promise.resolve().then(() => task(abortController.signal));
  const drained = taskPromise.then(() => undefined, () => undefined);
  let drainBoundary: Promise<Readonly<{ outcome: "drained" | "timed-out" }>> | null = null;
  const waitForDrain = (
    timeoutMilliseconds = ENHANCED_TIMING_CANCEL_DRAIN_TIMEOUT_MS
  ) => {
    if (drainBoundary) return drainBoundary;
    drainBoundary = new Promise((resolve) => {
      let settled = false;
      let drainTimer: TimerHandle | null = null;
      const finish = (outcome: "drained" | "timed-out") => {
        if (settled) return;
        settled = true;
        if (drainTimer != null) clearScheduledTimeout(drainTimer);
        drainTimer = null;
        resolve(Object.freeze({ outcome }));
      };
      const started = now();
      const deadline = Number.isFinite(started) && Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0
        ? started + timeoutMilliseconds
        : started;
      const check = () => {
        if (settled) return;
        const current = now();
        if (!Number.isFinite(current) || current >= deadline) {
          finish("timed-out");
          return;
        }
        drainTimer = scheduleTimeout(check, Math.max(0, deadline - current));
      };
      void drained.then(() => finish("drained"));
      check();
    });
    return drainBoundary;
  };
  void taskPromise.then(
    (value) => {
      if (!active) return;
      const current = now();
      if (!commitClaimed && (!Number.isFinite(current) || current >= owner.deadlineMilliseconds)) {
        settle({ outcome: "timed-out" });
        return;
      }
      settle({ outcome: "completed", value });
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
    drained,
    waitForDrain,
    claimCommit: () => {
      if (!active || commitClaimed || owner.kind !== "prepare") return false;
      const current = now();
      if (!Number.isFinite(current) || current >= owner.deadlineMilliseconds) return false;
      commitClaimed = true;
      if (timer != null) clearScheduledTimeout(timer);
      timer = null;
      return true;
    },
    cancel: () => commitClaimed ? false : settle({ outcome: "cancelled" }),
    snapshot: () => Object.freeze({ active, commitClaimed })
  });
};
