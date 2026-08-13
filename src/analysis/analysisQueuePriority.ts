export type AnalysisQueuePriorityInput = {
  trackId: string;
  loadedTrackIds: readonly (string | null | undefined)[];
  queuedTrackIds: readonly string[];
};

export const analysisQueuePriority = ({
  trackId,
  loadedTrackIds,
  queuedTrackIds
}: AnalysisQueuePriorityInput) => {
  const loadedIndex = loadedTrackIds.indexOf(trackId);
  if (loadedIndex >= 0) return loadedIndex;
  const queueIndex = queuedTrackIds.indexOf(trackId);
  if (queueIndex >= 0) return 100 + queueIndex;
  return 10_000;
};

export const sortAnalysisQueue = <T extends { id: string }>(
  tracks: readonly T[],
  loadedTrackIds: readonly (string | null | undefined)[],
  queuedTrackIds: readonly string[]
) => tracks
  .map((track, originalIndex) => ({
    track,
    originalIndex,
    priority: analysisQueuePriority({ trackId: track.id, loadedTrackIds, queuedTrackIds })
  }))
  .sort((left, right) => left.priority - right.priority || left.originalIndex - right.originalIndex)
  .map(({ track }) => track);
