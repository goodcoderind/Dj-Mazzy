import { describe, expect, it } from "vitest";
import { TransportClock } from "./TransportClock";

describe("TransportClock", () => {
  it("reads the injected audio clock", () => {
    const source = { currentTime: 12.5 };
    const clock = new TransportClock(source);
    expect(clock.now()).toBe(12.5);
  });

  it("never schedules earlier than the requested lead time", () => {
    const source = { currentTime: 10 };
    const clock = new TransportClock(source);
    expect(clock.resolveScheduleTime(8, 0.05)).toBe(10.05);
    expect(clock.resolveScheduleTime(12, 0.05)).toBe(12);
  });

  it("finds the next phrase boundary from an audio-clock anchor", () => {
    const clock = new TransportClock({ currentTime: 17 });
    expect(
      clock.nextBeatBoundary({
        anchorTime: 1,
        bpm: 120,
        boundaryBeats: 16
      })
    ).toBe(17);

    expect(
      clock.nextBeatBoundary({
        anchorTime: 1,
        bpm: 120,
        boundaryBeats: 16,
        minimumLeadSeconds: 0.01
      })
    ).toBe(25);
  });

  it("does not return musical boundaries before a future anchor", () => {
    const clock = new TransportClock({ currentTime: 2 });
    expect(
      clock.nextBeatBoundary({
        anchorTime: 5,
        bpm: 120,
        boundaryBeats: 16
      })
    ).toBe(5);
  });

  it("maps context time to media time for a constant playback rate", () => {
    const clock = new TransportClock({ currentTime: 0 });
    expect(clock.mediaTimeAt(14, 10, 20, 1.25)).toBe(25);
    expect(clock.mediaTimeAt(8, 10, 20, 1.25)).toBe(20);
  });

  it("rejects invalid rhythmic inputs", () => {
    const clock = new TransportClock({ currentTime: 0 });
    expect(() =>
      clock.nextBeatBoundary({ anchorTime: 0, bpm: 0, boundaryBeats: 16 })
    ).toThrow(RangeError);
    expect(() => clock.resolveScheduleTime(1, -1)).toThrow(RangeError);
  });
});
