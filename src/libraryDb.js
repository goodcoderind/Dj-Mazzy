import {
  BEAT_GRID_OVERRIDE_SCHEMA_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "./domain/versions";
import {
  PARTY_SESSION_CHECKPOINT_KEY,
  createPartySessionCheckpoint,
  createPartySessionCheckpointTombstone,
  normalizePartySessionCheckpointRecord
} from "./domain/partySessionCheckpoint";
import { normalizeContentIdentity } from "./storage/contentIdentity";

const DB_NAME = "mazzy-library";
export const LIBRARY_DATABASE_VERSION = 8;
const STORE_NAME = "tracks";
const META_STORE_NAME = "meta";
const PARTY_SESSION_STORE_NAME = "partySessions";
const CONTENT_IDENTITY_INDEX = "contentIdentity";
const LEGACY_LIBRARY_EPOCH_KEY = "libraryEpoch";
const LIBRARY_STATE_KEY = "libraryState";
const LIBRARY_STATE_SCHEMA_VERSION = "library-state/v1";
const LIBRARY_MUTATION_CHANNEL = "mazzy-library-mutations/v2";
const LIBRARY_MUTATION_SCHEMA_VERSION = "library-mutation/v2";
const mutationOriginId = crypto.randomUUID();
let databasePromise = null;

const checkpointAbortError = () => new DOMException("Party recovery write cancelled", "AbortError");

export const createAbortableMutationQueue = () => {
  let tail = Promise.resolve();
  return Object.freeze({
    run: (operation, { signal = null } = {}) => {
      let removeAbortListener = () => undefined;
      const turn = tail.then(() => {
        if (signal?.aborted) throw checkpointAbortError();
        return operation();
      });
      tail = turn.catch(() => undefined);
      if (!signal) return turn;
      const aborted = new Promise((_, reject) => {
        const onAbort = () => reject(checkpointAbortError());
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      });
      return Promise.race([turn, aborted]).finally(removeAbortListener);
    }
  });
};

const mutationSerializer = createAbortableMutationQueue();
const serializeMutation = (operation, options) => mutationSerializer.run(operation, options);

const safeCounter = (value) => Number.isSafeInteger(value) && value >= 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validRuntimeToken = (value) => typeof value === "string" && UUID.test(value);
const exactKeys = (value, expected) => {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
};

export const normalizeLibraryState = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.key !== LIBRARY_STATE_KEY || value.schemaVersion !== LIBRARY_STATE_SCHEMA_VERSION ||
      !safeCounter(value.epoch) || !safeCounter(value.revision)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join("|") !== ["epoch", "key", "revision", "schemaVersion"].join("|")) return null;
  return Object.freeze({
    key: LIBRARY_STATE_KEY,
    schemaVersion: LIBRARY_STATE_SCHEMA_VERSION,
    epoch: value.epoch,
    revision: value.revision
  });
};

const initialLibraryState = (legacyEpoch = 0) => Object.freeze({
  key: LIBRARY_STATE_KEY,
  schemaVersion: LIBRARY_STATE_SCHEMA_VERSION,
  epoch: safeCounter(legacyEpoch) ? legacyEpoch : 0,
  revision: 0
});

const nextLibraryState = (state, { clear = false } = {}) => {
  if (!state || state.revision >= Number.MAX_SAFE_INTEGER ||
      (clear && state.epoch >= Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Local library revision is invalid or exhausted");
  }
  return Object.freeze({
    ...state,
    epoch: clear ? state.epoch + 1 : state.epoch,
    revision: state.revision + 1
  });
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

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
});

const awaitWithAbort = (promise, signal) => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(checkpointAbortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, checkpointAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
};

const openDbWithAbort = async (signal, { closeLate = false } = {}) => {
  if (signal?.aborted) throw checkpointAbortError();
  const opening = openDb();
  try {
    return await awaitWithAbort(opening, signal);
  } catch (error) {
    if (signal?.aborted && closeLate) {
      void opening.then((opened) => {
        if (!signal.aborted) return;
        try { opened.close(); } catch { /* The late open is already non-authoritative. */ }
        if (databasePromise === opening) databasePromise = null;
      }, () => undefined);
    }
    throw error;
  }
};

