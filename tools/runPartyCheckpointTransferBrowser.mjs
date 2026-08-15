import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PipeCdp,
  evaluate,
  findChrome,
  makeStereoWav,
  reservePort,
  trustedClick,
  waitFor,
  waitForHttp
} from "./runPartyAppJourneyBrowser.mjs";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const createFixtures = async (root) => {
  const frequencies = [[101, 127], [139, 163], [181, 211], [233, 263]];
  const files = [];
  for (let index = 0; index < frequencies.length; index += 1) {
    const file = path.join(root, `generated-recovery-${index + 1}.wav`);
    await writeFile(file, makeStereoWav(1, ...frequencies[index]));
    files.push(file);
  }
  return files;
};

const runOne = async ({ chromePath, pageUrl, ordinal }) => {
  const profileRoot = await mkdtemp(path.join(tmpdir(), `mazzy-checkpoint-profile-${ordinal}-`));
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), `mazzy-checkpoint-files-${ordinal}-`));
  const fixtures = await createFixtures(fixtureRoot);
  let chrome = null;
  try {
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
      "--window-size=1440,1600",
      "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const cdp = new PipeCdp(chrome);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("DOM.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
      cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId)
    ]);
    const origin = new URL(pageUrl).origin;
    let exceptionCount = 0;
    let externalRequestCount = 0;
    const stopObservers = [];
    const external = (value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.origin !== origin;
      } catch { return true; }
    };
    const observeSession = (observedSessionId) => {
      stopObservers.push(cdp.subscribe("Runtime.exceptionThrown", observedSessionId, () => { exceptionCount += 1; }));
      stopObservers.push(cdp.subscribe("Network.requestWillBeSent", observedSessionId, (event) => {
        if (external(event.request.url)) externalRequestCount += 1;
      }));
      stopObservers.push(cdp.subscribe("Fetch.requestPaused", observedSessionId, async (event) => {
        if (external(event.request.url)) {
          externalRequestCount += 1;
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, observedSessionId);
        } else {
          await cdp.send("Fetch.continueRequest", { requestId: event.requestId }, observedSessionId);
        }
      }));
    };
    observeSession(sessionId);
    stopObservers.push(cdp.subscribe("Target.attachedToTarget", undefined, async (attached) => {
      if (!["worker", "shared_worker", "service_worker"].includes(attached.targetInfo?.type)) {
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, attached.sessionId);
        return;
      }
      await Promise.all([
        cdp.send("Runtime.enable", {}, attached.sessionId),
        cdp.send("Network.enable", {}, attached.sessionId),
        cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, attached.sessionId)
      ]);
      observeSession(attached.sessionId);
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, attached.sessionId);
    }));
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    });

    let loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 15_000);
    await cdp.send("Page.navigate", { url: pageUrl }, sessionId);
    await loaded;
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-status")?.textContent?.includes("EMPTY DISPOSABLE PROFILE")`),
      { timeoutMs: 20_000, message: "The recovery gate did not start with an empty profile." }
    );

    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
    const chooser = cdp.waitEvent("Page.fileChooserOpened", sessionId, 10_000);
    await trustedClick(cdp, sessionId, { selector: ".party-mode-flow button", text: "IMPORT MUSIC" });
    await chooser;
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
    const { nodeId: fileInputNodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "input[type='file'][multiple]"
    }, sessionId);
    if (!fileInputNodeId) throw new Error("The real hidden folder input was unavailable.");
    await cdp.send("DOM.setFileInputFiles", { files: [fixtureRoot], nodeId: fileInputNodeId }, sessionId);
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId);
    try {
      await waitFor(
        () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-status")?.textContent?.includes("IMPORT COMMITTED")`),
        { timeoutMs: 30_000, message: "The four generated recovery fixtures did not commit." }
      );
    } catch {
      const state = await evaluate(cdp, sessionId, `({
        status: document.querySelector("#checkpoint-transfer-status")?.textContent || "missing",
        rows: document.querySelectorAll(".library-row").length,
        membership: document.body.textContent?.includes("IMPORTING LOCAL MUSIC") === true,
        alert: document.querySelector("[role='alert']")?.textContent?.replace(/\\s+/g, " ").slice(0, 180) || "none",
        toast: document.querySelector(".toast")?.textContent || "none"
      })`);
      throw new Error(`The four generated recovery fixtures did not commit (${JSON.stringify(state)}).`);
    }
    const seedInvoked = await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector("#checkpoint-transfer-seed");
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (!seedInvoked) throw new Error("The diagnostics-only paused fixture action was unavailable.");
    try {
      await waitFor(
        () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-status")?.textContent?.includes("PAUSED RECOVERY SAVED")`),
        { timeoutMs: 15_000, message: "The paused recovery fixture was not saved." }
      );
    } catch {
      const state = await evaluate(cdp, sessionId, `({
        status: document.querySelector("#checkpoint-transfer-status")?.textContent || "missing",
        report: document.querySelector("#checkpoint-transfer-report")?.textContent || "none",
        rows: document.querySelectorAll(".library-row").length,
        phase: JSON.parse(sessionStorage.getItem("mazzy-checkpoint-transfer-diagnostic/v2") || "null")?.phase || "none",
        seedDisabled: document.querySelector("#checkpoint-transfer-seed")?.disabled
      })`);
      throw new Error(`The paused recovery fixture was not saved (${JSON.stringify(state)}).`);
    }

    loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 15_000);
    await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
    await loaded;
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-status")?.textContent?.includes("FIRST RECOVERY READY")`),
      { timeoutMs: 30_000, message: "The first reload did not expose the paused recovery." }
    );
    await trustedClick(cdp, sessionId, { selector: ".party-checkpoint-recovery button", text: "RESTORE PAUSED PLAN", exact: true });
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-status")?.textContent?.includes("FIRST TRANSFER CONFIRMED")`),
      { timeoutMs: 15_000, message: "The first writer transfer did not commit and apply." }
    );

    loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 15_000);
    await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
    await loaded;
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-status")?.textContent?.includes("SECOND RECOVERY READY")`),
      { timeoutMs: 30_000, message: "The transferred paused plan did not survive the second reload." }
    );
    await trustedClick(cdp, sessionId, { selector: ".party-checkpoint-recovery button", text: "RESTORE PAUSED PLAN", exact: true });
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-status")?.textContent?.includes("SECOND TRANSFER CONFIRMED")`),
      { timeoutMs: 15_000, message: "The second writer transfer did not commit and apply." }
    );
    await trustedClick(cdp, sessionId, {
      selector: ".party-checkpoint-recovery button",
      text: "REMOVE SAVED RECOVERY COPY",
      exact: true
    });
    const reportText = await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#checkpoint-transfer-report")?.textContent || ""`),
      { timeoutMs: 15_000, message: "The exact recovery removal did not produce a report." }
    );
    const report = JSON.parse(reportText);
    for (const stop of stopObservers.splice(0)) stop();
    await cdp.closeAndDrainSubscriptions();
    if (!report?.passed || report.schemaVersion !== "party-checkpoint-transfer-browser-report/v1" ||
        exceptionCount !== 0 || externalRequestCount !== 0 || cdp.observerFailed || cdp.backlogOverflowed) {
      throw new Error(`The recovery transfer report failed (${JSON.stringify({
        failureCodes: report?.failureCodes,
        focus: report?.focus,
        exceptionCount,
        externalRequestCount,
        observerFailed: cdp.observerFailed,
        backlogOverflowed: cdp.backlogOverflowed
      })}).`);
    }
    return report;
  } finally {
    if (chrome && chrome.exitCode == null) {
      chrome.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        chrome.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      if (chrome.exitCode == null) chrome.kill("SIGKILL");
    }
    await rm(profileRoot, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
};

const comparable = (report) => ({
  counts: report.counts,
  safety: report.safety,
  focus: report.focus,
  cleanup: report.cleanup,
  failureCodes: report.failureCodes,
  passed: report.passed
});

const main = async () => {
  const chromePath = await findChrome();
  const port = await reservePort();
  const preview = spawn("npm", ["run", "preview:diagnostics", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: workspaceRoot,
    env: { ...process.env, MAZZY_INCLUDE_DIAGNOSTICS: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const pageUrl = `http://127.0.0.1:${port}/party-checkpoint-transfer-diagnostic.html`;
    await waitForHttp(pageUrl, preview);
    const reports = [];
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      process.stdout.write(`Running paused recovery transfer ${ordinal}/2…\n`);
      reports.push(await runOne({ chromePath, pageUrl, ordinal }));
    }
    const reportsMatched = JSON.stringify(comparable(reports[0])) === JSON.stringify(comparable(reports[1]));
    if (!reportsMatched) throw new Error("The two fresh recovery runs produced different categorical evidence.");
    const artifact = Object.freeze({
      schemaVersion: "party-checkpoint-transfer-browser-acceptance/v1",
      runnerContract: "party-checkpoint-transfer-browser-runner/v1",
      status: "passed",
      freshProfileRuns: 2,
      reportsMatched,
      reports,
      evidenceScope: "Two fresh-profile generated-WAV full App paused-plan writer transfers across two reloads; not crash durability, physical output, real-music quality, or cross-browser support.",
      privacy: "Fixed enums, booleans, and capped counts only; no names, paths, IDs, tokens, hashes, timestamps, raw errors, Files, audio, user agent, or device metadata. Temporary files and profiles were deleted."
    });
    await writeFile(
      path.join(workspaceRoot, "PARTY_CHECKPOINT_TRANSFER_BROWSER_ACCEPTANCE_REPORT.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      { mode: 0o644 }
    );
    process.stdout.write("Two paused recovery transfer runs passed; aggregate report written.\n");
  } finally {
    if (preview.exitCode == null) preview.kill("SIGTERM");
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
