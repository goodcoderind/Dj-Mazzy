import type { SignalsmithStretchNode, StretchSchedule } from "signalsmith-stretch";

export const EXPERIMENTAL_KEY_LOCK_CONTRACT = "signalsmith-stretch-web/1.3.2/key-lock-spike-v1" as const;
export const EXPERIMENTAL_KEY_LOCK_MIN_RATE = 0.94;
export const EXPERIMENTAL_KEY_LOCK_MAX_RATE = 1.06;
export const EXPERIMENTAL_KEY_LOCK_RPC_TIMEOUT_MS = 5_000;

export type ExperimentalKeyLockHandle = Readonly<{
  contract: typeof EXPERIMENTAL_KEY_LOCK_CONTRACT;
  node: SignalsmithStretchNode;
  latencySeconds: number;
  assertHealthy: () => void;
  schedule: (options: StretchSchedule) => Promise<StretchSchedule>;
  dispose: () => Promise<void>;
}>;

const supportedRate = (rate: number) =>
  Number.isFinite(rate) && rate >= EXPERIMENTAL_KEY_LOCK_MIN_RATE && rate <= EXPERIMENTAL_KEY_LOCK_MAX_RATE;

const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = EXPERIMENTAL_KEY_LOCK_RPC_TIMEOUT_MS) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Key-lock ${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

export const isExperimentalKeyLockRateSupported = supportedRate;

/**
 * Experimental benchmark adapter only. It deliberately does not connect to the
 * live decks or grant phrase-blend eligibility.
 */
export const createExperimentalKeyLock = async (
  context: AudioContext,
  buffer: AudioBuffer,
  onProcessorFailure: () => void = () => undefined
): Promise<ExperimentalKeyLockHandle> => {
  if (!context?.audioWorklet || typeof AudioWorkletNode !== "function") {
    throw new Error("AudioWorklet is required for the key-lock experiment");
  }
  if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.numberOfChannels < 1) {
    throw new RangeError("A non-empty decoded audio buffer is required");
  }
  if ((context.sampleRate !== 44_100 && context.sampleRate !== 48_000) || buffer.sampleRate !== context.sampleRate) {
    throw new RangeError("The key-lock smoke adapter requires matching 44.1 or 48 kHz audio");
  }
  const { default: SignalsmithStretch } = await import("signalsmith-stretch");
  const channels = Math.min(2, buffer.numberOfChannels);
  const nodePromise = SignalsmithStretch(context, {
    // Signalsmith's inactive render path still indexes inputList[0]. Keep one
    // unconnected input even in buffer mode; declaring zero inputs terminates
    // the worklet before the first scheduled start.
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channels]
  });
  let node: SignalsmithStretchNode;
  try {
    node = await withTimeout(nodePromise, "initialization");
  } catch (error) {
    void nodePromise.then((lateNode) => {
      lateNode.onprocessorerror = null;
      lateNode.disconnect();
      lateNode.port.close();
    }).catch(() => undefined);
    throw error;
  }
  let processorFailed = false;
  node.onprocessorerror = () => {
    processorFailed = true;
    node.disconnect();
    onProcessorFailure();
  };
  try {
    await withTimeout(node.configure({ preset: "cheaper" }), "configuration");
    const samples = Array.from({ length: channels }, (_, channel) =>
      Float32Array.from(buffer.getChannelData(channel))
    );
    if (samples.some((channel) => !channel.every(Number.isFinite))) {
      throw new RangeError("Key-lock input samples must be finite");
    }
    await withTimeout(node.addBuffers(samples, samples.map((channel) => channel.buffer)), "buffer transfer");
  } catch (error) {
    node.onprocessorerror = null;
    node.disconnect();
    node.port.close();
    throw error;
  }
  const latencySeconds = Number(await withTimeout(node.latency(), "latency query").catch((error) => {
    node.onprocessorerror = null;
    node.disconnect();
    node.port.close();
    throw error;
  }));
  if (!Number.isFinite(latencySeconds) || latencySeconds < 0 || latencySeconds > 1) {
    node.onprocessorerror = null;
    node.disconnect();
    node.port.close();
    throw new Error("Key-lock worklet returned an invalid latency");
  }
  let disposed = false;
  return Object.freeze({
    contract: EXPERIMENTAL_KEY_LOCK_CONTRACT,
    node,
    latencySeconds,
    assertHealthy: () => {
      if (disposed) throw new Error("Key-lock experiment has been disposed");
      if (processorFailed) throw new Error("Key-lock processor failed");
    },
    schedule: async (options: StretchSchedule) => {
      if (disposed) throw new Error("Key-lock experiment has been disposed");
      if (processorFailed) throw new Error("Key-lock processor failed");
      const rate = Number(options.rate ?? 1);
      if (!supportedRate(rate)) throw new RangeError("Experimental key-lock rate must stay within ±6%");
      if (options.output != null && (!Number.isFinite(options.output) || options.output < 0)) {
        throw new RangeError("Key-lock output time must be finite and non-negative");
      }
      if (options.input != null && (!Number.isFinite(options.input) || options.input < 0)) {
        throw new RangeError("Key-lock input time must be finite and non-negative");
      }
      if (options.semitones != null && options.semitones !== 0) {
        throw new RangeError("Mazzy's key-lock experiment does not transpose pitch");
      }
      return withTimeout(node.schedule({ ...options, rate, semitones: 0 }), "schedule");
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try { await withTimeout(node.stop(context.currentTime), "stop", 250); } catch { /* best-effort experimental cleanup */ }
      try { await withTimeout(node.dropBuffers(), "buffer release", 250); } catch { /* best-effort experimental cleanup */ }
      node.onprocessorerror = null;
      node.disconnect();
      node.port.close();
    }
  });
};
