import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PipeCdp,
  evaluate,
  findChrome,
  reservePort,
  trustedClick,
  waitFor,
  waitForHttp
} from "./runPartyAppJourneyBrowser.mjs";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const run = async () => {
  const chromePath = await findChrome();
  const port = await reservePort();
  const profileRoot = await mkdtemp(path.join(tmpdir(), "mazzy-fatal-async-profile-"));
  const preview = spawn("npm", ["run", "preview:diagnostics", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: workspaceRoot,
    env: { ...process.env, MAZZY_INCLUDE_DIAGNOSTICS: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let chrome = null;
  try {
    const pageUrl = `http://127.0.0.1:${port}/fatal-host-recovery-diagnostic.html?fault=async`;
    await waitForHttp(pageUrl, preview);
    chrome = spawn(chromePath, [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profileRoot}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--autoplay-policy=document-user-activation-required",
      "--window-size=1200,900",
      "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const cdp = new PipeCdp(chrome);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("DOM.enable", {}, sessionId)
    ]);
    const loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 15_000);
    await cdp.send("Page.navigate", { url: pageUrl }, sessionId);
    await loaded;
    await trustedClick(cdp, sessionId, {
      selector: ".fatal-host-recovery-actions button",
      text: "START ACTIVE AUDIO AND CRASH TEST",
      exact: true
    });
    const state = await waitFor(
      () => evaluate(cdp, sessionId, `(() => {
        const alert = document.querySelector('[role="alert"]');
        if (!alert) return null;
        const buttons = [...alert.querySelectorAll('button')];
        const text = document.body.textContent || '';
        return {
          focused: document.activeElement === alert,
          title: alert.querySelector('h1')?.textContent || '',
          message: alert.querySelector('p:nth-of-type(2)')?.textContent || '',
          actions: buttons.map((button) => button.textContent),
          minimumHeights: buttons.map((button) => Math.round(button.getBoundingClientRect().height)),
          hostilePayloadAbsent: !text.includes('private-song.wav') && !text.includes('track-private-id') && !text.includes('/private/local/path'),
          launcherGone: !text.includes('START ACTIVE AUDIO AND CRASH TEST'),
          previewArmed: document.documentElement.dataset.mazzyFatalPreviewArmed === 'true',
          auditionArmed: document.documentElement.dataset.mazzyFatalAuditionArmed === 'true',
          deliberateFaultDispatched: document.documentElement.dataset.mazzyFatalFaultDispatched === 'true'
        };
      })()`),
      { timeoutMs: 10_000, message: "The async fatal recovery card did not appear." }
    );
    const exactCopy = state.title === "Mazzy needs to reload" && [
      "Mazzy hit an unexpected local error. Sound is stopped.",
      "Mazzy could not confirm every sound stopped. Use your device or speaker mute now."
    ].includes(state.message);
    if (!state.focused || !exactCopy || !state.hostilePayloadAbsent || !state.launcherGone ||
        !state.previewArmed || !state.auditionArmed || !state.deliberateFaultDispatched ||
        state.actions.join("|") !== "STOP ALL SOUND AGAIN|RELOAD MAZZY" ||
        state.minimumHeights.some((height) => height < 44)) {
      throw new Error("The async fatal recovery browser gate did not satisfy its fixed focus, copy, privacy, or action contract.");
    }
    await trustedClick(cdp, sessionId, {
      selector: ".fatal-host-recovery-actions button",
      text: "STOP ALL SOUND AGAIN",
      exact: true
    });
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector('[role="alert"]')?.textContent?.includes('Sound is stopped.') === true`),
      { timeoutMs: 5_000, message: "The exact fatal Stop retry did not reach confirmed shutdown." }
    );
    process.stdout.write("Async fatal host browser recovery passed.\n");
  } finally {
    if (chrome?.exitCode == null) {
      chrome.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        chrome.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      if (chrome.exitCode == null) chrome.kill("SIGKILL");
    }
    if (preview.exitCode == null) preview.kill("SIGTERM");
    await rm(profileRoot, { recursive: true, force: true });
  }
};

await run();