export const __setLibraryDatabasePromiseForTests = (promise) => {
  databasePromise = promise;
};

export const __openDbWithAbortForTests = (signal, options) => openDbWithAbort(signal, options);

const migrateTracks = (store, event) => {
  const needsAnalysisUpgrade = event.oldVersion < 5;
  const needsContentIdentityIndex = event.oldVersion < 6 && !store.indexNames.contains(CONTENT_IDENTITY_INDEX);
  if (!needsAnalysisUpgrade && !needsContentIdentityIndex) return;
  const seenContentIdentities = new Set();
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      if (needsContentIdentityIndex && !store.indexNames.contains(CONTENT_IDENTITY_INDEX)) {
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
};

const openDb = () => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, LIBRARY_DATABASE_VERSION);
    let blocked = false;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const metaStore = db.objectStoreNames.contains(META_STORE_NAME)
        ? request.transaction.objectStore(META_STORE_NAME)
        : db.createObjectStore(META_STORE_NAME, { keyPath: "key" });
      if (!db.objectStoreNames.contains(PARTY_SESSION_STORE_NAME)) {
        db.createObjectStore(PARTY_SESSION_STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex(CONTENT_IDENTITY_INDEX, CONTENT_IDENTITY_INDEX, { unique: true });
      } else {
        migrateTracks(request.transaction.objectStore(STORE_NAME), event);
      }
      if (event.oldVersion < 8) {
        const stateRequest = metaStore.get(LIBRARY_STATE_KEY);
        stateRequest.onsuccess = () => {
          if (normalizeLibraryState(stateRequest.result)) return;
          const legacyRequest = metaStore.get(LEGACY_LIBRARY_EPOCH_KEY);
          legacyRequest.onsuccess = () => metaStore.put(initialLibraryState(legacyRequest.result?.value));
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        if (databasePromise) databasePromise = null;
      };
      db.addEventListener?.("close", () => {
        databasePromise = null;
      });
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      blocked = true;
      databasePromise = null;
      reject(new DOMException("Another Mazzy tab is blocking the library upgrade", "BlockedError"));
    };
  });
  return databasePromise;
};

const readLibraryState = async (store) => {
  const state = normalizeLibraryState(await requestResult(store.get(LIBRARY_STATE_KEY)));
  if (!state) throw new DOMException("Local library revision is malformed", "DataError");
  return state;
};

export const loadLibraryRecoveryBundle = async ({ signal = null } = {}) => {
  const db = await openDbWithAbort(signal, { closeLate: true });
  if (signal?.aborted) throw checkpointAbortError();
  const tx = db.transaction([STORE_NAME, META_STORE_NAME, PARTY_SESSION_STORE_NAME], "readonly");
  const completed = waitForTransaction(tx);
  const abortTransaction = () => {
    try { tx.abort(); } catch { /* The transaction already settled. */ }
  };
  signal?.addEventListener("abort", abortTransaction, { once: true });
  const tracksRequest = tx.objectStore(STORE_NAME).getAll();
  const stateRequest = tx.objectStore(META_STORE_NAME).get(LIBRARY_STATE_KEY);
  const checkpointRequest = tx.objectStore(PARTY_SESSION_STORE_NAME).get(PARTY_SESSION_CHECKPOINT_KEY);
  try {
    const [tracks, rawState, checkpointRecord] = await Promise.all([
      requestResult(tracksRequest),
      requestResult(stateRequest),
      requestResult(checkpointRequest),
      completed
    ]);
    if (signal?.aborted) {
      abortTransaction();
      throw checkpointAbortError();
    }
    const libraryState = normalizeLibraryState(rawState);
    if (!libraryState) throw new DOMException("Local library revision is malformed", "DataError");
    return Object.freeze({
      tracks: Object.freeze(tracks || []),
      libraryState,
      checkpointRecord: checkpointRecord ?? null,
      checkpointRevision: rawCheckpointRevision(checkpointRecord)
    });
  } finally {
    signal?.removeEventListener("abort", abortTransaction);
  }
};

export const loadLibraryFromDb = async () => (await loadLibraryRecoveryBundle()).tracks;

