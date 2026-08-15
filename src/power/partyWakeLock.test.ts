import { describe, expect, it, vi } from "vitest";
import {
  PARTY_WAKE_LOCK_VERSION,
  createPartyWakeLockController,
  partyWakeLockStatusMessage
} from "./partyWakeLock";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("party wake lock", () => {
  it("projects bounded, advisory-only host guidance", () => {
    expect(partyWakeLockStatusMessage("requesting")).toBe("Asking the browser to keep this screen awake…");
    expect(partyWakeLockStatusMessage("active")).toBe("Mazzy asked this screen to stay awake while Autopilot runs.");
    expect(partyWakeLockStatusMessage("unavailable")).toBe(
      "Mazzy could not confirm screen wake. Keep the computer powered and awake while Autopilot runs."
    );
  });

  it("bounds a never-settling browser request and refuses visibility fan-out", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const statuses: string[] = [];
    const controller = createPartyWakeLockController({
      request,
      visibility: () => "visible",
      onStatus: (status) => statuses.push(status),
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: (callback) => { wake = callback; return 1 as ReturnType<typeof setTimeout>; },
      clearScheduledTimeout: vi.fn()
    });

    const acquisition = controller.acquire();
    expect(controller.version).toBe(PARTY_WAKE_LOCK_VERSION);
    clock = 10;
    wake();
    await acquisition;
    expect(statuses).toEqual(["requesting", "unavailable"]);
    expect(controller.snapshot()).toMatchObject({ acquiring: true, timedOut: true });
    controller.onVisibilityChange();
    await controller.acquire();
    expect(request).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe("unavailable");
  });

  it("rejects a throttled post-deadline sentinel and keeps manual guidance", async () => {
    let clock = 0;
    let resolveRequest!: (value: { release: () => Promise<void> }) => void;
    const release = vi.fn(async () => undefined);
    const statuses: string[] = [];
    const controller = createPartyWakeLockController({
      request: () => new Promise((resolve) => { resolveRequest = resolve; }),
      visibility: () => "visible",
      onStatus: (status) => statuses.push(status),
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });

    const acquisition = controller.acquire();
    clock = 11;
    resolveRequest({ release });
    await acquisition;
    await flush();
    expect(release).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["requesting", "unavailable"]);
    expect(controller.snapshot()).toMatchObject({ acquiring: false, retainedSentinel: false });
  });

  it("accepts one sentinel strictly before its deadline", async () => {
    let clock = 0;
    const statuses: string[] = [];
    const controller = createPartyWakeLockController({
      request: async () => ({ release: vi.fn(async () => undefined) }),
      visibility: () => "visible",
      onStatus: (status) => statuses.push(status),
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: () => 1 as ReturnType<typeof setTimeout>,
      clearScheduledTimeout: vi.fn()
    });
    const acquisition = controller.acquire();
    clock = 9.999;
    await acquisition;
    expect(statuses).toEqual(["requesting", "active"]);
  });

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

  it("retains a rejected late acquisition so fatal Stop can retry it", async () => {
    let resolveRequest!: (value: { release: () => Promise<void>; released?: boolean }) => void;
    const release = vi.fn()
      .mockRejectedValueOnce(new Error("temporary late release failure"))
      .mockResolvedValueOnce(undefined);
    const controller = createPartyWakeLockController({
      request: () => new Promise((resolve) => { resolveRequest = resolve; }),
      visibility: () => "visible"
    });
    const acquiring = controller.acquire();
    await controller.releaseForHostTeardown();
    resolveRequest({ release, released: false });
    await acquiring;
    await flush();
    await controller.releaseForHostTeardown();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("retains a timed-out sentinel whose late release fails until teardown retries it", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    let resolveRequest!: (value: { release: () => Promise<void>; released?: boolean }) => void;
    const release = vi.fn()
      .mockRejectedValueOnce(new Error("temporary late release failure"))
      .mockResolvedValueOnce(undefined);
    const controller = createPartyWakeLockController({
      request: () => new Promise((resolve) => { resolveRequest = resolve; }),
      visibility: () => "visible",
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: (callback) => { wake = callback; return 1 as ReturnType<typeof setTimeout>; },
      clearScheduledTimeout: vi.fn()
    });
    const acquisition = controller.acquire();
    clock = 10;
    wake();
    await acquisition;
    resolveRequest({ release, released: false });
    await flush();
    expect(controller.snapshot()).toMatchObject({
      retainedSentinel: true,
      activeSentinel: false,
      cleanupSentinel: true
    });
    await controller.acquire();
    expect(release).toHaveBeenCalledOnce();
    expect(controller.snapshot().activeSentinel).toBe(false);
    await controller.releaseForHostTeardown();
    expect(release).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().retainedSentinel).toBe(false);
  });

  it("lets fatal teardown retry an exact timed-out sentinel while its first release is unresolved", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    let resolveRequest!: (value: { release: () => Promise<void>; released?: boolean }) => void;
    let finishFirstRelease!: () => void;
    const release = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstRelease = resolve; }))
      .mockResolvedValueOnce(undefined);
    const request = vi.fn(() => new Promise<{ release: () => Promise<void>; released?: boolean }>(
      (resolve) => { resolveRequest = resolve; }
    ));
    const controller = createPartyWakeLockController({
      request,
      visibility: () => "visible",
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: (callback) => { wake = callback; return 1 as ReturnType<typeof setTimeout>; },
      clearScheduledTimeout: vi.fn()
    });
    const acquisition = controller.acquire();
    clock = 10;
    wake();
    await acquisition;
    resolveRequest({ release, released: false });
    await flush();
    expect(controller.snapshot().cleanupSentinel).toBe(true);

    await controller.releaseForHostTeardown();
    expect(release).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().retainedSentinel).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    finishFirstRelease();
  });

  it("releases for root teardown without updating the failed React subtree", async () => {
    const release = vi.fn(async () => undefined);
    const onStatus = vi.fn();
    const controller = createPartyWakeLockController({
      request: async () => ({ release }),
      visibility: () => "visible",
      onStatus
    });
    await controller.acquire();
    onStatus.mockClear();
    await controller.releaseForHostTeardown();
    expect(release).toHaveBeenCalledOnce();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("retains a rejected fatal release owner so Stop can retry it", async () => {
    const release = vi.fn()
      .mockRejectedValueOnce(new Error("temporary wake-lock release failure"))
      .mockResolvedValueOnce(undefined);
    const controller = createPartyWakeLockController({
      request: async () => ({ release }),
      visibility: () => "visible"
    });
    await controller.acquire();
    await controller.releaseForHostTeardown();
    await controller.releaseForHostTeardown();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not let an old release overwrite a newer active request", async () => {
    let finishOldRelease!: () => void;
    let oldReleaseListener: (() => void) | undefined;
    const statuses: string[] = [];
    const oldSentinel = {
      release: () => new Promise<void>((resolve) => { finishOldRelease = resolve; }),
      addEventListener: (_type: "release", listener: () => void) => { oldReleaseListener = listener; }
    };
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
    await flush();
    expect(requests).toBe(2);
    expect(controller.snapshot()).toMatchObject({
      wanted: true,
      retainedSentinel: true,
      activeSentinel: true,
      cleanupSentinel: false,
      acquiring: false
    });
    expect(statuses.at(-1)).toBe("active");
    oldReleaseListener?.();
    await flush();
    expect(requests).toBe(2);
  });

  it("starts one successor when timeout cleanup finishes after Pause and Restart", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    let resolveRequest!: (value: { release: () => Promise<void>; released?: boolean }) => void;
    let finishFirstRelease!: () => void;
    let finishPauseRelease!: () => void;
    const oldRelease = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstRelease = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishPauseRelease = resolve; }));
    const newSentinel = { release: vi.fn(async () => undefined) };
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }))
      .mockResolvedValueOnce(newSentinel);
    const controller = createPartyWakeLockController({
      request,
      visibility: () => "visible",
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: (callback) => { wake = callback; return 1 as ReturnType<typeof setTimeout>; },
      clearScheduledTimeout: vi.fn()
    });

    const acquisition = controller.acquire();
    clock = 10;
    wake();
    await acquisition;
    resolveRequest({ release: oldRelease, released: false });
    await flush();
    expect(oldRelease).toHaveBeenCalledOnce();

    const pausing = controller.release();
    await flush();
    expect(oldRelease).toHaveBeenCalledTimes(2);
    await controller.acquire();
    expect(request).toHaveBeenCalledOnce();

    finishFirstRelease();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      wanted: true,
      activeSentinel: true,
      cleanupSentinel: false
    });

    finishPauseRelease();
    await pausing;
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().activeSentinel).toBe(true);
  });

  it("does not reuse an old cleanup retry latch after visibility admits its successor", async () => {
    let clock = 0;
    let wake: () => void = () => undefined;
    const requestResolvers: Array<(value: { release: () => Promise<void>; released?: boolean }) => void> = [];
    const request = vi.fn(() => new Promise<{ release: () => Promise<void>; released?: boolean }>(
      (resolve) => requestResolvers.push(resolve)
    ));
    const firstLate = {
      released: false,
      release: vi.fn().mockRejectedValueOnce(new Error("late cleanup failed"))
    };
    const secondLate = {
      released: false,
      release: vi.fn(async () => undefined)
    };
    const statuses: string[] = [];
    const controller = createPartyWakeLockController({
      request,
      visibility: () => "visible",
      onStatus: (status) => statuses.push(status),
      now: () => clock,
      timeoutMilliseconds: 10,
      scheduleTimeout: (callback) => { wake = callback; return 1 as ReturnType<typeof setTimeout>; },
      clearScheduledTimeout: vi.fn()
    });

    const first = controller.acquire();
    clock = 10;
    wake();
    await first;
    requestResolvers[0](firstLate);
    await flush();
    expect(controller.snapshot().cleanupSentinel).toBe(true);

    await controller.acquire();
    firstLate.released = true;
    controller.onVisibilityChange();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    clock = 20;
    wake();
    requestResolvers[1](secondLate);
    await flush();
    expect(secondLate.release).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("unavailable");
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

  it("contains throwing status projection without weakening ownership", async () => {
    const release = vi.fn(async () => undefined);
    const controller = createPartyWakeLockController({
      request: async () => ({ release }),
      visibility: () => "visible",
      onStatus: () => { throw new Error("detached UI"); }
    });
    await expect(controller.acquire()).resolves.toBeUndefined();
    expect(controller.snapshot().retainedSentinel).toBe(true);
    await expect(controller.release()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });
});
