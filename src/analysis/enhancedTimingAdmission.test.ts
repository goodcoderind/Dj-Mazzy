import { describe, expect, it } from "vitest";
import {
  advanceEnhancedTimingAdmission,
  createEnhancedTimingAdmission,
  enhancedTimingRemovalStatusAfterPrepare,
  mayPublishEnhancedTimingAssetState,
  ownsEnhancedTimingAdmission,
  planEnhancedTimingRemovalGate,
  projectEnhancedTimingRemovalWork
} from "./enhancedTimingAdmission";

describe("enhanced timing admission", () => {
  it("admits only an exact allowed generation", () => {
    const unavailable = createEnhancedTimingAdmission();
    const available = advanceEnhancedTimingAdmission(unavailable, true);
    expect(ownsEnhancedTimingAdmission(available, available)).toBe(true);
    expect(ownsEnhancedTimingAdmission(unavailable, unavailable)).toBe(false);

    const removalGate = advanceEnhancedTimingAdmission(available, false);
    expect(ownsEnhancedTimingAdmission(removalGate, available)).toBe(false);
    const laterDownload = advanceEnhancedTimingAdmission(removalGate, true);
    expect(ownsEnhancedTimingAdmission(laterDownload, available)).toBe(false);
    expect(ownsEnhancedTimingAdmission(laterDownload, laterDownload)).toBe(true);
  });

  it("removes only enhanced work while preserving basic jobs and deferrals", () => {
    const projected = projectEnhancedTimingRemovalWork({
      pending: [
        { id: "basic", kind: "basic-program" },
        { id: "enhanced", kind: "enhanced" }
      ],
      queuedKeys: ["basic-program:basic", "enhanced:enhanced"],
      deferred: [
        ["basic-program:basic", { kind: "basic-program" }],
        ["enhanced:enhanced", { kind: "enhanced" }]
      ] as Array<[string, { kind: string }]>
    });
    expect(projected.pending).toEqual([{ id: "basic", kind: "basic-program" }]);
    expect([...projected.queuedKeys]).toEqual(["basic-program:basic"]);
    expect([...projected.deferred.keys()]).toEqual(["basic-program:basic"]);
    expect([...projected.removedTrackIds]).toEqual(["enhanced"]);
  });

  it("rejects a stale asset probe after removal claims or advances its generation", () => {
    expect(mayPublishEnhancedTimingAssetState({
      currentGeneration: 4,
      expectedGeneration: 4,
      removalGated: false
    })).toBe(true);
    expect(mayPublishEnhancedTimingAssetState({
      currentGeneration: 5,
      expectedGeneration: 4,
      removalGated: false
    })).toBe(false);
    expect(mayPublishEnhancedTimingAssetState({
      currentGeneration: 4,
      expectedGeneration: 4,
      removalGated: true
    })).toBe(false);
  });

  it("clears a completed-removal result when a new explicit download begins", () => {
    expect(enhancedTimingRemovalStatusAfterPrepare({ state: "removed", message: "fixed" })).toBeNull();
    expect(enhancedTimingRemovalStatusAfterPrepare({ state: "blocked", message: "fixed" })).toEqual({
      state: "blocked",
      message: "fixed"
    });
  });

  it("plans the production gate without cancelling or dropping basic work", () => {
    const admission = advanceEnhancedTimingAdmission(createEnhancedTimingAdmission(), true);
    const plan = planEnhancedTimingRemovalGate({
      admission,
      activeKind: "enhanced",
      pending: [
        { id: "one", kind: "enhanced" },
        { id: "two", kind: "basic-program" }
      ],
      queuedKeys: ["enhanced:one", "basic-program:two"],
      deferred: [
        ["enhanced:one", { kind: "enhanced" }],
        ["basic-program:two", { kind: "basic-program" }]
      ] as Array<[string, { kind: string }]>
    });
    expect(plan.cancelActiveEnhanced).toBe(true);
    expect(plan.admission.allowed).toBe(false);
    expect(plan.admission.generation).toBe(admission.generation + 1);
    expect(plan.work.pending).toEqual([{ id: "two", kind: "basic-program" }]);
    expect([...plan.work.queuedKeys]).toEqual(["basic-program:two"]);
    expect([...plan.work.deferred.keys()]).toEqual(["basic-program:two"]);
  });
});
