import { describe, expect, it } from "vitest";
import { AnalysisClient } from "./AnalysisClient";
import type { BasicAnalysisResult } from "./analyzePcm";
import {
  BASIC_ANALYZER_VERSION,
  TRACK_ANALYSIS_SCHEMA_VERSION
} from "../domain/versions";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = [];
  terminated = false;

  postMessage(message: Record<string, unknown>, transfer: Transferable[]) {
    this.messages.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  respond(requestId: number, result: BasicAnalysisResult) {
    this.onmessage?.({ data: { type: "result", requestId, result } } as MessageEvent);
  }
}

const result: BasicAnalysisResult = {
  schemaVersion: TRACK_ANALYSIS_SCHEMA_VERSION,
  analyzerVersion: BASIC_ANALYZER_VERSION,
  durationSeconds: 1,
  sampleRate: 8000,
  bpm: 120,
  bpmCandidates: [{ bpm: 120, confidence: 1 }],
  beatsSeconds: [0, 0.5],
  downbeatsSeconds: [],
  meter: null,
  tempoConfidence: 1,
  beatConfidence: 1,
  downbeatConfidence: 0,
  key: "C",
  scale: "major",
  keyConfidence: 0.5,
  energyByBeat: [0.5, 1],
  bandEnergyByBeat: [
    { low: 0.5, mid: 0.4, high: 0.1 },
    { low: 0.4, mid: 0.5, high: 0.1 }
  ],
  vocalProbabilityByBeat: [0.2, 0.4],
  structureBoundaries: [],
  phraseCandidates: [],
  automaticRhythmTrust: {
    schemaVersion: "automatic-rhythm-trust/v2",
    tier: "boundary-only",
    trustIndex: 0,
    calibrationVersion: null,
    calibratedSafeProbability: null,
    hardFailures: [],
    reasons: ["No automatic bar-start grid is available."],
    dimensions: { validity: 1, coverage: 0, tempoStability: 1, phaseStability: 1, downbeatCoherence: 0, signalActivity: 1 },
    complete32BeatWindows: 0,
    usableCutBeatIndices: [],
    usable16BeatWindows: []
  },
  programLevel: { schemaVersion: "program-level/v1", activeRmsDbfs: -14, samplePeakDbfs: -3, trimDb: 0, activeBlockCount: 2 }
};

describe("AnalysisClient", () => {
  it("transfers PCM ownership to the worker and resolves the matching request", async () => {
    const worker = new FakeWorker();
    const client = new AnalysisClient(worker as unknown as Worker);
    const pcm = new Float32Array([0, 0.5, -0.5]);
    const pending = client.analyzePcm(pcm, 8000, 1);

    expect(worker.messages[0].message).toMatchObject({
      type: "analyze",
      requestId: 1,
      sampleRate: 8000,
      durationSeconds: 1
    });
    expect(worker.messages[0].transfer).toEqual([pcm.buffer]);
    worker.respond(1, result);
    await expect(pending).resolves.toEqual(result);
  });

  it("keeps concurrent worker replies associated with their request IDs", async () => {
    const worker = new FakeWorker();
    const client = new AnalysisClient(worker as unknown as Worker);
    const first = client.analyzePcm(new Float32Array(8), 8000, 1);
    const second = client.analyzePcm(new Float32Array(8), 8000, 1);
    worker.respond(2, { ...result, bpm: 128 });
    worker.respond(1, result);
    await expect(first).resolves.toMatchObject({ bpm: 120 });
    await expect(second).resolves.toMatchObject({ bpm: 128 });
  });

  it("rejects pending work when disposed", async () => {
    const worker = new FakeWorker();
    const client = new AnalysisClient(worker as unknown as Worker);
    const pending = client.analyzePcm(new Float32Array(8), 8000, 1);
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow("analysis client disposed");
  });
});