export const loadLibraryState = async () => {
  const db = await openDb();
  const tx = db.transaction(META_STORE_NAME, "readonly");
  const completed = waitForTransaction(tx);
  const state = await readLibraryState(tx.objectStore(META_STORE_NAME));
  await completed;
  return state;
};

export const loadLibraryEpoch = async () => (await loadLibraryState()).epoch;

const normalizeLibraryMutationEvent = (value) => {
  if (!value || typeof value !== "object" || value.schemaVersion !== LIBRARY_MUTATION_SCHEMA_VERSION ||
      !validRuntimeToken(value.originId) || !safeCounter(value.libraryEpoch) ||
      !safeCounter(value.libraryRevision) || !safeCounter(value.checkpointRevision)) return null;
  if (!["track-deleted", "library-cleared", "library-membership-changed", "party-checkpoint-updated", "party-checkpoint-claimed", "party-checkpoint-cleared"].includes(value.type)) return null;
  const baseKeys = ["schemaVersion", "originId", "type", "libraryEpoch", "libraryRevision", "checkpointRevision"];
  const expectedKeys = value.type === "track-deleted"
    ? [...baseKeys, "trackId"]
    : value.type.startsWith("party-checkpoint-")
      ? [...baseKeys, "sessionId", "writerToken"]
      : baseKeys;
  if (!exactKeys(value, expectedKeys)) return null;
  if (value.type === "track-deleted" &&
      (typeof value.trackId !== "string" || !value.trackId || value.trackId.length > 128)) return null;
  if (value.type.startsWith("party-checkpoint-") &&
      ((value.sessionId !== null && !validRuntimeToken(value.sessionId)) ||
       (value.writerToken !== null && !validRuntimeToken(value.writerToken)))) return null;
  return value;
};

export const __normalizeLibraryMutationEventForTests = normalizeLibraryMutationEvent;

export const subscribeToLibraryMutations = (listener) => {
  if (typeof BroadcastChannel !== "function") return () => undefined;
  const channel = new BroadcastChannel(LIBRARY_MUTATION_CHANNEL);
  channel.onmessage = (event) => {
    const message = normalizeLibraryMutationEvent(event.data);
    if (message && message.originId !== mutationOriginId) listener(message);
  };
  return () => channel.close();
};

const broadcastLibraryMutation = (message) => {
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel(LIBRARY_MUTATION_CHANNEL);
  channel.postMessage({
    schemaVersion: LIBRARY_MUTATION_SCHEMA_VERSION,
    originId: mutationOriginId,
    ...message
  });
  channel.close();
};

const withCrossTabMutationLock = async (operation, { signal = null } = {}) => {
  if (signal?.aborted) throw checkpointAbortError();
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(
      LIBRARY_MUTATION_CHANNEL,
      signal ? { mode: "exclusive", signal } : { mode: "exclusive" },
      operation
    );
  }
  if (signal?.aborted) throw checkpointAbortError();
  return operation();
};

export const mergeRoutineTrackUpdate = (existing, incoming) => ({
  ...incoming,
  contentIdentity: existing.contentIdentity ?? incoming.contentIdentity ?? null,
  analysisOverrides: existing.analysisOverrides ?? incoming.analysisOverrides,
  timingReview: existing.timingReview ?? null
});

const sameRoutineContent = (existing, expected) => {
  const existingIdentity = normalizeContentIdentity(existing?.contentIdentity);
  const expectedIdentity = normalizeContentIdentity(expected);
  return existingIdentity === expectedIdentity &&
    (existingIdentity !== null || existing?.contentIdentity == null);
};

