export const PARTY_WAKE_LOCK_VERSION = "party-wake-lock/v2" as const;
export const PARTY_WAKE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;

export type PartyWakeLockStatus = "idle" | "requesting" | "active" | "unavailable";

export const partyWakeLockStatusMessage = (status: PartyWakeLockStatus) => status === "active"
  ? "Mazzy asked this screen to stay awake while Autopilot runs."
  : status === "unavailable"
    ? "Mazzy could not confirm screen wake. Keep the computer powered and awake while Autopilot runs."
    : "Asking the browser to keep this screen awake…";

type WakeLockSentinelLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void, options?: { once?: boolean }) => void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export const createPartyWakeLockController = ({
  request = () => navigator.wakeLock.request("screen") as Promise<WakeLockSentinelLike>,
  visibility = () => document.visibilityState,
  onStatus = () => undefined,
  now = () => performance.now(),
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  clearScheduledTimeout = (handle) => clearTimeout(handle),
  timeoutMilliseconds = PARTY_WAKE_LOCK_ACQUIRE_TIMEOUT_MS
}: {
  request?: () => Promise<WakeLockSentinelLike>;
  visibility?: () => DocumentVisibilityState;
  onStatus?: (status: PartyWakeLockStatus) => void;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearScheduledTimeout?: (handle: TimerHandle) => void;
  timeoutMilliseconds?: number;
} = {}) => {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("Invalid Party wake-lock deadline");
  }
  let wanted = false;
  let activeSentinel: WakeLockSentinelLike | null = null;
  let cleanupSentinel: WakeLockSentinelLike | null = null;
  let retryRequestedAfterCleanup = false;
  let generation = 0;
  let nativePending: {
    owner: number;
    deadlineMilliseconds: number;
    publicSettled: boolean;
    timedOut: boolean;
    timer: TimerHandle | null;
    settlement: Promise<void>;
    resolveSettlement: () => void;
  } | null = null;

  const publish = (status: PartyWakeLockStatus) => {
    try { onStatus(status); } catch { /* Wake ownership must not depend on React publication. */ }
  };

  const settlePublic = (attempt: NonNullable<typeof nativePending>) => {
    if (attempt.publicSettled) return;
    attempt.publicSettled = true;
    if (attempt.timer != null) clearScheduledTimeout(attempt.timer);
    attempt.timer = null;
    attempt.resolveSettlement();
  };

  const maybeAcquireAfterCleanup = () => {
    if (wanted && visibility() === "visible" && !activeSentinel &&
      !cleanupSentinel && !nativePending) void acquire();
  };

  const releaseCleanupSentinel = async (owned: WakeLockSentinelLike) => {
    try {
      await owned.release();
      if (cleanupSentinel === owned) cleanupSentinel = null;
    } catch {
      if (owned.released && cleanupSentinel === owned) cleanupSentinel = null;
    }
  };

  const releaseLateSentinel = async (acquired: WakeLockSentinelLike) => {
    cleanupSentinel = acquired;
    await releaseCleanupSentinel(acquired);
    if (wanted) {
      if (cleanupSentinel === acquired) publish("unavailable");
      else if (activeSentinel || nativePending) return;
      else if (retryRequestedAfterCleanup) {
        retryRequestedAfterCleanup = false;
        maybeAcquireAfterCleanup();
      }
      else publish("unavailable");
    }
  };

  const acquire: () => Promise<void> = () => {
    const newDemand = !wanted;
    wanted = true;
    if (newDemand) generation += 1;
    if (visibility() !== "visible") return Promise.resolve();
    if (cleanupSentinel) {
      retryRequestedAfterCleanup = true;
      publish("unavailable");
      return Promise.resolve();
    }
    if (activeSentinel && !activeSentinel.released) {
      retryRequestedAfterCleanup = false;
      publish("active");
      return Promise.resolve();
    }
    if (activeSentinel?.released) activeSentinel = null;
    if (nativePending) {
      if (nativePending.timedOut || nativePending.owner !== generation) publish("unavailable");
      return nativePending.settlement;
    }

    retryRequestedAfterCleanup = false;
    const owner = generation;
    const startedAtMilliseconds = now();
    const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    const attempt = {
      owner,
      deadlineMilliseconds,
      publicSettled: false,
      timedOut: false,
      timer: null as TimerHandle | null,
      settlement,
      resolveSettlement
    };
    nativePending = attempt;
    publish("requesting");

    const checkDeadline = () => {
      if (nativePending !== attempt || attempt.publicSettled) return;
      const current = now();
      if (!Number.isFinite(current) || current >= attempt.deadlineMilliseconds) {
        attempt.timedOut = true;
        settlePublic(attempt);
        if (wanted && owner === generation) publish("unavailable");
        return;
      }
      attempt.timer = scheduleTimeout(
        checkDeadline,
        Math.max(0, attempt.deadlineMilliseconds - current)
      );
    };
    attempt.timer = scheduleTimeout(checkDeadline, timeoutMilliseconds);

    let nativeRequest: Promise<WakeLockSentinelLike>;
    try {
      nativeRequest = request();
    } catch {
      nativePending = null;
      settlePublic(attempt);
      if (wanted && owner === generation) publish("unavailable");
      return settlement;
    }
    void nativeRequest.then(
      (acquired) => {
        if (nativePending === attempt) nativePending = null;
        const current = now();
        const onTime = Number.isFinite(current) && current < attempt.deadlineMilliseconds;
        if (!wanted || owner !== generation || attempt.timedOut || !onTime) {
          settlePublic(attempt);
          if (wanted && owner !== generation) retryRequestedAfterCleanup = true;
          void releaseLateSentinel(acquired).catch(() => undefined);
          return;
        }
        activeSentinel = acquired;
        settlePublic(attempt);
        acquired.addEventListener?.("release", () => {
          if (activeSentinel !== acquired) return;
          activeSentinel = null;
          maybeAcquireAfterCleanup();
        }, { once: true });
        publish("active");
      },
      () => {
        if (nativePending === attempt) nativePending = null;
        settlePublic(attempt);
        if (wanted && owner === generation) publish("unavailable");
        else maybeAcquireAfterCleanup();
      }
    );
    return settlement;
  };

  const releaseOwned = async (announce: boolean) => {
    wanted = false;
    retryRequestedAfterCleanup = false;
    const owner = ++generation;
    if (nativePending) settlePublic(nativePending);
    const active = activeSentinel;
    if (active) {
      activeSentinel = null;
      if (!active.released) cleanupSentinel = active;
    }
    if (announce) publish("idle");
    const cleanup = cleanupSentinel;
    if (cleanup && !cleanup.released) {
      await releaseCleanupSentinel(cleanup);
    } else if (cleanupSentinel === cleanup) {
      cleanupSentinel = null;
    }
    if (announce && !wanted && owner === generation) publish("idle");
    if (wanted && owner !== generation) {
      if (cleanupSentinel) publish("unavailable");
      else {
        retryRequestedAfterCleanup = false;
        maybeAcquireAfterCleanup();
      }
    }
  };
  const release = () => releaseOwned(true);
  const releaseForHostTeardown = () => releaseOwned(false);

  const onVisibilityChange = () => {
    if (activeSentinel?.released) activeSentinel = null;
    if (cleanupSentinel?.released) cleanupSentinel = null;
    maybeAcquireAfterCleanup();
  };

  return Object.freeze({
    version: PARTY_WAKE_LOCK_VERSION,
    acquire,
    release,
    releaseForHostTeardown,
    onVisibilityChange,
    snapshot: () => Object.freeze({
      wanted,
      acquiring: Boolean(nativePending || cleanupSentinel),
      timedOut: Boolean(nativePending?.timedOut),
      retainedSentinel: Boolean(activeSentinel || cleanupSentinel),
      activeSentinel: Boolean(activeSentinel),
      cleanupSentinel: Boolean(cleanupSentinel)
    })
  });
};
