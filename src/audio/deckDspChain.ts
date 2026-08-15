export type DeckDspChain = Readonly<{
  input: AudioNode;
  nodes: Readonly<{
    low: BiquadFilterNode;
    mid: BiquadFilterNode;
    high: BiquadFilterNode;
    transitionFilter: BiquadFilterNode;
    trim: GainNode;
  }>;
  trim: AudioParam;
  eq: Readonly<Record<"low" | "mid" | "high", AudioParam>>;
  filterCutoff: AudioParam;
}>;

export const createDeckDspChain = (
  context: BaseAudioContext,
  destination: AudioNode
): DeckDspChain => {
  const low = context.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 320;

  const mid = context.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1000;
  mid.Q.value = 0.5;

  const high = context.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 3200;

  const trim = context.createGain();
  const transitionFilter = context.createBiquadFilter();
  transitionFilter.type = "lowpass";
  transitionFilter.frequency.value = 20_000;
  transitionFilter.Q.value = 0.7;
  low.connect(mid);
  mid.connect(high);
  high.connect(transitionFilter);
  transitionFilter.connect(trim);
  trim.connect(destination);

  return Object.freeze({
    input: low,
    nodes: Object.freeze({ low, mid, high, transitionFilter, trim }),
    trim: trim.gain,
    eq: Object.freeze({ low: low.gain, mid: mid.gain, high: high.gain }),
    filterCutoff: transitionFilter.frequency
  });
};
