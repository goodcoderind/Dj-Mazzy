import type { TRANSITION_PLAN_SCHEMA_VERSION } from "./versions";

export type TransitionTemplate =
  | "phrase-blend"
  | "bass-swap"
  | "echo-drop"
  | "downbeat-cut"
  | "safe-fade";

export type EqPoint = {
  low: number;
  mid: number;
  high: number;
};

export type TransitionPlanV2 = {
  schemaVersion: typeof TRANSITION_PLAN_SCHEMA_VERSION;
  fromTrackId: string;
  toTrackId: string;
  template: TransitionTemplate;
  targetBpm: number | null;
  sourceStartBeat: number | null;
  targetStartBeat: number | null;
  lengthBeats: number | null;
  sourcePlaybackRate: number;
  targetPlaybackRate: number;
  score: number;
  confidence: number;
  scoreBreakdown: Record<string, number>;
  eligibility: {
    longBlendEligible: boolean;
    reasons: string[];
  };
  schedule: {
    requestedAt: number;
    startTime: number;
    endTime: number;
    durationSeconds: number;
    targetCueSeconds: number;
  };
  automation: {
    sourceGain: number[];
    targetGain: number[];
    sourceEq: EqPoint[];
    targetEq: EqPoint[];
    filter?: number[];
    echo?: number[];
  };
  explanation: string[];
};
