import type { PartyEnergyProfile } from "../planning/energyProfiles";

export const PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION = "party-session-checkpoint/v1" as const;
export const PARTY_SESSION_CHECKPOINT_KEY = "active" as const;
export const PARTY_SESSION_CHECKPOINT_MAX_TRACKS = 10_000;
export const PARTY_SESSION_CHECKPOINT_MAX_ACTIVE_SECONDS = 7 * 24 * 60 * 60;
export const PARTY_SESSION_DURATION_SECONDS = Object.freeze([
  60 * 60,
  2 * 60 * 60,
  3 * 60 * 60,
  4 * 60 * 60,
  6 * 60 * 60
] as const);

export type PartySessionCheckpointReason =
  | "active-periodic"
  | "host-paused"
  | "host-control"
  | "rescue"
  | "safety"
  | "audio-recovery"
  | "output-change"
  | "source-stopped";

export type PartySessionCheckpointAvailable = Readonly<{
  key: typeof PARTY_SESSION_CHECKPOINT_KEY;
  schemaVersion: typeof PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION;
  recordStatus: "available";
  revision: number;
  sessionId: string;
  writerToken: string;
  libraryEpoch: number;
  libraryRevision: number;
  restoreMode: "paused-plan";
  checkpointReason: PartySessionCheckpointReason;
  plannedDurationSeconds: number;
  accumulatedActiveSeconds: number;
  energyProfile: PartyEnergyProfile;
  energyShiftSteps: number;
  includeRestOfLibrary: boolean;
  playedTrackIds: readonly string[];
  remainingTrackIds: readonly string[];
  lastStableSourceTrackId: string;
}>;

export type PartySessionCheckpointTombstone = Readonly<{
  key: typeof PARTY_SESSION_CHECKPOINT_KEY;
  schemaVersion: typeof PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION;
  recordStatus: "claimed" | "cleared" | "invalidated";
  revision: number;
  sessionId: string | null;
  writerToken: string | null;
}>;

export type PartySessionCheckpointRecord =
  | PartySessionCheckpointAvailable
  | PartySessionCheckpointTombstone;

export type PartySessionCheckpointDraft = Omit<
  PartySessionCheckpointAvailable,
  "key" | "schemaVersion" | "recordStatus" | "revision" | "restoreMode"
>;

export type PartySessionCheckpointProjectionInput = Readonly<{
  sessionId: string;
  writerToken: string;
  libraryEpoch: number;
  libraryRevision: number;
  checkpointReason: PartySessionCheckpointReason;
  plannedDurationSeconds: number;
  elapsedActiveSeconds: number;
  energyProfile: PartyEnergyProfile;
  energyShift: number;
  includeRestOfLibrary: boolean;
  playedTrackIds: readonly string[];
  queueTrackIds: readonly string[];
  committedTargetTrackId?: string | null;
  lastStableSourceTrackId: string;
}>;

const AVAILABLE_KEYS = Object.freeze([
  "key",
  "schemaVersion",
  "recordStatus",
  "revision",
  "sessionId",
  "writerToken",
  "libraryEpoch",
  "libraryRevision",
  "restoreMode",
  "checkpointReason",
  "plannedDurationSeconds",
  "accumulatedActiveSeconds",
  "energyProfile",
  "energyShiftSteps",
  "includeRestOfLibrary",
  "playedTrackIds",
  "remainingTrackIds",
  "lastStableSourceTrackId"
] as const);

const TOMBSTONE_KEYS = Object.freeze([
  "key",
  "schemaVersion",
  "recordStatus",
  "revision",
  "sessionId",
  "writerToken"
] as const);

const REASONS = new Set<PartySessionCheckpointReason>([
  "active-periodic",
  "host-paused",
  "host-control",
  "rescue",
  "safety",
  "audio-recovery",
  "output-change",
  "source-stopped"
]);
const ENERGY_PROFILES = new Set<PartyEnergyProfile>(["steady", "build", "journey"]);
const TOMBSTONE_STATUSES = new Set(["claimed", "cleared", "invalidated"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
};

const safeInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;

const validOpaqueId = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);

