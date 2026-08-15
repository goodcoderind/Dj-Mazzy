import { describe, expect, it } from "vitest";
import {
  captureDeckTransportAuthority,
  createDeckTransportAuthority,
  invalidateDeckTransportAuthority,
  ownsDeckTransportAuthority
} from "./deckTransportAuthority";

describe("deck transport authority", () => {
  it("revokes an async start captured before Stop All Sound", () => {
    const authority = createDeckTransportAuthority();
    const pendingStart = captureDeckTransportAuthority(authority);

    invalidateDeckTransportAuthority(authority);

    expect(ownsDeckTransportAuthority(authority, pendingStart)).toBe(false);
    expect(ownsDeckTransportAuthority(authority, captureDeckTransportAuthority(authority))).toBe(true);
  });

  it("keeps repeated invalidation monotonic and rejects malformed tokens", () => {
    const authority = createDeckTransportAuthority();
    const first = invalidateDeckTransportAuthority(authority);
    const second = invalidateDeckTransportAuthority(authority);

    expect(second).toBe(first + 1);
    expect(ownsDeckTransportAuthority(authority, Number.NaN)).toBe(false);
    expect(ownsDeckTransportAuthority(authority, 1.5)).toBe(false);
  });

  it("moves away from a maximum-safe pending token without overflowing", () => {
    const authority = { revision: Number.MAX_SAFE_INTEGER };
    const pendingStart = captureDeckTransportAuthority(authority);

    expect(invalidateDeckTransportAuthority(authority)).toBe(1);
    expect(ownsDeckTransportAuthority(authority, pendingStart)).toBe(false);
  });
});
