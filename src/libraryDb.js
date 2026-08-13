import {
  BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "./domain/versions";

const DB_NAME = "mazzy-library";
const DB_VERSION = 7;
const STORE_NAME = "tracks";
const META_STORE_NAME = "meta";
const CONTENT_IDENTITY_INDEX = "contentIdentity";
const LIBRARY_EPOCH_KEY = "libraryEpoch";
const LIBRARY_MUTATION_CHANNEL = "mazzy-library-mutations/v1";
let mutationQueue = Promise.resolve();
const serializeMutation = (operation) => {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => undefined);
  return result;
};

export const waitForTransaction = (tx) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    callback(value);
  };
  const fail = () => finish(reject, tx.error ?? new Error("IndexedDB transaction failed"));
  tx.oncomplete = () => finish(resolve);
  tx.onerror = fail;
  tx.onabort = fail;
});

const openDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex(CONTENT_IDENTITY_INDEX, CONTENT_IDENTITY_INDEX, { unique: true });
      } else {
        const store = request.transaction.objectStore(STORE_NAME);
        const needsAnalysisUpgrade = event.oldVersion < 5;
        const needsContentIdentityIndex = event.oldVersion < 6 && !store.indexNames.contains(CONTENT_IDENTITY_INDEX);
        if (needsAnalysisUpgrade || needsContentIdentityIndex) {
          const seenContentIdentities = new Set();
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              if (needsContentIdentityIndex) {
                store.createIndex(CONTENT_IDENTITY_INDEX, CONTENT_IDENTITY_INDEX, { unique: true });
              }
              return;
            }
            let next = cursor.value;
            if (needsAnalysisUpgrade) {
              next = {
                ...next,
                schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
                analyzerVersion: next.analyzerVersion ?? null,
                analysisStatus: "stale",
                downbeatsSeconds: next.downbeatsSeconds ?? [],
                meter: next.meter ?? null,
                downbeatConfidence: next.downbeatConfidence ?? 0,
                energyByBeat: next.energyByBeat ?? [],
                bandEnergyByBeat: next.bandEnergyByBeat ?? [],
                vocalProbabilityByBeat: next.vocalProbabilityByBeat ?? [],
                structureBoundaries: next.structureBoundaries ?? [],
                phraseCandidates: next.phraseCandidates ?? [],
                analysisOverrides: {
                  ...(next.analysisOverrides ?? {}),
                  schemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION
                }
              };
            }
            if (needsContentIdentityIndex && next.contentIdentity) {
              if (seenContentIdentities.has(next.contentIdentity)) {
                const { contentIdentity: _duplicateIdentity, ...withoutDuplicateIdentity } = next;
                next = withoutDuplicateIdentity;
              } else {
                seenContentIdentities.add(next.contentIdentity);
              }
            }
            cursor.update(next);
            cursor.continue();
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new DOMException("Another Mazzy tab is blocking the library upgrade", "BlockedError"));
  });

export const loadLibraryFromDb = async () => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

export const loadLibraryEpoch = async () => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readonly");
    const request = tx.objectStore(META_STORE_NAME).get(LIBRARY_EPOCH_KEY);
    request.onsuccess = () => resolve(Number(request.result?.value ?? 0));
    request.onerror = () => reject(request.error);
  });
};

export const subscribeToLibraryMutations = (listener) => {
  if (typeof BroadcastChannel !== "function") return () => undefined;
  const channel = new BroadcastChannel(LIBRARY_MUTATION_CHANNEL);
  channel.onmessage = (event) => listener(event.data);
  return () => channel.close();
};

const broadcastLibraryMutation = (message) => {
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel(LIBRARY_MUTATION_CHANNEL);
  channel.postMessage(message);
  channel.close();
};

const withCrossTabMutationLock = async (operation) => {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(LIBRARY_MUTATION_CHANNEL, { mode: "exclusive" }, operation);
  }
  return operation();
};

export const mergeRoutineTrackUpdate = (existing, incoming) => ({
  ...incoming,
  contentIdentity: existing.contentIdentity ?? incoming.contentIdentity ?? null,
  analysisOverrides: existing.analysisOverrides ?? incoming.analysisOverrides,
  timingReview: existing.timingReview ?? null
});

export const saveTracksToDb = async (tracks) => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  tracks.forEach((track) => {
    const request = store.get(track.id);
    request.onsuccess = () => {
      if (request.result) store.put(mergeRoutineTrackUpdate(request.result, track));
    };
  });
  return waitForTransaction(tx);
});

export const saveImportedTracksToDb = async (tracks, legacyIdentities = [], expectedEpoch = null) => withCrossTabMutationLock(() => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const metaStore = tx.objectStore(META_STORE_NAME);
  const completed = waitForTransaction(tx);
  const savedTrackIds = [];
  const duplicateContentIdentities = [];
  const identityIndex = store.index(CONTENT_IDENTITY_INDEX);
  const beginWrites = () => {
    tracks.forEach((track) => {
      if (!track.contentIdentity) {
        store.put(track);
        savedTrackIds.push(track.id);
        return;
      }
      const request = identityIndex.getKey(track.contentIdentity);
      request.onsuccess = () => {
        if (request.result == null) {
          store.put(track);
          savedTrackIds.push(track.id);
        } else {
          duplicateContentIdentities.push(track.contentIdentity);
        }
      };
    });
    legacyIdentities.forEach(({ id, contentIdentity }) => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) store.put({ ...request.result, contentIdentity });
      };
    });
  };
  if (expectedEpoch == null) {
    beginWrites();
  } else {
    const epochRequest = metaStore.get(LIBRARY_EPOCH_KEY);
    epochRequest.onsuccess = () => {
      if (Number(epochRequest.result?.value ?? 0) !== expectedEpoch) {
        tx.abort();
        return;
      }
      beginWrites();
    };
  }
  await completed;
  return { savedTrackIds, duplicateContentIdentities };
}));

export const saveTrackToDb = async (track) => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const request = store.get(track.id);
  request.onsuccess = () => {
    if (request.result) store.put(mergeRoutineTrackUpdate(request.result, track));
  };
  return waitForTransaction(tx);
});

export const patchTrackInDb = async (trackId, patch) => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const completed = waitForTransaction(tx);
  const request = store.get(trackId);
  request.onsuccess = () => {
    if (request.result) store.put({ ...request.result, ...patch, id: trackId });
  };
  await completed;
});

export const deleteTrackFromDb = async (trackId) => withCrossTabMutationLock(() => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).delete(trackId);
  await waitForTransaction(tx);
  broadcastLibraryMutation({ type: "track-deleted", trackId });
}));

export const clearTracksFromDb = async () => withCrossTabMutationLock(() => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
  tx.objectStore(STORE_NAME).clear();
  const metaStore = tx.objectStore(META_STORE_NAME);
  const epochRequest = metaStore.get(LIBRARY_EPOCH_KEY);
  epochRequest.onsuccess = () => metaStore.put({
    key: LIBRARY_EPOCH_KEY,
    value: Number(epochRequest.result?.value ?? 0) + 1
  });
  await waitForTransaction(tx);
  broadcastLibraryMutation({ type: "library-cleared" });
}));
