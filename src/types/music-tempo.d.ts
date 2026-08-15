declare module "music-tempo" {
  export default class MusicTempo {
    constructor(
      audioData: Float32Array,
      params?: { hopSize?: number; timeStep?: number }
    );
    tempo: string | number;
    beats: number[];
    beatInterval: number;
    tempoList: number[];
  }
}
