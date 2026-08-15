export const LIBRARY_HYDRATION_RUNTIME_VERSION = "library-hydration-runtime/v1" as const;
export const LIBRARY_HYDRATION_TIMEOUT_MS = 30_000;

export type LibraryHydrationOwner = Readonly<{
  version: typeof LIBRARY_HYDRATION_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type LibraryHydrationSettlement<T> =
  | Readonly<{ outcome: "completed"; value: T; owner: LibraryHydrationOwner }>
  | Readonly<{ outcome: "failed"; owner: LibraryHydrationOwner }>
  | Readonly<{ outcome: "timed-out"; owner: LibraryHydrationOwner }>
  | Readonly<{ outcome: "cancelled"; owner: LibraryHydrationOwner }>;

export const ownsLibraryHydration = (
  current: LibraryHydrationOwner | null,
  expected: LibraryHydrationOwner | null
) => Boolean(current && expected &&
  current.version === LIBRARY_HYDRATION_RUNTIME_VERSION &&
  expected.version === LIBRARY_HYDRATION_RUNTIME_VERSION &&
  current.epoch === expected.epoch && current.operation === expected.operation &&
  current.startedAtMilliseconds === expected.startedAtMilliseconds &&
  current.deadlineMilliseconds === expected.deadlineMilliseconds);

export const startLibraryHydration = <T>({
  epoch,
  operation,
  task,
  ownsAuthority = () => true,
  timeoutMilliseconds = LIBRARY_HYDRATION_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  epoch: number;
  operation: number;
  task: (signal: AbortSignal, owner: LibraryHydrationOwner) => Promise<T>;
  ownsAuthority?: (owner: LibraryHydrationOwner) => boolean;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  if (!Number.isSafeInteger(epoch) || epoch <= 0 ||
      !Number.isSafeInteger(operation) || operation <= 0) {
    throw new RangeError("library hydration owner must use positive safe integers");
  }
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("library hydration timeout must be positive and finite");
  }
  const startedAtMilliseconds = nowMilliseconds();
  const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
  if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0 ||
      !Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
    throw new RangeError("library hydration clock is invalid");
  }
  const owner = Object.freeze({
    version: LIBRARY_HYDRATION_RUNTIME_VERSION,
    epoch,
    operation,
    startedAtMilliseconds,
    deadlineMilliseconds
  });
  const abortController = new AbortController();
  let settled = false;
  let timer: unknown = null;
  let resolveSettlement!: (value: LibraryHydrationSettlement<T>) => void;
  const settlement = new Promise<LibraryHydrationSettlement<T>>((resolve) => {
    resolveSettlement = resolve;
  });
  const settle = (value: LibraryHydrationSettlement<T>) => {
    if (settled) return false;
    settled = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    resolveSettlement(Object.freeze(value));
    return true;
  };
  const cancel = () => {
    if (settled) return false;
    abortController.abort();
    return settle({ outcome: "cancelled", owner });
  };
  const timeout = () => {
    if (settled) return false;
    if (!ownsAuthority(owner)) return cancel();
    // Revoke this runtime before asking the storage adapter to abort. Any late
    // open/transaction settlement observes `settled` and is inert.
    if (!settle({ outcome: "timed-out", owner })) return false;
    abortController.abort();
    return true;
  };
  const wakeAtDeadline = () => {
    if (settled) return;
    if (!ownsAuthority(owner)) {
      cancel();
      return;
    }
    const now = nowMilliseconds();
    if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) {
      timeout();
      return;
    }
    timer = setTimer(wakeAtDeadline, owner.deadlineMilliseconds - now);
  };
  timer = setTimer(wakeAtDeadline, timeoutMilliseconds);
  void Promise.resolve().then(() => task(abortController.signal, owner)).then(
    (value) => {
      if (settled) return;
      if (!ownsAuthority(owner)) {
        cancel();
        return;
      }
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) {
        timeout();
        return;
      }
      settle({ outcome: "completed", value, owner });
    },
    () => {
      if (settled) return;
      if (!ownsAuthority(owner)) {
        cancel();
        return;
      }
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) {
        timeout();
        return;
      }
      settle({ outcome: "failed", owner });
    }
  );
  return Object.freeze({ owner, settlement, cancel });
};
