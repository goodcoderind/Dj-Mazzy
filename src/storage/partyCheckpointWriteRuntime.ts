export const PARTY_CHECKPOINT_WRITE_RUNTIME_VERSION = "party-checkpoint-write-runtime/v1" as const;
export const PARTY_CHECKPOINT_WRITE_TIMEOUT_MS = 30_000;
export const PARTY_CHECKPOINT_CLEAR_OWNER_VERSION = "party-checkpoint-clear-owner/v1" as const;
export const PARTY_CHECKPOINT_CLAIM_OWNER_VERSION = "party-checkpoint-claim-owner/v1" as const;

export type PartyCheckpointWriteTicket = Readonly<{
  version: typeof PARTY_CHECKPOINT_WRITE_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  fingerprint: string;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

type Candidate<T> = Readonly<{ fingerprint: string; value: T }>;
type RuntimeMode = "running" | "exclusive" | "halted" | "circuit-open";

export type PartyCheckpointClearOwner = Readonly<{
  version: typeof PARTY_CHECKPOINT_CLEAR_OWNER_VERSION;
  operation: number;
  sessionId: string | null;
  writerToken: string | null;
}>;

export type PartyCheckpointClaimOwner = Readonly<{
  version: typeof PARTY_CHECKPOINT_CLAIM_OWNER_VERSION;
  operation: number;
  sessionId: string;
  checkpointRevision: number;
  previousWriterToken: string;
  nextWriterToken: string;
  libraryEpoch: number;
  libraryRevision: number;
}>;

export const createPartyCheckpointClaimOwner = (
  owner: Omit<PartyCheckpointClaimOwner, "version">
): PartyCheckpointClaimOwner => {
  if (!Number.isSafeInteger(owner.operation) || owner.operation <= 0 ||
      !Number.isSafeInteger(owner.checkpointRevision) || owner.checkpointRevision <= 0 ||
      !Number.isSafeInteger(owner.libraryEpoch) || owner.libraryEpoch < 0 ||
      !Number.isSafeInteger(owner.libraryRevision) || owner.libraryRevision < 0) {
    throw new RangeError("checkpoint claim counters are invalid");
  }
  if (![owner.sessionId, owner.previousWriterToken, owner.nextWriterToken]
    .every((value) => typeof value === "string" && value.length > 0)) {
    throw new TypeError("checkpoint claim identity is invalid");
  }
  return Object.freeze({ version: PARTY_CHECKPOINT_CLAIM_OWNER_VERSION, ...owner });
};

export const ownsPartyCheckpointClaim = (
  current: PartyCheckpointClaimOwner | null,
  expected: PartyCheckpointClaimOwner | null
) => Boolean(current && expected && Object.keys(expected).every((key) =>
  current[key as keyof PartyCheckpointClaimOwner] === expected[key as keyof PartyCheckpointClaimOwner]));

export const createPartyCheckpointClearOwner = ({
  operation,
  sessionId,
  writerToken
}: Omit<PartyCheckpointClearOwner, "version">): PartyCheckpointClearOwner => {
  if (!Number.isSafeInteger(operation) || operation <= 0) {
    throw new RangeError("checkpoint clear operation must be a positive safe integer");
  }
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId)) {
    throw new TypeError("checkpoint clear session id must be null or non-empty");
  }
  if (writerToken !== null && (typeof writerToken !== "string" || !writerToken)) {
    throw new TypeError("checkpoint clear writer token must be null or non-empty");
  }
  return Object.freeze({
    version: PARTY_CHECKPOINT_CLEAR_OWNER_VERSION,
    operation,
    sessionId,
    writerToken
  });
};

export const ownsPartyCheckpointClear = (
  current: PartyCheckpointClearOwner | null,
  expected: PartyCheckpointClearOwner | null
) => Boolean(current && expected &&
  current.version === PARTY_CHECKPOINT_CLEAR_OWNER_VERSION &&
  expected.version === PARTY_CHECKPOINT_CLEAR_OWNER_VERSION &&
  current.operation === expected.operation &&
  current.sessionId === expected.sessionId &&
  current.writerToken === expected.writerToken);

export type BoundedPartyCheckpointOperationResult<T> =
  | Readonly<{ outcome: "completed"; value: T }>
  | Readonly<{ outcome: "failed" }>
  | Readonly<{ outcome: "timed-out" }>
  | Readonly<{ outcome: "cancelled" }>;

