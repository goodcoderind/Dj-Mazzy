import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { afterAll, beforeEach } from "vitest";
import {
  LIBRARY_DATABASE_VERSION,
  __normalizeLibraryMutationEventForTests,
  __openDbWithAbortForTests,
  __resetLibraryDbForTests,
  __setLibraryDatabasePromiseForTests,
  claimPartySessionCheckpoint,
  clearPartySessionCheckpoint,
  clearTracksFromDb,
  createAbortableMutationQueue,
  deleteTrackFromDb,
  loadLibraryRecoveryBundle,
  mergeRoutineTrackUpdate,
  saveImportedTracksToDb,
  savePartySessionCheckpointToDb,
  saveRoutineTrackUpdatesToDb,
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

  it("rejects already-aborted membership mutations without changing membership", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const controller = new AbortController();
    controller.abort();
    await expect(saveImportedTracksToDb([track("source", "a")], [], initial, {
      signal: controller.signal
    })).rejects.toMatchObject({
      version: "library-membership-mutation-failure/v1",
      rollbackVerified: true
    });
    await expect(deleteTrackFromDb("source", {
      signal: controller.signal,
      expectedLibraryState: initial
    })).rejects.toMatchObject({
      version: "library-membership-mutation-failure/v1",
      rollbackVerified: true
    });
    await expect(clearTracksFromDb({
      signal: controller.signal,
      expectedLibraryState: initial
    })).rejects.toMatchObject({
      version: "library-membership-mutation-failure/v1",
      rollbackVerified: true
    });
    expect((await loadLibraryRecoveryBundle()).tracks).toEqual([]);
    expect((await loadLibraryRecoveryBundle()).libraryState).toEqual(initial);
  });

  it("aborts membership admission while queued for the profile Web Lock", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const originalNavigator = globalThis.navigator;
    const request = vi.fn((_name, options, operation) => new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("cancelled", "AbortError"));
      options.signal.addEventListener("abort", onAbort, { once: true });
      void operation;
      void resolve;
    }));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { ...(originalNavigator ?? {}), locks: { request } }
    });
    const controller = new AbortController();
    const pending = saveImportedTracksToDb([track("source", "a")], [], initial, {
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      version: "library-membership-mutation-failure/v1",
      rollbackVerified: true
    });
    expect(request).toHaveBeenCalledOnce();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator
    });
  });

  it("aborts and verifies rollback after a synchronous mid-import request failure", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    await expect(saveImportedTracksToDb([
      track("good", "a"),
      { ...track("bad", "b"), id: undefined }
    ], [], initial)).rejects.toMatchObject({
      version: "library-membership-mutation-failure/v1",
      rollbackVerified: true
    });
    const bundle = await loadLibraryRecoveryBundle();
    expect(bundle.tracks).toEqual([]);
    expect(bundle.libraryState).toEqual(initial);
    expect(bundle.checkpointRecord).toBeNull();
  });

  it("rejects an already-aborted startup hydration before reading local rows", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadLibraryRecoveryBundle({ signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("saves exact routine snapshots while preserving a newer manual timing patch", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const source = {
      ...track("source", "a"),
      bpm: 100,
      analysisOverrides: { schemaVersion: "override/v1", beatShiftSeconds: 0 },
      timingReview: null
    };
    await saveImportedTracksToDb([source], [], initial);
    const manual = { schemaVersion: "override/v1", beatShiftSeconds: 0.04 };
    const patched = await saveRoutineTrackUpdatesToDb({
      patches: [{ trackId: source.id, contentIdentity: source.contentIdentity, patch: { analysisOverrides: manual } }]
    });
    expect(patched).toMatchObject({ status: "saved", savedTrackIds: ["source"] });

    const snapshot = await saveRoutineTrackUpdatesToDb({
      tracks: [{ ...source, bpm: 128, analysisOverrides: { ...manual, beatShiftSeconds: 0 } }]
    });
    expect(snapshot.status).toBe("saved");
    const restored = (await loadLibraryRecoveryBundle()).tracks[0];
    expect(restored.bpm).toBe(128);
    expect(restored.analysisOverrides).toEqual(manual);
  });

  it("fails closed instead of writing a routine result into replaced content", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    await saveImportedTracksToDb([track("source", "a")], [], initial);
    const result = await saveRoutineTrackUpdatesToDb({
      tracks: [{ ...track("source", "b"), bpm: 140 }],
      patches: [{
        trackId: "source",
        contentIdentity: contentIdentity("b"),
        patch: { timingReview: { schemaVersion: "hostile" } }
      }]
    });
    expect(result).toMatchObject({ status: "partial", savedTrackIds: [], skippedTrackIds: ["source"] });
    expect((await loadLibraryRecoveryBundle()).tracks[0]).not.toHaveProperty("bpm");
  });

  it("preserves a successor snapshot while discarding its predecessor's pending patch", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    await saveImportedTracksToDb([track("source", "a")], [], initial);
    const deletion = await deleteTrackFromDb("source");
    const successor = track("source", "b");
    await saveImportedTracksToDb([successor], [], deletion.libraryState);
    const result = await saveRoutineTrackUpdatesToDb({
      tracks: [{ ...successor, bpm: 132 }],
      patches: [{
        trackId: "source",
        contentIdentity: contentIdentity("a"),
        patch: { timingReview: { schemaVersion: "stale-predecessor" } }
      }]
    });
    expect(result.status).toBe("saved");
    const restored = (await loadLibraryRecoveryBundle()).tracks[0];
    expect(restored.bpm).toBe(132);
    expect(restored.timingReview).toBeNull();
  });

  it("rejects an already-aborted routine write without changing the row", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const source = track("source", "a");
    await saveImportedTracksToDb([source], [], initial);
    const controller = new AbortController();
    controller.abort();
    await expect(saveRoutineTrackUpdatesToDb({ tracks: [{ ...source, bpm: 150 }] }, {
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect((await loadLibraryRecoveryBundle()).tracks[0]).not.toHaveProperty("bpm");
  });

  it("does not close a shared pending database open when only a routine owner aborts", async () => {
    let resolveOpen;
    const close = vi.fn();
    const opening = new Promise((resolve) => { resolveOpen = resolve; });
    __setLibraryDatabasePromiseForTests(opening);
    const controller = new AbortController();
    const routine = __openDbWithAbortForTests(controller.signal);
    controller.abort();
    await expect(routine).rejects.toMatchObject({ name: "AbortError" });
    const checkpointOwner = __openDbWithAbortForTests(null);
    const sharedDb = { close };
    resolveOpen(sharedDb);
    await expect(checkpointOwner).resolves.toBe(sharedDb);
    expect(close).not.toHaveBeenCalled();
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

  it("atomically transfers one exact checkpoint with its full payload and rejects a stale second restore", async () => {
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
    const results = await Promise.all([
      claimPartySessionCheckpoint(sessionId, saved.checkpoint.revision, writerA, writerB),
      claimPartySessionCheckpoint(sessionId, saved.checkpoint.revision, writerA, crypto.randomUUID())
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["stale-checkpoint", "transferred"]);
    const claimed = results.find((result) => result.status === "transferred");
    const stored = (await loadLibraryRecoveryBundle()).checkpointRecord;
    expect(claimed.checkpoint).toEqual(stored);
    expect(stored).toEqual({
      ...saved.checkpoint,
      recordStatus: "available",
      writerToken: claimed.checkpoint.writerToken,
      revision: 2
    });
  });

  it("leaves an exact available checkpoint unchanged when claim is already aborted", async () => {
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
    const controller = new AbortController();
    controller.abort();
    await expect(claimPartySessionCheckpoint(
      sessionId,
      saved.checkpoint.revision,
      writerA,
      writerB,
      { signal: controller.signal }
    )).rejects.toMatchObject({ name: "AbortError" });
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toMatchObject({
      recordStatus: "available",
      writerToken: writerA,
      revision: saved.checkpoint.revision
    });
  });

  it("rejects the previous writer after transfer and lets only the new writer clear", async () => {
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
    const claimed = await claimPartySessionCheckpoint(
      sessionId,
      saved.checkpoint.revision,
      writerA,
      writerB
    );
    expect(claimed.status).toBe("transferred");

    const oldWriterSave = await savePartySessionCheckpointToDb(
      draft(imported.libraryState),
      {
        checkpointRevision: claimed.revision,
        libraryEpoch: imported.libraryState.epoch,
        libraryRevision: imported.libraryState.revision,
        sessionId,
        writerToken: writerA
      }
    );
    expect(oldWriterSave.status).toBe("stale-checkpoint");
    const oldWriterClear = await clearPartySessionCheckpoint({
      expectedRevision: claimed.revision,
      expectedSessionId: sessionId,
      expectedWriterToken: writerA
    });
    expect(oldWriterClear.status).toBe("stale-checkpoint");
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toEqual(claimed.checkpoint);

    const writerC = crypto.randomUUID();
    const transferredAgain = await claimPartySessionCheckpoint(
      sessionId,
      claimed.revision,
      writerB,
      writerC
    );
    expect(transferredAgain.status).toBe("transferred");
    const reconciledOldWriterClear = await clearPartySessionCheckpoint({
      expectedRevision: transferredAgain.revision,
      expectedSessionId: sessionId,
      expectedWriterToken: writerB
    });
    expect(reconciledOldWriterClear.status).toBe("stale-checkpoint");
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toEqual(transferredAgain.checkpoint);

    const cleared = await clearPartySessionCheckpoint({
      expectedRevision: transferredAgain.revision,
      expectedSessionId: sessionId,
      expectedWriterToken: writerC
    });
    expect(cleared.status).toBe("cleared");
  });

  it("rejects a claim when library membership changed before its transaction", async () => {
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
    const changed = await saveImportedTracksToDb(
      [track("later", "c")],
      [],
      imported.libraryState
    );
    const checkpointBeforeClaim = (await loadLibraryRecoveryBundle()).checkpointRecord;
    const result = await claimPartySessionCheckpoint(
      sessionId,
      saved.checkpoint.revision,
      writerA,
      writerB,
      { expectedLibraryState: imported.libraryState }
    );
    expect(result).toMatchObject({ status: "stale-library", libraryState: changed.libraryState });
    expect((await loadLibraryRecoveryBundle()).checkpointRecord).toEqual(checkpointBeforeClaim);
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

  it("does not delete or clear rows when the expected library state is stale", async () => {
    const initial = (await loadLibraryRecoveryBundle()).libraryState;
    const imported = await saveImportedTracksToDb(
      [track("source", "a"), track("next", "b")],
      [],
      initial
    );
    const later = await saveImportedTracksToDb([track("later", "c")], [], imported.libraryState);
    const deletion = await deleteTrackFromDb("source", { expectedLibraryState: imported.libraryState });
    const clear = await clearTracksFromDb({ expectedLibraryState: imported.libraryState });
    expect(deletion.status).toBe("stale-library");
    expect(clear.status).toBe("stale-library");
    const bundle = await loadLibraryRecoveryBundle();
    expect(bundle.libraryState).toEqual(later.libraryState);
    expect(bundle.tracks.map(({ id }) => id).sort()).toEqual(["later", "next", "source"]);
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
