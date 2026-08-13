import type { RhythmExample } from "./rhythmBenchmark";

type PulseFixtureOptions = {
  id: string;
  description: string;
  bpm: number;
  durationSeconds: number;
  meter?: number;
  beatLevel?: number;
  downbeatLevel?: number;
  subdivisionLevel?: number;
};

const SAMPLE_RATE = 44_100;
export const GOLDEN_RHYTHM_FIXTURE_SET_VERSION = "generated-rhythm-fixtures/v1" as const;

const addPulse = (
  pcm: Float32Array,
  timeSeconds: number,
  amplitude: number,
  frequency: number,
  sampleRate: number
) => {
  const start = Math.round(timeSeconds * sampleRate);
  const length = Math.round(sampleRate * 0.08);
  for (let index = 0; index < length && start + index < pcm.length; index += 1) {
    const envelope = Math.exp(-index / (sampleRate * 0.012));
    pcm[start + index] += amplitude * envelope * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
};

const pulseFixture = ({
  id,
  description,
  bpm,
  durationSeconds,
  meter = 4,
  beatLevel = 0.52,
  downbeatLevel = 0.95,
  subdivisionLevel = 0
}: PulseFixtureOptions): RhythmExample => {
  const pcm = new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
  const interval = 60 / bpm;
  const beatsSeconds: number[] = [];
  const downbeatsSeconds: number[] = [];
  for (let beat = 0; beat * interval < durationSeconds - 0.02; beat += 1) {
    const time = beat * interval;
    const isDownbeat = beat % meter === 0;
    beatsSeconds.push(time);
    if (isDownbeat) downbeatsSeconds.push(time);
    addPulse(pcm, time, isDownbeat ? downbeatLevel : beatLevel, isDownbeat ? 72 : 180, SAMPLE_RATE);
    if (subdivisionLevel > 0 && time + interval / 2 < durationSeconds) {
      addPulse(pcm, time + interval / 2, subdivisionLevel, 360, SAMPLE_RATE);
    }
  }
  return {
    id,
    description,
    provenance: "procedurally-generated",
    sampleRate: SAMPLE_RATE,
    pcm,
    reference: { bpm, beatsSeconds, downbeatsSeconds }
  };
};

const sustainedChordFixture = (): RhythmExample => {
  const durationSeconds = 10;
  const pcm = new Float32Array(SAMPLE_RATE * durationSeconds);
  const frequencies = [261.6256, 329.6276, 391.9954];
  for (let index = 0; index < pcm.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const attack = Math.min(1, time / 0.15);
    const release = Math.min(1, (durationSeconds - time) / 0.3);
    pcm[index] =
      attack *
      release *
      frequencies.reduce(
        (sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * time) / frequencies.length,
        0
      );
  }
  return {
    id: "sustained-c-major-no-beat",
    description: "Negative control: sustained harmony with no periodic beat.",
    provenance: "procedurally-generated",
    sampleRate: SAMPLE_RATE,
    pcm,
    reference: { bpm: null, beatsSeconds: [], downbeatsSeconds: [] }
  };
};

export const createGoldenRhythmFixtures = (): RhythmExample[] => [
  pulseFixture({
    id: "steady-120-4-4",
    description: "Clean 120 BPM four-on-the-floor pulse with a stronger bar accent.",
    bpm: 120,
    durationSeconds: 16
  }),
  pulseFixture({
    id: "steady-90-4-4",
    description: "Slower 90 BPM pulse with explicit four-beat bar accents.",
    bpm: 90,
    durationSeconds: 20
  }),
  pulseFixture({
    id: "offbeat-heavy-100-4-4",
    description: "100 BPM pulse with strong eighth-note offbeats to expose metrical ambiguity.",
    bpm: 100,
    durationSeconds: 18,
    subdivisionLevel: 0.38
  }),
  sustainedChordFixture(),
  {
    id: "digital-silence",
    description: "Negative control: silence must not receive a tempo or beat grid.",
    provenance: "procedurally-generated",
    sampleRate: SAMPLE_RATE,
    pcm: new Float32Array(SAMPLE_RATE * 8),
    reference: { bpm: null, beatsSeconds: [], downbeatsSeconds: [] }
  }
];
