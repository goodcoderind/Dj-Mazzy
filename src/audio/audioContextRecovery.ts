export type AudioContextRecoveryState = "running" | "suspended" | "interrupted" | "closed";

export const needsHostAudioRecovery = (state: string): state is Exclude<AudioContextRecoveryState, "running"> =>
  state === "suspended" || state === "interrupted" || state === "closed";

export const audioRecoveryMessage = (state: string) => state === "closed"
  ? "Audio stopped because the browser closed its audio engine. Reload Mazzy to continue."
  : state === "interrupted"
    ? "Audio was interrupted by the device. Return here and resume audio when the device is ready."
    : "The browser paused audio. Resume audio to continue; Autopilot is paused.";
