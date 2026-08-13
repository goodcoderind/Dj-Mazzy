export const KEY_LOCK_CAPABILITY_SCHEMA_VERSION = "key-lock-capability/v1" as const;
export const SIGNALSMITH_KEY_LOCK_PROCESSOR = "signalsmith-stretch-web/1.3.2" as const;

export type KeyLockCapability = Readonly<{
  schemaVersion: typeof KEY_LOCK_CAPABILITY_SCHEMA_VERSION;
  processor: typeof SIGNALSMITH_KEY_LOCK_PROCESSOR;
  status: "benchmark-approved";
  minimumRate: number;
  maximumRate: number;
  sampleRate: 44_100 | 48_000;
  acceptanceContract: "key-lock-device-acceptance/v1";
  contextSampleRate: 44_100 | 48_000;
  sourceLoadKey: string;
  targetLoadKey: string;
  sourceBackend: typeof SIGNALSMITH_KEY_LOCK_PROCESSOR;
  targetBackend: typeof SIGNALSMITH_KEY_LOCK_PROCESSOR;
}>;

export const keyLockCapabilityCovers = (
  capability: KeyLockCapability | null | undefined,
  rates: readonly number[],
  runtime?: Readonly<{
    contextSampleRate: number;
    sourceLoadKey: string;
    targetLoadKey: string;
    sourceBackend: string;
    targetBackend: string;
  }>
) => Boolean(
  rates.length > 0 &&
  capability?.schemaVersion === KEY_LOCK_CAPABILITY_SCHEMA_VERSION &&
  capability.processor === SIGNALSMITH_KEY_LOCK_PROCESSOR &&
  capability.status === "benchmark-approved" &&
  capability.acceptanceContract === "key-lock-device-acceptance/v1" &&
  capability.contextSampleRate === capability.sampleRate &&
  typeof capability.sourceLoadKey === "string" && capability.sourceLoadKey.length > 0 &&
  typeof capability.targetLoadKey === "string" && capability.targetLoadKey.length > 0 &&
  capability.sourceBackend === SIGNALSMITH_KEY_LOCK_PROCESSOR &&
  capability.targetBackend === SIGNALSMITH_KEY_LOCK_PROCESSOR &&
  (capability.sampleRate === 44_100 || capability.sampleRate === 48_000) &&
  capability.minimumRate === 0.94 &&
  capability.maximumRate === 1.06 &&
  runtime !== undefined &&
  runtime.contextSampleRate === capability.contextSampleRate &&
  runtime.sourceLoadKey === capability.sourceLoadKey &&
  runtime.targetLoadKey === capability.targetLoadKey &&
  runtime.sourceBackend === capability.sourceBackend &&
  runtime.targetBackend === capability.targetBackend &&
  rates.every((rate) => Number.isFinite(rate) && rate >= capability.minimumRate && rate <= capability.maximumRate)
);
