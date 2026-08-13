import { describe, expect, it } from "vitest";
import { createBeatAuditionEvents } from "./BeatGridAudition";

describe("beat-grid audition scheduling", () => {
  it("maps track beats to the audio clock at the active playback rate", () => {
    const events = createBeatAuditionEvents({
      beatsSeconds: [0, 0.5, 1, 1.5, 2],
      downbeatsSeconds: [0, 2],
      trackPositionSeconds: 0.75,
      playbackRate: 1.25,
      audioStartTime: 10,
      schedulingLeadSeconds: 0,
      maxBeats: 3
    });
    expect(events).toEqual([
      { audioTime: 10.2, trackTime: 1, downbeat: false },
      { audioTime: 10.6, trackTime: 1.5, downbeat: false },
      { audioTime: 11, trackTime: 2, downbeat: true }
    ]);
  });

  it("skips unschedulable clicks without shifting the remaining grid", () => {
    const events = createBeatAuditionEvents({
      beatsSeconds: [0.76, 1, 1.5],
      downbeatsSeconds: [],
      trackPositionSeconds: 0.75,
      playbackRate: 1,
      audioStartTime: 10,
      schedulingLeadSeconds: 0.03
    });
    expect(events.map((event) => event.audioTime)).toEqual([10.25, 10.75]);
  });

  it("refuses invalid playback rates", () => {
    expect(
      createBeatAuditionEvents({
        beatsSeconds: [0, 0.5],
        downbeatsSeconds: [],
        trackPositionSeconds: 0,
        playbackRate: 0,
        audioStartTime: 1
      })
    ).toEqual([]);
  });
});
