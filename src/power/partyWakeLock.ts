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
  let acquiring = false;

  const acquire = async () => {
    wanted = true;
    const owner = ++generation;
    if (visibility() !== "visible") return;
    acquiring = true;
    onStatus("requesting");
    try {
      const acquired = await request();
      if (!wanted || owner !== generation) {
        if (owner === generation) acquiring = false;
        try {
          await acquired.release();
        } catch {
          if (!wanted && !acquired.released && sentinel === null) sentinel = acquired;
        }
        return;
      }
      acquiring = false;
      sentinel = acquired;
      acquired.addEventListener?.("release", () => {
        if (sentinel !== acquired) return;
        sentinel = null;
        if (wanted && visibility() === "visible") void acquire();
      }, { once: true });
      onStatus("active");
    } catch {
      if (owner === generation) acquiring = false;
      if (wanted && owner === generation) onStatus("unavailable");
    }
  };

  const releaseOwned = async (announce: boolean) => {
    wanted = false;
    const owner = ++generation;
    acquiring = false;
    const active = sentinel;
    if (announce) onStatus("idle");
    if (active && !active.released) {
      try {
        await active.release();
        if (sentinel === active) sentinel = null;
      } catch {
        if (!active.released && (sentinel === active || (sentinel === null && owner === generation))) {
          sentinel = active;
        }
      }
    } else if (sentinel === active) {
      sentinel = null;
    }
    if (announce && !wanted && owner === generation) onStatus("idle");
  };
  const release = () => releaseOwned(true);
  const releaseForHostTeardown = () => releaseOwned(false);

  const onVisibilityChange = () => {
    if (sentinel?.released) sentinel = null;
    if (wanted && visibility() === "visible" && !sentinel && !acquiring) void acquire();
  };

  return { acquire, release, releaseForHostTeardown, onVisibilityChange };
};
