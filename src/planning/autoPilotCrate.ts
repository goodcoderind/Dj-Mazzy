export type AutoPilotCrateTrack = {
  id: string;
  analysisOverrides?: { autoMixDisabled?: boolean } | null;
};

export const buildAutoPilotCandidateIds = (
  queuedIds: readonly string[],
  library: readonly AutoPilotCrateTrack[],
  playedIds: readonly string[],
  loadedIds: readonly (string | null | undefined)[],
  includeRestOfLibrary: boolean,
  unavailableIds: readonly string[] = []
) => {
  const blocked = new Set([...playedIds, ...loadedIds.filter((id): id is string => Boolean(id)), ...unavailableIds]);
  const byId = new Map(library.map((track) => [track.id, track]));
  const seen = new Set<string>();
  const result: string[] = [];
  const append = (id: string) => {
    const track = byId.get(id);
    if (!track || seen.has(id) || blocked.has(id) || track.analysisOverrides?.autoMixDisabled) return;
    seen.add(id);
    result.push(id);
  };
  queuedIds.forEach(append);
  if (includeRestOfLibrary) library.forEach((track) => append(track.id));
  return result;
};

export const buildAutoPilotPlanningIds = (
  queuedIds: readonly string[],
  library: readonly AutoPilotCrateTrack[],
  playedIds: readonly string[],
  loadedIds: readonly (string | null | undefined)[],
  includeRestOfLibrary: boolean,
  unavailableIds: readonly string[] = []
) => {
  const queued = buildAutoPilotCandidateIds(queuedIds, library, playedIds, loadedIds, false, unavailableIds);
  return queued.length
    ? queued
    : buildAutoPilotCandidateIds([], library, playedIds, loadedIds, includeRestOfLibrary, unavailableIds);
};
