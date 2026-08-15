import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { afterAll, beforeEach } from "vitest";
import {
  LIBRARY_DATABASE_VERSION,
  __normalizeLibraryMutationEventForTests,
  __resetLibraryDbForTests,
  claimPartySessionCheckpoint,
  clearPartySessionCheckpoint,
  clearTracksFromDb,
  createAbortableMutationQueue,
  deleteTrackFromDb,
  loadLibraryRecoveryBundle,
  mergeRoutineTrackUpdate,
  saveImportedTracksToDb,
  savePartySessionCheckpointToDb,
  waitForTransaction
} from "./libraryDb";

const contentIdentity = (character) => `file-content-sha256/v1:${character.repeat(64)}`;
const track = (id, character) => ({
  id,
  name: id,
  file: new Blob([id], { type: "audio/wav" }),
  contentIdentity: contentIdentity(character)
});
const sessionId = "11111111-1111-4111-8111-111111111111";
const writerA = "22222222-2222-4222-8222-222222222222";
const writerB = "33333333-3333-4333-8333-333333333333";

const putRawCheckpoint = async (value) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("mazzy-library", LIBRARY_DATABASE_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = db.transaction("partySessions", "readwrite");
  tx.objectStore("partySessions").put(value);
  await waitForTransaction(tx);
  db.close();
};

const draft = (libraryState, overrides = {}) => ({
  sessionId,
  writerToken: writerA,
  libraryEpoch: libraryState.epoch,
  libraryRevision: libraryState.revision,
  checkpointReason: "active-periodic",
  plannedDurationSeconds: 10_800,
  accumulatedActiveSeconds: 1_200,
  energyProfile: "build",
  energyShiftSteps: 1,
  includeRestOfLibrary: false,
  playedTrackIds: ["source"],
  remainingTrackIds: ["next"],
  lastStableSourceTrackId: "source",
  ...overrides
});

beforeEach(async () => {
  await __resetLibraryDbForTests({ deleteDatabase: true });
});

afterAll(async () => {
  await __resetLibraryDbForTests({ deleteDatabase: true });
});

