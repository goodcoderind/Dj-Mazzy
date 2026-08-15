import { describe, expect, it, vi } from "vitest";
import {
  captureFatalHostFailure,
  createFatalHostAudioSafetyController,
  fatalHostRecoveryView
} from "./fatalHostAudioSafety";

describe("fatal host audio safety", () => {
  it("revokes first and reports only an exact confirmed shutdown", () => {
    const order: string[] = [];
    const releaseWakeLock = vi.fn(() => { order.push("wake"); });
    const controller = createFatalHostAudioSafetyController({
      revokeExistingEngine: () => {
        order.push("revoke");
        return {
          shutdownForFatalHostError: () => {
            order.push("shutdown");
            return { version: "fatal-host-audio-shutdown/v1", outcome: "confirmed-stopped" };
          }
        };
      },
      releaseWakeLock
    });
    expect(controller.stopExistingAudio()).toEqual({
      version: "fatal-host-audio-safety/v1",
      outcome: "confirmed-stopped"
    });
    expect(order).toEqual(["revoke", "shutdown", "wake"]);
  });

  it("fails closed on a thrown or malformed cleanup and remains retryable", () => {
    let attempt = 0;
    const controller = createFatalHostAudioSafetyController({
      revokeExistingEngine: () => ({
        shutdownForFatalHostError: () => {
          attempt += 1;
          if (attempt === 1) throw new Error("private teardown detail");
          return { version: "fatal-host-audio-shutdown/v1", outcome: "confirmed-stopped" };
        }
      })
    });
    expect(controller.stopExistingAudio().outcome).toBe("uncertain");
    expect(controller.stopExistingAudio().outcome).toBe("confirmed-stopped");
  });

  it("projects hostile errors to fixed private recovery copy", () => {
    const privateText = "secret-song.wav track-private-id /Users/private/stack";
    const state = captureFatalHostFailure(new Error(privateText), () => ({
      version: "fatal-host-audio-safety/v1",
      outcome: "uncertain"
    }));
    const view = fatalHostRecoveryView(state.outcome);
    const serialized = JSON.stringify({ state, view });
    expect(serialized).not.toContain("secret-song");
    expect(serialized).not.toContain("track-private-id");
    expect(serialized).not.toContain("/Users/private");
    expect(view.message).toContain("speaker mute");
  });

  it("treats an absent engine as already stopped", () => {
    const controller = createFatalHostAudioSafetyController({
      revokeExistingEngine: () => null
    });
    expect(controller.stopExistingAudio().outcome).toBe("confirmed-stopped");
  });
});