export const startBoundedPartyCheckpointOperation = <T>({
  task,
  ownsAuthority = () => true,
  timeoutMilliseconds = PARTY_CHECKPOINT_WRITE_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  task: (signal: AbortSignal) => Promise<T>;
  ownsAuthority?: () => boolean;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("checkpoint operation timeout must be positive and finite");
  }
  const startedAtMilliseconds = nowMilliseconds();
  if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0) {
    throw new RangeError("checkpoint operation clock must be finite and non-negative");
  }
  const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
  if (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
    throw new RangeError("checkpoint operation deadline is invalid");
  }
  const abortController = new AbortController();
  let settled = false;
  let timer: unknown = null;
  let resolveResult!: (result: BoundedPartyCheckpointOperationResult<T>) => void;
  const promise = new Promise<BoundedPartyCheckpointOperationResult<T>>((resolve) => {
    resolveResult = resolve;
  });
  const settle = (result: BoundedPartyCheckpointOperationResult<T>) => {
    if (settled) return false;
    settled = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    resolveResult(Object.freeze(result));
    return true;
  };
  const claimTimeout = () => {
    if (!ownsAuthority()) {
      abortController.abort();
      return settle({ outcome: "cancelled" });
    }
    if (!settle({ outcome: "timed-out" })) return false;
    abortController.abort();
    return true;
  };
  const wakeAtDeadline = () => {
    if (settled) return;
    if (!ownsAuthority()) {
      abortController.abort();
      settle({ outcome: "cancelled" });
      return;
    }
    const now = nowMilliseconds();
    if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
      claimTimeout();
      return;
    }
    timer = setTimer(wakeAtDeadline, deadlineMilliseconds - now);
  };
  timer = setTimer(wakeAtDeadline, timeoutMilliseconds);
  void Promise.resolve().then(() => task(abortController.signal)).then(
    (value) => {
      if (settled) return;
      if (!ownsAuthority()) {
        abortController.abort();
        settle({ outcome: "cancelled" });
        return;
      }
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
        claimTimeout();
        return;
      }
      settle({ outcome: "completed", value });
    },
    () => {
      if (settled) return;
      if (!ownsAuthority()) {
        settle({ outcome: "cancelled" });
        return;
      }
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
        claimTimeout();
        return;
      }
      settle({ outcome: "failed" });
    }
  );
  return Object.freeze({
    promise,
    cancel: () => {
      if (settled) return false;
      abortController.abort();
      return settle({ outcome: "cancelled" });
    },
    deadlineMilliseconds
  });
};

export type PartyCheckpointWriteRuntimeSnapshot = Readonly<{
  version: typeof PARTY_CHECKPOINT_WRITE_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  mode: RuntimeMode;
  activeFingerprint: string | null;
  pendingFingerprint: string | null;
}>;

export const shouldQueuePartyCheckpointCandidate = ({
  fingerprint,
  lastSavedFingerprint,
  runtime
}: {
  fingerprint: string;
  lastSavedFingerprint: string;
  runtime: Pick<PartyCheckpointWriteRuntimeSnapshot, "activeFingerprint" | "pendingFingerprint">;
}) => fingerprint !== lastSavedFingerprint ||
  runtime.activeFingerprint !== null || runtime.pendingFingerprint !== null;

