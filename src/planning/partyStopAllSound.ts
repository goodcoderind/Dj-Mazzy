export const PARTY_STOP_ALL_SOUND_SCHEMA_VERSION = "party-stop-all-sound/v1" as const;

export const PARTY_STOP_ALL_SOUND_STEPS = [
  "lock-new-starts",
  "cancel-preload",
  "cancel-transition-arm",
  "cancel-active-transition",
  "cancel-auxiliary-audio",
  "stop-deck-a",
  "stop-deck-b",
  "pause-party-session",
  "release-wake-lock"
] as const;

export type PartyStopAllSoundStep = typeof PARTY_STOP_ALL_SOUND_STEPS[number];

export type PartyStopAllSoundResult = Readonly<{
  schemaVersion: typeof PARTY_STOP_ALL_SOUND_SCHEMA_VERSION;
  completedSteps: readonly PartyStopAllSoundStep[];
  failedSteps: readonly PartyStopAllSoundStep[];
  passed: boolean;
}>;

export type PartyStopAllSoundVerification = Readonly<{
  deckAStopped: boolean;
  deckBStopped: boolean;
  crossfadeCleared: boolean;
  transitionAuthorityCleared: boolean;
  preloadAuthorityCleared: boolean;
  armAuthorityCleared: boolean;
  auxiliaryAuthorityCleared: boolean;
}>;

export const verifyPartyStopAllSound = (verification: PartyStopAllSoundVerification): boolean =>
  Object.values(verification).every((value) => value === true);

export const runPartyStopAllSound = (
  perform: (step: PartyStopAllSoundStep) => void
): PartyStopAllSoundResult => {
  const completedSteps: PartyStopAllSoundStep[] = [];
  const failedSteps: PartyStopAllSoundStep[] = [];
  for (const step of PARTY_STOP_ALL_SOUND_STEPS) {
    try {
      perform(step);
      completedSteps.push(step);
    } catch {
      // Emergency shutdown is best-effort across independent audio owners. A
      // failed transition cleanup must never prevent either deck from pausing.
      failedSteps.push(step);
    }
  }
  return Object.freeze({
    schemaVersion: PARTY_STOP_ALL_SOUND_SCHEMA_VERSION,
    completedSteps: Object.freeze(completedSteps),
    failedSteps: Object.freeze(failedSteps),
    passed: failedSteps.length === 0
  });
};