export const saveRoutineTrackUpdatesToDb = async ({ tracks = [], patches = [] }, { signal = null } = {}) =>
  withCrossTabMutationLock(() => serializeMutation(async () => {
    if (signal?.aborted) throw checkpointAbortError();
    const db = await openDbWithAbort(signal);
    if (signal?.aborted) throw checkpointAbortError();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const completed = waitForTransaction(tx);
    const abortTransaction = () => {
      try { tx.abort(); } catch { /* The exact transaction already settled. */ }
    };
    signal?.addEventListener("abort", abortTransaction, { once: true });
    const store = tx.objectStore(STORE_NAME);
    const snapshots = new Map();
    const patchByTrack = new Map();
    for (const track of tracks) {
      if (!track || typeof track.id !== "string" || !track.id) continue;
      snapshots.set(track.id, track);
    }
    for (const entry of patches) {
      if (!entry || typeof entry.trackId !== "string" || !entry.trackId ||
          !entry.patch || typeof entry.patch !== "object" || Array.isArray(entry.patch)) continue;
      const current = patchByTrack.get(entry.trackId);
      patchByTrack.set(entry.trackId, {
        trackId: entry.trackId,
        contentIdentity: normalizeContentIdentity(entry.contentIdentity),
        patch: { ...(current?.patch ?? {}), ...entry.patch }
      });
    }
    const ids = new Set([...snapshots.keys(), ...patchByTrack.keys()]);
    const savedTrackIds = [];
    const skippedTrackIds = [];
    try {
      for (const trackId of ids) {
        const request = store.get(trackId);
        request.onsuccess = () => {
          const existing = request.result;
          const snapshot = snapshots.get(trackId);
          const patch = patchByTrack.get(trackId);
          const snapshotIdentity = normalizeContentIdentity(snapshot?.contentIdentity);
          const patchOwnedBySnapshot = !snapshot || patch?.contentIdentity === snapshotIdentity;
          const exactPatch = patchOwnedBySnapshot ? patch : null;
          const expectedIdentity = snapshot ? snapshotIdentity : exactPatch?.contentIdentity ?? null;
          if (!existing || !sameRoutineContent(existing, expectedIdentity)) {
            skippedTrackIds.push(trackId);
            return;
          }
          let next = snapshot ? mergeRoutineTrackUpdate(existing, snapshot) : existing;
          if (exactPatch) next = { ...next, ...exactPatch.patch, id: trackId };
          store.put(next);
          savedTrackIds.push(trackId);
        };
      }
      await completed;
      if (signal?.aborted) throw checkpointAbortError();
      return Object.freeze({
        status: skippedTrackIds.length ? "partial" : "saved",
        savedTrackIds: Object.freeze([...savedTrackIds]),
        skippedTrackIds: Object.freeze([...skippedTrackIds])
      });
    } finally {
      signal?.removeEventListener("abort", abortTransaction);
    }
  }, { signal }), { signal });

const sameLibraryState = (current, expected) => current && expected &&
  current.epoch === expected.epoch && current.revision === expected.revision;

export const saveImportedTracksToDb = async (
  tracks,
  legacyIdentities = [],
  expectedLibraryState = null
) => withCrossTabMutationLock(() => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction([STORE_NAME, META_STORE_NAME, PARTY_SESSION_STORE_NAME], "readwrite");
  const completed = waitForTransaction(tx);
  const store = tx.objectStore(STORE_NAME);
  const metaStore = tx.objectStore(META_STORE_NAME);
  const [existingRows, currentState, rawCheckpoint] = await Promise.all([
    requestResult(store.getAll()),
    readLibraryState(metaStore),
    requestResult(tx.objectStore(PARTY_SESSION_STORE_NAME).get(PARTY_SESSION_CHECKPOINT_KEY))
  ]);
  const expected = typeof expectedLibraryState === "number"
    ? { epoch: expectedLibraryState, revision: currentState.revision }
    : expectedLibraryState;
  if (expected && !sameLibraryState(currentState, expected)) {
    await completed;
    return { status: "stale-library", savedTrackIds: [], duplicateContentIdentities: [], libraryState: currentState };
  }

  const byId = new Map(existingRows.map((track) => [track.id, track]));
  const identities = new Set(existingRows.map((track) => track.contentIdentity).filter(Boolean));
  const savedTrackIds = [];
  const duplicateContentIdentities = [];
  for (const track of tracks) {
    if (track.contentIdentity && identities.has(track.contentIdentity)) {
      duplicateContentIdentities.push(track.contentIdentity);
      continue;
    }
    if (track.contentIdentity) identities.add(track.contentIdentity);
    store.put(track);
    byId.set(track.id, track);
    savedTrackIds.push(track.id);
  }
  let legacyChanged = false;
  for (const { id, contentIdentity } of legacyIdentities) {
    const existing = byId.get(id);
    if (!existing || existing.contentIdentity === contentIdentity) continue;
    if (identities.has(contentIdentity)) continue;
    identities.add(contentIdentity);
    const next = { ...existing, contentIdentity };
    store.put(next);
    byId.set(id, next);
    legacyChanged = true;
  }
  const changed = savedTrackIds.length > 0 || legacyChanged;
  const libraryState = changed ? nextLibraryState(currentState) : currentState;
  if (changed) metaStore.put(libraryState);
  await completed;
  if (changed) {
    broadcastLibraryMutation({
      type: "library-membership-changed",
      libraryEpoch: libraryState.epoch,
      libraryRevision: libraryState.revision,
      checkpointRevision: rawCheckpointRevision(rawCheckpoint)
    });
  }
  return { status: "saved", savedTrackIds, duplicateContentIdentities, libraryState };
}));