export const createPartyCheckpointWriteRuntime = <T, R>({
  write,
  onResolved,
  onRejected,
  onTimedOut,
  timeoutMilliseconds = PARTY_CHECKPOINT_WRITE_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  write: (value: T, signal: AbortSignal, ticket: PartyCheckpointWriteTicket) => Promise<R>;
  onResolved?: (value: T, result: R, ticket: PartyCheckpointWriteTicket) => boolean | void;
  onRejected?: (value: T, ticket: PartyCheckpointWriteTicket) => boolean | void;
  onTimedOut?: (value: T, ticket: PartyCheckpointWriteTicket) => void;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("checkpoint write timeout must be positive and finite");
  }
  let epoch = 1;
  let operation = 0;
  let mode: RuntimeMode = "running";
  let pending: Candidate<T> | null = null;
  let active: null | {
    candidate: Candidate<T>;
    ticket: PartyCheckpointWriteTicket;
    abortController: AbortController;
    timer: unknown;
  } = null;
  let exclusiveWaiters: Array<(ready: boolean) => void> = [];

  const resolveExclusive = (ready: boolean) => {
    const waiters = exclusiveWaiters;
    exclusiveWaiters = [];
    waiters.forEach((resolve) => resolve(ready));
  };

  const owns = (ticket: PartyCheckpointWriteTicket) => Boolean(active &&
    active.ticket.epoch === ticket.epoch && active.ticket.operation === ticket.operation &&
    active.ticket.fingerprint === ticket.fingerprint);

  const clearActive = () => {
    if (!active) return;
    if (active.timer != null) clearTimer(active.timer);
    active = null;
  };

  const claimTimeout = (ticket: PartyCheckpointWriteTicket) => {
    if (!owns(ticket)) return false;
    const expired = active!;
    clearActive();
    expired.abortController.abort();
    pending = null;
    mode = "circuit-open";
    resolveExclusive(false);
    try { onTimedOut?.(expired.candidate.value, ticket); } catch { /* Runtime ownership is already revoked. */ }
    return true;
  };

  const wakeAtDeadline = (ticket: PartyCheckpointWriteTicket) => {
    if (!owns(ticket)) return;
    const now = nowMilliseconds();
    if (!Number.isFinite(now)) {
      claimTimeout(ticket);
      return;
    }
    const remaining = ticket.deadlineMilliseconds - now;
    if (remaining > 0) {
      active!.timer = setTimer(() => wakeAtDeadline(ticket), remaining);
      return;
    }
    claimTimeout(ticket);
  };

  const start = (candidate: Candidate<T>) => {
    if (mode !== "running" || active) return;
    const startedAtMilliseconds = nowMilliseconds();
    if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0) {
      mode = "circuit-open";
      pending = null;
      resolveExclusive(false);
      return;
    }
    const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
    if (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
      mode = "circuit-open";
      pending = null;
      resolveExclusive(false);
      return;
    }
    const ticket = Object.freeze({
      version: PARTY_CHECKPOINT_WRITE_RUNTIME_VERSION,
      epoch,
      operation: ++operation,
      fingerprint: candidate.fingerprint,
      startedAtMilliseconds,
      deadlineMilliseconds
    });
    const abortController = new AbortController();
    active = { candidate, ticket, abortController, timer: null };
    active.timer = setTimer(() => wakeAtDeadline(ticket), timeoutMilliseconds);
    void Promise.resolve().then(() => write(candidate.value, abortController.signal, ticket)).then(
      (result) => {
        if (!owns(ticket)) return;
        const now = nowMilliseconds();
        if (!Number.isFinite(now) || now >= ticket.deadlineMilliseconds) {
          claimTimeout(ticket);
          return;
        }
        clearActive();
        let keepRunning = true;
        try { keepRunning = onResolved?.(candidate.value, result, ticket) !== false; } catch { keepRunning = false; }
        if (!keepRunning) {
          epoch += 1;
          pending = null;
          mode = "halted";
          resolveExclusive(false);
          return;
        }
        if (mode === "exclusive") {
          resolveExclusive(true);
          return;
        }
        const next = pending;
        pending = null;
        if (mode === "running" && next && next.fingerprint !== candidate.fingerprint) start(next);
      },
      () => {
        if (!owns(ticket)) return;
        const now = nowMilliseconds();
        if (!Number.isFinite(now) || now >= ticket.deadlineMilliseconds) {
          claimTimeout(ticket);
          return;
        }
        clearActive();
        let keepRunning = true;
        try { keepRunning = onRejected?.(candidate.value, ticket) !== false; } catch { keepRunning = false; }
        if (!keepRunning) {
          epoch += 1;
          pending = null;
          mode = "halted";
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
      }
    );
  };

  const halt = () => {
    epoch += 1;
    pending = null;
    mode = "halted";
    if (active) {
      const previous = active;
      clearActive();
      previous.abortController.abort();
    }
    resolveExclusive(false);
  };

  return Object.freeze({
    enqueue: (candidate: Candidate<T>) => {
      if (typeof candidate?.fingerprint !== "string" || !candidate.fingerprint) {
        throw new TypeError("checkpoint write fingerprint is required");
      }
      if (mode !== "running") return mode === "circuit-open" ? "circuit-open" as const : "paused" as const;
      if (!active) {
        start(Object.freeze({ ...candidate }));
        return "started" as const;
      }
      if (active.candidate.fingerprint === candidate.fingerprint) {
        pending = null;
        return "duplicate" as const;
      }
      if (pending?.fingerprint === candidate.fingerprint) {
        return "duplicate" as const;
      }
      pending = Object.freeze({ ...candidate });
      return "coalesced" as const;
    },
    prepareExclusive: () => {
      if (mode !== "running") return Promise.resolve(false);
      mode = "exclusive";
      pending = null;
      if (!active) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => exclusiveWaiters.push(resolve));
    },
    resume: () => {
      if (mode !== "exclusive") return false;
      mode = "running";
      return true;
    },
    reset: () => {
      if (mode === "circuit-open" || mode === "exclusive") return false;
      halt();
      mode = "running";
      return true;
    },
    completeExclusive: () => {
      if (mode !== "exclusive" || active) return false;
      epoch += 1;
      pending = null;
      resolveExclusive(false);
      mode = "running";
      return true;
    },
    openCircuit: () => {
      epoch += 1;
      pending = null;
      mode = "circuit-open";
      if (active) {
        const previous = active;
        clearActive();
        previous.abortController.abort();
      }
      resolveExclusive(false);
    },
    halt,
    snapshot: (): PartyCheckpointWriteRuntimeSnapshot => Object.freeze({
      version: PARTY_CHECKPOINT_WRITE_RUNTIME_VERSION,
      epoch,
      operation,
      mode,
      activeFingerprint: active?.candidate.fingerprint ?? null,
      pendingFingerprint: pending?.fingerprint ?? null
    })
  });
};
