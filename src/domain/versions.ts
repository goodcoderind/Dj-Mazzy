/**
 * Persisted records must carry these versions. Increment the relevant version
 * whenever a stored result can no longer be interpreted safely.
 */
export const TRACK_ANALYSIS_SCHEMA_VERSION = "track-analysis/v5" as const;
export const BASIC_ANALYZER_VERSION = "basic-worker/v5" as const;
export const BEAT_GRID_OVERRIDE_SCHEMA_VERSION = "beat-grid-overrides/v1" as const;
export const TIMING_REVIEW_SCHEMA_VERSION = "timing-review/v1" as const;
export const AUTOMATIC_RHYTHM_TRUST_SCHEMA_VERSION = "automatic-rhythm-trust/v2" as const;
export const TRANSITION_PLAN_SCHEMA_VERSION = "transition-plan/v2" as const;
