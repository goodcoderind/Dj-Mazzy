export const LIBRARY_ROUTINE_WRITE_RUNTIME_VERSION = "library-routine-write-runtime/v1" as const;
export const LIBRARY_ROUTINE_WRITE_TIMEOUT_MS = 15_000;

export type LibraryRoutineWriteTicket = Readonly<{
  version: typeof LIBRARY_ROUTINE_WRITE_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type LibraryRoutineWriteSettlement<R> =
  | Readonly<{ outcome: "completed"; result: R; ticket: LibraryRoutineWriteTicket }>
  | Readonly<{ outcome: "failed"; ticket: LibraryRoutineWriteTicket }>
  | Readonly<{ outcome: "timed-out"; ticket: LibraryRoutineWriteTicket }>
  | Readonly<{ outcome: "cancelled"; ticket: LibraryRoutineWriteTicket | null }>
  | Readonly<{ outcome: "circuit-open"; ticket: null }>;

type RuntimeMode = "running" | "exclusive" | "halted" | "circuit-open";
type Deferred<R> = Readonly<{
  promise: Promise<LibraryRoutineWriteSettlement<R>>;
  resolve: (settlement: LibraryRoutineWriteSettlement<R>) => void;
}>;
type Batch<T, R> = {
  value: T;
  deferred: Deferred<R>;
};

const createDeferred = <R>(): Deferred<R> => {
  let resolve!: (settlement: LibraryRoutineWriteSettlement<R>) => void;
  const promise = new Promise<LibraryRoutineWriteSettlement<R>>((currentResolve) => {
    resolve = currentResolve;
  });
  return Object.freeze({ promise, resolve });
};

export type LibraryRoutineWriteRuntimeSnapshot = Readonly<{
  version: typeof LIBRARY_ROUTINE_WRITE_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  mode: RuntimeMode;
  exclusiveReturnMode: RuntimeMode | null;
  active: boolean;
  pending: boolean;
}>;

export const createLibraryRoutineWriteRuntime = <T, R>({
  write,
  mergePending,
  retryRejectedWhileExclusive = () => null,
  onResolved,
  onRejected,
  onTimedOut,
  timeoutMilliseconds = LIBRARY_ROUTINE_WRITE_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  write: (value: T, signal: AbortSignal, ticket: LibraryRoutineWriteTicket) => Promise<R>;
  mergePending: (current: T, incoming: T) => T;
  retryRejectedWhileExclusive?: (value: T) => T | null;
  onResolved?: (value: T, result: R, ticket: LibraryRoutineWriteTicket) => boolean | void;
  onRejected?: (value: T, ticket: LibraryRoutineWriteTicket) => boolean | void;
  onTimedOut?: (value: T, ticket: LibraryRoutineWriteTicket) => void;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("library routine write timeout must be positive and finite");
  }
  let epoch = 1;
  let operation = 0;
  let mode: RuntimeMode = "running";
  let exclusiveReturnMode: RuntimeMode = "running";
  let pending: Batch<T, R> | null = null;
  let active: null | {
    batch: Batch<T, R>;
    ticket: LibraryRoutineWriteTicket;
    abortController: AbortController;
    timer: unknown;
  } = null;
  let exclusiveWaiters: Array<(ready: boolean) => void> = [];

  const resolveExclusive = (ready: boolean) => {
    const waiters = exclusiveWaiters;
    exclusiveWaiters = [];
    waiters.forEach((resolve) => resolve(ready));
  };
  const owns = (ticket: LibraryRoutineWriteTicket) => Boolean(active &&
    active.ticket.epoch === ticket.epoch && active.ticket.operation === ticket.operation);
  const clearActive = () => {
    if (!active) return;
    if (active.timer != null) clearTimer(active.timer);
    active = null;
  };
  const cancelPending = () => {
    if (!pending) return;
    const previous = pending;
    pending = null;
    previous.deferred.resolve(Object.freeze({ outcome: "cancelled", ticket: null }));
  };
  const claimTimeout = (ticket: LibraryRoutineWriteTicket) => {
    if (!owns(ticket)) return false;
    const expired = active!;
    clearActive();
    expired.abortController.abort();
    expired.batch.deferred.resolve(Object.freeze({ outcome: "timed-out", ticket }));
    cancelPending();
    mode = "circuit-open";
    exclusiveReturnMode = "circuit-open";
    resolveExclusive(false);
    try { onTimedOut?.(expired.batch.value, ticket); } catch { /* Ownership is already revoked. */ }
    return true;
  };
  const wakeAtDeadline = (ticket: LibraryRoutineWriteTicket) => {
    if (!owns(ticket)) return;
    const now = nowMilliseconds();
    if (!Number.isFinite(now) || now >= ticket.deadlineMilliseconds) {
      claimTimeout(ticket);
      return;
    }
    active!.timer = setTimer(() => wakeAtDeadline(ticket), ticket.deadlineMilliseconds - now);
  };
  const start = (batch: Batch<T, R>) => {
    if (mode !== "running" || active) return;
    const startedAtMilliseconds = nowMilliseconds();
    const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
    if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0 ||
        !Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
      mode = "circuit-open";
      batch.deferred.resolve(Object.freeze({ outcome: "circuit-open", ticket: null }));
      cancelPending();
      resolveExclusive(false);
      return;
    }
    const ticket = Object.freeze({
      version: LIBRARY_ROUTINE_WRITE_RUNTIME_VERSION,
      epoch,
      operation: ++operation,
      startedAtMilliseconds,
      deadlineMilliseconds
    });
    const abortController = new AbortController();
    active = { batch, ticket, abortController, timer: null };
    active.timer = setTimer(() => wakeAtDeadline(ticket), timeoutMilliseconds);
    void Promise.resolve().then(() => write(batch.value, abortController.signal, ticket)).then(
      (result) => {
        if (!owns(ticket)) return;
        const now = nowMilliseconds();
        if (!Number.isFinite(now) || now >= ticket.deadlineMilliseconds) {
          claimTimeout(ticket);
          return;
        }
        clearActive();
        batch.deferred.resolve(Object.freeze({ outcome: "completed", result, ticket }));
        let keepRunning = true;
        try { keepRunning = onResolved?.(batch.value, result, ticket) !== false; } catch { keepRunning = false; }
        if (!keepRunning) {
          epoch += 1;
          cancelPending();
          mode = "halted";
          exclusiveReturnMode = "halted";
          resolveExclusive(false);
          return;
        }
        if (mode === "exclusive") {
          resolveExclusive(true);
          return;
        }
        const next = pending;
        pending = null;
        if (mode === "running" && next) start(next);
      },
      () => {
        if (!owns(ticket)) return;
        const now = nowMilliseconds();
        if (!Number.isFinite(now) || now >= ticket.deadlineMilliseconds) {
          claimTimeout(ticket);
          return;
        }
        clearActive();
        batch.deferred.resolve(Object.freeze({ outcome: "failed", ticket }));
        let keepRunning = true;
        try { keepRunning = onRejected?.(batch.value, ticket) !== false; } catch { keepRunning = false; }
        if (!keepRunning) {
          epoch += 1;
          cancelPending();
          mode = "halted";
          exclusiveReturnMode = "halted";
          resolveExclusive(false);
          return;
        }
        if (mode === "exclusive") {
          const retry = retryRejectedWhileExclusive(batch.value);
          if (retry !== null) {
            if (!pending) {
              pending = { value: retry, deferred: createDeferred<R>() };
            } else {
              pending.value = mergePending(retry, pending.value);
            }
          }
          resolveExclusive(true);
          return;
        }
        const next = pending;
        pending = null;
        if (mode === "running" && next) start(next);
      }
    );
  };
  const immediate = (outcome: "cancelled" | "circuit-open") => Promise.resolve(Object.freeze({
    outcome,
    ticket: null
  }) as LibraryRoutineWriteSettlement<R>);
  const halt = () => {
    epoch += 1;
    cancelPending();
    mode = "halted";
    exclusiveReturnMode = "halted";
    if (active) {
      const previous = active;
      clearActive();
      previous.abortController.abort();
      previous.batch.deferred.resolve(Object.freeze({ outcome: "cancelled", ticket: previous.ticket }));
    }
    resolveExclusive(false);
  };

  return Object.freeze({
    enqueue: (value: T) => {
      if (mode === "circuit-open") return Object.freeze({ status: "circuit-open" as const, settlement: immediate("circuit-open") });
      if (mode === "exclusive") {
        if (!pending) pending = { value, deferred: createDeferred<R>() };
        else pending.value = mergePending(pending.value, value);
        return Object.freeze({ status: "coalesced" as const, settlement: pending.deferred.promise });
      }
      if (mode !== "running") return Object.freeze({ status: "paused" as const, settlement: immediate("cancelled") });
      if (!active) {
        const batch = { value, deferred: createDeferred<R>() };
        start(batch);
        return Object.freeze({ status: "started" as const, settlement: batch.deferred.promise });
      }
      if (!pending) {
        pending = { value, deferred: createDeferred<R>() };
      } else {
        pending.value = mergePending(pending.value, value);
      }
      return Object.freeze({ status: "coalesced" as const, settlement: pending.deferred.promise });
    },
    prepareExclusive: () => {
      if (mode === "exclusive") return Promise.resolve(false);
      if (mode === "circuit-open" || mode === "halted") {
        exclusiveReturnMode = mode;
        mode = "exclusive";
        return Promise.resolve(true);
      }
      if (mode !== "running") return Promise.resolve(false);
      exclusiveReturnMode = "running";
      mode = "exclusive";
      if (!active) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => exclusiveWaiters.push(resolve));
    },
    completeExclusive: () => {
      if (mode !== "exclusive" || active) return false;
      epoch += 1;
      mode = exclusiveReturnMode;
      resolveExclusive(false);
      if (mode === "running") {
        const next = pending;
        pending = null;
        if (next) start(next);
      } else {
        cancelPending();
      }
      return true;
    },
    halt,
    snapshot: (): LibraryRoutineWriteRuntimeSnapshot => Object.freeze({
      version: LIBRARY_ROUTINE_WRITE_RUNTIME_VERSION,
      epoch,
      operation,
      mode,
      exclusiveReturnMode: mode === "exclusive" ? exclusiveReturnMode : null,
      active: Boolean(active),
      pending: Boolean(pending)
    })
  });
};
