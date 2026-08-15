import { describe, expect, it, vi } from "vitest";
import { createFatalHostEventBoundary } from "./fatalHostEventBoundary";

describe("fatal host event boundary", () => {
  it("stops audio before publishing a fixed pre-mount snapshot", () => {
    const order: string[] = [];
    const boundary = createFatalHostEventBoundary({
      stopAudio: () => { order.push("stop"); return { outcome: "confirmed-stopped" }; }
    });
    boundary.subscribe(() => order.push("notify"));
    const preventDefault = vi.fn(() => order.push("prevent"));
    const hostile = new Error("private-song.wav track-id /Users/private/stack");

    const state = boundary.capture(hostile, preventDefault);

    expect(order).toEqual(["prevent", "stop", "notify"]);
    expect(state).toMatchObject({ failed: true, outcome: "confirmed-stopped", revision: 1 });
    expect(JSON.stringify(state)).not.toContain("private-song");
  });

  it("installs both page event listeners and prevents their defaults", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const target = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type))
    };
    const stopAudio = vi.fn(() => ({ outcome: "uncertain" }));
    const boundary = createFatalHostEventBoundary({ stopAudio });
    const uninstall = boundary.install(target);
    const firstPrevent = vi.fn();
    const secondPrevent = vi.fn();

    listeners.get("error")?.({ error: new Error("private"), preventDefault: firstPrevent });
    listeners.get("unhandledrejection")?.({ reason: new Error("private"), preventDefault: secondPrevent });

    expect(firstPrevent).toHaveBeenCalledOnce();
    expect(secondPrevent).toHaveBeenCalledOnce();
    expect(stopAudio).toHaveBeenCalledTimes(2);
    expect(boundary.snapshot()).toMatchObject({ failed: true, outcome: "uncertain", revision: 1 });
    uninstall();
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("allows an exact shutdown retry to improve uncertainty without downgrade", () => {
    let attempt = 0;
    const listener = vi.fn(() => { throw new Error("detached view"); });
    const boundary = createFatalHostEventBoundary({
      stopAudio: () => ({ outcome: ++attempt === 1 ? "uncertain" : "confirmed-stopped" })
    });
    boundary.subscribe(listener);

    expect(boundary.capture(null).outcome).toBe("uncertain");
    expect(boundary.retryStop().outcome).toBe("confirmed-stopped");
    expect(boundary.capture(null).outcome).toBe("confirmed-stopped");
    expect(boundary.snapshot().revision).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("replays a failure captured before a recovery view subscribes", () => {
    const boundary = createFatalHostEventBoundary({
      stopAudio: () => ({ outcome: "uncertain" })
    });
    boundary.capture(new Error("private pre-mount detail"));
    const subscriber = vi.fn();

    boundary.subscribe(subscriber);

    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({
      failed: true,
      outcome: "uncertain",
      revision: 1
    }));
  });
});
