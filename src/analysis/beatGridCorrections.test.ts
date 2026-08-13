import { describe, expect, it } from "vitest";
import {
  buildEffectiveBeatGrid,
  emptyBeatGridOverrides,
  nudgeBeatGrid,
  scaleCorrectedBpm,
  setBeatAtTime,
  setDownbeatAtTime
} from "./beatGridCorrections";
import { BEAT_GRID_OVERRIDE_SCHEMA_VERSION } from "../domain/versions";

const analysis = {
  durationSeconds: 4,
  bpm: 120,
  beatsSeconds: [0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6],
  downbeatsSeconds: [],
  meter: 4
};

describe("beat-grid corrections", () => {
  it("creates versioned empty overrides", () => {
    expect(emptyBeatGridOverrides()).toEqual({ schemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION });
  });

  it("shifts generated beats without mutating them", () => {
    const original = [...analysis.beatsSeconds];
    const overrides = setBeatAtTime(analysis, 0.65);
    const grid = buildEffectiveBeatGrid({ ...analysis, analysisOverrides: overrides });
    expect(grid.beatsSeconds[0]).toBeCloseTo(0.15);
    expect(grid.beatsSeconds[1]).toBeCloseTo(0.65);
    expect(analysis.beatsSeconds).toEqual(original);
  });

  it("nudges the whole grid by a precise amount", () => {
    const overrides = nudgeBeatGrid(analysis, -0.01);
    const grid = buildEffectiveBeatGrid({ ...analysis, analysisOverrides: overrides });
    expect(grid.beatsSeconds[0]).toBeCloseTo(0.09);
  });

  it("persists a four-beat downbeat phase from the nearest beat", () => {
    const overrides = setDownbeatAtTime(analysis, 1.62);
    const grid = buildEffectiveBeatGrid({ ...analysis, analysisOverrides: overrides });
    expect(overrides.firstDownbeatBeatIndex).toBe(3);
    expect(grid.downbeatsSeconds).toEqual([1.6, 3.6]);
  });

  it("regenerates a regular grid for manual half/double tempo", () => {
    const doubled = scaleCorrectedBpm(analysis, 2);
    const grid = buildEffectiveBeatGrid({ ...analysis, analysisOverrides: doubled });
    expect(grid.bpm).toBe(240);
    expect(grid.beatsSeconds.slice(0, 4)).toEqual([0.1, 0.35, 0.6, 0.85]);
  });

  it("clears an incompatible downbeat phase when tempo interpretation changes", () => {
    const withDownbeat = {
      ...analysis,
      analysisOverrides: setDownbeatAtTime(analysis, 1.6)
    };
    const halved = scaleCorrectedBpm(withDownbeat, 0.5);
    const grid = buildEffectiveBeatGrid({ ...analysis, analysisOverrides: halved });
    expect(halved.firstDownbeatBeatIndex).toBeUndefined();
    expect(grid.downbeatsSeconds).toEqual([]);
  });

  it("safely ignores non-finite corrections and clamps the playhead to the track", () => {
    expect(setBeatAtTime(analysis, Number.NaN)).toEqual(emptyBeatGridOverrides());
    expect(setDownbeatAtTime(analysis, Number.NaN)).toEqual(emptyBeatGridOverrides());
    expect(nudgeBeatGrid(analysis, Number.NaN)).toEqual(emptyBeatGridOverrides());
    const clamped = setBeatAtTime(analysis, 99);
    expect(clamped.firstBeatSeconds).toBeLessThanOrEqual(analysis.durationSeconds);
  });
});