const rawCheckpointRevision = (value) => safeCounter(value?.revision) && value.revision > 0 &&
  value.revision < Number.MAX_SAFE_INTEGER
  ? value.revision
  : 0;

const broadcastCheckpoint = (type, libraryState, checkpointRevision, extra = {}) => {
  broadcastLibraryMutation({
    type,
    libraryEpoch: libraryState.epoch,
    libraryRevision: libraryState.revision,
    checkpointRevision,
    ...extra
  });
};

export const savePartySessionCheckpointToDb = async (draft, expected, { signal = null } = {}) =>
  withCrossTabMutationLock(() => serializeMutation(async () => {
    if (signal?.aborted) throw checkpointAbortError();
    const db = await openDb();
    if (signal?.aborted) throw checkpointAbortError();
    const tx = db.transaction([STORE_NAME, META_STORE_NAME, PARTY_SESSION_STORE_NAME], "readwrite");
    const completed = waitForTransaction(tx);
    const abortTransaction = () => {
      try { tx.abort(); } catch { /* The transaction already settled. */ }
    };
    signal?.addEventListener("abort", abortTransaction, { once: true });
    const trackStore = tx.objectStore(STORE_NAME);
    const metaStore = tx.objectStore(META_STORE_NAME);
    const sessionStore = tx.objectStore(PARTY_SESSION_STORE_NAME);
    try {
      const [trackIds, libraryState, rawCurrent] = await Promise.all([
        requestResult(trackStore.getAllKeys()),
        readLibraryState(metaStore),
        requestResult(sessionStore.get(PARTY_SESSION_CHECKPOINT_KEY))
      ]);
      if (signal?.aborted) {
        abortTransaction();
        throw checkpointAbortError();
      }
      const current = rawCurrent == null ? null : normalizePartySessionCheckpointRecord(rawCurrent);
      if (rawCurrent != null && !current) {
        await completed;
        return { status: "invalid-checkpoint", checkpoint: null, libraryState };
      }
      const currentRevision = current?.revision ?? 0;
      if (!sameLibraryState(libraryState, {
        epoch: expected.libraryEpoch,
        revision: expected.libraryRevision
      })) {
        await completed;
        return { status: "stale-library", checkpoint: null, libraryState };
      }
      if (currentRevision !== expected.checkpointRevision ||
          (expected.sessionId != null && current?.sessionId !== expected.sessionId) ||
          (expected.writerToken != null && current?.writerToken !== expected.writerToken)) {
        await completed;
        return { status: "stale-checkpoint", checkpoint: null, libraryState };
      }
      const knownIds = new Set(trackIds);
      const references = [draft.lastStableSourceTrackId, ...draft.playedTrackIds, ...draft.remainingTrackIds];
      if (references.some((id) => !knownIds.has(id))) {
        await completed;
        return { status: "missing-track", checkpoint: null, libraryState };
      }
      const checkpoint = createPartySessionCheckpoint({
        ...draft,
        libraryEpoch: libraryState.epoch,
        libraryRevision: libraryState.revision
      }, currentRevision + 1);
      sessionStore.put(checkpoint);
      await completed;
      broadcastCheckpoint("party-checkpoint-updated", libraryState, checkpoint.revision, {
        sessionId: checkpoint.sessionId,
        writerToken: checkpoint.writerToken
      });
      return { status: "saved", checkpoint, libraryState };
    } finally {
      signal?.removeEventListener("abort", abortTransaction);
    }
  }, { signal }), { signal });

