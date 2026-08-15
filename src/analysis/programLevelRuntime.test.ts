import { describe, expect, it } from "vitest";
import { programLevelFailurePolicy } from "./programLevelRuntime";

describe("loaded-deck program-level failure policy", () => {
  it("keeps current beat/key state when only v1-to-v2 level migration fails", () => {
    expect(programLevelFailurePolicy(true)).toEqual({
      preserveBasicAnalysis: true,
      trimDb: 0,
      levelStatus: "failed"
    });
  });

  it("allows the existing full-analysis fallback when basic analysis was missing", () => {
    expect(programLevelFailurePolicy(false).preserveBasicAnalysis).toBe(false);
  });
});