const validRuntimeToken = (value: unknown) => typeof value === "string" && UUID.test(value);

const validTrackIds = (value: unknown): value is string[] => {
  if (!Array.isArray(value) || value.length > PARTY_SESSION_CHECKPOINT_MAX_TRACKS) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || !validOpaqueId(value[index])) return false;
  }
  return new Set(value).size === value.length;
};

const freezeAvailable = (record: PartySessionCheckpointAvailable): PartySessionCheckpointAvailable =>
  Object.freeze({
    ...record,
    playedTrackIds: Object.freeze([...record.playedTrackIds]),
    remainingTrackIds: Object.freeze([...record.remainingTrackIds])
  });

export const normalizePartySessionCheckpointRecord = (
  value: unknown
): PartySessionCheckpointRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.key !== PARTY_SESSION_CHECKPOINT_KEY ||
      record.schemaVersion !== PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION ||
      !safeInteger(record.revision, 1, Number.MAX_SAFE_INTEGER - 1)) return null;

  if (TOMBSTONE_STATUSES.has(String(record.recordStatus))) {
    if (!exactKeys(record, TOMBSTONE_KEYS)) return null;
    if (record.sessionId !== null && !validRuntimeToken(record.sessionId)) return null;
    if (record.writerToken !== null && !validRuntimeToken(record.writerToken)) return null;
    return Object.freeze({
      key: PARTY_SESSION_CHECKPOINT_KEY,
      schemaVersion: PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION,
      recordStatus: record.recordStatus as PartySessionCheckpointTombstone["recordStatus"],
      revision: Number(record.revision),
      sessionId: record.sessionId as string | null,
      writerToken: record.writerToken as string | null
    });
  }

  if (record.recordStatus !== "available" || !exactKeys(record, AVAILABLE_KEYS)) return null;
  if (!validRuntimeToken(record.sessionId) || !validRuntimeToken(record.writerToken)) return null;
  if (!safeInteger(record.libraryEpoch) || !safeInteger(record.libraryRevision)) return null;
  if (record.restoreMode !== "paused-plan" || !REASONS.has(record.checkpointReason as PartySessionCheckpointReason)) return null;
  if (!PARTY_SESSION_DURATION_SECONDS.includes(record.plannedDurationSeconds as never)) return null;
  if (!safeInteger(record.accumulatedActiveSeconds, 0, PARTY_SESSION_CHECKPOINT_MAX_ACTIVE_SECONDS)) return null;
  if (!ENERGY_PROFILES.has(record.energyProfile as PartyEnergyProfile)) return null;
  if (!safeInteger(record.energyShiftSteps, -3, 3)) return null;
  if (typeof record.includeRestOfLibrary !== "boolean") return null;
  if (!validTrackIds(record.playedTrackIds) || !validTrackIds(record.remainingTrackIds)) return null;
  if (!validOpaqueId(record.lastStableSourceTrackId)) return null;

  const played = new Set(record.playedTrackIds);
  if (!played.has(String(record.lastStableSourceTrackId))) return null;
  if (record.remainingTrackIds.some((id) => played.has(id))) return null;

  return freezeAvailable({
    key: PARTY_SESSION_CHECKPOINT_KEY,
    schemaVersion: PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION,
    recordStatus: "available",
    revision: Number(record.revision),
    sessionId: String(record.sessionId),
    writerToken: String(record.writerToken),
    libraryEpoch: Number(record.libraryEpoch),
    libraryRevision: Number(record.libraryRevision),
    restoreMode: "paused-plan",
    checkpointReason: record.checkpointReason as PartySessionCheckpointReason,
    plannedDurationSeconds: Number(record.plannedDurationSeconds),
    accumulatedActiveSeconds: Number(record.accumulatedActiveSeconds),
    energyProfile: record.energyProfile as PartyEnergyProfile,
    energyShiftSteps: Number(record.energyShiftSteps),
    includeRestOfLibrary: record.includeRestOfLibrary,
    playedTrackIds: record.playedTrackIds,
    remainingTrackIds: record.remainingTrackIds,
    lastStableSourceTrackId: String(record.lastStableSourceTrackId)
  });
};

