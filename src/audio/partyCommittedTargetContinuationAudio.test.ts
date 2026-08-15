import { describe, expect, it } from "vitest";
import {
  runPartyCommittedTargetAudioTransaction,
  type CommittedTargetSnapshot,
  type PartyCommittedTargetAudioAdapter
} from "./partyCommittedTargetContinuationAudio";

const harness = (fault: "none" | "start" | "gain" | "post" = "none") => {
  let owned = true;
  let active = false;
  let gain = 0.37;
  let snapshot: CommittedTargetSnapshot = { trackId: "target", status: "ready", playbackRate: 1 };
  const calls: string[] = [];
  const adapter: PartyCommittedTargetAudioAdapter = {
    sampleRate: 48_000,
    now: () => 10,
    authority: () => owned,
    revokeAuthority: () => { calls.push("revoke"); owned = false; },
    getSnapshot: () => snapshot,
    isActive: () => active,
    isExactTarget: (value) => value?.trackId === "target",
    getGain: () => gain,
    setGain: (value) => { calls.push(`gain:${value}`); gain = value; },
    playReadyAtIfRunning: (startTime, offset, authority) => {
      calls.push(`start:${startTime}:${offset}`);
      if (fault === "start") throw new Error("start failed");
      if (!authority()) return null;
      active = true;
      snapshot = { ...snapshot, status: "scheduled" };
      return { scheduledStart: startTime, snapshot };
    },
    scheduleGainCurve: (_curve, startTime, duration, authority) => {
      calls.push(`curve:${startTime}:${duration}`);
      if (fault === "gain") throw new Error("gain failed");
      if (!authority()) throw new Error("authority expired");
      gain = 1;
      if (fault === "post") snapshot = { ...snapshot, trackId: "replacement" };
      return startTime;
    },
    pause: () => { calls.push("pause"); active = false; snapshot = { ...snapshot, status: "paused" }; }
  };
  return { adapter, calls, get gain() { return gain; }, get active() { return active; } };
};

describe("committed target audio transaction", () => {
  it("mutes, starts from zero, schedules the shared ramp, and revokes exactly once", () => {
    const test = harness();
    const result = runPartyCommittedTargetAudioTransaction(test.adapter);
    expect(result).toMatchObject({ status: "scheduled", reason: "scheduled", cleanupConfirmed: true });
    expect(result.scheduledStart).toBeCloseTo(10.03, 6);
    expect(test.calls).toEqual(["gain:0", "start:10.03:0", "curve:10.03:0.08", "revoke"]);
    expect(test.active).toBe(true);
    expect(test.gain).toBe(1);
  });

  it.each(["start", "gain"] as const)("rolls back exact gain and playback after a %s failure", (fault) => {
    const test = harness(fault);
    const result = runPartyCommittedTargetAudioTransaction(test.adapter);
    expect(result.status).toBe("failed");
    expect(result.cleanupConfirmed).toBe(true);
    expect(test.active).toBe(false);
    expect(test.gain).toBeCloseTo(0.37, 8);
    expect(test.calls.indexOf("revoke")).toBeLessThan(test.calls.indexOf("pause"));
  });

  it("never touches a replacement target during failed postcondition cleanup", () => {
    const test = harness("post");
    const result = runPartyCommittedTargetAudioTransaction(test.adapter);
    expect(result).toMatchObject({ status: "failed", reason: "postcondition-failed", cleanupConfirmed: false });
    expect(test.calls).not.toContain("pause");
  });

  it("rejects non-ready and non-unit-rate targets before gain mutation", () => {
    for (const snapshot of [
      { trackId: "target", status: "paused", playbackRate: 1 },
      { trackId: "target", status: "ready", playbackRate: 0.94 }
    ]) {
      const test = harness();
      const original = test.adapter.getSnapshot;
      const result = runPartyCommittedTargetAudioTransaction({ ...test.adapter, getSnapshot: () => snapshot ?? original() });
      expect(result).toMatchObject({ status: "failed", reason: "target-not-ready", cleanupConfirmed: true });
      expect(test.calls).toEqual(["revoke"]);
    }
  });
});
