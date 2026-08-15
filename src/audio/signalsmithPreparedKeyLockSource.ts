import { createExperimentalKeyLock } from "../experimental/keyLockRuntime";
import {
  PREPARED_KEY_LOCK_PROCESSOR,
  type PreparedKeyLockFactory
} from "./keyLockPreparedSource";

/**
 * Concrete local preparation factory. It is intentionally not installed into
 * live decks yet: preparation/readiness must pass the full device and listening
 * gates before it can become transition authority.
 */
export const createSignalsmithPreparedKeyLockSource: PreparedKeyLockFactory = async (
  context,
  buffer,
  onProcessorFailure
) => {
  const handle = await createExperimentalKeyLock(context, buffer, onProcessorFailure);
  return Object.freeze({
    processor: PREPARED_KEY_LOCK_PROCESSOR,
    latencySeconds: handle.latencySeconds,
    minimumRate: 0.94 as const,
    maximumRate: 1.06 as const,
    connect: (destination) => { handle.node.connect(destination); },
    start: async ({ outputTime, inputSeconds, rate }) => {
      await handle.schedule({ active: true, output: outputTime, input: inputSeconds, rate, semitones: 0 });
      handle.assertHealthy();
    },
    stop: async (outputTime = context.currentTime) => {
      await handle.schedule({ active: false, output: outputTime });
    },
    dispose: handle.dispose
  });
};