export const createPartySessionCheckpoint = (
  draft: PartySessionCheckpointDraft,
  revision: number
): PartySessionCheckpointAvailable => {
  const normalized = normalizePartySessionCheckpointRecord({
    key: PARTY_SESSION_CHECKPOINT_KEY,
    schemaVersion: PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION,
    recordStatus: "available",
    revision,
    restoreMode: "paused-plan",
    ...draft
  });
  if (!normalized || normalized.recordStatus !== "available") {
    throw new TypeError("Party session checkpoint input is invalid.");
  }
  return normalized;
};

export const projectPausedPartySessionCheckpoint = (
  input: PartySessionCheckpointProjectionInput
): PartySessionCheckpointDraft => {
  if (!Number.isFinite(input.elapsedActiveSeconds) || input.elapsedActiveSeconds < 0) {
    throw new TypeError("Party session checkpoint elapsed time is invalid.");
  }
  if (!Number.isFinite(input.energyShift)) {
    throw new TypeError("Party session checkpoint energy shift is invalid.");
  }
  const playedTrackIds = [...new Set([...input.playedTrackIds, input.lastStableSourceTrackId])];
  const played = new Set(playedTrackIds);
  const remainingTrackIds = [...new Set([
    ...(input.committedTargetTrackId ? [input.committedTargetTrackId] : []),
    ...input.queueTrackIds
  ])].filter((trackId) => !played.has(trackId));
  const draft = {
    sessionId: input.sessionId,
    writerToken: input.writerToken,
    libraryEpoch: input.libraryEpoch,
    libraryRevision: input.libraryRevision,
    checkpointReason: input.checkpointReason,
    plannedDurationSeconds: input.plannedDurationSeconds,
    accumulatedActiveSeconds: Math.min(
      PARTY_SESSION_CHECKPOINT_MAX_ACTIVE_SECONDS,
      Math.floor(input.elapsedActiveSeconds)
    ),
    energyProfile: input.energyProfile,
    energyShiftSteps: Math.round(input.energyShift * 10),
    includeRestOfLibrary: input.includeRestOfLibrary,
    playedTrackIds,
    remainingTrackIds,
    lastStableSourceTrackId: input.lastStableSourceTrackId
  } satisfies PartySessionCheckpointDraft;
  // Reuse the strict record validator so a projected value can never be broader
  // than a value accepted from storage.
  createPartySessionCheckpoint(draft, 1);
  return Object.freeze({
    ...draft,
    playedTrackIds: Object.freeze(playedTrackIds),
    remainingTrackIds: Object.freeze(remainingTrackIds)
  });
};

export const createPartySessionCheckpointTombstone = (
  recordStatus: PartySessionCheckpointTombstone["recordStatus"],
  revision: number,
  sessionId: string | null,
  writerToken: string | null
): PartySessionCheckpointTombstone => {
  const normalized = normalizePartySessionCheckpointRecord({
    key: PARTY_SESSION_CHECKPOINT_KEY,
    schemaVersion: PARTY_SESSION_CHECKPOINT_SCHEMA_VERSION,
    recordStatus,
    revision,
    sessionId,
    writerToken
  });
  if (!normalized || normalized.recordStatus === "available") {
    throw new TypeError("Party session checkpoint tombstone is invalid.");
  }
  return normalized;
};

export type PartySessionCheckpointReconciliation = Readonly<{
  status: "available" | "stale-library" | "missing-track" | "invalid" | "none";
  checkpoint: PartySessionCheckpointAvailable | null;
}>;

export const reconcilePartySessionCheckpoint = (
  rawRecord: unknown,
  libraryEpoch: number,
  libraryRevision: number,
  currentTrackIds: readonly string[]
): PartySessionCheckpointReconciliation => {
  const record = normalizePartySessionCheckpointRecord(rawRecord);
  if (!record) return Object.freeze({ status: rawRecord == null ? "none" : "invalid", checkpoint: null });
  if (record.recordStatus !== "available") return Object.freeze({ status: "none", checkpoint: null });
  if (!safeInteger(libraryEpoch) || !safeInteger(libraryRevision) ||
      record.libraryEpoch !== libraryEpoch || record.libraryRevision > libraryRevision) {
    return Object.freeze({ status: "stale-library", checkpoint: null });
  }
  const availableIds = new Set(currentTrackIds);
  const references = [
    record.lastStableSourceTrackId,
    ...record.playedTrackIds,
    ...record.remainingTrackIds
  ];
  if (references.some((id) => !availableIds.has(id))) {
    return Object.freeze({ status: "missing-track", checkpoint: null });
  }
  return Object.freeze({ status: "available", checkpoint: record });
};

