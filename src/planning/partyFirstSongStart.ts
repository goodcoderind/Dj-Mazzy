export const PARTY_FIRST_SONG_START_VERSION = "party-first-song-start/v1" as const;
export const PARTY_FIRST_SONG_START_TIMEOUT_MS = 10_000;

export type PartyFirstSongStartOwner = Readonly<{
  version: typeof PARTY_FIRST_SONG_START_VERSION;
  operation: number;
  deck: "a" | "b";
  trackId: string;
  loadAuthorityKey: string | null;
  startAuthorityKey: string;
  startedAtMilliseconds: number;
  deadlineMilliseconds: number;
}>;

export type PartyFirstSongStartSettlement<T> =
  | Readonly<{ outcome: "completed"; value: T }>
  | Readonly<{ outcome: "cancelled" }>
  | Readonly<{ outcome: "failed" }>
  | Readonly<{ outcome: "timed-out" }>;

export const ownsPartyFirstSongStart = (
  current: PartyFirstSongStartOwner | null,
  expected: PartyFirstSongStartOwner
) => current === expected;

export const partyFirstSongStartMayContinue = ({
  current,
  expected,
  startAuthorityKey,
  nowMilliseconds,
  blocked,
  trackId,
  loadAuthorityKey
}: {
  current: PartyFirstSongStartOwner | null;
  expected: PartyFirstSongStartOwner;
  startAuthorityKey: string | null;
  nowMilliseconds: number;
  blocked: boolean;
  trackId: string | null;
  loadAuthorityKey: string | null;
}) => ownsPartyFirstSongStart(current, expected) &&
  startAuthorityKey === expected.startAuthorityKey &&
  Number.isFinite(nowMilliseconds) && nowMilliseconds < expected.deadlineMilliseconds &&
  !blocked && trackId === expected.trackId && loadAuthorityKey === expected.loadAuthorityKey;

export const partyFirstSongStartRequiresRecoveryCircuit = ({
  commitClaimed,
  accepted
}: {
  commitClaimed: boolean;
  accepted: boolean;
}) => commitClaimed && !accepted;

export const startPartyFirstSongStart = <T>({
  operation,
  deck,
  trackId,
  loadAuthorityKey,
  task,
  timeoutMilliseconds = PARTY_FIRST_SONG_START_TIMEOUT_MS,
  nowMilliseconds = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id as number)
}: {
  operation: number;
  deck: "a" | "b";
  trackId: string;
  loadAuthorityKey: string | null;
  task: (control: Readonly<{
    mayContinue: () => boolean;
    claimCommit: () => boolean;
  }>) => Promise<T>;
  timeoutMilliseconds?: number;
  nowMilliseconds?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) => {
  if (!Number.isSafeInteger(operation) || operation <= 0 || !["a", "b"].includes(deck) ||
      typeof trackId !== "string" || trackId.length === 0 ||
      (loadAuthorityKey !== null && (typeof loadAuthorityKey !== "string" || loadAuthorityKey.length === 0)) ||
      !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("Party first-song start settings are invalid.");
  }
  const startedAtMilliseconds = nowMilliseconds();
  const deadlineMilliseconds = startedAtMilliseconds + timeoutMilliseconds;
  if (!Number.isFinite(startedAtMilliseconds) || startedAtMilliseconds < 0 ||
      !Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= startedAtMilliseconds) {
    throw new RangeError("Party first-song start deadline is invalid.");
  }
  const owner = Object.freeze({
    version: PARTY_FIRST_SONG_START_VERSION,
    operation,
    deck,
    trackId,
    loadAuthorityKey,
    startAuthorityKey: `${PARTY_FIRST_SONG_START_VERSION}:${operation}`,
    startedAtMilliseconds,
    deadlineMilliseconds
  });
  let settled = false;
  let cancelled = false;
  let commitClaimed = false;
  let timer: unknown = null;
  let resolveSettlement!: (value: PartyFirstSongStartSettlement<T>) => void;
  const settlement = new Promise<PartyFirstSongStartSettlement<T>>((resolve) => {
    resolveSettlement = resolve;
  });
  const settle = (value: PartyFirstSongStartSettlement<T>) => {
    if (settled) return false;
    settled = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    resolveSettlement(Object.freeze(value));
    return true;
  };
  const claimDeadline = () => settle({ outcome: "timed-out" });
  const wakeAtDeadline = () => {
    if (settled || commitClaimed) return;
    const now = nowMilliseconds();
    if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
      claimDeadline();
      return;
    }
    timer = setTimer(wakeAtDeadline, deadlineMilliseconds - now);
  };
  const control = Object.freeze({
    mayContinue: () => !settled && !cancelled,
    claimCommit: () => {
      if (settled || cancelled) return false;
      if (commitClaimed) return true;
      const now = nowMilliseconds();
      if (!Number.isFinite(now) || now >= deadlineMilliseconds) {
        claimDeadline();
        return false;
      }
      commitClaimed = true;
      if (timer != null) clearTimer(timer);
      timer = null;
      return true;
    }
  });
  timer = setTimer(wakeAtDeadline, timeoutMilliseconds);
  void Promise.resolve().then(() => task(control)).then(
    (value) => {
      if (settled) return;
      const now = nowMilliseconds();
      if (!commitClaimed && (!Number.isFinite(now) || now >= deadlineMilliseconds)) {
        claimDeadline();
        return;
      }
      settle(cancelled ? { outcome: "cancelled" } : { outcome: "completed", value });
    },
    () => {
      if (settled) return;
      const now = nowMilliseconds();
      if (!commitClaimed && (!Number.isFinite(now) || now >= deadlineMilliseconds)) {
        claimDeadline();
        return;
      }
      settle(cancelled ? { outcome: "cancelled" } : { outcome: "failed" });
    }
  );
  return Object.freeze({
    owner,
    settlement,
    requestCancel: () => {
      if (settled || commitClaimed) return false;
      cancelled = true;
      return true;
    },
    revoke: () => commitClaimed ? false : settle({ outcome: "cancelled" }),
    snapshot: () => Object.freeze({ settled, cancelled, commitClaimed })
  });
};
