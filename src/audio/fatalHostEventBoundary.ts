import { stopExistingAudioForFatalHostError } from "./fatalHostAudioSafety";

export const FATAL_HOST_EVENT_BOUNDARY_VERSION = "fatal-host-event-boundary/v1" as const;

export type FatalHostEventState = Readonly<{
  version: typeof FATAL_HOST_EVENT_BOUNDARY_VERSION;
  failed: boolean;
  outcome: "confirmed-stopped" | "uncertain" | null;
  revision: number;
}>;

type FatalEventTarget = {
  addEventListener: (type: "error" | "unhandledrejection", listener: (event: unknown) => void) => void;
  removeEventListener: (type: "error" | "unhandledrejection", listener: (event: unknown) => void) => void;
};

const initialState = (): FatalHostEventState => Object.freeze({
  version: FATAL_HOST_EVENT_BOUNDARY_VERSION,
  failed: false,
  outcome: null,
  revision: 0
});

export const createFatalHostEventBoundary = ({
  stopAudio = stopExistingAudioForFatalHostError
}: {
  stopAudio?: () => { outcome?: unknown };
} = {}) => {
  let state = initialState();
  const listeners = new Set<(next: FatalHostEventState) => void>();

  const capture = (_privatePayload: unknown, preventDefault?: () => void) => {
    try { preventDefault?.(); } catch { /* Audio shutdown remains authoritative. */ }
    let nextOutcome: FatalHostEventState["outcome"] = "uncertain";
    try {
      nextOutcome = stopAudio()?.outcome === "confirmed-stopped" ? "confirmed-stopped" : "uncertain";
    } catch { /* Fixed system-mute guidance owns an unverified shutdown. */ }
    if (state.outcome === "confirmed-stopped") nextOutcome = "confirmed-stopped";
    const changed = !state.failed || state.outcome !== nextOutcome;
    if (changed) {
      state = Object.freeze({
        version: FATAL_HOST_EVENT_BOUNDARY_VERSION,
        failed: true,
        outcome: nextOutcome,
        revision: state.revision + 1
      });
      for (const listener of listeners) {
        try { listener(state); } catch { /* A detached recovery view cannot weaken shutdown. */ }
      }
    }
    return state;
  };

  const install = (target: FatalEventTarget) => {
    const onError = (event: unknown) => capture(event, () => (event as { preventDefault?: () => void })?.preventDefault?.());
    const onUnhandledRejection = (event: unknown) => capture(
      event,
      () => (event as { preventDefault?: () => void })?.preventDefault?.()
    );
    target.addEventListener("error", onError);
    target.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      target.removeEventListener("error", onError);
      target.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  };

  return Object.freeze({
    capture,
    install,
    snapshot: () => state,
    subscribe: (listener: (next: FatalHostEventState) => void) => {
      listeners.add(listener);
      if (state.failed) {
        try { listener(state); } catch { /* A detached recovery view cannot weaken shutdown. */ }
      }
      return () => listeners.delete(listener);
    },
    retryStop: () => capture(null)
  });
};

const productionBoundary = createFatalHostEventBoundary();

export const captureFatalHostEvent = (privatePayload: unknown) => productionBoundary.capture(privatePayload);
export const fatalHostEventSnapshot = () => productionBoundary.snapshot();
export const subscribeFatalHostEvents = (listener: (next: FatalHostEventState) => void) =>
  productionBoundary.subscribe(listener);
export const retryFatalHostEventStop = () => productionBoundary.retryStop();
export const installFatalHostEventBoundary = (target: FatalEventTarget = window) =>
  productionBoundary.install(target);
