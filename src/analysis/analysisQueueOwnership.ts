import { normalizeContentIdentity } from "../storage/contentIdentity";

export const ownsQueuedAnalysisLibraryRow = ({
  expectedTrackId,
  expectedContentIdentity,
  currentTrackId,
  currentContentIdentity,
  expectedFile,
  currentFile,
  removed
}: {
  expectedTrackId: string;
  expectedContentIdentity: unknown;
  currentTrackId: unknown;
  currentContentIdentity: unknown;
  expectedFile: unknown;
  currentFile: unknown;
  removed: boolean;
}) => {
  if (removed || currentTrackId !== expectedTrackId) return false;
  const expected = normalizeContentIdentity(expectedContentIdentity);
  const current = normalizeContentIdentity(currentContentIdentity);
  if (expected) return current === expected;
  return expectedContentIdentity == null && currentContentIdentity == null && expectedFile === currentFile;
};

export const shouldRequeueReplacementAnalysis = ({
  removed,
  currentRowPresent,
  previousJobStillOwnsRow,
  needsAnalysis
}: {
  removed: boolean;
  currentRowPresent: boolean;
  previousJobStillOwnsRow: boolean;
  needsAnalysis: boolean;
}) => !removed && currentRowPresent && !previousJobStillOwnsRow && needsAnalysis;
