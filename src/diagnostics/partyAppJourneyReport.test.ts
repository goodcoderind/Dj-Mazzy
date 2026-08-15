import { describe, expect, it } from "vitest";
import { buildPartyAppJourneyReport, type PartyAppJourneyReportInput } from "./partyAppJourneyReport";

const health = (overrides = {}) => ({
  schemaVersion: "audio-health/v2" as const,
  supported: true,
  expectedOutputActive: false,
  sampleRate: 48_000,
  renderedFrames: 48_000 * 25,
  expectedActiveFrames: 48_000 * 24,
  silentFrames: 0,
  renderQuanta: 48_000 * 25 / 128,
  nonFiniteSamples: 0,
  clippedSamples: 0,
  processorErrors: 0,
  peak: 0.08,
  longestUnexpectedSilentSeconds: 0.02,
  reports: 25,
  contextStates: ["suspended", "running"] as AudioContextState[],
  ...overrides
});

const valid = (overrides = {}): PartyAppJourneyReportInput => ({
  buildContract: "mazzy-app-basic/v1",
  runnerContract: "party-app-browser-runner/v1",
  fixtureContract: "generated-stereo-wav/v1",
  scenario: "three-track-safe-fade",
  importedTracks: 3,
  hydratedTracks: 3,
  storedTracksAfter: 3,
  immediateDeckStarts: 1,
  scheduledTargetStarts: 2,
  scheduledTransitions: 2,
  uniqueTransitionOwners: 2,
  completedTransitions: 2,
  cancelledTransitions: 0,
  transitionOwnershipFailures: 0,
  nativeTransitionSourceCompletions: 2,
  nativeTransitionDispatches: 2,
  recoveredTransitionDispatches: 0,
  crossfadeSentinelDispatches: 0,
  safeFadeTransitions: 2,
  nonSafeFadeTransitions: 0,
  maximumCompletionLatenessSeconds: 0.02,
  maximumCompletionEarlinessSeconds: 0.001,
  terminalTracePassed: true,
  queueTracksAfter: 0,
  autoPilotActiveAfter: false,
  checkpointStatusAfter: "cleared",
  activeDecksAfter: 0,
  activeCrossfadeAfter: false,
  recoveryUiVisibleAfter: false,
  importFocusRestored: true,
  firstSongPlayFocused: true,
  readinessFocused: true,
  stopControlReadyAfter: true,
  contextInterruptions: 0,
  health: health(),
  externalRequests: 0,
  uncaughtErrors: 0,
  unhandledRejections: 0,
  pageStayedVisible: true,
  timedOut: false,
  aborted: false,
  ...overrides
});

describe("full App Party journey report", () => {
  it("accepts one exact aggregate-only three-track journey", () => {
    const report = buildPartyAppJourneyReport(valid());
    expect(report.passed).toBe(true);
    expect(report.failureCodes).toEqual([]);
    expect(report.schemaVersion).toBe("party-app-journey-report/v1");
    expect(JSON.stringify(report)).not.toMatch(/trackId|filename|\.wav|\/Users\/|userAgent|errorMessage/);
  });

  it.each([
    ["import-count", { importedTracks: 2 }],
    ["hydration-count", { hydratedTracks: 2 }],
    ["stored-count", { storedTracksAfter: 2 }],
    ["first-start-count", { immediateDeckStarts: 2 }],
    ["target-start-count", { scheduledTargetStarts: 1 }],
    ["transition-count", { completedTransitions: 1 }],
    ["transition-owner-count", { uniqueTransitionOwners: 1 }],
    ["transition-template", { safeFadeTransitions: 1, nonSafeFadeTransitions: 1 }],
    ["transition-completion", { maximumCompletionLatenessSeconds: 0.101 }],
    ["transition-completion", { maximumCompletionEarlinessSeconds: 0.011 }],
    ["transition-completion", { transitionOwnershipFailures: 1 }],
    ["transition-completion", { nativeTransitionSourceCompletions: 1 }],
    ["transition-completion", { nativeTransitionDispatches: 1 }],
    ["transition-completion", { recoveredTransitionDispatches: 1 }],
    ["transition-completion", { crossfadeSentinelDispatches: 1 }],
    ["terminal-trace", { terminalTracePassed: false }],
    ["queue-not-empty", { queueTracksAfter: 1 }],
    ["autopilot-still-active", { autoPilotActiveAfter: true }],
    ["checkpoint-not-cleared", { checkpointStatusAfter: "available" }],
    ["deck-still-active", { activeDecksAfter: 1 }],
    ["crossfade-still-active", { activeCrossfadeAfter: true }],
    ["recovery-visible", { recoveryUiVisibleAfter: true }],
    ["focus-flow", { readinessFocused: false }],
    ["stop-unavailable", { stopControlReadyAfter: false }],
    ["external-network", { externalRequests: 1 }],
    ["uncaught-error", { unhandledRejections: 1 }],
    ["page-hidden", { pageStayedVisible: false }],
    ["timed-out", { timedOut: true }]
  ])("fails closed for %s", (failure, overrides) => {
    expect(buildPartyAppJourneyReport(valid(overrides)).failureCodes).toContain(failure);
  });

  it("rejects silent, inconsistent, interrupted, or clipped health evidence", () => {
    expect(buildPartyAppJourneyReport(valid({ health: health({ peak: 0 }) })).failureCodes)
      .toContain("output-silent");
    expect(buildPartyAppJourneyReport(valid({ health: health({ renderQuanta: 1 }) })).failureCodes)
      .toContain("audio-health-incomplete");
    expect(buildPartyAppJourneyReport(valid({ contextInterruptions: 1 })).failureCodes)
      .toContain("context-interrupted");
    expect(buildPartyAppJourneyReport(valid({
      health: health({ contextStates: ["running", "interrupted", "running"] })
    })).failureCodes).toContain("context-interrupted");
    expect(buildPartyAppJourneyReport(valid({ health: health({ clippedSamples: 1 }) })).failureCodes)
      .toContain("clipped-output");
  });

  it("rejects malformed contracts, unsafe numbers, and hostile extra fields", () => {
    expect(() => buildPartyAppJourneyReport(valid({ importedTracks: Number.NaN }))).toThrow("safe counters");
    expect(() => buildPartyAppJourneyReport(valid({ health: health({ renderedFrames: -1 }) }))).toThrow("malformed");
    expect(() => buildPartyAppJourneyReport(valid({ health: health({ sampleRate: 44_100 }) }))).toThrow("malformed");
    expect(() => buildPartyAppJourneyReport(valid({ health: health({ reports: 201 }) }))).toThrow("malformed");
    expect(() => buildPartyAppJourneyReport({
      ...valid(),
      privateSongPath: "/private/song.wav"
    } as unknown as PartyAppJourneyReportInput)).toThrow("exact allowlisted contract");
    expect(() => buildPartyAppJourneyReport(valid({
      runnerContract: "party-app-browser-runner/v0" as "party-app-browser-runner/v1"
    }))).toThrow("exact allowlisted contract");
  });
});
