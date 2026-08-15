import { afterEach, describe, expect, it, vi } from "vitest";
import {
  broadcastEnhancedTimingRemovalStarted,
  ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION,
  ENHANCED_TIMING_REMOVAL_TAB_ORIGIN_ID,
  enhancedTimingObservationIsLocallyOwned,
  projectEnhancedTimingRevocationObservation,
  subscribeToEnhancedTimingRemoval
} from "./enhancedTimingRemovalChannel";

type Listener = (event: MessageEvent) => void;

const originalBroadcastChannel = globalThis.BroadcastChannel;

afterEach(() => {
  if (originalBroadcastChannel) vi.stubGlobal("BroadcastChannel", originalBroadcastChannel);
  else vi.unstubAllGlobals();
});

describe("enhanced timing removal channel", () => {
  it("does not misclassify a local removal while its post-proof observation is deferred", () => {
    const allowedOne = { authority: { epoch: 1, token: "authority-token-000001" }, revoked: false };
    const revokedTwo = { authority: { epoch: 2, token: "authority-token-000002" }, revoked: true };
    const allowedThree = { authority: { epoch: 3, token: "authority-token-000003" }, revoked: false };
    const observedWhileLocalOwnerIsLive = projectEnhancedTimingRevocationObservation({
      initialize: false,
      baseline: allowedOne,
      observed: revokedTwo,
      localObservationOwned: enhancedTimingObservationIsLocallyOwned({
        observed: revokedTwo,
        prepareAuthority: null,
        removalActive: true
      })
    });
    expect(observedWhileLocalOwnerIsLive).toEqual({ applyRemote: false, nextBaseline: revokedTwo });
    expect(projectEnhancedTimingRevocationObservation({
      initialize: false,
      baseline: observedWhileLocalOwnerIsLive.nextBaseline,
      observed: revokedTwo,
      localObservationOwned: false
    })).toEqual({ applyRemote: false, nextBaseline: revokedTwo });
    expect(projectEnhancedTimingRevocationObservation({
      initialize: false,
      baseline: allowedOne,
      observed: revokedTwo,
      localObservationOwned: false
    })).toEqual({ applyRemote: true, nextBaseline: revokedTwo });

    const explicitPrepare = projectEnhancedTimingRevocationObservation({
      initialize: false,
      baseline: revokedTwo,
      observed: allowedThree,
      localObservationOwned: enhancedTimingObservationIsLocallyOwned({
        observed: allowedThree,
        prepareAuthority: allowedThree.authority,
        removalActive: false
      })
    });
    expect(explicitPrepare).toEqual({ applyRemote: false, nextBaseline: allowedThree });
    expect(projectEnhancedTimingRevocationObservation({
      initialize: false,
      baseline: explicitPrepare.nextBaseline,
      observed: { authority: { epoch: 4, token: "authority-token-000004" }, revoked: true },
      localObservationOwned: false
    }).applyRemote).toBe(true);

    expect(projectEnhancedTimingRevocationObservation({
      initialize: false,
      baseline: allowedOne,
      observed: allowedThree,
      localObservationOwned: enhancedTimingObservationIsLocallyOwned({
        observed: allowedThree,
        prepareAuthority: allowedOne.authority,
        removalActive: false
      })
    }).applyRemote).toBe(true);
  });

  it("does not let a local prepare consume a foreign allowed authority", () => {
    const local = { authority: { epoch: 7, token: "authority-token-000007" }, revoked: false };
    const foreign = { authority: { epoch: 8, token: "authority-token-000008" }, revoked: false };
    const localObservationOwned = enhancedTimingObservationIsLocallyOwned({
      observed: foreign,
      prepareAuthority: local.authority,
      removalActive: false
    });
    expect(localObservationOwned).toBe(false);
    expect(projectEnhancedTimingRevocationObservation({
      initialize: false,
      baseline: local,
      observed: foreign,
      localObservationOwned
    })).toEqual({ applyRemote: true, nextBaseline: foreign });
  });

  it("publishes only the fixed removal-start message and closes", () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("BroadcastChannel", class {
      postMessage = postMessage;
      close = close;
      addEventListener() {}
      removeEventListener() {}
    });

    expect(broadcastEnhancedTimingRemovalStarted()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      version: ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION,
      type: "removal-started",
      originId: ENHANCED_TIMING_REMOVAL_TAB_ORIGIN_ID
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts only the fixed normalized message and contains listener failures", () => {
    let installed: Listener | null = null;
    const removeEventListener = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("BroadcastChannel", class {
      postMessage() {}
      addEventListener(_type: string, listener: Listener) { installed = listener; }
      removeEventListener = removeEventListener;
      close = close;
    });
    const listener = vi.fn(() => { throw new Error("private failure"); });
    const unsubscribe = subscribeToEnhancedTimingRemoval(listener);

    expect(() => installed?.({ data: { version: "wrong", type: "removal-started", originId: "foreign-tab-origin-0001" } } as MessageEvent)).not.toThrow();
    expect(() => installed?.({
      data: { version: ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION, type: "removal-started", extra: "ignored" }
    } as MessageEvent)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(() => installed?.({
      data: {
        version: ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION,
        type: "removal-started",
        originId: ENHANCED_TIMING_REMOVAL_TAB_ORIGIN_ID
      }
    } as MessageEvent)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(() => installed?.({
      data: {
        version: ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION,
        type: "removal-started",
        originId: "foreign-tab-origin-0001"
      }
    } as MessageEvent)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(() => { unsubscribe(); unsubscribe(); }).not.toThrow();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("contains constructor, post, registration, and cleanup failures", () => {
    vi.stubGlobal("BroadcastChannel", class {
      constructor() { throw new Error("unavailable"); }
    });
    expect(broadcastEnhancedTimingRemovalStarted()).toBe(false);
    expect(() => subscribeToEnhancedTimingRemoval(() => undefined)()).not.toThrow();

    vi.stubGlobal("BroadcastChannel", class {
      postMessage() { throw new Error("post failed"); }
      addEventListener() { throw new Error("listen failed"); }
      removeEventListener() { throw new Error("remove failed"); }
      close() { throw new Error("close failed"); }
    });
    expect(broadcastEnhancedTimingRemovalStarted()).toBe(false);
    expect(() => subscribeToEnhancedTimingRemoval(() => undefined)()).not.toThrow();
  });
});
