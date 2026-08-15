import { describe, expect, it } from "vitest";
import {
  createDeckPlaybackCompletionLease,
  deriveConstantRatePlaybackEndTime,
  deriveRampedPlaybackEndTime,
  inspectDeckPlaybackCompletion,
  ownsDeckPlaybackCompletionLease
} from "./deckPlaybackCompletionOwnership";

const lease = () => createDeckPlaybackCompletionLease({
  operation: 1,
  channel: "a",
  loadRevision: 2,
  transportRevision: 3,
  ratePlanRevision: 1,
  sourceId: 4,
  trackId: "track-a",
  intent: "natural",
  startTimeSeconds: 10,
  startOffsetSeconds: 20,
  durationSeconds: 120,
  endPositionSeconds: 120,
  expectedEndTimeSeconds: 110
});

describe("deck playback completion ownership", () => {
  it("derives constant-rate and linear-ramp completion times", () => {
    expect(deriveConstantRatePlaybackEndTime({
      startTimeSeconds: 10,
      startOffsetSeconds: 20,
      durationSeconds: 120,
      playbackRate: 1
    })).toBe(110);
    expect(deriveRampedPlaybackEndTime({
      durationSeconds: 120,
      rampStartTimeSeconds: 20,
      rampStartPositionSeconds: 30,
      rampDurationSeconds: 10,
      startRate: 1,
      targetRate: 1.5
    })).toBeCloseTo(20 + 10 + (90 - 12.5) / 1.5, 9);
    expect(deriveRampedPlaybackEndTime({
      durationSeconds: 35,
      rampStartTimeSeconds: 20,
      rampStartPositionSeconds: 30,
      rampDurationSeconds: 10,
      startRate: 0.5,
      targetRate: 1.5
    })).toBeCloseTo(20 + (-0.5 + Math.sqrt(1.25)) / 0.1, 9);
    expect(deriveConstantRatePlaybackEndTime({
      startTimeSeconds: 20,
      startOffsetSeconds: 10,
      durationSeconds: 20,
      playbackRate: 0.5
    })).toBe(40);
    expect(deriveConstantRatePlaybackEndTime({
      startTimeSeconds: 20,
      startOffsetSeconds: 10,
      durationSeconds: 20,
      playbackRate: 1.5
    })).toBeCloseTo(20 + 10 / 1.5);
    expect(deriveRampedPlaybackEndTime({
      durationSeconds: 20,
      rampStartTimeSeconds: 10,
      rampStartPositionSeconds: 4,
      rampDurationSeconds: 4,
      startRate: 1.5,
      targetRate: 0.5
    })).toBeCloseTo(14 + 12 / 0.5);
    expect(deriveRampedPlaybackEndTime({
      durationSeconds: 8,
      rampStartTimeSeconds: 10,
      rampStartPositionSeconds: 4,
      rampDurationSeconds: 4,
      startRate: 1.5,
      targetRate: 0.5
    })).toBeCloseTo(10 + (1.5 - Math.sqrt(1.5 ** 2 - 2 * 0.25 * 4)) / 0.25);
  });

  it("uses exact audio-clock boundary and every ownership identity", () => {
    const expected = lease();
    const base = {
      current: expected,
      expected,
      loadRevision: 2,
      transportRevision: 3,
      sourceId: 4,
      trackId: "track-a",
      sourcePresent: true,
      signal: "source-onended"
    } as const;
    expect(inspectDeckPlaybackCompletion({ ...base, nowSeconds: 109.999 })).toBe("waiting");
    expect(inspectDeckPlaybackCompletion({ ...base, nowSeconds: 110 })).toBe("ready");
    expect(inspectDeckPlaybackCompletion({ ...base, signal: "reconcile", nowSeconds: 110 })).toBe("waiting");
    expect(inspectDeckPlaybackCompletion({ ...base, signal: "audio-clock", nowSeconds: 110.05 })).toBe("ready");
    expect(inspectDeckPlaybackCompletion({ ...base, nowSeconds: 110, sourceId: 5 })).toBe("superseded");
    expect(inspectDeckPlaybackCompletion({ ...base, nowSeconds: 110, transportRevision: 4 })).toBe("superseded");
    expect(inspectDeckPlaybackCompletion({ ...base, nowSeconds: 110, loadRevision: 3 })).toBe("superseded");
    expect(inspectDeckPlaybackCompletion({ ...base, nowSeconds: 110, trackId: "replacement" })).toBe("superseded");
  });

  it("rejects malformed, future-inconsistent, and partial leases", () => {
    const expected = lease();
    expect(ownsDeckPlaybackCompletionLease(expected, { ...expected, sourceId: 5 })).toBe(false);
    expect(() => createDeckPlaybackCompletionLease({ ...expected, operation: 0 } as never))
      .toThrow(RangeError);
    expect(() => createDeckPlaybackCompletionLease({
      ...expected,
      expectedEndTimeSeconds: 9
    } as never)).toThrow(RangeError);
    expect(() => deriveRampedPlaybackEndTime({
      durationSeconds: 30,
      rampStartTimeSeconds: 10,
      rampStartPositionSeconds: 30,
      rampDurationSeconds: 2,
      startRate: 1,
      targetRate: 1
    })).toThrow(RangeError);
    expect(() => deriveConstantRatePlaybackEndTime({
      startTimeSeconds: 0,
      startOffsetSeconds: 0,
      durationSeconds: 30,
      playbackRate: Number.NaN
    })).toThrow(RangeError);
    expect(inspectDeckPlaybackCompletion({
      current: expected,
      expected,
      nowSeconds: Number.POSITIVE_INFINITY,
      loadRevision: 2,
      transportRevision: 3,
      sourceId: 4,
      trackId: "track-a",
      sourcePresent: true,
      signal: "source-onended"
    })).toBe("superseded");
  });
});
