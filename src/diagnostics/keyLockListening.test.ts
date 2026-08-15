import { describe, expect, it } from "vitest";
import {
  PRIVATE_LISTENING_EXCERPT_SECONDS,
  PRIVATE_LISTENING_MINIMUM_SECONDS,
  planPrivateExcerpt
} from "./keyLockListening";

describe("private key-lock listening excerpt", () => {
  it("selects a bounded excerpt around one-third into a long file", () => {
    const sampleRate = 48_000;
    const plan = planPrivateExcerpt(sampleRate * 120, sampleRate);
    expect(plan.frameCount).toBe(sampleRate * PRIVATE_LISTENING_EXCERPT_SECONDS);
    expect(plan.startFrame).toBe(Math.round(sampleRate * 120 * 0.34));
  });

  it("keeps a short but complete file from its beginning", () => {
    const sampleRate = 44_100;
    const plan = planPrivateExcerpt(sampleRate * PRIVATE_LISTENING_MINIMUM_SECONDS, sampleRate);
    expect(plan).toEqual({ frameCount: sampleRate * PRIVATE_LISTENING_MINIMUM_SECONDS, startFrame: 0 });
  });

  it("rejects a file too short to finish the handoff trial", () => {
    expect(() => planPrivateExcerpt(48_000 * (PRIVATE_LISTENING_MINIMUM_SECONDS - 0.01), 48_000)).toThrow(
      /too short/
    );
  });

  it("rejects malformed dimensions", () => {
    expect(() => planPrivateExcerpt(-1, 48_000)).toThrow(/invalid/);
    expect(() => planPrivateExcerpt(48_000, Number.NaN)).toThrow(/invalid/);
  });
});
