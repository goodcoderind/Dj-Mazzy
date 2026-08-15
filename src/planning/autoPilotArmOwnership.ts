export const AUTO_PILOT_ARM_OWNERSHIP_VERSION = "auto-pilot-arm-ownership/v1" as const;
export const AUTO_PILOT_ARM_MAX_LEASE_SECONDS = 8;
export const AUTO_PILOT_ARM_MIN_LEASE_SECONDS = 0.05;
export const AUTO_PILOT_ARM_RETRY_RUNWAY_SECONDS = 4.25;

export type AutoPilotArmDeck = "a" | "b";

export type AutoPilotArmLease = Readonly<{
  version: typeof AUTO_PILOT_ARM_OWNERSHIP_VERSION;
  operation: number;
  generation: number;
  transitionKey: string;
  sourceDeck: AutoPilotArmDeck;
  targetDeck: AutoPilotArmDeck;
  sourceTrackId: string;
  targetTrackId: string;
  sourceLoadKey: string;
  targetLoadKey: string;
  startedAtSeconds: number;
  deadlineSeconds: number;
}>;

type ArmPairIdentity = Readonly<{
  sourceDeck: AutoPilotArmDeck;
  targetDeck: AutoPilotArmDeck;
  sourceTrackId: string | null;
  targetTrackId: string | null;
  sourceLoadKey: string | null;
  targetLoadKey: string | null;
}>;

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const nonEmpty = (value: string) => typeof value === "string" && value.length > 0;

const validLease = (lease: AutoPilotArmLease) =>
  lease.version === AUTO_PILOT_ARM_OWNERSHIP_VERSION &&
  positiveInteger(lease.operation) && positiveInteger(lease.generation) &&
  ["a", "b"].includes(lease.sourceDeck) && ["a", "b"].includes(lease.targetDeck) &&
  lease.sourceDeck !== lease.targetDeck &&
  nonEmpty(lease.sourceTrackId) && nonEmpty(lease.targetTrackId) &&
  nonEmpty(lease.sourceLoadKey) && nonEmpty(lease.targetLoadKey) &&
  lease.transitionKey === `${lease.sourceLoadKey}->${lease.targetLoadKey}` &&
  finiteNonNegative(lease.startedAtSeconds) && finiteNonNegative(lease.deadlineSeconds) &&
  lease.deadlineSeconds > lease.startedAtSeconds &&
  lease.deadlineSeconds - lease.startedAtSeconds >= AUTO_PILOT_ARM_MIN_LEASE_SECONDS - 1e-9 &&
  lease.deadlineSeconds - lease.startedAtSeconds <= AUTO_PILOT_ARM_MAX_LEASE_SECONDS + 1e-9;

export const deriveAutoPilotArmDeadline = (input: Readonly<{
  nowSeconds: number;
  scheduledStartSeconds: number;
  minimumArmLeadSeconds: number;
}>) => {
  if (!finiteNonNegative(input.nowSeconds) || !finiteNonNegative(input.scheduledStartSeconds) ||
    !finiteNonNegative(input.minimumArmLeadSeconds)) return null;
  const deadlineSeconds = Math.min(
    input.nowSeconds + AUTO_PILOT_ARM_MAX_LEASE_SECONDS,
    input.scheduledStartSeconds - input.minimumArmLeadSeconds
  );
  if (deadlineSeconds - input.nowSeconds < AUTO_PILOT_ARM_MIN_LEASE_SECONDS - 1e-9) return null;
  return deadlineSeconds;
};

export const createAutoPilotArmLease = (input: Omit<AutoPilotArmLease, "version">) => {
  const lease = Object.freeze({ version: AUTO_PILOT_ARM_OWNERSHIP_VERSION, ...input });
  if (!validLease(lease)) {
    throw new RangeError("transition arm lease must be finite, bounded, and exact");
  }
  return lease;
};

export const ownsAutoPilotArmLease = (
  current: AutoPilotArmLease | null | undefined,
  expected: AutoPilotArmLease | null | undefined
) => Boolean(current && expected &&
  validLease(current) && validLease(expected) &&
  current.version === AUTO_PILOT_ARM_OWNERSHIP_VERSION &&
  current.operation === expected.operation &&
  current.generation === expected.generation &&
  current.transitionKey === expected.transitionKey &&
  current.sourceDeck === expected.sourceDeck && current.targetDeck === expected.targetDeck &&
  current.sourceTrackId === expected.sourceTrackId && current.targetTrackId === expected.targetTrackId &&
  current.sourceLoadKey === expected.sourceLoadKey && current.targetLoadKey === expected.targetLoadKey &&
  current.startedAtSeconds === expected.startedAtSeconds && current.deadlineSeconds === expected.deadlineSeconds);

export const inspectAutoPilotArmLease = (input: Readonly<{
  current: AutoPilotArmLease | null;
  expected: AutoPilotArmLease;
  nowSeconds: number;
  pair: ArmPairIdentity;
}>) => {
  if (!finiteNonNegative(input.nowSeconds)) throw new RangeError("nowSeconds must be finite and non-negative");
  if (!ownsAutoPilotArmLease(input.current, input.expected)) return "superseded" as const;
  const lease = input.expected;
  if (input.nowSeconds < lease.startedAtSeconds) return "superseded" as const;
  if (input.pair.sourceDeck !== lease.sourceDeck || input.pair.targetDeck !== lease.targetDeck ||
    input.pair.sourceTrackId !== lease.sourceTrackId || input.pair.targetTrackId !== lease.targetTrackId ||
    input.pair.sourceLoadKey !== lease.sourceLoadKey || input.pair.targetLoadKey !== lease.targetLoadKey) {
    return "superseded" as const;
  }
  return input.nowSeconds < lease.deadlineSeconds ? "active" as const : "expired" as const;
};

export const decideAutoPilotArmFailure = (input: Readonly<{
  consecutiveFailures: number;
  sourceRemainingSeconds: number;
}>) => {
  if (!Number.isSafeInteger(input.consecutiveFailures) || input.consecutiveFailures < 1 ||
    !finiteNonNegative(input.sourceRemainingSeconds)) {
    throw new RangeError("arm failure state must be finite and positive");
  }
  return input.consecutiveFailures >= 2 ||
    input.sourceRemainingSeconds < AUTO_PILOT_ARM_RETRY_RUNWAY_SECONDS
    ? "pause" as const
    : "retry" as const;
};
