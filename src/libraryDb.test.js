import { describe, expect, it, vi } from "vitest";
import { mergeRoutineTrackUpdate, waitForTransaction } from "./libraryDb";

describe("waitForTransaction", () => {
  it("rejects an abort-only quota failure exactly once", async () => {
    const quotaError = new DOMException("quota full", "QuotaExceededError");
    const tx = { error: quotaError };
    const pending = waitForTransaction(tx);
    tx.onabort();
    tx.onerror();
    await expect(pending).rejects.toBe(quotaError);
  });

  it("settles a successful transaction exactly once", async () => {
    const tx = { error: null };
    const resolved = vi.fn();
    const pending = waitForTransaction(tx).then(resolved);
    tx.oncomplete();
    tx.onabort();
    await pending;
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("preserves fields owned by identity and timing patches", () => {
    const existing = {
      id: "track-1",
      bpm: 100,
      contentIdentity: "file-content-sha256/v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      analysisOverrides: { schemaVersion: "override/current", beatShiftSeconds: 0.02 },
      timingReview: { schemaVersion: "review/current", answers: ["yes"] }
    };
    const staleAnalysisSnapshot = {
      id: "track-1",
      bpm: 120,
      contentIdentity: null,
      analysisOverrides: { schemaVersion: "old" },
      timingReview: null
    };
    expect(mergeRoutineTrackUpdate(existing, staleAnalysisSnapshot)).toEqual({
      ...staleAnalysisSnapshot,
      bpm: 120,
      contentIdentity: existing.contentIdentity,
      analysisOverrides: existing.analysisOverrides,
      timingReview: existing.timingReview
    });
  });
});
