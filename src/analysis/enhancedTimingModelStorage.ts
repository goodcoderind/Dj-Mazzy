export const ENHANCED_TIMING_MODEL_CACHE = "mazzy-timing-model-v1";
export const ENHANCED_TIMING_MODEL_CONTROL_CACHE = "mazzy-timing-model-control-v1";
export const ENHANCED_TIMING_MODEL_STORAGE_LOCK = "mazzy-enhanced-timing-model-storage/v1";
export const ENHANCED_TIMING_MODEL_CONTROL_VERSION = "enhanced-timing-model-control/v1";

export type EnhancedTimingModelAuthority = Readonly<{
  epoch: number;
  token: string;
}>;

type CacheLike = {
  match: (request: string) => Promise<Response | undefined>;
  put: (request: string, response: Response) => Promise<void>;
  delete: (request: string) => Promise<boolean>;
  keys: () => Promise<readonly unknown[]>;
};

type CacheStorageLike = {
  open: (name: string) => Promise<CacheLike>;
  delete: (name: string) => Promise<boolean>;
  has: (name: string) => Promise<boolean>;
};

type LockManagerLike = {
  request: <T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>) => Promise<T>;
};

export const createEnhancedTimingModelStorage = ({
  cacheStorage,
  locks,
  origin,
  createToken = () => {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
        .map((value) => value.toString(16).padStart(2, "0")).join("");
    }
    throw new Error("Enhanced timing model control is unavailable");
  }
}: {
  cacheStorage: CacheStorageLike;
  locks?: LockManagerLike | null;
  origin: string;
  createToken?: () => string;
}) => {
  const markerUrl = `${origin}/.mazzy/enhanced-timing-model-revoked-v1`;
  const exclusively = <T>(task: () => Promise<T>) => locks
    ? locks.request(ENHANCED_TIMING_MODEL_STORAGE_LOCK, { mode: "exclusive" }, task)
    : task();
  const readControl = async () => {
    if (!(await cacheStorage.has(ENHANCED_TIMING_MODEL_CONTROL_CACHE))) return false;
    const control = await cacheStorage.open(ENHANCED_TIMING_MODEL_CONTROL_CACHE);
    const response = await control.match(markerUrl);
    if (!response) return false;
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid control");
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 4 ||
        record.version !== ENHANCED_TIMING_MODEL_CONTROL_VERSION ||
        !Number.isSafeInteger(record.epoch) || Number(record.epoch) < 0 ||
        typeof record.token !== "string" || !/^[A-Za-z0-9-]{16,128}$/.test(record.token) ||
        typeof record.revoked !== "boolean") throw new Error("invalid control");
      return Object.freeze({ epoch: Number(record.epoch), token: record.token, revoked: record.revoked });
    } catch {
      return Object.freeze({ malformed: true as const });
    }
  };
  const freshToken = () => {
    const token = createToken();
    if (!/^[A-Za-z0-9-]{16,128}$/.test(token)) {
      throw new Error("Enhanced timing model control is unavailable");
    }
    return token;
  };
  const currentControl = async () => {
    const stored = await readControl();
    if (stored && !("malformed" in stored)) return stored;
    const initial = Object.freeze({
      epoch: 0,
      token: freshToken(),
      revoked: Boolean(stored && "malformed" in stored)
    });
    await writeControl(initial);
    return initial;
  };
  const writeControl = async (state: { epoch: number; token: string; revoked: boolean }) => {
    const control = await cacheStorage.open(ENHANCED_TIMING_MODEL_CONTROL_CACHE);
    await control.put(markerUrl, new Response(JSON.stringify({
      version: ENHANCED_TIMING_MODEL_CONTROL_VERSION,
      epoch: state.epoch,
      token: state.token,
      revoked: state.revoked
    }), { headers: { "content-type": "application/json" } }));
  };
  const nextControl = async (revoked: boolean) => {
    const current = await currentControl();
    if (current.epoch >= Number.MAX_SAFE_INTEGER) throw new Error("Enhanced timing model control is unavailable");
    const token = freshToken();
    const next = Object.freeze({ epoch: current.epoch + 1, token, revoked });
    await writeControl(next);
    return next;
  };
  const assertAllowed = async (expected?: EnhancedTimingModelAuthority) => {
    const current = await currentControl();
    if (current.revoked || (expected &&
      (current.epoch !== expected.epoch || current.token !== expected.token))) {
      throw new Error("Enhanced timing model storage is disabled");
    }
    return Object.freeze({ epoch: current.epoch, token: current.token });
  };

  return Object.freeze({
    revoked: () => exclusively(async () => (await currentControl()).revoked),
    currentAllowedAuthority: () => exclusively(async () => assertAllowed()),
    controlObservation: () => exclusively(async () => {
      const current = await currentControl();
      return Object.freeze({
        authority: Object.freeze({ epoch: current.epoch, token: current.token }),
        revoked: current.revoked
      });
    }),
    allowAfterHostAction: () => exclusively(async () => {
      const next = await nextControl(false);
      return Object.freeze({ epoch: next.epoch, token: next.token });
    }),
    match: (url: string, expected?: EnhancedTimingModelAuthority) => exclusively(async () => {
      await assertAllowed(expected);
      const cache = await cacheStorage.open(ENHANCED_TIMING_MODEL_CACHE);
      return cache.match(url);
    }),
    hasAnyAssets: (expected?: EnhancedTimingModelAuthority) => exclusively(async () => {
      await assertAllowed(expected);
      if (!(await cacheStorage.has(ENHANCED_TIMING_MODEL_CACHE))) return false;
      const cache = await cacheStorage.open(ENHANCED_TIMING_MODEL_CACHE);
      return (await cache.keys()).length > 0;
    }),
    hasAnyAssetsForRemoval: () => exclusively(async () => {
      if (!(await cacheStorage.has(ENHANCED_TIMING_MODEL_CACHE))) return false;
      const cache = await cacheStorage.open(ENHANCED_TIMING_MODEL_CACHE);
      return (await cache.keys()).length > 0;
    }),
    runIfAllowed: <T>(expected: EnhancedTimingModelAuthority, task: () => Promise<T>) => exclusively(async () => {
      await assertAllowed(expected);
      return task();
    }),
    put: (url: string, response: Response, expected?: EnhancedTimingModelAuthority) => exclusively(async () => {
      await assertAllowed(expected);
      const cache = await cacheStorage.open(ENHANCED_TIMING_MODEL_CACHE);
      await cache.put(url, response);
    }),
    deleteAsset: (url: string, expected?: EnhancedTimingModelAuthority) => exclusively(async () => {
      await assertAllowed(expected);
      if (!(await cacheStorage.has(ENHANCED_TIMING_MODEL_CACHE))) return false;
      const cache = await cacheStorage.open(ENHANCED_TIMING_MODEL_CACHE);
      return cache.delete(url);
    }),
    revokeAndRemove: () => exclusively(async () => {
      await nextControl(true);
      await cacheStorage.delete(ENHANCED_TIMING_MODEL_CACHE);
      const absent = !(await cacheStorage.has(ENHANCED_TIMING_MODEL_CACHE));
      // Without a cross-context lock there is no proof that a foreign writer
      // cannot race immediately after the absence check.
      return Boolean(locks && absent);
    })
  });
};

