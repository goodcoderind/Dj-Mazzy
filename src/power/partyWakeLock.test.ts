import { describe, expect, it, vi } from "vitest";
import { createPartyWakeLockController } from "./partyWakeLock";

describe("party wake lock", () => {
  it("acquires and releases only while requested", async () => {
    const release = vi.fn(async () => undefined);
    const statuses: string[] = [];
    const controller = createPartyWakeLockController({
      request: async () => ({ release }),
      visibility: () => "visible",
      onStatus: (status) => statuses.push(status)
    });
    await controller.acquire();
    expect(statuses).toEqual(["requesting", "active"]);
    await controller.release();
    expect(release).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe("idle");
  });

  it("reports unavailable without blocking party control", async () => {
    const statuses: string[] = [];
    const controller = createPartyWakeLockController({
      request: async () => { throw new Error("not supported"); },
      visibility: () => "visible",
      onStatus: (status) => statuses.push(status)
    });
    await controller.acquire();
    expect(statuses).toEqual(["requesting", "unavailable"]);
  });

  it("releases a late acquisition after the party was paused", async () => {
    let resolveRequest!: (value: { release: () => Promise<void> }) => void;
    const release = vi.fn(async () => undefined);
    const controller = createPartyWakeLockController({
      request: () => new Promise((resolve) => { resolveRequest = resolve; }),
      visibility: () => "visible"
    });
    const acquiring = controller.acquire();
    await controller.release();
    resolveRequest({ release });
    await acquiring;
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not let an old release overwrite a newer active request", async () => {
    let finishOldRelease!: () => void;
    const statuses: string[] = [];
    const oldSentinel = { release: () => new Promise<void>((resolve) => { finishOldRelease = resolve; }) };
    const newSentinel = { release: vi.fn(async () => undefined) };
    let requests = 0;
    const controller = createPartyWakeLockController({
      request: async () => ++requests === 1 ? oldSentinel : newSentinel,
      visibility: () => "visible",
      onStatus: (status) => statuses.push(status)
    });
    await controller.acquire();
    const releasing = controller.release();
    await controller.acquire();
    finishOldRelease();
    await releasing;
    expect(statuses.at(-1)).toBe("active");
  });

  it("reacquires after a browser-released sentinel becomes visible", async () => {
    let releaseListener: (() => void) | undefined;
    let visible: DocumentVisibilityState = "hidden";
    const first = {
      released: false,
      release: vi.fn(async () => undefined),
      addEventListener: (_type: "release", listener: () => void) => { releaseListener = listener; }
    };
    const second = { release: vi.fn(async () => undefined) };
    let requests = 0;
    const controller = createPartyWakeLockController({
      request: async () => ++requests === 1 ? first : second,
      visibility: () => visible
    });
    visible = "visible";
    await controller.acquire();
    first.released = true;
    controller.onVisibilityChange();
    await Promise.resolve();
    releaseListener?.();
    await Promise.resolve();
    expect(requests).toBe(2);
  });
});