export const partySessionCheckpointFingerprint = (
  checkpoint: PartySessionCheckpointAvailable
) => JSON.stringify({
  sessionId: checkpoint.sessionId,
  writerToken: checkpoint.writerToken,
  libraryEpoch: checkpoint.libraryEpoch,
  libraryRevision: checkpoint.libraryRevision,
  checkpointReason: checkpoint.checkpointReason,
  plannedDurationSeconds: checkpoint.plannedDurationSeconds,
  accumulatedActiveSeconds: checkpoint.accumulatedActiveSeconds,
  energyProfile: checkpoint.energyProfile,
  energyShiftSteps: checkpoint.energyShiftSteps,
  includeRestOfLibrary: checkpoint.includeRestOfLibrary,
  playedTrackIds: checkpoint.playedTrackIds,
  remainingTrackIds: checkpoint.remainingTrackIds,
  lastStableSourceTrackId: checkpoint.lastStableSourceTrackId
});

const partySessionCheckpointTransferPayloadFingerprint = (
  checkpoint: PartySessionCheckpointAvailable
) => JSON.stringify({
  sessionId: checkpoint.sessionId,
  libraryEpoch: checkpoint.libraryEpoch,
  libraryRevision: checkpoint.libraryRevision,
  restoreMode: checkpoint.restoreMode,
  checkpointReason: checkpoint.checkpointReason,
  plannedDurationSeconds: checkpoint.plannedDurationSeconds,
  accumulatedActiveSeconds: checkpoint.accumulatedActiveSeconds,
  energyProfile: checkpoint.energyProfile,
  energyShiftSteps: checkpoint.energyShiftSteps,
  includeRestOfLibrary: checkpoint.includeRestOfLibrary,
  playedTrackIds: checkpoint.playedTrackIds,
  remainingTrackIds: checkpoint.remainingTrackIds,
  lastStableSourceTrackId: checkpoint.lastStableSourceTrackId
});

export const transferPartySessionCheckpointOwnership = (
  checkpoint: PartySessionCheckpointAvailable,
  nextWriterToken: string
): PartySessionCheckpointAvailable => {
  const normalized = normalizePartySessionCheckpointRecord(checkpoint);
  if (!normalized || normalized.recordStatus !== "available" ||
      normalized.revision >= Number.MAX_SAFE_INTEGER ||
      nextWriterToken === normalized.writerToken) {
    throw new TypeError("Party session checkpoint ownership transfer is invalid.");
  }
  return createPartySessionCheckpoint({
    sessionId: normalized.sessionId,
    writerToken: nextWriterToken,
    libraryEpoch: normalized.libraryEpoch,
    libraryRevision: normalized.libraryRevision,
    checkpointReason: normalized.checkpointReason,
    plannedDurationSeconds: normalized.plannedDurationSeconds,
    accumulatedActiveSeconds: normalized.accumulatedActiveSeconds,
    energyProfile: normalized.energyProfile,
    energyShiftSteps: normalized.energyShiftSteps,
    includeRestOfLibrary: normalized.includeRestOfLibrary,
    playedTrackIds: normalized.playedTrackIds,
    remainingTrackIds: normalized.remainingTrackIds,
    lastStableSourceTrackId: normalized.lastStableSourceTrackId
  }, normalized.revision + 1);
};

