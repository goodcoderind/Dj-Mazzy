import { AudioEngine } from "./AudioEngine";

let sharedAudioEngine: AudioEngine | null = null;

export const getAudioEngine = () => {
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
