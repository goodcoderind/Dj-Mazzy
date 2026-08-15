export const TRANSITION_REHEARSAL_RUNTIME_VERSION = "transition-rehearsal-runtime/v1" as const;
export const TRANSITION_REHEARSAL_PREPARATION_TIMEOUT_MS = 30_000;

export type TransitionRehearsalRuntimeOwner = Readonly<{
  version: typeof TRANSITION_REHEARSAL_RUNTIME_VERSION;
  operation: number;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type TransitionRehearsalRuntimeControl = Readonly<{
  mayContinue: () => boolean;
  cancellationRequested: () => boolean;
}>;

export type TransitionRehearsalRuntimeSettlement<T> =
  | Readonly<{ outcome: "completed"; value: T }>
  | Readonly<{ outcome: "cancelled" }>
  | Readonly<{ outcome: "failed" }>
  | Readonly<{ outcome: "timed-out" }>;

export const transitionRehearsalBlocksPlayback = ({
  preparationOwned,
  renderOwned,
  previewOwned,
  circuitOpen
}: {
  preparationOwned: boolean;
  renderOwned: boolean;
  previewOwned: boolean;
  circuitOpen: boolean;
}) => preparationOwned || renderOwned || previewOwned || circuitOpen;

export const transitionRehearsalSettlementOpensCircuit = (
  outcome: TransitionRehearsalRuntimeSettlement<unknown>["outcome"]
) => outcome === "timed-out";

export const startTransitionRehearsalRuntime = <T>({
  operation,
  task,
  timeoutMilliseconds = TRANSITION_REHEARSAL_PREPARATION_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  operation: number;
  task: (control: TransitionRehearsalRuntimeControl) => Promise<T>;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  if (!Number.isSafeInteger(operation) || operation <= 0 ||
      !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("Transition rehearsal runtime settings are invalid.");
  }
  const startedAtMilliseconds = nowMilliseconds();
  const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
  if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0 ||
      !Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
    throw new RangeError("Transition rehearsal deadline is invalid.");
  }
  const owner = Object.freeze({
    version: TRANSITION_REHEARSAL_RUNTIME_VERSION,
    operation,
    startedAtMilliseconds,
    deadlineMilliseconds
  });
  let settled = false;
  let cancelRequested = false;
  let timer: unknown = null;
  let resolveSettlement!: (value: TransitionRehearsalRuntimeSettlement<T>) => void;
  const settlement = new Promise<TransitionRehearsalRuntimeSettlement<T>>((resolve) => {
    resolveSettlement = resolve;
  });
  const settle = (value: TransitionRehearsalRuntimeSettlement<T>) => {
    if (settled) return false;
    settled = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    resolveSettlement(Object.freeze(value));
    return true;
  };
  const claimDeadline = () => settle({ outcome: "timed-out" });
  const wakeAtDeadline = () => {
    if (settled) return;
    const now = nowMilliseconds();
    if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
      claimDeadline();
      return;
    }
    timer = setTimer(wakeAtDeadline, deadlineMilliseconds - now);
  };
  const control = Object.freeze({
    mayContinue: () => !settled && !cancelRequested,
    cancellationRequested: () => cancelRequested
  });
  timer = setTimer(wakeAtDeadline, timeoutMilliseconds);
  void Promise.resolve().then(() => task(control)).then(
    (value) => {
      if (settled) return;
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
        claimDeadline();
        return;
      }
      settle(cancelRequested ? { outcome: "cancelled" } : { outcome: "completed", value });
    },
    () => {
      if (settled) return;
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
        claimDeadline();
        return;
      }
      settle(cancelRequested ? { outcome: "cancelled" } : { outcome: "failed" });
    }
  );
  return Object.freeze({
    owner,
    settlement,
    requestCancel: () => {
      if (settled) return false;
      cancelRequested = true;
      return true;
    },
    revoke: () => settle({ outcome: "cancelled" }),
    snapshot: () => Object.freeze({ settled, cancelRequested })
  });
};
