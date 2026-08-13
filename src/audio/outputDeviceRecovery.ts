export const OUTPUT_DEVICE_RECOVERY_MESSAGE =
  "The browser noticed a media-device change. The current song may keep playing; check the speakers before continuing. Autopilot is paused.";

export const supportsOutputDeviceChangeMonitoring = (mediaDevices: unknown): mediaDevices is EventTarget =>
  Boolean(mediaDevices && typeof (mediaDevices as EventTarget).addEventListener === "function");
