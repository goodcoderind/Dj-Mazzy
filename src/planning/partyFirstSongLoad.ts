export const PARTY_FIRST_SONG_LOAD_VERSION = "party-first-song-load/v1" as const;

export type PartyFirstSongLoadOwner = Readonly<{
  version: typeof PARTY_FIRST_SONG_LOAD_VERSION;
  operation: number;
  deck: "a" | "b";
  trackId: string;
  loadAuthorityKey: string;
}>;

export const createPartyFirstSongLoadOwner = ({
  operation,
  deck,
  trackId
}: {
  operation: number;
  deck: "a" | "b";
  trackId: string;
}): PartyFirstSongLoadOwner => {
  if (!Number.isSafeInteger(operation) || operation <= 0 || !["a", "b"].includes(deck) ||
    typeof trackId !== "string" || trackId.length === 0) {
    throw new Error("Invalid first-song load owner");
  }
  return Object.freeze({
    version: PARTY_FIRST_SONG_LOAD_VERSION,
    operation,
    deck,
    trackId,
    loadAuthorityKey: `party-first:${operation}`
  });
};

export const ownsPartyFirstSongLoad = (
  current: PartyFirstSongLoadOwner | null,
  expected: PartyFirstSongLoadOwner
) => Boolean(current && current.version === PARTY_FIRST_SONG_LOAD_VERSION &&
  current.operation === expected.operation && current.deck === expected.deck &&
  current.trackId === expected.trackId && current.loadAuthorityKey === expected.loadAuthorityKey);

export const ownsPartyFirstSongTimer = (
  timer: Readonly<{ operation: number }> | null,
  owner: PartyFirstSongLoadOwner
) => Boolean(timer && timer.operation === owner.operation);

export const mayClearPartyFirstSongRecoveryStatus = (cleanupConfirmed: unknown) =>
  cleanupConfirmed === true;

export const matchesPartyFirstSongReadyOwner = ({
  readyOwner,
  deck,
  trackId,
  loadAuthorityKey
}: {
  readyOwner: PartyFirstSongLoadOwner | null;
  deck: "a" | "b";
  trackId: string | null;
  loadAuthorityKey: string | null;
}) => Boolean(readyOwner && trackId && loadAuthorityKey &&
  readyOwner.deck === deck && readyOwner.trackId === trackId &&
  readyOwner.loadAuthorityKey === loadAuthorityKey);

export const shouldClearPartyFirstSongReadyForLoad = ({
  readyOwner,
  deck,
  trackId,
  loadAuthorityKey
}: {
  readyOwner: PartyFirstSongLoadOwner | null;
  deck: "a" | "b";
  trackId: string | null;
  loadAuthorityKey: string | null;
}) => Boolean(readyOwner && readyOwner.deck === deck &&
  !matchesPartyFirstSongReadyOwner({ readyOwner, deck, trackId, loadAuthorityKey }));

export const shouldClearPartyFirstSongReadyForTransportStart = matchesPartyFirstSongReadyOwner;
export const shouldClearPartyFirstSongReadyForLoadInvalidation = matchesPartyFirstSongReadyOwner;

export const partyFirstSongReadyActionMessage = (otherDeckPlaying: boolean) => otherDeckPlaying
  ? "The chosen first song remains ready. Another deck is playing; pause it, then press Play First Song."
  : "First song ready. This song stays stopped until you press Play First Song.";

export const shouldClearPartyFirstSongStatusAfterStop = ({
  verifiedStopped,
  status
}: {
  verifiedStopped: boolean;
  status: string | null;
}) => verifiedStopped && (status === "ready" || status === "cleanup-error");

export const partyFirstSongBlocksAutopilotStart = ({
  openingOwned,
  readyOwned
}: {
  openingOwned: boolean;
  readyOwned: boolean;
}) => openingOwned || readyOwned;

export type PartyFirstSongLoadSettlement =
  | "ignore-stale"
  | "ready"
  | "cancelled"
  | "read-failed"
  | "audio-blocked"
  | "cleanup-required";

export const decidePartyFirstSongLoadSettlement = ({
  current,
  expected,
  outcome,
  currentTrackId,
  ready,
  playing,
  playbackRate,
  readinessCurrent,
  contextRunning,
  libraryCurrent,
  recoveryLocked
}: {
  current: PartyFirstSongLoadOwner | null;
  expected: PartyFirstSongLoadOwner;
  outcome: "loaded" | "cancelled" | "unplayable-file" | "audio-blocked";
  currentTrackId: string | null;
  ready: boolean;
  playing: boolean;
  playbackRate: number;
  readinessCurrent: boolean;
  contextRunning: boolean;
  libraryCurrent: boolean;
  recoveryLocked: boolean;
}): PartyFirstSongLoadSettlement => {
  if (!ownsPartyFirstSongLoad(current, expected)) return "ignore-stale";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "unplayable-file") return "read-failed";
  if (outcome === "audio-blocked") return "audio-blocked";
  if (currentTrackId === expected.trackId && ready && !playing && playbackRate === 1 &&
    readinessCurrent && contextRunning && libraryCurrent && !recoveryLocked) {
    return "ready";
  }
  return "cleanup-required";
};
