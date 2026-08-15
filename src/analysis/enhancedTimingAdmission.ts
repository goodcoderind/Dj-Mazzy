export type EnhancedTimingAdmission = Readonly<{
  allowed: boolean;
  generation: number;
}>;

export const createEnhancedTimingAdmission = (): EnhancedTimingAdmission =>
  Object.freeze({ allowed: false, generation: 0 });

export const advanceEnhancedTimingAdmission = (
  current: EnhancedTimingAdmission,
  allowed: boolean
): EnhancedTimingAdmission => Object.freeze({
  allowed: allowed === true,
  generation: Number.isSafeInteger(current?.generation) && current.generation >= 0
    ? current.generation + 1
    : 1
});

export const ownsEnhancedTimingAdmission = (
  current: EnhancedTimingAdmission | null | undefined,
  expected: EnhancedTimingAdmission | null | undefined
) => Boolean(current?.allowed && expected?.allowed &&
  Number.isSafeInteger(current.generation) &&
  current.generation === expected.generation);

export const mayPublishEnhancedTimingAssetState = ({
  currentGeneration,
  expectedGeneration,
  removalGated
}: {
  currentGeneration: number;
  expectedGeneration: number;
  removalGated: boolean;
}) => removalGated === false &&
  Number.isSafeInteger(currentGeneration) &&
  currentGeneration === expectedGeneration;

export const enhancedTimingRemovalStatusAfterPrepare = <T extends { state: string } | null>(
  current: T
) => current?.state === "removed" ? null : current;

export const projectEnhancedTimingRemovalWork = <
  TJob extends { id: string; kind: string },
  TDeferred extends { kind: string }
>({
  pending,
  queuedKeys,
  deferred
}: {
  pending: TJob[];
  queuedKeys: Iterable<string>;
  deferred: Iterable<[string, TDeferred]>;
}) => {
  const removedTrackIds = new Set(
    pending.filter((job) => job.kind === "enhanced").map((job) => job.id)
  );
  return Object.freeze({
    pending: pending.filter((job) => job.kind !== "enhanced"),
    queuedKeys: new Set([...queuedKeys].filter((key) => !key.startsWith("enhanced:"))),
    deferred: new Map([...deferred].filter(([, value]) => value.kind !== "enhanced")),
    removedTrackIds
  });
};

export const planEnhancedTimingRemovalGate = <
  TJob extends { id: string; kind: string },
  TDeferred extends { kind: string }
>({
  admission,
  activeKind,
  pending,
  queuedKeys,
  deferred
}: {
  admission: EnhancedTimingAdmission;
  activeKind: string | null;
  pending: TJob[];
  queuedKeys: Iterable<string>;
  deferred: Iterable<[string, TDeferred]>;
}) => Object.freeze({
  admission: advanceEnhancedTimingAdmission(admission, false),
  cancelActiveEnhanced: activeKind === "enhanced",
  work: projectEnhancedTimingRemovalWork({ pending, queuedKeys, deferred })
});
