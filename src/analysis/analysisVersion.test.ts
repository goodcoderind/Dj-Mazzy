import { describe, expect, it } from "vitest";
import { BASIC_ANALYZER_VERSION, TRACK_ANALYSIS_SCHEMA_VERSION } from "../domain/versions";
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

  it("rejects explicitly stale, unfinished, or malformed cache records", () => {
    expect(hasCurrentBasicAnalysis({ analyzerVersion: BASIC_ANALYZER_VERSION, schemaVersion: "track-analysis/v4", duration: 180 })).toBe(false);
    expect(hasCurrentBasicAnalysis({ analyzerVersion: BASIC_ANALYZER_VERSION, schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION, analysisStatus: "pending", duration: 180 })).toBe(false);
    expect(hasCurrentBasicAnalysis({ analyzerVersion: BASIC_ANALYZER_VERSION, schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION, analysisStatus: "ready", duration: Number.NaN })).toBe(false);
  });
});
