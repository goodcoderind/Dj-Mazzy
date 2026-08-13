import {
  BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "./domain/versions";

const DB_NAME = "mazzy-library";
const DB_VERSION = 5;
const STORE_NAME = "tracks";
let mutationQueue = Promise.resolve();
const serializeMutation = (operation) => {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => undefined);
  return result;
};

const openDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      } else if (event.oldVersion < 5) {
        const store = request.transaction.objectStore(STORE_NAME);
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          cursor.update({
            ...cursor.value,
            schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
            analyzerVersion: cursor.value.analyzerVersion ?? null,
            analysisStatus: "stale",
            downbeatsSeconds: cursor.value.downbeatsSeconds ?? [],
            meter: cursor.value.meter ?? null,
            downbeatConfidence: cursor.value.downbeatConfidence ?? 0,
            energyByBeat: cursor.value.energyByBeat ?? [],
            bandEnergyByBeat: cursor.value.bandEnergyByBeat ?? [],
            vocalProbabilityByBeat: cursor.value.vocalProbabilityByBeat ?? [],
            structureBoundaries: cursor.value.structureBoundaries ?? [],
            phraseCandidates: cursor.value.phraseCandidates ?? [],
            analysisOverrides: {
              ...(cursor.value.analysisOverrides ?? {}),
              schemaVersion: BEAT_GRID_OVERRIDE_SCHEMA_VERSION
            }
          });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

export const saveTracksToDb = async (tracks) => serializeMutation(async () => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    tracks.forEach((track) => store.put(track));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
});

export const saveTrackToDb = async (track) => serializeMutation(async () => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(track);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
});

export const deleteTrackFromDb = async (trackId) => serializeMutation(async () => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(trackId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
});

export const clearTracksFromDb = async () => serializeMutation(async () => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
});
