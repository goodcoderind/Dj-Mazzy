import { describe, expect, it, vi } from "vitest";
import { createMazzyRootErrorOptions } from "./reactRootErrorOptions";

describe("React root error privacy", () => {
  it("discards hostile caught and recoverable errors without logging", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stop = vi.fn();
    const options = createMazzyRootErrorOptions({ stopUncaughtAudio: stop });
    const hostile = new Error("secret-song.wav track-private-id /Users/private/stack");
    options.onCaughtError(hostile);
    options.onRecoverableError(hostile);
    expect(consoleError).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("stops existing audio without exposing an uncaught root error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stop = vi.fn();
    const options = createMazzyRootErrorOptions({ stopUncaughtAudio: stop });
    options.onUncaughtError(new Error("secret-song.wav /private/path"));
    expect(stop).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
