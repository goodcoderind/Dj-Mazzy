import { describe, expect, it } from "vitest";
import { sortAnalysisQueue } from "./analysisQueuePriority";

describe("background analysis priority", () => {
  it("puts loaded decks first, queued tracks next, then preserves library order", () => {
    const tracks = ["rest-1", "queue-2", "loaded-b", "rest-2", "loaded-a", "queue-1"]
      .map((id) => ({ id }));
    expect(sortAnalysisQueue(tracks, ["loaded-a", "loaded-b"], ["queue-1", "queue-2"])
      .map((track) => track.id)).toEqual([
        "loaded-a", "loaded-b", "queue-1", "queue-2", "rest-1", "rest-2"
      ]);
  });

  it("is deterministic when IDs are absent from both priority groups", () => {
    const tracks = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sortAnalysisQueue(tracks, [], []).map((track) => track.id)).toEqual(["a", "b", "c"]);
  });
});
