import { describe, expect, it } from "vitest";
import {
  advancePartyAutopilotTickEpoch,
  claimPartyAutopilotTickFailure,
  createPartyAutopilotTickBoundary,
  issuePartyAutopilotTick,
  ownsPartyAutopilotTick,
  runPartyAutopilotTickTask
} from "./partyAutopilotTickBoundary";

describe("Party Autopilot tick boundary", () => {
  it("allows overlapping observation tickets in one epoch", () => {
    const initial = createPartyAutopilotTickBoundary();
    const first = issuePartyAutopilotTick(initial);
    const second = issuePartyAutopilotTick(first.boundary);
    expect(ownsPartyAutopilotTick(second.boundary, first.ticket)).toBe(true);
    expect(ownsPartyAutopilotTick(second.boundary, second.ticket)).toBe(true);
  });

  it("invalidates every prior ticket when authority advances", () => {
    const issued = issuePartyAutopilotTick(createPartyAutopilotTickBoundary());
    const advanced = advancePartyAutopilotTickEpoch(issued.boundary);
    expect(ownsPartyAutopilotTick(advanced, issued.ticket)).toBe(false);
    const successor = issuePartyAutopilotTick(advanced);
    expect(ownsPartyAutopilotTick(successor.boundary, successor.ticket)).toBe(true);
  });

  it("allows exactly one fatal claim and invalidates sibling tickets", () => {
    const first = issuePartyAutopilotTick(createPartyAutopilotTickBoundary());
    const second = issuePartyAutopilotTick(first.boundary);
    const claimed = claimPartyAutopilotTickFailure(second.boundary, first.ticket);
    expect(claimed.claimed).toBe(true);
    expect(ownsPartyAutopilotTick(claimed.boundary, first.ticket)).toBe(false);
    expect(ownsPartyAutopilotTick(claimed.boundary, second.ticket)).toBe(false);
    expect(claimPartyAutopilotTickFailure(claimed.boundary, second.ticket).claimed).toBe(false);
  });

  it("cannot let a stale epoch claim a successor failure", () => {
    const original = issuePartyAutopilotTick(createPartyAutopilotTickBoundary());
    const advanced = advancePartyAutopilotTickEpoch(original.boundary);
    expect(claimPartyAutopilotTickFailure(advanced, original.ticket).claimed).toBe(false);
  });

  it("fails closed at unsafe counter boundaries", () => {
    const initial = createPartyAutopilotTickBoundary();
    expect(() => issuePartyAutopilotTick({ ...initial, nextOperation: Number.MAX_SAFE_INTEGER }))
      .toThrow(RangeError);
    expect(() => advancePartyAutopilotTickEpoch({ ...initial, epoch: Number.MAX_SAFE_INTEGER }))
      .toThrow(RangeError);
  });

  it("contains task rejection and reports the last authoritative phase", async () => {
    const phases: string[] = [];
    await expect(runPartyAutopilotTickTask({
      task: async (setPhase) => {
        setPhase("preload");
        throw new Error("decode adapter rejected");
      },
      onFailure: (phase) => { phases.push(phase); }
    })).resolves.toBeUndefined();
    expect(phases).toEqual(["preload"]);
  });

  it("contains a second failure inside fatal cleanup", async () => {
    await expect(runPartyAutopilotTickTask({
      task: async () => { throw new Error("planner failed"); },
      onFailure: () => { throw new Error("cleanup failed"); }
    })).resolves.toBeUndefined();
  });
});
