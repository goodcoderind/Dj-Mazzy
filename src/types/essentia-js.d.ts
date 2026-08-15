declare module "essentia.js" {
  type Vector = { delete?: () => void };
  type RhythmExtractorResult = {
    bpm: number;
    ticks: Vector;
    confidence: number;
    estimates: Vector;
    bpmIntervals: Vector;
  };

  class Essentia {
    constructor(wasm: unknown);
    arrayToVector(values: Float32Array): Vector;
    vectorToArray(vector: Vector): Float32Array;
    RhythmExtractor2013(
      signal: Vector,
      maxTempo?: number,
      method?: "degara" | "multifeature",
      minTempo?: number
    ): RhythmExtractorResult;
  }

  const packageExports: {
    Essentia: typeof Essentia;
    EssentiaWASM: unknown;
  };
  export default packageExports;
}
