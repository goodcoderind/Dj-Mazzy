import type { DeckChannel } from "./AudioEngine";

export const PREPARED_KEY_LOCK_PROCESSOR = "signalsmith-stretch-web/1.3.2" as const;

export type PreparedKeyLockSource = Readonly<{
  processor: typeof PREPARED_KEY_LOCK_PROCESSOR;
  latencySeconds: number;
  minimumRate: 0.94;
  maximumRate: 1.06;
  connect: (destination: AudioNode) => void;
  start: (options: Readonly<{
    outputTime: number;
    inputSeconds: number;
    rate: number;
  }>) => Promise<void>;
  stop: (outputTime?: number) => Promise<void>;
  dispose: () => Promise<void>;
}>;

export type PreparedKeyLockFactory = (
  context: AudioContext,
  buffer: AudioBuffer,
  onProcessorFailure: () => void
) => Promise<PreparedKeyLockSource>;

export type DeckKeyLockState =
  | Readonly<{ status: "unavailable"; loadKey: string | null }>
  | Readonly<{ status: "preparing"; loadKey: string }>
  | Readonly<{
      status: "ready";
      loadKey: string;
      processor: typeof PREPARED_KEY_LOCK_PROCESSOR;
      latencySeconds: number;
      minimumRate: 0.94;
      maximumRate: 1.06;
    }>
  | Readonly<{
      status: "failed";
      loadKey: string;
      reason: "unsupported" | "initialization" | "processor" | "timeout";
    }>;

export const runtimeKeyLockLoadKey = (channel: DeckChannel, revision: number) =>
  `${channel}:${revision}`;
