import { AudioEngine } from "./AudioEngine";

let sharedAudioEngine: AudioEngine | null = null;
let fatalHostLocked = false;

export const getAudioEngine = () => {
  if (fatalHostLocked) {
    throw new Error("audio starts are locked after a fatal host error");
  }
  if (!sharedAudioEngine) {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("Web Audio is not supported in this browser");
    }
    sharedAudioEngine = new AudioEngine(new AudioContextConstructor());
  }
  return sharedAudioEngine;
};

export const getAudioContext = () => getAudioEngine().context;

export const peekAudioEngine = () => sharedAudioEngine;

export const revokeAudioEngineForFatalHostError = () => {
  fatalHostLocked = true;
  return sharedAudioEngine;
};
