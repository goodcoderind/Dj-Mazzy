import type { BEAT_GRID_OVERRIDE_SCHEMA_VERSION } from "./versions";

export type BeatGridOverrides = {
  schemaVersion: typeof BEAT_GRID_OVERRIDE_SCHEMA_VERSION;
  correctedBpm?: number;
  firstBeatSeconds?: number;
  firstDownbeatBeatIndex?: number;
  autoMixDisabled?: boolean;
};

export type BeatGridAnalysis = {
  durationSeconds?: number | null;
  duration?: number | null;
  bpm?: number | null;
  beatsSeconds?: number[];
  downbeatsSeconds?: number[];
  meter?: number | null;
  analysisOverrides?: Partial<BeatGridOverrides> | null;
};
