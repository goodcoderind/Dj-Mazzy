export const ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION = "enhanced-timing-removal-channel/v1" as const;
const CHANNEL_NAME = "mazzy-enhanced-timing-removal-v1";
const createTabOriginId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};
export const ENHANCED_TIMING_REMOVAL_TAB_ORIGIN_ID = createTabOriginId();
const MESSAGE = Object.freeze({
  version: ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION,
  type: "removal-started" as const,
  originId: ENHANCED_TIMING_REMOVAL_TAB_ORIGIN_ID
});

type ChannelLike = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  close: () => void;
};

type ChannelConstructor = new (name: string) => ChannelLike;

const isRemovalStartedMessage = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 &&
    record.version === ENHANCED_TIMING_REMOVAL_CHANNEL_VERSION &&
    record.type === "removal-started" &&
    typeof record.originId === "string" && record.originId.length >= 16 && record.originId.length <= 128;
};

const channelConstructor = () => typeof BroadcastChannel === "function"
  ? BroadcastChannel as unknown as ChannelConstructor
  : null;

export const projectEnhancedTimingRevocationObservation = ({
  initialize,
  baseline,
  observed,
  localObservationOwned
}: {
  initialize: boolean;
  baseline: Readonly<{ authority: EnhancedTimingModelAuthority; revoked: boolean }> | null;
  observed: Readonly<{ authority: EnhancedTimingModelAuthority; revoked: boolean }>;
  localObservationOwned: boolean;
}) => Object.freeze({
  applyRemote: !initialize && baseline !== null &&
    (baseline.authority.epoch !== observed.authority.epoch ||
      baseline.authority.token !== observed.authority.token ||
      baseline.revoked !== observed.revoked) &&
    !localObservationOwned,
  nextBaseline: observed
});

export const enhancedTimingObservationIsLocallyOwned = ({
  observed,
  prepareAuthority,
  removalActive
}: {
  observed: Readonly<{ authority: EnhancedTimingModelAuthority; revoked: boolean }>;
  prepareAuthority?: EnhancedTimingModelAuthority | null;
  removalActive: boolean;
}) => Boolean(
  (removalActive && observed.revoked) ||
  (!observed.revoked && prepareAuthority &&
    observed.authority.epoch === prepareAuthority.epoch &&
    observed.authority.token === prepareAuthority.token)
);

export const broadcastEnhancedTimingRemovalStarted = () => {
  const Constructor = channelConstructor();
  if (!Constructor) return false;
  let channel: ChannelLike | null = null;
  try {
    channel = new Constructor(CHANNEL_NAME);
    channel.postMessage(MESSAGE);
    return true;
  } catch {
    return false;
  } finally {
    try { channel?.close(); } catch { /* advisory channel cleanup is best effort */ }
  }
};

export const subscribeToEnhancedTimingRemoval = (listener: () => void) => {
  const Constructor = channelConstructor();
  if (!Constructor) return () => undefined;
  let channel: ChannelLike;
  try {
    channel = new Constructor(CHANNEL_NAME);
  } catch {
    return () => undefined;
  }
  const onMessage = (event: MessageEvent) => {
    if (isRemovalStartedMessage(event.data) &&
      event.data.originId !== ENHANCED_TIMING_REMOVAL_TAB_ORIGIN_ID) {
      try { listener(); } catch { /* advisory listeners cannot escape */ }
    }
  };
  try {
    channel.addEventListener("message", onMessage);
  } catch {
    try { channel.close(); } catch { /* advisory channel cleanup is best effort */ }
    return () => undefined;
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try { channel.removeEventListener("message", onMessage); } catch { /* best effort */ }
    try { channel.close(); } catch { /* best effort */ }
  };
};
import type { EnhancedTimingModelAuthority } from "./enhancedTimingModelStorage";
