import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PipeCdp } from "./runPartyAppJourneyBrowser.mjs";

const fakeChrome = () => {
  const chrome = new EventEmitter();
  chrome.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  chrome.exitCode = null;
  return chrome;
};

const emitCdp = (chrome, message) => {
  chrome.stdio[4].write(`${JSON.stringify(message)}\0`);
};

describe("full App browser CDP monitoring", () => {
  it("keeps persistent safety observers alive beyond the old one-shot timeout", async () => {
    vi.useFakeTimers();
    try {
      const chrome = fakeChrome();
      const cdp = new PipeCdp(chrome);
      let observed = 0;
      cdp.subscribe("Runtime.exceptionThrown", "page", () => { observed += 1; });

      await vi.advanceTimersByTimeAsync(131_000);
      emitCdp(chrome, {
        sessionId: "page",
        method: "Runtime.exceptionThrown",
        params: { exceptionDetails: {} }
      });

      expect(observed).toBe(1);
      expect(cdp.observerFailed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed instead of silently dropping a known event backlog overflow", async () => {
    const chrome = fakeChrome();
    const cdp = new PipeCdp(chrome);
    const first = cdp.waitEvent("Page.loadEventFired", "page", 10_000);
    emitCdp(chrome, { sessionId: "page", method: "Page.loadEventFired", params: { ordinal: 0 } });
    await first;
    for (let ordinal = 1; ordinal <= 1_001; ordinal += 1) {
      emitCdp(chrome, { sessionId: "page", method: "Page.loadEventFired", params: { ordinal } });
    }
    expect(cdp.backlogOverflowed).toBe(true);
  });

  it("drains a rejecting asynchronous observer before the report boundary", async () => {
    const chrome = fakeChrome();
    const cdp = new PipeCdp(chrome);
    let rejectObserver;
    const observerSettlement = new Promise((_, reject) => { rejectObserver = reject; });
    cdp.subscribe("Fetch.requestPaused", "page", () => observerSettlement);
    emitCdp(chrome, { sessionId: "page", method: "Fetch.requestPaused", params: {} });

    const draining = cdp.closeAndDrainSubscriptions();
    expect(cdp.observerFailed).toBe(false);
    rejectObserver(new Error("fixed test failure"));
    await draining;

    expect(cdp.observerFailed).toBe(true);
    expect(cdp.inFlightSubscribers.size).toBe(0);
  });

  it("fails if in-flight worker setup tries to add child observers after close", async () => {
    const chrome = fakeChrome();
    const cdp = new PipeCdp(chrome);
    let releaseSetup;
    const setupGate = new Promise((resolve) => { releaseSetup = resolve; });
    cdp.subscribe("Target.attachedToTarget", undefined, async () => {
      await setupGate;
      cdp.subscribe("Runtime.exceptionThrown", "worker", () => undefined);
    });
    emitCdp(chrome, { method: "Target.attachedToTarget", params: {} });

    const draining = cdp.closeAndDrainSubscriptions();
    releaseSetup();
    await draining;

    expect(cdp.observerFailed).toBe(true);
  });
});
