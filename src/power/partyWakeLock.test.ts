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
});
