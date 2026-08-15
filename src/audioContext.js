// Compatibility shim while existing imports migrate to the central engine.
export {
  getAudioContext,
  getAudioEngine,
  peekAudioEngine,
  revokeAudioEngineForFatalHostError
} from "./audio/audioEngineSingleton";
