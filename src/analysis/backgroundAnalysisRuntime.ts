export const BACKGROUND_ANALYSIS_RUNTIME_VERSION = "background-analysis-runtime/v1" as const;

export const BACKGROUND_ANALYSIS_STAGE_TIMEOUT_MS = Object.freeze({
  read: 90_000,
  decode: 120_000,
  "decode-runtime": 120_000,
  "basic-program": 180_000,
  "enhanced-render": 300_000,
  "enhanced-inference": 300_000
});

export type BackgroundAnalysisStage = keyof typeof BACKGROUND_ANALYSIS_STAGE_TIMEOUT_MS;
export type BackgroundAnalysisJobKind = "basic-program" | "enhanced";

export type BackgroundAnalysisLease = Readonly<{
  version: typeof BACKGROUND_ANALYSIS_RUNTIME_VERSION;
  epoch: number;
  operation: number;
  trackId: string;
  contentIdentity: string | null;
  fileToken: unknown;
  kind: BackgroundAnalysisJobKind;
  attempt: 1;
}>;

export const createBackgroundAnalysisLease = ({
  epoch,
  operation,
  trackId,
  contentIdentity,
  fileToken,
  kind
}: Omit<BackgroundAnalysisLease, "version" | "attempt">): BackgroundAnalysisLease | null => {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(operation) || operation <= 0) return null;
  if (typeof trackId !== "string" || !trackId || (kind !== "basic-program" && kind !== "enhanced")) return null;
  if (contentIdentity !== null && (typeof contentIdentity !== "string" || !contentIdentity)) return null;
  if (contentIdentity === null && fileToken == null) return null;
  return Object.freeze({
    version: BACKGROUND_ANALYSIS_RUNTIME_VERSION,
    epoch,
    operation,
    trackId,
    contentIdentity,
    fileToken,
    kind,
    attempt: 1
  });
};

export const ownsBackgroundAnalysisLease = (
  current: BackgroundAnalysisLease | null | undefined,
  expected: BackgroundAnalysisLease | null | undefined
) => Boolean(current && expected &&
  current.version === BACKGROUND_ANALYSIS_RUNTIME_VERSION &&
  expected.version === BACKGROUND_ANALYSIS_RUNTIME_VERSION &&
  current.epoch === expected.epoch &&
  current.operation === expected.operation &&
  current.trackId === expected.trackId &&
  current.contentIdentity === expected.contentIdentity &&
  (current.contentIdentity !== null || current.fileToken === expected.fileToken) &&
  current.kind === expected.kind &&
  current.attempt === expected.attempt);

export type BackgroundAnalysisStageLease = Readonly<{
  job: BackgroundAnalysisLease;
  stage: BackgroundAnalysisStage;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export const createBackgroundAnalysisStageLease = ({
  job,
  stage,
  startedAtMilliseconds,
  timeoutMilliseconds = BACKGROUND_ANALYSIS_STAGE_TIMEOUT_MS[stage]
}: {
  job: BackgroundAnalysisLease;
  stage: BackgroundAnalysisStage;
  startedAtMilliseconds: number;
  timeoutMilliseconds?: number;
}): BackgroundAnalysisStageLease | null => {
  if (!ownsBackgroundAnalysisLease(job, job) || !(stage in BACKGROUND_ANALYSIS_STAGE_TIMEOUT_MS)) return null;
  if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0 ||
    !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) return null;
  const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
  if (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) return null;
  return Object.freeze({ job, stage, startedAtMilliseconds, deadlineMilliseconds });
};

export const ownsBackgroundAnalysisStageLease = (
  current: BackgroundAnalysisStageLease | null | undefined,
  expected: BackgroundAnalysisStageLease | null | undefined
) => Boolean(current && expected &&
  ownsBackgroundAnalysisLease(current.job, expected.job) &&
  current.stage === expected.stage &&
  current.startedAtMilliseconds === expected.startedAtMilliseconds &&
  current.deadlineMilliseconds === expected.deadlineMilliseconds);

export type BackgroundStageSettlement<T> =
  | { outcome: "completed"; value: T }
  | { outcome: "failed" }
  | { outcome: "timed-out" }
  | { outcome: "cancelled" };