export const isPartySessionCheckpointOwnershipTransfer = ({
  previous,
  next,
  nextWriterToken
}: {
  previous: PartySessionCheckpointAvailable;
  next: unknown;
  nextWriterToken: string;
}) => {
  const normalizedPrevious = normalizePartySessionCheckpointRecord(previous);
  const normalizedNext = normalizePartySessionCheckpointRecord(next);
  return Boolean(normalizedPrevious?.recordStatus === "available" &&
    normalizedNext?.recordStatus === "available" &&
    normalizedNext.revision === normalizedPrevious.revision + 1 &&
    normalizedNext.writerToken === nextWriterToken &&
    normalizedNext.writerToken !== normalizedPrevious.writerToken &&
    partySessionCheckpointTransferPayloadFingerprint(normalizedNext) ===
      partySessionCheckpointTransferPayloadFingerprint(normalizedPrevious));
};

export const projectRestoredPausedPartyState = (
  checkpoint: PartySessionCheckpointAvailable
) => {
  const normalized = normalizePartySessionCheckpointRecord(checkpoint);
  if (!normalized || normalized.recordStatus !== "available") {
    throw new TypeError("Restored paused party state is invalid.");
  }
  return Object.freeze({
    plannedDurationSeconds: normalized.plannedDurationSeconds,
    accumulatedActiveSeconds: normalized.accumulatedActiveSeconds,
    energyProfile: normalized.energyProfile,
    energyShift: normalized.energyShiftSteps / 10,
    includeRestOfLibrary: normalized.includeRestOfLibrary,
    playedTrackIds: Object.freeze([...normalized.playedTrackIds]),
    remainingTrackIds: Object.freeze([...normalized.remainingTrackIds]),
    lastStableSourceTrackId: normalized.lastStableSourceTrackId
  });
};

export const resolvePartySessionCheckpointDiscardTarget = ({
  recoveryCheckpoint,
  storedCheckpoint,
  localSessionId,
  localWriterToken,
  writerLost,
  runtimeMode,
  unownedFallbackRevision
}: {
  recoveryCheckpoint: unknown;
  storedCheckpoint: unknown;
  localSessionId: string | null;
  localWriterToken: string;
  writerLost: boolean;
  runtimeMode: string;
  unownedFallbackRevision: number;
}) => {
  if (writerLost || runtimeMode !== "running") return null;
  if (localSessionId) {
    const stored = normalizePartySessionCheckpointRecord(storedCheckpoint);
    if (!stored || !["available", "claimed"].includes(stored.recordStatus) ||
        stored.sessionId !== localSessionId || stored.writerToken !== localWriterToken) return null;
    return Object.freeze({
      revision: stored.revision,
      sessionId: stored.sessionId,
      writerToken: stored.writerToken
    });
  }
  const recovery = normalizePartySessionCheckpointRecord(recoveryCheckpoint);
  const stored = normalizePartySessionCheckpointRecord(storedCheckpoint);
  const exact = recovery?.recordStatus === "available"
    ? recovery
    : stored?.recordStatus === "available" ? stored : null;
  if (exact) return Object.freeze({
    revision: exact.revision,
    sessionId: exact.sessionId,
    writerToken: exact.writerToken
  });
  if (!Number.isSafeInteger(unownedFallbackRevision) || unownedFallbackRevision < 0) return null;
  return Object.freeze({
    revision: unownedFallbackRevision,
    sessionId: null,
    writerToken: null
  });
};

export const refreshOwnedPartySessionCheckpointDiscardTarget = ({
  capturedTarget,
  storedCheckpoint,
  localSessionId,
  localWriterToken
}: {
  capturedTarget: Readonly<{ revision: number; sessionId: string | null; writerToken: string | null }>;
  storedCheckpoint: unknown;
  localSessionId: string;
  localWriterToken: string;
}) => {
  if (!capturedTarget || capturedTarget.sessionId !== localSessionId ||
      capturedTarget.writerToken !== localWriterToken ||
      !Number.isSafeInteger(capturedTarget.revision) || capturedTarget.revision < 0) return null;
  const stored = normalizePartySessionCheckpointRecord(storedCheckpoint);
  if (!stored || !["available", "claimed"].includes(stored.recordStatus) ||
      stored.sessionId !== localSessionId || stored.writerToken !== localWriterToken ||
      stored.revision < capturedTarget.revision) return null;
  return Object.freeze({
    revision: stored.revision,
    sessionId: stored.sessionId,
    writerToken: stored.writerToken
  });
};
