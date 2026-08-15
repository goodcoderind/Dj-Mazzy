import { describe, expect, it } from "vitest";
import {
  DECK_LOAD_PURPOSE,
  DECK_LOAD_READINESS_VERSION,
  DECK_LOAD_TRIM_PROOF_TOLERANCE_DB,
  commitDecodedDeckReadiness,
  decideDeckLoadReadiness,
  ownsDeckLoadReadiness,
  runDeckPostDecodeLoad,
  shouldAutoEjectDeckLoadFailure
} from "./deckLoadReadiness";

describe("deck load readiness", () => {
  it("keeps manual loads on the existing inline-analysis contract", () => {
    expect(decideDeckLoadReadiness({
      purpose: DECK_LOAD_PURPOSE.manual,
      hasCurrentBasicAnalysis: false,
      cachedTrimDb: null
    })).toEqual({
      version: DECK_LOAD_READINESS_VERSION,
      kind: "run-inline-analysis"
    });
  });

  it("leaves first-song failure cleanup to its exact owner", () => {
    expect(shouldAutoEjectDeckLoadFailure({
      purpose: DECK_LOAD_PURPOSE.partyFirstSong,
      outcome: "unplayable-file"
    })).toBe(false);
    expect(shouldAutoEjectDeckLoadFailure({
      purpose: DECK_LOAD_PURPOSE.manual,
      outcome: "unplayable-file"
    })).toBe(true);
    expect(shouldAutoEjectDeckLoadFailure({
      purpose: DECK_LOAD_PURPOSE.autoPilotPreload,
      outcome: "cancelled"
    })).toBe(false);
  });

  it("publishes the Party first song after decode without constructing inline analysis", () => {
    const decision = decideDeckLoadReadiness({
      purpose: DECK_LOAD_PURPOSE.partyFirstSong,
      hasCurrentBasicAnalysis: false,
      cachedTrimDb: null
    });
    expect(decision).toMatchObject({
      kind: "publish-decoded",
      timingFacts: "none",
      levelTrim: "neutral",
      safeFadeOnly: true,
      trimDb: 0
    });
    let inlineFactoryCalls = 0;
    expect(runDeckPostDecodeLoad({
      decision,
      publishDecoded: () => "ready",
      runInlineAnalysis: () => {
        inlineFactoryCalls += 1;
        return new Promise(() => undefined);
      }
    })).toBe("ready");
    expect(inlineFactoryCalls).toBe(0);
  });

  it("publishes a fully cached Autopilot load as analyzed", () => {
    expect(decideDeckLoadReadiness({
      purpose: DECK_LOAD_PURPOSE.autoPilotPreload,
      hasCurrentBasicAnalysis: true,
      cachedTrimDb: -2.4
    })).toEqual({
      version: DECK_LOAD_READINESS_VERSION,
      kind: "publish-decoded",
      timingFacts: "cached-basic",
      levelTrim: "cached",
      safeFadeOnly: false,
      applyCachedBasicAnalysis: true,
      trimDb: -2.4,
      levelStatus: "ready",
      reason: "cached-analysis"
    });
  });

  it.each([
    [true, null, "level-analysis-pending", 0],
    [false, -1.2, "basic-analysis-pending", -1.2],
    [false, null, "basic-and-level-analysis-pending", 0],
    [false, Number.NaN, "basic-and-level-analysis-pending", 0],
    [false, 3.1, "basic-and-level-analysis-pending", 0],
    [false, -6.1, "basic-and-level-analysis-pending", 0]
  ])("freezes missing or malformed Autopilot facts into a conservative load", (hasBasic, trim, reason, expectedTrim) => {
    expect(decideDeckLoadReadiness({
      purpose: DECK_LOAD_PURPOSE.autoPilotPreload,
      hasCurrentBasicAnalysis: hasBasic,
      cachedTrimDb: trim
    })).toMatchObject({
      kind: "publish-decoded",
      timingFacts: hasBasic ? "cached-basic" : "none",
      levelTrim: trim != null && Number.isFinite(trim) && trim >= -6 && trim <= 3 ? "cached" : "neutral",
      safeFadeOnly: !hasBasic,
      applyCachedBasicAnalysis: hasBasic,
      trimDb: expectedTrim,
      levelStatus: trim != null && Number.isFinite(trim) && trim >= -6 && trim <= 3 ? "ready" : "deferred",
      reason
    });
  });

  it("rejects an unknown load purpose", () => {
    expect(() => decideDeckLoadReadiness({
      purpose: "background" as never,
      hasCurrentBasicAnalysis: false,
      cachedTrimDb: null
    })).toThrow("Unsupported deck load purpose");
  });

  it("uses the production post-decode branch without constructing inline analysis for Autopilot", () => {
    const calls: string[] = [];
    const decision = decideDeckLoadReadiness({
      purpose: DECK_LOAD_PURPOSE.autoPilotPreload,
      hasCurrentBasicAnalysis: false,
      cachedTrimDb: null
    });
    if (decision.kind !== "publish-decoded") throw new Error("unexpected decision");

    let inlineFactoryCalls = 0;
    expect(runDeckPostDecodeLoad({
      decision,
      publishDecoded: (publishDecision) => commitDecodedDeckReadiness({
        decision: publishDecision,
        ownsAuthority: () => true,
        applyCachedBasicAnalysis: () => calls.push("basic"),
        clearBasicAnalysis: () => calls.push("safe-fade"),
        applyTrim: (trimDb) => calls.push(`trim:${trimDb}`),
        publishDecodedBuffer: () => calls.push("ready")
      }),
      runInlineAnalysis: () => {
        inlineFactoryCalls += 1;
        return new Promise(() => undefined);
      }
    })).toBe("published");
    expect(calls).toEqual(["safe-fade", "trim:0", "ready"]);
    expect(inlineFactoryCalls).toBe(0);
  });

  it("keeps manual readiness pending on the inline analysis branch", async () => {
    const decision = decideDeckLoadReadiness({
      purpose: DECK_LOAD_PURPOSE.manual,
      hasCurrentBasicAnalysis: false,
      cachedTrimDb: null
    });
    let resolveAnalysis!: (value: string) => void;
    let publishCalls = 0;
    const pending = runDeckPostDecodeLoad({
      decision,
      publishDecoded: () => {
        publishCalls += 1;
        return "unexpected";
      },
      runInlineAnalysis: () => new Promise<string>((resolve) => { resolveAnalysis = resolve; })
    });
    expect(publishCalls).toBe(0);
    expect(pending).toBeInstanceOf(Promise);
    resolveAnalysis("analyzed-and-ready");
    await expect(pending).resolves.toBe("analyzed-and-ready");
  });

  it("rechecks exact authority before trim and publication", () => {
    const calls: string[] = [];
    let owns = true;
    const decision = decideDeckLoadReadiness({
      purpose: DECK_LOAD_PURPOSE.autoPilotPreload,
      hasCurrentBasicAnalysis: true,
      cachedTrimDb: -1
    });
    if (decision.kind !== "publish-decoded") throw new Error("unexpected decision");

    expect(commitDecodedDeckReadiness({
      decision,
      ownsAuthority: () => owns,
      applyCachedBasicAnalysis: () => {
        calls.push("basic");
        owns = false;
      },
      clearBasicAnalysis: () => calls.push("clear"),
      applyTrim: () => calls.push("trim"),
      publishDecodedBuffer: () => calls.push("ready")
    })).toBe("cancelled");
    expect(calls).toEqual(["basic"]);
  });

  it("binds the published readiness proof to exact load identity and trim", () => {
    const snapshot = {
      version: DECK_LOAD_READINESS_VERSION,
      trackId: "track-1",
      loadAuthorityKey: "load-1",
      timingFacts: "none",
      levelTrim: "neutral",
      safeFadeOnly: true,
      reason: "basic-and-level-analysis-pending",
      trimDb: 0
    } as const;
    const input = {
      value: snapshot,
      trackId: "track-1",
      loadAuthorityKey: "load-1",
      appliedTrimDb: 0
    };
    expect(ownsDeckLoadReadiness(input)).toBe(true);
    expect(ownsDeckLoadReadiness({ ...input, value: null })).toBe(false);
    expect(ownsDeckLoadReadiness({ ...input, value: { ...snapshot, version: "deck-load-readiness/v0" } })).toBe(false);
    expect(ownsDeckLoadReadiness({ ...input, value: { ...snapshot, loadAuthorityKey: "load-2" } })).toBe(false);
    expect(ownsDeckLoadReadiness({ ...input, appliedTrimDb: 0.1 })).toBe(false);
    expect(ownsDeckLoadReadiness({ ...input, value: { ...snapshot, safeFadeOnly: false } })).toBe(false);
  });

  it.each([-6, -2.4, -0.1, 0.1, 3])("retains a tight float32-compatible trim tolerance for %s dB", (trimDb) => {
    const appliedTrimDb = 20 * Math.log10(Math.fround(10 ** (trimDb / 20)));
    const snapshot = {
      version: DECK_LOAD_READINESS_VERSION,
      trackId: "track-1",
      loadAuthorityKey: "load-1",
      timingFacts: "cached-basic",
      levelTrim: "cached",
      safeFadeOnly: false,
      reason: "cached-analysis",
      trimDb
    } as const;
    expect(Math.abs(appliedTrimDb - trimDb)).toBeLessThan(DECK_LOAD_TRIM_PROOF_TOLERANCE_DB);
    expect(ownsDeckLoadReadiness({
      value: snapshot,
      trackId: "track-1",
      loadAuthorityKey: "load-1",
      appliedTrimDb
    })).toBe(true);
    expect(ownsDeckLoadReadiness({
      value: snapshot,
      trackId: "track-1",
      loadAuthorityKey: "load-1",
      appliedTrimDb: trimDb + 0.01
    })).toBe(false);
  });
});
