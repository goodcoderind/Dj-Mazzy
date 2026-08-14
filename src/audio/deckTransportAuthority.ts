export type DeckTransportAuthority = {
  revision: number;
};

export const createDeckTransportAuthority = (): DeckTransportAuthority => ({ revision: 1 });

export const captureDeckTransportAuthority = (authority: DeckTransportAuthority) => authority.revision;

export const invalidateDeckTransportAuthority = (authority: DeckTransportAuthority) => {
  authority.revision = authority.revision >= Number.MAX_SAFE_INTEGER ? 1 : authority.revision + 1;
  return authority.revision;
};

export const ownsDeckTransportAuthority = (
  authority: DeckTransportAuthority,
  capturedRevision: number
) => Number.isSafeInteger(capturedRevision) && capturedRevision === authority.revision;