describe("waitForTransaction", () => {
  it("rejects an abort-only quota failure exactly once", async () => {
    const quotaError = new DOMException("quota full", "QuotaExceededError");
    const tx = { error: quotaError };
    const pending = waitForTransaction(tx);
    tx.onabort();
    tx.onerror();
    await expect(pending).rejects.toBe(quotaError);
  });

  it("settles a successful transaction exactly once", async () => {
    const tx = { error: null };
    const resolved = vi.fn();
    const pending = waitForTransaction(tx).then(resolved);
    tx.oncomplete();
    tx.onabort();
    await pending;
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("preserves fields owned by identity and timing patches", () => {
    const existing = {
      id: "track-1",
      bpm: 100,
      contentIdentity: "file-content-sha256/v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      analysisOverrides: { schemaVersion: "override/current", beatShiftSeconds: 0.02 },
      timingReview: { schemaVersion: "review/current", answers: ["yes"] }
    };
    const staleAnalysisSnapshot = {
      id: "track-1",
      bpm: 120,
      contentIdentity: null,
      analysisOverrides: { schemaVersion: "old" },
      timingReview: null
    };
    expect(mergeRoutineTrackUpdate(existing, staleAnalysisSnapshot)).toEqual({
      ...staleAnalysisSnapshot,
      bpm: 120,
      contentIdentity: existing.contentIdentity,
      analysisOverrides: existing.analysisOverrides,
      timingReview: existing.timingReview
    });
  });
});

describe("library recovery storage", () => {
  it("migrates a prior v7 database into a coherent v8 recovery bundle", async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("mazzy-library", 7);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("tracks", { keyPath: "id" })
          .createIndex("contentIdentity", "contentIdentity", { unique: true });
        const meta = db.createObjectStore("meta", { keyPath: "key" });
        meta.put({ key: "libraryEpoch", value: 3 });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const bundle = await loadLibraryRecoveryBundle();
    expect(LIBRARY_DATABASE_VERSION).toBe(8);
    expect(bundle.libraryState).toEqual({
      key: "libraryState",
      schemaVersion: "library-state/v1",
      epoch: 3,
      revision: 0
    });
    expect(bundle.checkpointRecord).toBeNull();
    expect(bundle.checkpointRevision).toBe(0);
  });

  it("commits imported membership and a referentially valid checkpoint atomically", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    expect(imported.status).toBe("saved");
    expect(imported.libraryState.revision).toBe(1);

    const saved = await savePartySessionCheckpointToDb(draft(imported.libraryState), {
      checkpointRevision: 0,
      libraryEpoch: imported.libraryState.epoch,
      libraryRevision: imported.libraryState.revision,
      sessionId: null,
      writerToken: null
    });
    expect(saved.status).toBe("saved");
    expect(saved.checkpoint.revision).toBe(1);

    const bundle = await loadLibraryRecoveryBundle();
    expect(bundle.tracks.map(({ id }) => id).sort()).toEqual(["next", "source"]);
    expect(bundle.checkpointRecord).toEqual(saved.checkpoint);
    expect(bundle.checkpointRevision).toBe(saved.checkpoint.revision);
  });

  it("rejects an already-aborted checkpoint write before opening storage ownership", async () => {
    const controller = new AbortController();
    controller.abort();
    const state = (await loadLibraryRecoveryBundle()).libraryState;
    await expect(savePartySessionCheckpointToDb(draft(state), {
      checkpointRevision: 0,
      libraryEpoch: state.epoch,
      libraryRevision: state.revision,
      sessionId: null,
      writerToken: null
    }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toBeNull();
  });

  it("releases an aborted queue waiter without running it after the predecessor settles", async () => {
    const queue = createAbortableMutationQueue();
    let releaseFirst;
    const first = queue.run(() => new Promise((resolve) => { releaseFirst = resolve; }));
    const controller = new AbortController();
    const secondTask = vi.fn();
    const second = queue.run(secondTask, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst();
    await first;
    await Promise.resolve();
    expect(secondTask).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted checkpoint clear without changing the saved record", async () => {
    const state = (await loadLibraryRecoveryBundle()).libraryState;
    const controller = new AbortController();
    controller.abort();
    await expect(clearPartySessionCheckpoint({ expectedRevision: 0 }, {
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toBeNull();
    expect((await loadLibraryRecoveryBundle()).libraryState).toEqual(state);
  });

  it("does not advance membership revision for a duplicate-only import", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const first = await saveImportedTracksToDb([track("source", "a")], [], initial);
    const duplicate = await saveImportedTracksToDb(
      [track("duplicate-id", "a")],
      [],
      first.libraryState
    );
    expect(duplicate.savedTrackIds).toEqual([]);
    expect(duplicate.libraryState).toEqual(first.libraryState);
    expect((await loadLibraryRecoveryBundle()).tracks.map(({ id }) => id)).toEqual(["source"]);
  });

  it("allows exactly one writer from a checkpoint revision", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    const expected = {
      checkpointRevision: 0,
      libraryEpoch: imported.libraryState.epoch,
      libraryRevision: imported.libraryState.revision,
      sessionId: null,
      writerToken: null
    };
    const [first, second] = await Promise.all([
      savePartySessionCheckpointToDb(draft(imported.libraryState), expected),
      savePartySessionCheckpointToDb(draft(imported.libraryState, {
        sessionId: "44444444-4444-4444-8444-444444444444",
        writerToken: writerB
      }), expected)
    ]);
    expect([first.status, second.status].sort()).toEqual(["saved", "stale-checkpoint"]);
  });

  it("claims one exact checkpoint and rejects a stale second restore", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    const saved = await savePartySessionCheckpointToDb(draft(imported.libraryState), {
      checkpointRevision: 0,
      libraryEpoch: imported.libraryState.epoch,
      libraryRevision: imported.libraryState.revision,
      sessionId: null,
      writerToken: null
    });
    const claimed = await claimPartySessionCheckpoint(sessionId, saved.checkpoint.revision, writerA, writerB);
    const stale = await claimPartySessionCheckpoint(sessionId, saved.checkpoint.revision, writerA, crypto.randomUUID());
    expect(claimed.status).toBe("claimed");
    expect(stale.status).toBe("stale-checkpoint");
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toMatchObject({
      recordStatus: "claimed",
      writerToken: writerB,
      revision: 2
    });
  });

  it("invalidates recovery atomically when a track is deleted", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    const saved = await savePartySessionCheckpointToDb(draft(imported.libraryState), {
      checkpointRevision: 0,
      libraryEpoch: imported.libraryState.epoch,
      libraryRevision: imported.libraryState.revision,
      sessionId: null,
      writerToken: null
    });
    const deletion = await deleteTrackFromDb("next");
    expect(deletion.deleted).toBe(true);
    expect(deletion.libraryState.revision).toBe(imported.libraryState.revision + 1);
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toMatchObject({
      recordStatus: "invalidated",
      revision: saved.checkpoint.revision + 1
    });

    const staleSave = await savePartySessionCheckpointToDb(draft(deletion.libraryState), {
      checkpointRevision: saved.checkpoint.revision,
      libraryEpoch: deletion.libraryState.epoch,
      libraryRevision: deletion.libraryState.revision,
      sessionId,
      writerToken: writerA
    });
    expect(staleSave.status).toBe("stale-checkpoint");
  });

  it("increments the library epoch and tombstones recovery in the same clear transaction", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    await savePartySessionCheckpointToDb(draft(imported.libraryState), {
      checkpointRevision: 0,
      libraryEpoch: imported.libraryState.epoch,
      libraryRevision: imported.libraryState.revision,
      sessionId: null,
      writerToken: null
    });
    const cleared = await clearTracksFromDb();
    const bundle = await loadLibraryRecoveryBundle();
    expect(bundle.tracks).toEqual([]);
    expect(bundle.libraryState).toMatchObject({
      epoch: imported.libraryState.epoch + 1,
      revision: imported.libraryState.revision + 1
    });
    expect(bundle.checkpointRecord).toMatchObject({
      recordStatus: "invalidated",
      revision: cleared.checkpointRevision
    });
  });

  it("preserves the last valid checkpoint when a stale clear is rejected", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    const saved = await savePartySessionCheckpointToDb(draft(imported.libraryState), {
      checkpointRevision: 0,
      libraryEpoch: imported.libraryState.epoch,
      libraryRevision: imported.libraryState.revision,
      sessionId: null,
      writerToken: null
    });
    const stale = await clearPartySessionCheckpoint({
      expectedRevision: saved.checkpoint.revision - 1,
      expectedSessionId: sessionId,
      expectedWriterToken: writerA
    });
    expect(stale.status).toBe("stale-checkpoint");
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toEqual(saved.checkpoint);
  });

  it("CAS-protects deletion of a malformed recovery record", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    await putRawCheckpoint({ key: "active", revision: 7, privateName: "must-not-render" });
    const malformed = await loadLibraryRecoveryBundle();
    expect(malformed.checkpointRevision).toBe(7);

    const repaired = await clearPartySessionCheckpoint({ expectedRevision: 7 });
    expect(repaired).toMatchObject({ status: "cleared", revision: 8 });
    const saved = await savePartySessionCheckpointToDb(draft(imported.libraryState), {
      checkpointRevision: 8,
      libraryEpoch: imported.libraryState.epoch,
      libraryRevision: imported.libraryState.revision,
      sessionId: null,
      writerToken: null
    });
    expect(saved.status).toBe("saved");

    const staleDelete = await clearPartySessionCheckpoint({ expectedRevision: 7 });
    expect(staleDelete.status).toBe("stale-checkpoint");
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toEqual(saved.checkpoint);
  });
});

describe("library mutation notification validation", () => {
  const base = {
    schemaVersion: "library-mutation/v2",
    originId: "44444444-4444-4444-8444-444444444444",
    type: "library-membership-changed",
    libraryEpoch: 1,
    libraryRevision: 2,
    checkpointRevision: 3
  };

  it("accepts only the exact allowlisted advisory shape", () => {
    expect(__normalizeLibraryMutationEventForTests(base)).toEqual(base);
    expect(__normalizeLibraryMutationEventForTests({ ...base, filename: "private.wav" })).toBeNull();
    expect(__normalizeLibraryMutationEventForTests({ ...base, originId: "not-a-uuid" })).toBeNull();
    expect(__normalizeLibraryMutationEventForTests({ ...base, libraryRevision: Number.NaN })).toBeNull();
  });
});
