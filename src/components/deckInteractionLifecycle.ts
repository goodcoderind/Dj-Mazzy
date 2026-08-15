export const runDeckLoadInvalidationBoundary = ({
  notify,
  revoke
}: {
  notify: () => void;
  revoke: () => void;
}) => {
  try { notify(); } catch { /* Host notification cannot retain Deck authority. */ }
  revoke();
};

export const commitDeckTransportStart = <T>({
  start,
  ownsAuthority,
  rollback,
  notify
}: {
  start: () => T;
  ownsAuthority: () => boolean;
  rollback: () => void;
  notify: () => void;
}): T | null => {
  const result = start();
  let owned = false;
  try { owned = ownsAuthority(); } catch { /* A failed observer cannot publish a transport start. */ }
  if (!owned) {
    try { rollback(); } catch { /* The caller retains its recovery owner when rollback is uncertain. */ }
    return null;
  }
  try {
    notify();
  } catch {
    try { rollback(); } catch { /* The caller retains its recovery owner when rollback is uncertain. */ }
    return null;
  }
  return result;
};

export const ownsDeferredDeckInteraction = ({
  locked,
  expectedLoadGeneration,
  currentLoadGeneration,
  expectedTrackId,
  currentTrackId
}: {
  locked: boolean;
  expectedLoadGeneration: number;
  currentLoadGeneration: number;
  expectedTrackId: string | null;
  currentTrackId: string | null;
}) => !locked && expectedLoadGeneration === currentLoadGeneration &&
  expectedTrackId === currentTrackId;

export const deckPlaybackStartIsLocked = ({
  renderedLocked,
  mutableLocked,
  activeOwnerKey,
  requestOwnerKey
}: {
  renderedLocked: boolean;
  mutableLocked: boolean;
  activeOwnerKey: string | null;
  requestOwnerKey: string | null;
}) => renderedLocked || mutableLocked ||
  (activeOwnerKey !== null && activeOwnerKey !== requestOwnerKey);

export const partySetupRevokesDeckTransport = ({
  partySetupLocked,
  activeStartOwnerKey
}: {
  partySetupLocked: boolean;
  activeStartOwnerKey: string | null;
}) => partySetupLocked && activeStartOwnerKey === null;
