import { stopExistingAudioForFatalHostError } from "./audio/fatalHostAudioSafety";

export const createMazzyRootErrorOptions = ({
  stopUncaughtAudio = stopExistingAudioForFatalHostError
}: {
  stopUncaughtAudio?: () => unknown;
} = {}) => Object.freeze({
  // React 19 otherwise logs caught Error objects, which can contain local file
  // names or paths. The visible boundary owns fixed, metadata-free guidance.
  onCaughtError: (_privateError: unknown) => undefined,
  onRecoverableError: (_privateError: unknown) => undefined,
  onUncaughtError: (_privateError: unknown) => {
    try { stopUncaughtAudio(); } catch { /* The root has no stronger recovery surface. */ }
  }
});

export const MAZZY_ROOT_ERROR_OPTIONS = createMazzyRootErrorOptions();
