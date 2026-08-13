declare module "signalsmith-stretch" {
  export type StretchSchedule = {
    output?: number;
    active?: boolean;
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  };

  export type SignalsmithStretchNode = AudioWorkletNode & {
    inputTime: number;
    addBuffers: (channels: Float32Array[], transfer?: ArrayBuffer[]) => Promise<number>;
    dropBuffers: (toSeconds?: number) => Promise<{ start: number; end: number }>;
    configure: (options: { preset?: "default" | "cheaper"; blockMs?: number | null; intervalMs?: number; splitComputation?: boolean }) => Promise<unknown>;
    latency: () => Promise<number>;
    schedule: (options: StretchSchedule) => Promise<StretchSchedule>;
    start: (when?: number | StretchSchedule, offset?: number, duration?: number, rate?: number, semitones?: number) => Promise<unknown>;
    stop: (when?: number) => Promise<unknown>;
    setUpdateInterval: (seconds: number, callback?: (inputTime: number) => void) => Promise<unknown>;
  };

  export default function SignalsmithStretch(
    context: AudioContext,
    options?: AudioWorkletNodeOptions
  ): Promise<SignalsmithStretchNode>;
}
