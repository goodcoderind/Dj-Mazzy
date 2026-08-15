import { revokeAudioEngineForFatalHostError } from "./audioEngineSingleton";
import type { FatalHostAudioShutdown } from "./AudioEngine";

export const FATAL_HOST_AUDIO_SAFETY_VERSION = "fatal-host-audio-safety/v1" as const;

export type FatalHostAudioSafetyResult = Readonly<{
  version: typeof FATAL_HOST_AUDIO_SAFETY_VERSION;
  outcome: "confirmed-stopped" | "uncertain";
}>;

type ExistingAudioEngine = {
  shutdownForFatalHostError: () => FatalHostAudioShutdown;
};

let wakeLockRelease: (() => void | Promise<void>) | null = null;
let fatalHostEngaged = false;

export const registerFatalHostWakeLockRelease = (release: () => void | Promise<void>) => {
  wakeLockRelease = release;
  return () => {
    if (!fatalHostEngaged && wakeLockRelease === release) wakeLockRelease = null;
  };
};

export const createFatalHostAudioSafetyController = ({
  revokeExistingEngine,
  releaseWakeLock
}: {
  revokeExistingEngine: () => ExistingAudioEngine | null;
  releaseWakeLock?: () => void | Promise<void>;
}) => Object.freeze({
  stopExistingAudio: (): FatalHostAudioSafetyResult => {
    const engine = revokeExistingEngine();
    let outcome: FatalHostAudioSafetyResult["outcome"] = engine ? "uncertain" : "confirmed-stopped";
    if (engine) {
      try {
        const shutdown = engine.shutdownForFatalHostError();
        if (shutdown.version === "fatal-host-audio-shutdown/v1" &&
            shutdown.outcome === "confirmed-stopped") {
          outcome = "confirmed-stopped";
        }
      } catch { /* Fixed host guidance owns an unverified shutdown. */ }
    }
    try {
      const release = releaseWakeLock?.();
      if (release && typeof (release as Promise<void>).catch === "function") {
        void (release as Promise<void>).catch(() => undefined);
      }
    } catch { /* Wake-lock cleanup never weakens the audio warning. */ }
    return Object.freeze({ version: FATAL_HOST_AUDIO_SAFETY_VERSION, outcome });
  }
});

const productionController = createFatalHostAudioSafetyController({
  revokeExistingEngine: revokeAudioEngineForFatalHostError,
  releaseWakeLock: () => wakeLockRelease?.()
});

export const stopExistingAudioForFatalHostError = () => {
  fatalHostEngaged = true;
  return productionController.stopExistingAudio();
};

export const fatalHostRecoveryView = (outcome: unknown) => Object.freeze({
  status: outcome === "confirmed-stopped" ? "confirmed-stopped" as const : "uncertain" as const,
  title: "Mazzy needs to reload",
  message: outcome === "confirmed-stopped"
    ? "Mazzy hit an unexpected local error. Sound is stopped."
    : "Mazzy could not confirm every sound stopped. Use your device or speaker mute now.",
  stopAction: "STOP ALL SOUND AGAIN",
  reloadAction: "RELOAD MAZZY"
});

export const captureFatalHostFailure = (
  _privateError: unknown,
  stop = stopExistingAudioForFatalHostError
) => {
  const result = stop();
  return Object.freeze({
    failed: true as const,
    outcome: result.outcome === "confirmed-stopped" ? "confirmed-stopped" as const : "uncertain" as const
  });
};
