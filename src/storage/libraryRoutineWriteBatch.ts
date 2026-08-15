export type LibraryRoutineTrackPatch = Readonly<{
  trackId: string;
  contentIdentity: string | null;
  patch: Readonly<Record<string, unknown>>;
}>;

export type LibraryRoutineWriteBatch<TTrack = unknown> = Readonly<{
  tracks: ReadonlyArray<TTrack> | null;
  patches: ReadonlyArray<LibraryRoutineTrackPatch>;
  membershipBoundary: boolean;
  routineGeneration: number;
}>;

export const createLibraryRoutineSnapshotBatch = <TTrack>(
  tracks: ReadonlyArray<TTrack>,
  routineGeneration = 0
) => Object.freeze({
  tracks: Object.freeze([...tracks]),
  patches: Object.freeze([]) as ReadonlyArray<LibraryRoutineTrackPatch>,
  membershipBoundary: false,
  routineGeneration
});

export const createLibraryRoutineMembershipBatch = <TTrack>(
  tracks: ReadonlyArray<TTrack>,
  routineGeneration = 0
) => Object.freeze({
  tracks: Object.freeze([...tracks]),
  patches: Object.freeze([]) as ReadonlyArray<LibraryRoutineTrackPatch>,
  membershipBoundary: true,
  routineGeneration
});

export const createLibraryRoutinePatchBatch = (
  trackId: string,
  contentIdentity: string | null,
  patch: Readonly<Record<string, unknown>>
) => {
  if (typeof trackId !== "string" || !trackId || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("routine track patch is invalid");
  }
  return Object.freeze({
    tracks: null,
    patches: Object.freeze([Object.freeze({
      trackId,
      contentIdentity,
      patch: Object.freeze({ ...patch })
    })]),
    membershipBoundary: false,
    routineGeneration: 0
  });
};

export const mergeLibraryRoutineWriteBatches = <TTrack>(
  current: LibraryRoutineWriteBatch<TTrack>,
  incoming: LibraryRoutineWriteBatch<TTrack>
): LibraryRoutineWriteBatch<TTrack> => {
  const patches = new Map<string, LibraryRoutineTrackPatch>();
  for (const entry of [...current.patches, ...incoming.patches]) {
    if (incoming.membershipBoundary && incoming.tracks) {
      const exactTrack = incoming.tracks.find((track) =>
        (track as { id?: unknown })?.id === entry.trackId
      ) as { contentIdentity?: unknown } | undefined;
      if (!exactTrack || exactTrack.contentIdentity !== entry.contentIdentity) continue;
    }
    const previous = patches.get(entry.trackId);
    const sameContentOwner = previous?.contentIdentity === entry.contentIdentity;
    patches.set(entry.trackId, Object.freeze({
      trackId: entry.trackId,
      contentIdentity: entry.contentIdentity,
      patch: Object.freeze({ ...(sameContentOwner ? previous?.patch ?? {} : {}), ...entry.patch })
    }));
  }
  return Object.freeze({
    tracks: incoming.tracks === null ? current.tracks : Object.freeze([...incoming.tracks]),
    patches: Object.freeze([...patches.values()]),
    membershipBoundary: incoming.membershipBoundary,
    routineGeneration: Math.max(current.routineGeneration, incoming.routineGeneration)
  });
};

export const shouldQueueLibraryRoutineSnapshot = <TTrack>({
  library,
  skipSnapshot,
  circuitOpen
}: {
  library: ReadonlyArray<TTrack>;
  skipSnapshot: ReadonlyArray<TTrack> | null;
  circuitOpen: boolean;
}) => library.length > 0 && library !== skipSnapshot && !circuitOpen;

export const retryRejectedLibraryRoutineSnapshot = <TTrack>(
  batch: LibraryRoutineWriteBatch<TTrack>
): LibraryRoutineWriteBatch<TTrack> | null => batch.tracks === null
  ? null
  : createLibraryRoutineSnapshotBatch(batch.tracks, batch.routineGeneration);

export const hasUnpersistedLibraryRoutineGeneration = ({
  dirtyGeneration,
  savedGeneration
}: {
  dirtyGeneration: number;
  savedGeneration: number;
}) => Number.isSafeInteger(dirtyGeneration) && Number.isSafeInteger(savedGeneration) &&
  dirtyGeneration > savedGeneration;

export const libraryRoutineEnqueueOwnsPersistence = (
  status: string
) => status === "started" || status === "coalesced";

export const libraryRoutineSaveStatusAfterSettlement = ({
  pending,
  dirtyGeneration,
  savedGeneration
}: {
  pending: boolean;
  dirtyGeneration: number;
  savedGeneration: number;
}) => pending || hasUnpersistedLibraryRoutineGeneration({ dirtyGeneration, savedGeneration })
  ? "saving" as const
  : "saved" as const;

export const shouldEnqueueLibraryRoutineSnapshot = ({
  membershipChanged,
  active,
  pending,
  dirtyGeneration,
  savedGeneration
}: {
  membershipChanged: boolean;
  active: boolean;
  pending: boolean;
  dirtyGeneration: number;
  savedGeneration: number;
}) => hasUnpersistedLibraryRoutineGeneration({ dirtyGeneration, savedGeneration }) ||
  (membershipChanged && (active || pending));