const getProductionStorage = () =>
  createEnhancedTimingModelStorage({
    cacheStorage: caches,
    locks: typeof globalThis.navigator?.locks?.request === "function"
      ? globalThis.navigator.locks as unknown as LockManagerLike
      : null,
    origin: globalThis.location?.origin ?? "https://mazzy.invalid"
  });

export const enhancedTimingModelAssetsRevoked = () => getProductionStorage().revoked();
export const allowEnhancedTimingModelAssetsAfterHostAction = () => getProductionStorage().allowAfterHostAction();
export const currentEnhancedTimingModelAllowedAuthority = () => getProductionStorage().currentAllowedAuthority();
export const enhancedTimingModelControlObservation = () => getProductionStorage().controlObservation();
export const matchEnhancedTimingModelAsset = (url: string, expected?: EnhancedTimingModelAuthority) =>
  getProductionStorage().match(url, expected);
export const enhancedTimingModelCacheHasEntries = (expected?: EnhancedTimingModelAuthority) =>
  getProductionStorage().hasAnyAssets(expected);
export const enhancedTimingModelCacheHasEntriesForRemoval = () =>
  getProductionStorage().hasAnyAssetsForRemoval();
export const runIfEnhancedTimingModelAllowed = <T>(expected: EnhancedTimingModelAuthority, task: () => Promise<T>) =>
  getProductionStorage().runIfAllowed(expected, task);
export const putEnhancedTimingModelAsset = (url: string, response: Response, expected?: EnhancedTimingModelAuthority) =>
  getProductionStorage().put(url, response, expected);
export const deleteEnhancedTimingModelAsset = (url: string, expected?: EnhancedTimingModelAuthority) =>
  getProductionStorage().deleteAsset(url, expected);
export const revokeAndRemoveEnhancedTimingModelAssets = () => getProductionStorage().revokeAndRemove();
