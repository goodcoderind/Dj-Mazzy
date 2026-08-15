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
  if (!ownsAuthority()) {
    rollback();
    return null;
  }
  try {
    notify();
  } catch {
    rollback();
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
