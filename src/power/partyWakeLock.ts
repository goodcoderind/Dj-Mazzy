export type PartyWakeLockStatus = "idle" | "requesting" | "active" | "unavailable";

type WakeLockSentinelLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void, options?: { once?: boolean }) => void;
};

export const createPartyWakeLockController = ({
  request = () => navigator.wakeLock.request("screen") as Promise<WakeLockSentinelLike>,
  visibility = () => document.visibilityState,
  onStatus = () => undefined
}: {
  request?: () => Promise<WakeLockSentinelLike>;
  visibility?: () => DocumentVisibilityState;
  onStatus?: (status: PartyWakeLockStatus) => void;
} = {}) => {
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let generation = 0;

  const acquire = async () => {
    wanted = true;
    const owner = ++generation;
    if (visibility() !== "visible") return;
    onStatus("requesting");
    try {
      const acquired = await request();
      if (!wanted || owner !== generation) {
        await acquired.release().catch(() => undefined);
        return;
      }
      sentinel = acquired;
      acquired.addEventListener?.("release", () => {
        if (sentinel === acquired) sentinel = null;
        if (wanted) onStatus("unavailable");
      }, { once: true });
      onStatus("active");
    } catch {
      if (wanted && owner === generation) onStatus("unavailable");
    }
  };

  const release = async () => {
    wanted = false;
    generation += 1;
    const active = sentinel;
    sentinel = null;
    if (active && !active.released) await active.release().catch(() => undefined);
    onStatus("idle");
  };

  const onVisibilityChange = () => {
    if (wanted && visibility() === "visible" && !sentinel) void acquire();
  };

  return { acquire, release, onVisibilityChange };
};
