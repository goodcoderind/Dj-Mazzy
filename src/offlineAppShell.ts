export const OFFLINE_APP_SHELL_CONTRACT = "mazzy-offline-app-shell/v2" as const;

export const registerOfflineAppShell = () => {
  if (!__MAZZY_OFFLINE_SHELL_INCLUDED__ || !("serviceWorker" in navigator)) return;
  const path = window.location.pathname;
  const base = import.meta.env.BASE_URL;
  const baseWithoutSlash = base.length > 1 ? base.slice(0, -1) : base;
  if (path !== base && path !== baseWithoutSlash && path !== `${base}index.html`) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${base}mazzy-sw.js`, {
      scope: base,
      updateViaCache: "none"
    }).catch(() => {
      // Playback and local-library access remain available when installation is
      // unsupported or storage is unavailable. Registration never blocks UI.
    });
  }, { once: true });
};