export const claimPartySessionCheckpoint = async (
  sessionId,
  expectedRevision,
  previousWriterToken,
  nextWriterToken,
  { signal = null, expectedLibraryState = null } = {}
) => withCrossTabMutationLock(() => serializeMutation(async () => {
  if (signal?.aborted) throw checkpointAbortError();
  const db = await openDbWithAbort(signal);
  if (signal?.aborted) throw checkpointAbortError();
  const tx = db.transaction([META_STORE_NAME, PARTY_SESSION_STORE_NAME], "readwrite");
  const completed = waitForTransaction(tx);
  void completed.catch(() => undefined);
  const abortTransaction = () => {
    try { tx.abort(); } catch { /* The transaction already settled. */ }
  };
  signal?.addEventListener("abort", abortTransaction, { once: true });
  const metaStore = tx.objectStore(META_STORE_NAME);
  const sessionStore = tx.objectStore(PARTY_SESSION_STORE_NAME);
  try {
    const [libraryState, rawCurrent] = await Promise.all([
      readLibraryState(metaStore),
      requestResult(sessionStore.get(PARTY_SESSION_CHECKPOINT_KEY))
    ]);
    if (signal?.aborted) throw checkpointAbortError();
    if (expectedLibraryState && !sameLibraryState(libraryState, expectedLibraryState)) {
      await completed;
      return { status: "stale-library", revision: rawCheckpointRevision(rawCurrent), libraryState };
    }
    const current = normalizePartySessionCheckpointRecord(rawCurrent);
    if (!current || current.recordStatus !== "available" || current.sessionId !== sessionId ||
        current.writerToken !== previousWriterToken || current.revision !== expectedRevision) {
      await completed;
      return { status: "stale-checkpoint", revision: current?.revision ?? rawCheckpointRevision(rawCurrent), libraryState };
    }
    const tombstone = createPartySessionCheckpointTombstone(
      "claimed",
      current.revision + 1,
      sessionId,
      nextWriterToken
    );
    sessionStore.put(tombstone);
    await completed;
    broadcastCheckpoint("party-checkpoint-claimed", libraryState, tombstone.revision, {
      sessionId,
      writerToken: nextWriterToken
    });
    return { status: "claimed", revision: tombstone.revision, libraryState };
  } finally {
    signal?.removeEventListener("abort", abortTransaction);
  }
}, { signal }), { signal });

export const clearPartySessionCheckpoint = async ({
  expectedRevision = null,
  expectedSessionId = null,
  expectedWriterToken = null,
  recordStatus = "cleared"
} = {}, { signal = null } = {}) => withCrossTabMutationLock(() => serializeMutation(async () => {
  if (signal?.aborted) throw checkpointAbortError();
  const db = await openDb();
  if (signal?.aborted) throw checkpointAbortError();
  const tx = db.transaction([META_STORE_NAME, PARTY_SESSION_STORE_NAME], "readwrite");
  const completed = waitForTransaction(tx);
  const abortTransaction = () => {
    try { tx.abort(); } catch { /* The transaction already settled. */ }
  };
  signal?.addEventListener("abort", abortTransaction, { once: true });
  const metaStore = tx.objectStore(META_STORE_NAME);
  const sessionStore = tx.objectStore(PARTY_SESSION_STORE_NAME);
  try {
    const [libraryState, rawCurrent] = await Promise.all([
      readLibraryState(metaStore),
      requestResult(sessionStore.get(PARTY_SESSION_CHECKPOINT_KEY))
    ]);
    if (signal?.aborted) {
      abortTransaction();
      throw checkpointAbortError();
    }
    const current = rawCurrent == null ? null : normalizePartySessionCheckpointRecord(rawCurrent);
    const currentRevision = current?.revision ?? rawCheckpointRevision(rawCurrent);
    if ((expectedRevision != null && currentRevision !== expectedRevision) ||
        (expectedSessionId != null && current?.sessionId !== expectedSessionId) ||
        (expectedWriterToken != null && current?.writerToken !== expectedWriterToken)) {
      await completed;
      return { status: "stale-checkpoint", revision: currentRevision, libraryState };
    }
    const tombstone = createPartySessionCheckpointTombstone(
      recordStatus,
      currentRevision + 1,
      current?.sessionId ?? expectedSessionId,
      current?.writerToken ?? expectedWriterToken
    );
    sessionStore.put(tombstone);
    await completed;
    broadcastCheckpoint("party-checkpoint-cleared", libraryState, tombstone.revision, {
      sessionId: tombstone.sessionId,
      writerToken: tombstone.writerToken
    });
    return { status: "cleared", revision: tombstone.revision, libraryState };
  } finally {
    signal?.removeEventListener("abort", abortTransaction);
  }
}, { signal }), { signal });