export const startBoundedBackgroundStage = <T>({
  task,
  timeoutMs,
  ownsAuthority,
  onTimeout,
  onCancel,
  deadlineMilliseconds,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  task: () => Promise<T>;
  timeoutMs: number;
  ownsAuthority: () => boolean;
  onTimeout?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  deadlineMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  let settled = false;
  let timer: unknown = null;
  let resolveSettlement!: (value: BackgroundStageSettlement<T>) => void;
  const settlement = new Promise<BackgroundStageSettlement<T>>((resolve) => { resolveSettlement = resolve; });
  const finish = (value: BackgroundStageSettlement<T>) => {
    if (settled) return false;
    settled = true;
    if (timer != null) clearTimer(timer);
    resolveSettlement(value);
    return true;
  };
  const deadline = deadlineMilliseconds ?? nowMilliseconds() + timeoutMs;
  const claimTimeout = () => {
    if (settled) return;
    if (!ownsAuthority()) {
      finish({ outcome: "cancelled" });
      return;
    }
    const claimed = finish({ outcome: "timed-out" });
    if (claimed) void Promise.resolve().then(() => onTimeout?.()).catch(() => undefined);
  };
  const wakeAtDeadline = () => {
    if (settled) return;
    const remaining = deadline - nowMilliseconds();
    if (remaining > 0) {
      timer = setTimer(wakeAtDeadline, remaining);
      return;
    }
    claimTimeout();
  };
  timer = setTimer(wakeAtDeadline, Math.max(0, deadline - nowMilliseconds()));
  void Promise.resolve().then(task).then(
    (value) => !ownsAuthority()
      ? finish({ outcome: "cancelled" })
      : nowMilliseconds() >= deadline ? claimTimeout() : finish({ outcome: "completed", value }),
    () => !ownsAuthority()
      ? finish({ outcome: "cancelled" })
      : nowMilliseconds() >= deadline ? claimTimeout() : finish({ outcome: "failed" })
  );
  return {
    settlement,
    cancel: () => {
      if (settled) return false;
      void Promise.resolve().then(() => onCancel?.()).catch(() => undefined);
      return finish({ outcome: "cancelled" });
    }
  };
};

export const backgroundAnalysisJobKey = (trackId: string, kind: BackgroundAnalysisJobKind) => `${kind}:${trackId}`;

export const shouldRetainBackgroundAnalysisDeferral = ({
  kind,
  rowPresent,
  basicProgramComplete,
  enhancedComplete
}: {
  kind: BackgroundAnalysisJobKind;
  rowPresent: boolean;
  basicProgramComplete: boolean;
  enhancedComplete: boolean;
}) => rowPresent && (kind === "basic-program" ? !basicProgramComplete : !enhancedComplete);

export const isRetryableBackgroundAnalysisStage = (stage: BackgroundAnalysisStage) =>
  stage !== "decode" && stage !== "enhanced-render";

export type BackgroundAnalysisDeferral = Readonly<{
  kind: BackgroundAnalysisJobKind;
  stage: BackgroundAnalysisStage;
}>;

export const isRetryableBackgroundAnalysisDeferral = ({
  deferral,
  decodeCircuitOpen,
  enhancedRenderCircuitOpen
}: {
  deferral: BackgroundAnalysisDeferral;
  decodeCircuitOpen: boolean;
  enhancedRenderCircuitOpen: boolean;
}) => !decodeCircuitOpen &&
  isRetryableBackgroundAnalysisStage(deferral.stage) &&
  !(enhancedRenderCircuitOpen && deferral.kind === "enhanced");

export const decideBackgroundDecodeFailure = ({
  outcome,
  runtimeUnavailable
}: {
  outcome: "failed" | "timed-out" | "cancelled";
  runtimeUnavailable: boolean;
}) => outcome === "timed-out"
  ? { deferStage: "decode" as const, unabortable: true }
  : outcome === "failed" && runtimeUnavailable
    ? { deferStage: "decode-runtime" as const, unabortable: false }
    : { deferStage: null, unabortable: false };

export const backgroundAnalysisRowsAfterMutationRollback = <T extends { id: string }>(
  rows: readonly T[],
  removedTrackIds: ReadonlySet<string>
) => rows.filter((row) => !removedTrackIds.has(row.id));

export const deriveBackgroundAnalysisNotice = ({
  deferrals,
  decodeCircuitOpen,
  enhancedRenderCircuitOpen,
  retryUsed,
  enhancedEnabled = true
}: {
  deferrals: readonly BackgroundAnalysisDeferral[];
  decodeCircuitOpen: boolean;
  enhancedRenderCircuitOpen: boolean;
  retryUsed: boolean;
  enhancedEnabled?: boolean;
}) => {
  const enhancedCircuit = enhancedEnabled && enhancedRenderCircuitOpen;
  const retryable = !retryUsed && deferrals.some((deferral) => isRetryableBackgroundAnalysisDeferral({
    deferral,
    decodeCircuitOpen,
    enhancedRenderCircuitOpen: enhancedCircuit
  }));
  if (decodeCircuitOpen) return {
    type: "circuit-open" as const,
    retryable: false,
    message: "Local analysis paused for this tab because a browser audio step did not finish. Mazzy can still try to open songs; missing timing uses Safe Fade and missing level data uses neutral loudness. Reload Mazzy to retry analysis."
  };
  if (enhancedCircuit) return {
    type: "circuit-open" as const,
    retryable,
    message: retryable
      ? "Enhanced background timing paused because a browser audio step did not finish. Other deferred local checks can be retried; reload Mazzy before retrying enhanced timing."
      : "Enhanced background timing remains paused for this tab. Reload Mazzy before retrying enhanced timing."
  };
  if (deferrals.length) return {
    type: "session-deferred" as const,
    retryable,
    message: "Some optional local analysis took too long and was deferred for this session. Mazzy can still try to open those songs; missing timing uses Safe Fade and missing level data uses neutral loudness."
  };
  return null;
};

export const sortBackgroundAnalysisJobs = <T extends { id: string; kind: BackgroundAnalysisJobKind }>(
  jobs: readonly T[],
  loadedTrackIds: readonly (string | null | undefined)[],
  queuedTrackIds: readonly string[]
) => jobs
  .map((job, originalIndex) => {
    const loadedIndex = loadedTrackIds.indexOf(job.id);
    const queueIndex = queuedTrackIds.indexOf(job.id);
    const rowPriority = loadedIndex >= 0 ? loadedIndex : queueIndex >= 0 ? 100 + queueIndex : 10_000;
    return { job, originalIndex, stagePriority: job.kind === "basic-program" ? 0 : 1, rowPriority };
  })
  .sort((left, right) => left.stagePriority - right.stagePriority || left.rowPriority - right.rowPriority || left.originalIndex - right.originalIndex)
  .map(({ job }) => job);

type BackgroundFileReader = Pick<FileReader, "result" | "error" | "readyState" | "onload" | "onerror" | "onabort" | "readAsArrayBuffer" | "abort">;

export const readBlobForBackgroundAnalysis = (
  blob: Blob,
  signal: AbortSignal,
  createReader: () => BackgroundFileReader = () => new FileReader()
) => new Promise<ArrayBuffer>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException("Background analysis cancelled", "AbortError"));
    return;
  }
  const reader = createReader();
  const cleanup = () => signal.removeEventListener("abort", onAbort);
  const onAbort = () => {
    try {
      if (reader.readyState === 1) reader.abort();
    } catch { /* Cancellation still rejects below. */ }
    cleanup();
    reject(new DOMException("Background analysis cancelled", "AbortError"));
  };
  reader.onload = () => {
    cleanup();
    if (signal.aborted || !(reader.result instanceof ArrayBuffer)) {
      reject(new DOMException("Background analysis cancelled", "AbortError"));
      return;
    }
    resolve(reader.result);
  };
  reader.onerror = () => {
    cleanup();
    reject(reader.error ?? new Error("Local file read failed"));
  };
  reader.onabort = onAbort;
  signal.addEventListener("abort", onAbort, { once: true });
  reader.readAsArrayBuffer(blob);
});
