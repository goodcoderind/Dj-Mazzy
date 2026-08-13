import { describe, expect, it } from "vitest";
import { BASIC_ANALYZER_VERSION } from "../domain/versions";
import { hasCurrentBasicAnalysis } from "./analysisVersion";

describe("analysis cache versioning", () => {
  it("accepts current low-confidence results without forcing endless retries", () => {
    expect(
      hasCurrentBasicAnalysis({
        analyzerVersion: BASIC_ANALYZER_VERSION,
        duration: 180
      })
    ).toBe(true);
  });

  it("invalidates records produced by the old pitch mapping", () => {
    expect(
      hasCurrentBasicAnalysis({
        analyzerVersion: "basic-main-thread/v1",
        duration: 180
      })
    ).toBe(false);
  });
});