export const deleteTrackFromDb = async (trackId) => withCrossTabMutationLock(() => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction([STORE_NAME, META_STORE_NAME, PARTY_SESSION_STORE_NAME], "readwrite");
  const completed = waitForTransaction(tx);
  const trackStore = tx.objectStore(STORE_NAME);
  const metaStore = tx.objectStore(META_STORE_NAME);
  const sessionStore = tx.objectStore(PARTY_SESSION_STORE_NAME);
  const [existingTrack, currentState, rawCheckpoint] = await Promise.all([
    requestResult(trackStore.get(trackId)),
    readLibraryState(metaStore),
    requestResult(sessionStore.get(PARTY_SESSION_CHECKPOINT_KEY))
  ]);
  let libraryState = currentState;
  let checkpointRevision = rawCheckpointRevision(rawCheckpoint);
  if (existingTrack) {
    trackStore.delete(trackId);
    libraryState = nextLibraryState(currentState);
    metaStore.put(libraryState);
    const currentCheckpoint = normalizePartySessionCheckpointRecord(rawCheckpoint);
    const tombstone = createPartySessionCheckpointTombstone(
      "invalidated",
      checkpointRevision + 1,
      currentCheckpoint?.sessionId ?? null,
      currentCheckpoint?.writerToken ?? null
    );
    checkpointRevision = tombstone.revision;
    sessionStore.put(tombstone);
  }
  await completed;
  if (existingTrack) {
    broadcastLibraryMutation({
      type: "track-deleted",
      trackId,
      libraryEpoch: libraryState.epoch,
      libraryRevision: libraryState.revision,
      checkpointRevision
    });
  }
  return { deleted: Boolean(existingTrack), libraryState, checkpointRevision };
}));

export const clearTracksFromDb = async () => withCrossTabMutationLock(() => serializeMutation(async () => {
  const db = await openDb();
  const tx = db.transaction([STORE_NAME, META_STORE_NAME, PARTY_SESSION_STORE_NAME], "readwrite");
  const completed = waitForTransaction(tx);
  const trackStore = tx.objectStore(STORE_NAME);
  const metaStore = tx.objectStore(META_STORE_NAME);
  const sessionStore = tx.objectStore(PARTY_SESSION_STORE_NAME);
  const [currentState, rawCheckpoint] = await Promise.all([
    readLibraryState(metaStore),
    requestResult(sessionStore.get(PARTY_SESSION_CHECKPOINT_KEY))
  ]);
  const libraryState = nextLibraryState(currentState, { clear: true });
  const currentCheckpoint = normalizePartySessionCheckpointRecord(rawCheckpoint);
  const tombstone = createPartySessionCheckpointTombstone(
    "invalidated",
    rawCheckpointRevision(rawCheckpoint) + 1,
    currentCheckpoint?.sessionId ?? null,
    currentCheckpoint?.writerToken ?? null
  );
  trackStore.clear();
  metaStore.put(libraryState);
  sessionStore.put(tombstone);
  await completed;
  broadcastLibraryMutation({
    type: "library-cleared",
    libraryEpoch: libraryState.epoch,
    libraryRevision: libraryState.revision,
    checkpointRevision: tombstone.revision
  });
  return { libraryState, checkpointRevision: tombstone.revision };
}));

export const __resetLibraryDbForTests = async ({ deleteDatabase = false } = {}) => {
  const db = databasePromise ? await databasePromise.catch(() => null) : null;
  db?.close?.();
  databasePromise = null;
  if (!deleteDatabase || typeof indexedDB === "undefined") return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new DOMException("Test database deletion blocked", "BlockedError"));
  });
};
