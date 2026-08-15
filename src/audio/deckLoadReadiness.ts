export const DECK_LOAD_READINESS_VERSION = "deck-load-readiness/v1" as const;
export const DECK_LOAD_TRIM_PROOF_TOLERANCE_DB = 0.0001;

export const DECK_LOAD_PURPOSE = Object.freeze({
  manual: "manual",
  autoPilotPreload: "autopilot-preload"
} as const);

export type DeckLoadPurpose = typeof DECK_LOAD_PURPOSE[keyof typeof DECK_LOAD_PURPOSE];
type ReadinessInput = {
  purpose: DeckLoadPurpose;
  hasCurrentBasicAnalysis: boolean;
  cachedTrimDb: number | null;
};

export type DeckLoadReadinessDecision =
  | Readonly<{
      version: typeof DECK_LOAD_READINESS_VERSION;
      kind: "run-inline-analysis";
    }>
  | Readonly<{
      version: typeof DECK_LOAD_READINESS_VERSION;
      kind: "publish-decoded";
      timingFacts: "cached-basic" | "none";
      levelTrim: "cached" | "neutral";
      safeFadeOnly: boolean;
      applyCachedBasicAnalysis: boolean;
      trimDb: number;
      levelStatus: "ready" | "deferred";
      reason:
        | "cached-analysis"
        | "basic-analysis-pending"
        | "level-analysis-pending"
        | "basic-and-level-analysis-pending";
    }>;

export type PublishDecodedDeckReadinessDecision = Extract<
  DeckLoadReadinessDecision,
  { kind: "publish-decoded" }
>;

export type DeckLoadReadinessSnapshot = Readonly<{
  version: typeof DECK_LOAD_READINESS_VERSION;
  trackId: string;
  loadAuthorityKey: string;
  timingFacts: "cached-basic" | "none";
  levelTrim: "cached" | "neutral";
  safeFadeOnly: boolean;
  reason: PublishDecodedDeckReadinessDecision["reason"];
  trimDb: number;
}>;

export const ownsDeckLoadReadiness = ({
  value,
  trackId,
  loadAuthorityKey,
  appliedTrimDb
}: {
  value: unknown;
  trackId: string;
  loadAuthorityKey: string;
  appliedTrimDb: number;
}) => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<DeckLoadReadinessSnapshot>;
  if (snapshot.version !== DECK_LOAD_READINESS_VERSION || snapshot.trackId !== trackId ||
    snapshot.loadAuthorityKey !== loadAuthorityKey ||
    !["cached-basic", "none"].includes(String(snapshot.timingFacts)) ||
    !["cached", "neutral"].includes(String(snapshot.levelTrim)) ||
    typeof snapshot.safeFadeOnly !== "boolean" || snapshot.safeFadeOnly !== (snapshot.timingFacts === "none") ||
    typeof snapshot.trimDb !== "number" || !Number.isFinite(snapshot.trimDb) ||
    snapshot.trimDb < -6 || snapshot.trimDb > 3 ||
    typeof appliedTrimDb !== "number" || !Number.isFinite(appliedTrimDb) ||
    Math.abs(snapshot.trimDb - appliedTrimDb) > DECK_LOAD_TRIM_PROOF_TOLERANCE_DB ||
    (snapshot.levelTrim === "neutral" && snapshot.trimDb !== 0)) return false;
  const expectedReason = snapshot.timingFacts === "cached-basic"
    ? snapshot.levelTrim === "cached" ? "cached-analysis" : "level-analysis-pending"
    : snapshot.levelTrim === "cached" ? "basic-analysis-pending" : "basic-and-level-analysis-pending";
  return snapshot.reason === expectedReason;
};

export const runDeckPostDecodeLoad = <T>({
  decision,
  publishDecoded,
  runInlineAnalysis
}: {
  decision: DeckLoadReadinessDecision;
  publishDecoded: (decision: PublishDecodedDeckReadinessDecision) => T;
  runInlineAnalysis: () => T | Promise<T>;
}) => decision.kind === "publish-decoded"
  ? publishDecoded(decision)
  : runInlineAnalysis();

export const commitDecodedDeckReadiness = ({
  decision,
  ownsAuthority,
  applyCachedBasicAnalysis,
  clearBasicAnalysis,
  applyTrim,
  publishDecodedBuffer
}: {
  decision: PublishDecodedDeckReadinessDecision;
  ownsAuthority: () => boolean;
  applyCachedBasicAnalysis: () => void;
  clearBasicAnalysis: () => void;
  applyTrim: (trimDb: number, levelStatus: "ready" | "deferred") => void;
  publishDecodedBuffer: () => void;
}) => {
  if (!ownsAuthority()) return "cancelled" as const;
  if (decision.applyCachedBasicAnalysis) applyCachedBasicAnalysis();
  else clearBasicAnalysis();
  if (!ownsAuthority()) return "cancelled" as const;
  applyTrim(decision.trimDb, decision.levelStatus);
  if (!ownsAuthority()) return "cancelled" as const;
  publishDecodedBuffer();
  return "published" as const;
};

const validCachedTrim = (value: number | null) =>
  typeof value === "number" && Number.isFinite(value) && value >= -6 && value <= 3;

export const decideDeckLoadReadiness = ({
  purpose,
  hasCurrentBasicAnalysis: hasBasic,
  cachedTrimDb
}: ReadinessInput): DeckLoadReadinessDecision => {
  if (purpose === DECK_LOAD_PURPOSE.manual) {
    return Object.freeze({
      version: DECK_LOAD_READINESS_VERSION,
      kind: "run-inline-analysis"
    });
  }
  if (purpose !== DECK_LOAD_PURPOSE.autoPilotPreload) {
    throw new Error("Unsupported deck load purpose");
  }

  const hasLevel = validCachedTrim(cachedTrimDb);
  const reason = hasBasic
    ? hasLevel ? "cached-analysis" : "level-analysis-pending"
    : hasLevel ? "basic-analysis-pending" : "basic-and-level-analysis-pending";

  return Object.freeze({
    version: DECK_LOAD_READINESS_VERSION,
    kind: "publish-decoded",
    timingFacts: hasBasic ? "cached-basic" : "none",
    levelTrim: hasLevel ? "cached" : "neutral",
    safeFadeOnly: !hasBasic,
    applyCachedBasicAnalysis: hasBasic,
    trimDb: hasLevel ? cachedTrimDb as number : 0,
    levelStatus: hasLevel ? "ready" : "deferred",
    reason
  });
};
