import { describe, expect, it } from "vitest";
import { ownsQueuedAnalysisLibraryRow, shouldRequeueReplacementAnalysis } from "./analysisQueueOwnership";

const identityA = `file-content-sha256/v1:${"a".repeat(64)}`;
const identityB = `file-content-sha256/v1:${"b".repeat(64)}`;
const fileA = {};

describe("queued analysis library ownership", () => {
  it("accepts only the same current local content row", () => {
    expect(ownsQueuedAnalysisLibraryRow({
      expectedTrackId: "track-1",
      expectedContentIdentity: identityA,
      currentTrackId: "track-1",
      currentContentIdentity: identityA,
      expectedFile: fileA,
      currentFile: fileA,
      removed: false
    })).toBe(true);
  });

  it.each([
    ["track-2", identityA, false],
    ["track-1", identityB, false],
    ["track-1", identityA, true],
    ["track-1", "hostile", false]
  ])("rejects a removed or replaced settlement", (currentTrackId, currentContentIdentity, removed) => {
    expect(ownsQueuedAnalysisLibraryRow({
      expectedTrackId: "track-1",
      expectedContentIdentity: identityA,
      currentTrackId,
      currentContentIdentity,
      expectedFile: fileA,
      currentFile: fileA,
      removed
    })).toBe(false);
  });

  it("supports legacy rows only while both identities remain absent", () => {
    expect(ownsQueuedAnalysisLibraryRow({
      expectedTrackId: "legacy",
      expectedContentIdentity: null,
      currentTrackId: "legacy",
      currentContentIdentity: null,
      expectedFile: fileA,
      currentFile: fileA,
      removed: false
    })).toBe(true);
    expect(ownsQueuedAnalysisLibraryRow({
      expectedTrackId: "legacy",
      expectedContentIdentity: null,
      currentTrackId: "legacy",
      currentContentIdentity: identityA,
      expectedFile: fileA,
      currentFile: fileA,
      removed: false
    })).toBe(false);
  });

  it("rejects malformed legacy identity and same-id Blob replacement", () => {
    expect(ownsQueuedAnalysisLibraryRow({
      expectedTrackId: "legacy",
      expectedContentIdentity: null,
      currentTrackId: "legacy",
      currentContentIdentity: "hostile",
      expectedFile: fileA,
      currentFile: fileA,
      removed: false
    })).toBe(false);
    expect(ownsQueuedAnalysisLibraryRow({
      expectedTrackId: "legacy",
      expectedContentIdentity: null,
      currentTrackId: "legacy",
      currentContentIdentity: null,
      expectedFile: fileA,
      currentFile: {},
      removed: false
    })).toBe(false);
  });

  it("requeues a missing-analysis replacement exactly when it remains present and not removed", () => {
    const replacement = {
      removed: false,
      currentRowPresent: true,
      previousJobStillOwnsRow: false,
      needsAnalysis: true
    };
    expect(shouldRequeueReplacementAnalysis(replacement)).toBe(true);
    expect(shouldRequeueReplacementAnalysis({ ...replacement, removed: true })).toBe(false);
    expect(shouldRequeueReplacementAnalysis({ ...replacement, currentRowPresent: false })).toBe(false);
    expect(shouldRequeueReplacementAnalysis({ ...replacement, previousJobStillOwnsRow: true })).toBe(false);
    expect(shouldRequeueReplacementAnalysis({ ...replacement, needsAnalysis: false })).toBe(false);
  });
});
