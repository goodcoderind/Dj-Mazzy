export const LIBRARY_RECONCILIATION_RUNTIME_VERSION = "library-reconciliation-runtime/v1" as const;
export const LIBRARY_RECONCILIATION_TIMEOUT_MS = 30_000;

export type LibraryReconciliationOwner = Readonly<{
  version: typeof LIBRARY_RECONCILIATION_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type LibraryReconciliationSnapshot = Readonly<{
  version: typeof LIBRARY_RECONCILIATION_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  mode: "running" | "paused" | "circuit-open" | "halted";
  active: boolean;
  pending: boolean;
}>;

export type LibraryReconciliationRequirements = Readonly<{
  minimumLibraryEpoch: number;
  minimumLibraryRevision: number;
  minimumCheckpointRevision: number;
}>;

export const mergeLibraryReconciliationRequirements = <T extends LibraryReconciliationRequirements>(
  current: T,
  incoming: T
): T => Object.freeze({
  ...incoming,
  minimumLibraryEpoch: Math.max(current.minimumLibraryEpoch, incoming.minimumLibraryEpoch),
  minimumLibraryRevision: current.minimumLibraryEpoch === incoming.minimumLibraryEpoch
    ? Math.max(current.minimumLibraryRevision, incoming.minimumLibraryRevision)
    : current.minimumLibraryEpoch > incoming.minimumLibraryEpoch
      ? current.minimumLibraryRevision
      : incoming.minimumLibraryRevision,
  minimumCheckpointRevision: Math.max(
    current.minimumCheckpointRevision,
    incoming.minimumCheckpointRevision
  )
});

export const libraryReconciliationResultCovers = ({
  requirements,
  libraryEpoch,
  libraryRevision,
  checkpointRevision
}: {
  requirements: LibraryReconciliationRequirements;
  libraryEpoch: number;
  libraryRevision: number;
  checkpointRevision: number;
}) => Boolean(libraryEpoch > requirements.minimumLibraryEpoch ||
  (libraryEpoch === requirements.minimumLibraryEpoch &&
    libraryRevision >= requirements.minimumLibraryRevision)) &&
  checkpointRevision >= requirements.minimumCheckpointRevision;

export const settleLibraryReconciliationWaiters = (
  waiters: Set<() => void>
) => {
  for (const resolve of waiters) resolve();
  waiters.clear();
};

type Active<T> = {
  trigger: T;
  owner: LibraryReconciliationOwner;
  abortController: AbortController;
  timer: unknown;
};

export const ownsLibraryReconciliation = (
  current: LibraryReconciliationOwner | null,
  expected: LibraryReconciliationOwner | null
) => Boolean(current && expected &&
  current.version === LIBRARY_RECONCILIATION_RUNTIME_VERSION &&
  expected.version === LIBRARY_RECONCILIATION_RUNTIME_VERSION &&
  current.epoch === expected.epoch && current.operation === expected.operation &&
  current.startedAtMilliseconds === expected.startedAtMilliseconds &&
  current.deadlineMilliseconds === expected.deadlineMilliseconds);

export const shouldQuiescePartyForRemoteCheckpoint = ({
  eventType,
  eventCheckpointRevision,
  currentCheckpointRevision,
  currentSessionId,
}: {
  eventType: string;
  eventCheckpointRevision: number;
  eventSessionId: string | null;
  eventWriterToken: string | null;
  currentCheckpointRevision: number;
  currentSessionId: string | null;
  currentWriterToken: string | null;
}) => Boolean(eventType.startsWith("party-checkpoint-") && currentSessionId &&
  Number.isSafeInteger(eventCheckpointRevision) &&
  eventCheckpointRevision > currentCheckpointRevision);

export const createLibraryReconciliationRuntime = <T, R>({
  read,
  mergePending = (_current, incoming) => incoming,
  onStarted,
  onCompleted,
  onFailed,
  onTimedOut,
  timeoutMilliseconds = LIBRARY_RECONCILIATION_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  queueTask = (callback) => globalThis.queueMicrotask(callback)
}: {
  read: (trigger: T, signal: AbortSignal, owner: LibraryReconciliationOwner) => Promise<R>;
  mergePending?: (current: T, incoming: T) => T;
  onStarted?: (trigger: T, owner: LibraryReconciliationOwner) => void;
  onCompleted?: (trigger: T, result: R, owner: LibraryReconciliationOwner) => void;
  onFailed?: (trigger: T, owner: LibraryReconciliationOwner) => void;
  onTimedOut?: (trigger: T, owner: LibraryReconciliationOwner) => void;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
  queueTask?: (callback: () => void) => void;
}) => {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("library reconciliation timeout must be positive and finite");
  }
  let epoch = 1;
  let operation = 0;
  let mode: LibraryReconciliationSnapshot["mode"] = "running";
  let active: Active<T> | null = null;
  let pending: T | null = null;
  let drainQueued = false;

  const owns = (owner: LibraryReconciliationOwner) => Boolean(active &&
    ownsLibraryReconciliation(active.owner, owner));
  const clearActive = () => {
    if (!active) return;
    if (active.timer != null) clearTimer(active.timer);
    active = null;
  };
  const revokeActive = () => {
    if (!active) return false;
    const previous = active;
    clearActive();
    previous.abortController.abort();
    return true;
  };
  const openCircuit = () => {
    epoch += 1;
    pending = null;
    revokeActive();
    mode = "circuit-open";
  };
  const scheduleDrain = () => {
    if (drainQueued) return;
    drainQueued = true;
    queueTask(() => {
      drainQueued = false;
      if (mode !== "running" || active || pending === null) return;
      const next = pending;
      pending = null;
      start(next);
    });
  };
  const claimTimeout = (owner: LibraryReconciliationOwner) => {
    if (!owns(owner)) return false;
    const expired = active!;
    clearActive();
    expired.abortController.abort();
    pending = null;
    mode = "circuit-open";
    try { onTimedOut?.(expired.trigger, owner); } catch { /* Runtime ownership is already closed. */ }
    return true;
  };
  const wakeAtDeadline = (owner: LibraryReconciliationOwner) => {
    if (!owns(owner)) return;
    const now = nowMilliseconds();
    if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) {
      claimTimeout(owner);
      return;
    }
    active!.timer = setTimer(() => wakeAtDeadline(owner), owner.deadlineMilliseconds - now);
  };
  const start = (trigger: T) => {
    if (mode !== "running" || active) return false;
    const startedAtMilliseconds = nowMilliseconds();
    const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
    if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0 ||
        !Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
      mode = "circuit-open";
      try { onFailed?.(trigger, Object.freeze({
        version: LIBRARY_RECONCILIATION_RUNTIME_VERSION,
        epoch,
        operation: ++operation,
        startedAtMilliseconds: 0,
        deadlineMilliseconds: timeoutMilliseconds
      })); } catch { /* The runtime remains fail-closed. */ }
      return false;
    }
    const owner = Object.freeze({
      version: LIBRARY_RECONCILIATION_RUNTIME_VERSION,
      epoch,
      operation: ++operation,
      startedAtMilliseconds,
      deadlineMilliseconds
    });
    const abortController = new AbortController();
    active = { trigger, owner, abortController, timer: null };
    active.timer = setTimer(() => wakeAtDeadline(owner), timeoutMilliseconds);
    try { onStarted?.(trigger, owner); } catch { /* Storage ownership remains authoritative. */ }
    void Promise.resolve().then(() => read(trigger, abortController.signal, owner)).then(
      (result) => {
        if (!owns(owner)) return;
        const now = nowMilliseconds();
        if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) {
          claimTimeout(owner);
          return;
        }
        clearActive();
        if (pending !== null) {
          scheduleDrain();
          return;
        }
        try { onCompleted?.(trigger, result, owner); } catch {
          mode = "circuit-open";
          try { onFailed?.(trigger, owner); } catch { /* The runtime remains fail-closed. */ }
        }
      },
      () => {
        if (!owns(owner)) return;
        const now = nowMilliseconds();
        if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) {
          claimTimeout(owner);
          return;
        }
        clearActive();
        if (pending !== null) {
          scheduleDrain();
          return;
        }
        mode = "circuit-open";
        try { onFailed?.(trigger, owner); } catch { /* The runtime remains fail-closed. */ }
      }
    );
    return true;
  };

  return Object.freeze({
    request: (trigger: T) => {
      if (mode === "circuit-open" || mode === "halted") return "blocked" as const;
      pending = pending === null ? trigger : mergePending(pending, trigger);
      if (mode === "paused") return "coalesced" as const;
      if (active) return "coalesced" as const;
      scheduleDrain();
      return "started" as const;
    },
    pause: () => {
      if (mode !== "running") return false;
      if (active) pending = pending === null
        ? active.trigger
        : mergePending(active.trigger, pending);
      revokeActive();
      mode = "paused";
      return true;
    },
    resume: () => {
      if (mode !== "paused") return false;
      mode = "running";
      scheduleDrain();
      return true;
    },
    openCircuit,
    halt: () => {
      epoch += 1;
      pending = null;
      revokeActive();
      mode = "halted";
    },
    snapshot: (): LibraryReconciliationSnapshot => Object.freeze({
      version: LIBRARY_RECONCILIATION_RUNTIME_VERSION,
      epoch,
      operation,
      mode,
      active: Boolean(active),
      pending: pending !== null
    })
  });
};
