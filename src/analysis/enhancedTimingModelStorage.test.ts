import { describe, expect, it, vi } from "vitest";
import {
  ENHANCED_TIMING_MODEL_CACHE,
  createEnhancedTimingModelStorage
} from "./enhancedTimingModelStorage";

const createCaches = () => {
  const entries = new Map<string, Map<string, Response>>();
  const cacheStorage = {
    open: vi.fn(async (name: string) => {
      if (!entries.has(name)) entries.set(name, new Map());
      const cache = entries.get(name)!;
      return {
        match: async (key: string) => cache.get(key)?.clone(),
        put: async (key: string, value: Response) => { cache.set(key, value.clone()); },
        delete: async (key: string) => cache.delete(key),
        keys: async () => [...cache.keys()]
      };
    }),
    delete: vi.fn(async (name: string) => entries.delete(name)),
    has: vi.fn(async (name: string) => entries.has(name))
  };
  return { entries, cacheStorage };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
};

const createSerialLocks = () => {
  let tail = Promise.resolve();
  return {
    request<T>(_name: string, _options: unknown, task: () => Promise<T>) {
      const result = tail.then(task, task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
};

describe("enhanced timing model storage", () => {
  it("refuses preparation before mutating control storage when the origin lock is unavailable", async () => {
    const { entries, cacheStorage } = createCaches();
    const storage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks: null,
      origin: "https://mazzy.invalid"
    });

    expect(storage.supportsExclusiveLock()).toBe(false);
    await expect(storage.allowAfterHostAction()).rejects.toThrow("coordination is unavailable");
    expect(entries.size).toBe(0);
  });

  it("revokes before deletion and refuses every later cache write", async () => {
    const { entries, cacheStorage } = createCaches();
    const locks = { request: vi.fn(async (_name, _options, task) => task()) };
    const storage = createEnhancedTimingModelStorage({ cacheStorage, locks, origin: "https://mazzy.invalid" });
    const firstEpoch = await storage.currentAllowedAuthority();
    await storage.put("https://mazzy.invalid/model", new Response("model"), firstEpoch);
    await expect(storage.revokeAndRemove()).resolves.toBe(true);
    expect(entries.has(ENHANCED_TIMING_MODEL_CACHE)).toBe(false);
    await expect(storage.put("https://mazzy.invalid/model", new Response("late"))).rejects.toThrow("disabled");
    await expect(storage.deleteAsset("https://mazzy.invalid/model")).rejects.toThrow("disabled");
    expect(entries.has(ENHANCED_TIMING_MODEL_CACHE)).toBe(false);
  });

  it("waits for an active foreign writer, then deletes it and blocks queued resurrection", async () => {
    const { entries, cacheStorage } = createCaches();
    const locks = createSerialLocks();
    const storage = createEnhancedTimingModelStorage({ cacheStorage, locks, origin: "https://mazzy.invalid" });
    const putEntered = deferred<void>();
    const releasePut = deferred<void>();
    const originalOpen = cacheStorage.open;
    cacheStorage.open = vi.fn(async (name: string) => {
      const cache = await originalOpen(name);
      if (name !== ENHANCED_TIMING_MODEL_CACHE) return cache;
      return {
        ...cache,
        put: async (key: string, value: Response) => {
          putEntered.resolve();
          await releasePut.promise;
          await cache.put(key, value);
        }
      };
    });

    const staleEpoch = await storage.currentAllowedAuthority();
    const staleWriter = storage.put("https://mazzy.invalid/model", new Response("stale"), staleEpoch);
    await putEntered.promise;
    const removal = storage.revokeAndRemove();
    let removalSettled = false;
    void removal.finally(() => { removalSettled = true; });
    await Promise.resolve();
    expect(removalSettled).toBe(false);

    releasePut.resolve();
    await staleWriter;
    await expect(removal).resolves.toBe(true);
    expect(entries.has(ENHANCED_TIMING_MODEL_CACHE)).toBe(false);
    await expect(storage.put("https://mazzy.invalid/model", new Response("resurrect"))).rejects.toThrow("disabled");
    expect(entries.has(ENHANCED_TIMING_MODEL_CACHE)).toBe(false);
  });

  it("holds final result publication behind the same revocation lock", async () => {
    const { cacheStorage } = createCaches();
    const locks = createSerialLocks();
    const storage = createEnhancedTimingModelStorage({ cacheStorage, locks, origin: "https://mazzy.invalid" });
    const publish = vi.fn(async () => undefined);
    const oldAuthority = await storage.currentAllowedAuthority();

    await expect(storage.revokeAndRemove()).resolves.toBe(true);
    await expect(storage.runIfAllowed(oldAuthority, publish)).rejects.toThrow("disabled");
    expect(publish).not.toHaveBeenCalled();
  });

  it("requires an explicit host action before a successor writer can run", async () => {
    const { cacheStorage } = createCaches();
    const locks = { request: vi.fn(async (_name, _options, task) => task()) };
    const storage = createEnhancedTimingModelStorage({ cacheStorage, locks, origin: "https://mazzy.invalid" });
    await storage.revokeAndRemove();
    await expect(storage.match("https://mazzy.invalid/model")).rejects.toThrow("disabled");
    const successorEpoch = await storage.allowAfterHostAction();
    await storage.put("https://mazzy.invalid/model", new Response("new model"), successorEpoch);
    await expect(storage.match("https://mazzy.invalid/model", successorEpoch)).resolves.toBeInstanceOf(Response);
  });

  it("restores revocation when preparation loses authority during the control write", async () => {
    const { cacheStorage } = createCaches();
    const locks = createSerialLocks();
    let owned = true;
    let controlPuts = 0;
    const originalOpen = cacheStorage.open;
    cacheStorage.open = vi.fn(async (name: string) => {
      const cache = await originalOpen(name);
      if (name !== "mazzy-timing-model-control-v1") return cache;
      return {
        ...cache,
        put: async (key: string, value: Response) => {
          controlPuts += 1;
          await cache.put(key, value);
          if (controlPuts === 2) owned = false;
        }
      };
    });
    const storage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks,
      origin: "https://mazzy.invalid",
      createToken: (() => {
        let token = 0;
        return () => `authority-token-${String(++token).padStart(6, "0")}`;
      })()
    });

    await expect(storage.allowAfterHostAction(undefined, () => owned)).rejects.toThrow("cancelled");
    await expect(storage.controlObservation()).resolves.toMatchObject({ revoked: true });
  });

  it("persists verification only for the exact completed preparation authority", async () => {
    const { cacheStorage } = createCaches();
    const storage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks: createSerialLocks(),
      origin: "https://mazzy.invalid"
    });
    const first = await storage.allowAfterHostAction();
    await expect(storage.preparationVerified(first)).resolves.toBe(false);
    await expect(storage.markPreparationVerified(first)).resolves.toBe(true);
    await expect(storage.preparationVerified(first)).resolves.toBe(true);

    const successor = await storage.allowAfterHostAction();
    await expect(storage.preparationVerified(successor)).resolves.toBe(false);
    await expect(storage.markPreparationVerified(first)).rejects.toThrow("disabled");
  });

  it("removes a proof whose owner is cancelled during proof persistence", async () => {
    const { cacheStorage } = createCaches();
    const storage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks: createSerialLocks(),
      origin: "https://mazzy.invalid"
    });
    const authority = await storage.allowAfterHostAction();
    let owned = true;
    const originalOpen = cacheStorage.open;
    cacheStorage.open = vi.fn(async (name: string) => {
      const cache = await originalOpen(name);
      if (name !== "mazzy-timing-model-control-v1") return cache;
      return {
        ...cache,
        put: async (key: string, value: Response) => {
          await cache.put(key, value);
          if (key.includes("preparation-proof")) owned = false;
        }
      };
    });

    await expect(storage.markPreparationVerified(authority, () => owned)).rejects.toThrow("cancelled");
    await expect(storage.preparationVerified(authority)).resolves.toBe(false);
  });

  it("distinguishes an unconfirmed proof delete from harmless successor ownership", async () => {
    const { cacheStorage } = createCaches();
    const storage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks: createSerialLocks(),
      origin: "https://mazzy.invalid"
    });
    const first = await storage.allowAfterHostAction();
    await storage.markPreparationVerified(first);
    const originalOpen = cacheStorage.open;
    cacheStorage.open = vi.fn(async (name: string) => {
      const cache = await originalOpen(name);
      if (name !== "mazzy-timing-model-control-v1") return cache;
      return {
        ...cache,
        delete: async (key: string) => {
          if (key.includes("preparation-proof")) throw new Error("private cache failure");
          return cache.delete(key);
        }
      };
    });
    await expect(storage.invalidatePreparationProof(first)).resolves.toEqual({
      outcome: "unconfirmed"
    });
    await expect(storage.preparationVerified(first)).resolves.toBe(true);

    cacheStorage.open = originalOpen;
    const successor = await storage.allowAfterHostAction();
    await expect(storage.invalidatePreparationProof(first)).resolves.toEqual({
      outcome: "superseded"
    });
    await expect(storage.preparationVerified(successor)).resolves.toBe(false);
  });

  it("rejects an old writer and result after removal plus a successor host action", async () => {
    const { cacheStorage } = createCaches();
    const locks = createSerialLocks();
    const storage = createEnhancedTimingModelStorage({ cacheStorage, locks, origin: "https://mazzy.invalid" });
    const oldEpoch = await storage.allowAfterHostAction();
    await storage.put("https://mazzy.invalid/model", new Response("old"), oldEpoch);
    await expect(storage.revokeAndRemove()).resolves.toBe(true);
    const successorEpoch = await storage.allowAfterHostAction();
    expect(successorEpoch.epoch).toBeGreaterThan(oldEpoch.epoch);
    expect(successorEpoch.token).not.toBe(oldEpoch.token);
    await expect(storage.put("https://mazzy.invalid/old", new Response("late"), oldEpoch)).rejects.toThrow("disabled");
    const publishOld = vi.fn(async () => undefined);
    await expect(storage.runIfAllowed(oldEpoch, publishOld)).rejects.toThrow("disabled");
    expect(publishOld).not.toHaveBeenCalled();
    await expect(storage.put("https://mazzy.invalid/new", new Response("new"), successorEpoch)).resolves.toBeUndefined();
  });

  it("never reauthorizes an old epoch after control eviction or malformed replacement", async () => {
    const { entries, cacheStorage } = createCaches();
    const locks = createSerialLocks();
    let token = 0;
    const createToken = () => `authority-token-${String(++token).padStart(6, "0")}`;
    const storage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks,
      origin: "https://mazzy.invalid",
      createToken
    });
    const oldAuthority = await storage.allowAfterHostAction();
    await storage.revokeAndRemove();
    await cacheStorage.delete("mazzy-timing-model-control-v1");
    const afterEviction = await storage.allowAfterHostAction();
    expect(afterEviction.epoch).toBe(oldAuthority.epoch);
    expect(afterEviction.token).not.toBe(oldAuthority.token);
    await expect(storage.put("https://mazzy.invalid/late-evicted", new Response("late"), oldAuthority))
      .rejects.toThrow("disabled");

    await storage.revokeAndRemove();
    const control = entries.get("mazzy-timing-model-control-v1")!;
    control.set("https://mazzy.invalid/.mazzy/enhanced-timing-model-revoked-v1", new Response("malformed"));
    const afterMalformed = await storage.allowAfterHostAction();
    expect(afterMalformed.token).not.toBe(afterEviction.token);
    await expect(storage.runIfAllowed(afterEviction, async () => undefined)).rejects.toThrow("disabled");
  });

  it("never claims origin-wide removal without Web Lock support", async () => {
    const { cacheStorage } = createCaches();
    const storage = createEnhancedTimingModelStorage({ cacheStorage, locks: null, origin: "https://mazzy.invalid" });
    await expect(storage.revokeAndRemove()).resolves.toBe(false);
    await expect(storage.put("https://mazzy.invalid/model", new Response("late"))).rejects.toThrow("disabled");
  });

  it("never writes or trusts a durable preparation proof without Web Lock support", async () => {
    const { cacheStorage } = createCaches();
    const coordinatedStorage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks: createSerialLocks(),
      origin: "https://mazzy.invalid"
    });
    const authority = await coordinatedStorage.allowAfterHostAction();
    const storage = createEnhancedTimingModelStorage({
      cacheStorage,
      locks: null,
      origin: "https://mazzy.invalid"
    });
    await expect(storage.allowAfterHostAction()).rejects.toThrow("coordination is unavailable");
    await expect(storage.markPreparationVerified(authority)).rejects.toThrow("unavailable");
    await expect(storage.preparationVerified(authority)).resolves.toBe(false);
    await expect(storage.invalidatePreparationProof(authority)).resolves.toEqual({
      outcome: "unconfirmed"
    });
  });
});
