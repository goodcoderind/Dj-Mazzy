export const LIBRARY_MEMBERSHIP_MUTATION_RUNTIME_VERSION =
  "library-membership-mutation-runtime/v1" as const;

export const LIBRARY_MEMBERSHIP_PREPARE_TIMEOUT_MS = 90_000;
export const LIBRARY_MEMBERSHIP_ESTIMATE_TIMEOUT_MS = 10_000;
export const LIBRARY_MEMBERSHIP_COMMIT_TIMEOUT_MS = 30_000;

export type LibraryMembershipMutationKind = "import" | "delete" | "clear";
export type LibraryMembershipMutationStage = "reading" | "digesting" | "estimating" | "committing";
export type LibraryMembershipMutationPhase = "idle" | "preparing" | "waiting-exclusive" | "committing" | "circuit-open";

export type LibraryImportPickerOwner = Readonly<{
  version: "library-import-picker-owner/v1";
  operation: number;
}>;

export type LibraryMembershipMutationOwner = Readonly<{
  version: typeof LIBRARY_MEMBERSHIP_MUTATION_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  kind: LibraryMembershipMutationKind;
  expectedLibraryEpoch: number;
  expectedLibraryRevision: number;
}>;

export type LibraryMembershipStageOwner = Readonly<{
  mutation: LibraryMembershipMutationOwner;
  stage: LibraryMembershipMutationStage;
  stageOperation: number;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type LibraryMembershipStageSettlement<T> =
  | Readonly<{ outcome: "completed"; value: T; owner: LibraryMembershipStageOwner }>
  | Readonly<{ outcome: "failed"; error: unknown; owner: LibraryMembershipStageOwner }>
  | Readonly<{ outcome: "timed-out"; owner: LibraryMembershipStageOwner }>
  | Readonly<{ outcome: "cancelled"; owner: LibraryMembershipStageOwner }>;

const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const safeCounter = (value: number) => Number.isSafeInteger(value) && value >= 0;

export const createLibraryImportPickerOwner = (operation: number): LibraryImportPickerOwner => {
  if (!positiveSafeInteger(operation)) throw new RangeError("library import picker owner is invalid");
  return Object.freeze({ version: "library-import-picker-owner/v1", operation });
};

export const ownsLibraryImportPicker = (
  current: LibraryImportPickerOwner | null,
  expected: LibraryImportPickerOwner | null
) => Boolean(current && expected &&
  current.version === "library-import-picker-owner/v1" &&
  expected.version === "library-import-picker-owner/v1" &&
  current.operation === expected.operation);

export const createLibraryMembershipMutationOwner = ({
  epoch,
  operation,
  kind,
  expectedLibraryEpoch,
  expectedLibraryRevision
}: Omit<LibraryMembershipMutationOwner, "version">): LibraryMembershipMutationOwner => {
  if (!positiveSafeInteger(epoch) || !positiveSafeInteger(operation) ||
      !["import", "delete", "clear"].includes(kind) ||
      !safeCounter(expectedLibraryEpoch) || !safeCounter(expectedLibraryRevision)) {
    throw new RangeError("library membership mutation owner is invalid");
  }
  return Object.freeze({
    version: LIBRARY_MEMBERSHIP_MUTATION_RUNTIME_VERSION,
    epoch,
    operation,
    kind,
    expectedLibraryEpoch,
    expectedLibraryRevision
  });
};

export const ownsLibraryMembershipMutation = (
  current: LibraryMembershipMutationOwner | null,
  expected: LibraryMembershipMutationOwner | null
) => Boolean(current && expected &&
  current.version === LIBRARY_MEMBERSHIP_MUTATION_RUNTIME_VERSION &&
  expected.version === LIBRARY_MEMBERSHIP_MUTATION_RUNTIME_VERSION &&
  current.epoch === expected.epoch && current.operation === expected.operation &&
  current.kind === expected.kind &&
  current.expectedLibraryEpoch === expected.expectedLibraryEpoch &&
  current.expectedLibraryRevision === expected.expectedLibraryRevision);

export const mayCancelLibraryMembershipPreparation = (phase: LibraryMembershipMutationPhase) =>
  phase === "preparing";

export const libraryMembershipRevocationDisposition = (phase: LibraryMembershipMutationPhase) =>
  phase === "committing" ? "uncertain" as const : "cancelled" as const;

export const membershipFailureHasDefiniteRollback = (error: unknown) =>
  Boolean(error && typeof error === "object" &&
    "version" in error && error.version === "library-membership-mutation-failure/v1" &&
    "rollbackVerified" in error && error.rollbackVerified === true);

export const mayContinueLibraryMembershipAfterExclusive = ({
  ownerCurrent,
  expectedLibraryEpoch,
  expectedLibraryRevision,
  currentLibraryEpoch,
  currentLibraryRevision
}: {
  ownerCurrent: boolean;
  expectedLibraryEpoch: number;
  expectedLibraryRevision: number;
  currentLibraryEpoch: number;
  currentLibraryRevision: number;
}) => Boolean(ownerCurrent && expectedLibraryEpoch === currentLibraryEpoch &&
  expectedLibraryRevision === currentLibraryRevision);

export const mayClaimPreparedImportCommit = ({
  phase,
  globalMutationMode,
  reconciliationMode,
  reconciliationActive,
  reconciliationPending,
  checkpointBusy,
  checkpointClaimOwned,
  checkpointClearOwned
}: {
  phase: LibraryMembershipMutationPhase;
  globalMutationMode: string;
  reconciliationMode: string;
  reconciliationActive: boolean;
  reconciliationPending: boolean;
  checkpointBusy: boolean;
  checkpointClaimOwned: boolean;
  checkpointClearOwned: boolean;
}) => Boolean(phase === "preparing" && globalMutationMode === "idle" &&
  reconciliationMode === "running" && !reconciliationActive && !reconciliationPending &&
  !checkpointBusy && !checkpointClaimOwned && !checkpointClearOwned);

export const verifyDeckMembershipCleanup = (
  deck: {
    getTrackId?: () => string | null;
    isPlaying?: () => boolean;
    eject?: () => void;
  } | null,
  expectedTrackId: string | null = null
) => {
  if (!deck) return Object.freeze({ affected: false, confirmed: false });
  try {
    const currentTrackId = deck.getTrackId?.() ?? null;
    const affected = expectedTrackId == null ? true : currentTrackId === expectedTrackId;
    if (!affected) return Object.freeze({ affected: false, confirmed: true });
    deck.eject?.();
    const confirmed = !deck.getTrackId?.() && !deck.isPlaying?.();
    return Object.freeze({ affected: true, confirmed });
  } catch {
    return Object.freeze({ affected: true, confirmed: false });
  }
};

export const retryExactDeckMembershipCleanup = (
  deck: Parameters<typeof verifyDeckMembershipCleanup>[0],
  owner: Readonly<{ trackId: string | null; exact: boolean }>
) => {
  if (!owner.exact || !deck) return Object.freeze({ confirmed: false, clearLoadedIdentity: false });
  if (owner.trackId == null) {
    try {
      const confirmed = !deck.getTrackId?.() && !deck.isPlaying?.();
      return Object.freeze({ confirmed, clearLoadedIdentity: confirmed });
    } catch {
      return Object.freeze({ confirmed: false, clearLoadedIdentity: false });
    }
  }
  const cleanup = verifyDeckMembershipCleanup(deck, owner.trackId);
  let currentTrackId: string | null = owner.trackId;
  try { currentTrackId = deck.getTrackId?.() ?? null; } catch { /* Keep the exact old identity. */ }
  return Object.freeze({
    confirmed: cleanup.confirmed,
    clearLoadedIdentity: cleanup.confirmed && (cleanup.affected || currentTrackId == null)
  });
};

export const startBoundedLibraryMembershipStage = <T>({
  mutation,
  stage,
  stageOperation,
  task,
  ownsAuthority = () => true,
  timeoutMilliseconds = stage === "estimating"
    ? LIBRARY_MEMBERSHIP_ESTIMATE_TIMEOUT_MS
    : stage === "committing"
      ? LIBRARY_MEMBERSHIP_COMMIT_TIMEOUT_MS
      : LIBRARY_MEMBERSHIP_PREPARE_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  mutation: LibraryMembershipMutationOwner;
  stage: LibraryMembershipMutationStage;
  stageOperation: number;
  task: (signal: AbortSignal, owner: LibraryMembershipStageOwner) => Promise<T>;
  ownsAuthority?: (owner: LibraryMembershipStageOwner) => boolean;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  if (!ownsLibraryMembershipMutation(mutation, mutation) ||
      !["reading", "digesting", "estimating", "committing"].includes(stage) ||
      !positiveSafeInteger(stageOperation) ||
      !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("library membership stage is invalid");
  }
  const startedAtMilliseconds = nowMilliseconds();
  const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
  if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0 ||
      !Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
    throw new RangeError("library membership stage clock is invalid");
  }
  const owner = Object.freeze({
    mutation,
    stage,
    stageOperation,
    startedAtMilliseconds,
    deadlineMilliseconds
  });
  const abortController = new AbortController();
  let settled = false;
  let timer: unknown = null;
  let resolveSettlement!: (value: LibraryMembershipStageSettlement<T>) => void;
  const settlement = new Promise<LibraryMembershipStageSettlement<T>>((resolve) => {
    resolveSettlement = resolve;
  });
  const settle = (value: LibraryMembershipStageSettlement<T>) => {
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
  const claimTimeout = () => {
    if (settled) return false;
    if (!ownsAuthority(owner)) return cancel();
    if (!settle({ outcome: "timed-out", owner })) return false;
    abortController.abort();
    return true;
  };
  const inspectDeadline = () => {
    if (settled) return;
    if (!ownsAuthority(owner)) {
      cancel();
      return;
    }
    const now = nowMilliseconds();
    if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) {
      claimTimeout();
      return;
    }
    timer = setTimer(inspectDeadline, owner.deadlineMilliseconds - now);
  };
  timer = setTimer(inspectDeadline, timeoutMilliseconds);
  void Promise.resolve().then(() => {
    if (settled) return undefined as T;
    if (!ownsAuthority(owner)) {
      cancel();
      return undefined as T;
    }
    return task(abortController.signal, owner);
  }).then(
    (value) => {
      if (settled) return;
      if (!ownsAuthority(owner)) return void cancel();
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) return void claimTimeout();
      settle({ outcome: "completed", value, owner });
    },
    (error) => {
      if (settled) return;
      if (!ownsAuthority(owner)) return void cancel();
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= owner.deadlineMilliseconds) return void claimTimeout();
      settle({ outcome: "failed", error, owner });
    }
  );
  return Object.freeze({ owner, settlement, cancel });
};
