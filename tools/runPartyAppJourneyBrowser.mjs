import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromeCandidates = [
  process.env.MAZZY_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

const commandExists = async (candidate) => {
  try {
    const child = spawn(candidate, ["--version"], { stdio: "ignore" });
    return await new Promise((resolve) => {
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    });
  } catch {
    return false;
  }
};

const findChrome = async () => {
  for (const candidate of chromeCandidates) {
    if (await commandExists(candidate)) return candidate;
  }
  throw new Error("A local Chrome or Chromium executable is required for the full App journey.");
};

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a loopback port.");
  return port;
};

const waitForHttp = async (url, processHandle, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode != null) throw new Error("The diagnostics preview server exited early.");
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch { /* Preview is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The diagnostics preview server did not become ready.");
};

class PipeCdp {
  constructor(chrome) {
    this.chrome = chrome;
    this.writePipe = chrome.stdio[3];
    this.readPipe = chrome.stdio[4];
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.subscriptions = new Map();
    this.eventBacklog = new Map();
    this.knownEventKeys = new Set();
    this.inFlightSubscribers = new Set();
    this.subscriptionsClosed = false;
    this.backlogOverflowed = false;
    this.observerFailed = false;
    this.buffer = Buffer.alloc(0);
    this.readPipe.on("data", (chunk) => this.consume(chunk));
    this.readPipe.on("error", () => this.failAll());
    chrome.once("exit", () => this.failAll());
  }

  failAll() {
    for (const { reject } of this.pending.values()) reject(new Error("Chrome CDP pipe closed."));
    this.pending.clear();
    for (const waiters of this.events.values()) {
      for (const waiter of waiters) waiter.reject(new Error("Chrome CDP pipe closed."));
    }
    this.events.clear();
    this.subscriptions.clear();
    this.eventBacklog.clear();
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const boundary = this.buffer.indexOf(0);
      if (boundary < 0) return;
      const raw = this.buffer.subarray(0, boundary).toString("utf8");
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!raw) continue;
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(`CDP command failed: ${request.method}`));
        else request.resolve(message.result ?? {});
        continue;
      }
      if (message.method) {
        const key = `${message.sessionId ?? "browser"}:${message.method}`;
        const subscribers = this.subscriptions.get(key);
        if (subscribers?.size) {
          for (const subscriber of subscribers) {
            try {
              let tracked;
              tracked = Promise.resolve(subscriber(message.params ?? {}))
                .catch(() => { this.observerFailed = true; })
                .finally(() => { this.inFlightSubscribers.delete(tracked); });
              this.inFlightSubscribers.add(tracked);
            } catch { this.observerFailed = true; }
          }
        }
        const waiters = this.events.get(key);
        if (waiters?.length) {
          const waiter = waiters.shift();
          if (!waiters.length) this.events.delete(key);
          waiter.resolve(message.params ?? {});
        } else if (!subscribers?.size && this.knownEventKeys.has(key)) {
          const queued = this.eventBacklog.get(key) ?? [];
          if (queued.length < 1_000) queued.push(message.params ?? {});
          else this.backlogOverflowed = true;
          this.eventBacklog.set(key, queued);
        }
      }
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.writePipe.write(`${JSON.stringify(payload)}\0`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  waitEvent(method, sessionId = undefined, timeoutMs = 10_000) {
    const key = `${sessionId ?? "browser"}:${method}`;
    this.knownEventKeys.add(key);
    const queued = this.eventBacklog.get(key);
    if (queued?.length) {
      const event = queued.shift();
      if (!queued.length) this.eventBacklog.delete(key);
      return Promise.resolve(event);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const waiters = this.events.get(key) ?? [];
      waiters.push(waiter);
      this.events.set(key, waiters);
      const timer = setTimeout(() => {
        const current = this.events.get(key) ?? [];
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
        if (!current.length) this.events.delete(key);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      timer.unref?.();
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  subscribe(method, sessionId, subscriber) {
    if (this.subscriptionsClosed) {
      this.observerFailed = true;
      return () => undefined;
    }
    const key = `${sessionId ?? "browser"}:${method}`;
    const subscribers = this.subscriptions.get(key) ?? new Set();
    subscribers.add(subscriber);
    this.subscriptions.set(key, subscribers);
    return () => {
      const current = this.subscriptions.get(key);
      current?.delete(subscriber);
      if (!current?.size) this.subscriptions.delete(key);
    };
  }

  async closeAndDrainSubscriptions(timeoutMs = 5_000) {
    this.subscriptionsClosed = true;
    this.subscriptions.clear();
    const deadline = Date.now() + timeoutMs;
    while (this.inFlightSubscribers.size) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        this.observerFailed = true;
        return;
      }
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), remainingMs);
        timer.unref?.();
      });
      const settled = await Promise.race([
        Promise.allSettled([...this.inFlightSubscribers]).then(() => "settled"),
        timedOut
      ]);
      clearTimeout(timer);
      if (settled === "timed-out") {
        this.observerFailed = true;
        return;
      }
    }
  }
}

const evaluate = async (cdp, sessionId, expression) => {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);
  if (result.exceptionDetails) throw new Error("The browser evaluation failed.");
  return result.result?.value;
};

const waitFor = async (operation, { timeoutMs = 30_000, intervalMs = 100, message = "Browser condition timed out." } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
};

const elementPointExpression = ({ selector, text = null, exact = false, descendant = null }) => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const match = nodes.find((node) => {
    const label = (node.textContent || "").replace(/\\s+/g, " ").trim();
    const textMatches = ${text == null ? "true" : exact
      ? `label === ${JSON.stringify(text)}`
      : `label.includes(${JSON.stringify(text)})`};
    const target = ${descendant ? `node.querySelector(${JSON.stringify(descendant)})` : "node"};
    if (!textMatches || !target || target.disabled) return false;
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  });
  if (!match) return null;
  const target = ${descendant ? `match.querySelector(${JSON.stringify(descendant)})` : "match"};
  target.scrollIntoView({ block: "center", inline: "center" });
  const rect = target.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

const trustedClick = async (cdp, sessionId, options) => {
  const point = await waitFor(
    () => evaluate(cdp, sessionId, elementPointExpression(options)),
    { timeoutMs: options.timeoutMs ?? 30_000, message: `Could not find enabled control: ${options.text ?? options.selector}` }
  );
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1
  }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1
  }, sessionId);
};

const makeStereoWav = (seconds, leftFrequency, rightFrequency, sampleRate = 48_000) => {
  const frames = Math.round(seconds * sampleRate);
  const channels = 2;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const edge = Math.min(1, frame / 480, (frames - 1 - frame) / 480);
    const slowPulse = 0.72 + 0.28 * Math.max(0, Math.sin(2 * Math.PI * 2 * frame / sampleRate));
    const left = 0.07 * edge * slowPulse * Math.sin(2 * Math.PI * leftFrequency * frame / sampleRate);
    const right = 0.07 * edge * slowPulse * Math.sin(2 * Math.PI * rightFrequency * frame / sampleRate);
    buffer.writeInt16LE(Math.round(left * 32767), 44 + frame * 4);
    buffer.writeInt16LE(Math.round(right * 32767), 46 + frame * 4);
  }
  return buffer;
};

const createFixtures = async (root) => {
  const definitions = [[110, 137], [147, 174], [196, 220]];
  const files = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const file = path.join(root, `generated-party-${index + 1}.wav`);
    await writeFile(file, makeStereoWav(12, ...definitions[index]));
    files.push(file);
  }
  return files;
};

const runOneJourney = async ({ chromePath, pageUrl, runOrdinal }) => {
  const profileRoot = await mkdtemp(path.join(tmpdir(), `mazzy-party-profile-${runOrdinal}-`));
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), `mazzy-party-files-${runOrdinal}-`));
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
    let cdpExceptions = 0;
    let cdpExternalRequests = 0;
    const stopObservers = [];
    const origin = new URL(pageUrl).origin;
    const isExternalNetworkUrl = (value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.origin !== origin;
      } catch {
        return true;
      }
    };
    const countExceptions = (observedSessionId = sessionId) => {
      stopObservers.push(cdp.subscribe("Runtime.exceptionThrown", observedSessionId, () => {
        cdpExceptions += 1;
      }));
    };
    const countRequests = (observedSessionId = sessionId) => {
      stopObservers.push(cdp.subscribe("Network.requestWillBeSent", observedSessionId, (event) => {
        if (isExternalNetworkUrl(event.request.url)) cdpExternalRequests += 1;
      }));
    };
    const guardRequests = (observedSessionId = sessionId) => {
      stopObservers.push(cdp.subscribe("Fetch.requestPaused", observedSessionId, async (event) => {
        const external = isExternalNetworkUrl(event.request.url);
        if (external) {
          cdpExternalRequests += 1;
          await cdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient"
          }, observedSessionId);
        } else {
          await cdp.send("Fetch.continueRequest", { requestId: event.requestId }, observedSessionId);
        }
      }));
    };
    countExceptions();
    countRequests();
    guardRequests();
    const observeAttachedTarget = async (attached) => {
      if (!["worker", "shared_worker", "service_worker"].includes(attached.targetInfo?.type)) {
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, attached.sessionId);
        return;
      }
      await Promise.all([
        cdp.send("Runtime.enable", {}, attached.sessionId),
        cdp.send("Network.enable", {}, attached.sessionId),
        cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, attached.sessionId)
      ]);
      countExceptions(attached.sessionId);
      countRequests(attached.sessionId);
      guardRequests(attached.sessionId);
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, attached.sessionId);
    };
    stopObservers.push(cdp.subscribe("Target.attachedToTarget", undefined, observeAttachedTarget));
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    });

    let loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 15_000);
    await cdp.send("Page.navigate", { url: pageUrl }, sessionId);
    await loaded;
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#party-app-journey-status")?.textContent?.includes("EMPTY DISPOSABLE PROFILE")`),
      { timeoutMs: 20_000, message: "The journey page did not confirm an empty profile." }
    );

    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
    const chooser = cdp.waitEvent("Page.fileChooserOpened", sessionId, 10_000);
    await trustedClick(cdp, sessionId, { selector: ".party-mode-flow button", text: "IMPORT MUSIC" });
    const chooserEvent = await chooser;
    if (!chooserEvent.backendNodeId) throw new Error("Chrome did not expose the real file input owner.");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
    const { nodeId: fileInputNodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "input[type='file'][multiple]"
    }, sessionId);
    if (!fileInputNodeId) throw new Error("The real hidden file input was not available.");
    await evaluate(cdp, sessionId, `(() => {
      const input = document.querySelector("input[type='file'][multiple]");
      if (!input) return false;
      input.addEventListener("change", (event) => {
        const files = [...(event.target.files || [])];
        globalThis.__mazzyJourneyFileDelivery = {
          count: files.length,
          wavCount: files.filter((file) => file.name.toLowerCase().endsWith(".wav")).length
        };
      }, { once: true, capture: true });
      return true;
    })()`);
    await cdp.send("DOM.setFileInputFiles", {
      files: [fixtureRoot],
      nodeId: fileInputNodeId
    }, sessionId);
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId);
    try {
      await waitFor(
        () => evaluate(cdp, sessionId, `document.querySelector("#party-app-journey-status")?.textContent?.includes("IMPORT COMMITTED")`),
        { timeoutMs: 45_000, message: "The generated files did not commit through the real import path." }
      );
    } catch {
      const state = await evaluate(cdp, sessionId, `({
        rows: document.querySelectorAll(".library-row").length,
        membershipStatus: Boolean(document.querySelector(".party-mode-readiness[aria-busy='true']")),
        selectedFiles: document.querySelector("input[type='file'][multiple]")?.files?.length ?? -1,
        importDisabled: [...document.querySelectorAll("button")]
          .find((node) => node.textContent?.includes("IMPORT MUSIC"))?.disabled ?? null,
        deliveredCount: globalThis.__mazzyJourneyFileDelivery?.count ?? -1,
        deliveredWavCount: globalThis.__mazzyJourneyFileDelivery?.wavCount ?? -1,
        noSupportedToast: document.body.textContent?.includes("No supported MP3") === true,
        updatingToast: document.body.textContent?.includes("Local music is still updating") === true
      })`);
      throw new Error(`The generated import did not settle (mode=${chooserEvent.mode}, rows=${state.rows}, busy=${state.membershipStatus}, selected=${state.selectedFiles}, delivered=${state.deliveredCount}/${state.deliveredWavCount}, disabled=${state.importDisabled}, unsupported=${state.noSupportedToast}, updating=${state.updatingToast}, exceptions=${cdpExceptions}).`);
    }
    const importFocused = await evaluate(cdp, sessionId,
      `document.activeElement?.textContent?.replace(/\\s+/g, " ").includes("IMPORT MUSIC") === true`);
    if (!importFocused) throw new Error("Import completion did not restore focus to the persistent Import action.");

    loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 15_000);
    await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
    await loaded;
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#party-app-journey-status")?.textContent?.includes("HYDRATION CONFIRMED")`),
      { timeoutMs: 30_000, message: "The hard reload did not hydrate all generated Blobs." }
    );
    await trustedClick(cdp, sessionId, { selector: "#party-app-journey-start", text: "ARM PARTY JOURNEY EVIDENCE", exact: true });
    await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#party-app-journey-status")?.textContent?.includes("JOURNEY ARMED")`),
      { timeoutMs: 10_000, message: "Audio-health evidence did not arm from the trusted click." }
    );

    await trustedClick(cdp, sessionId, { selector: ".library-row button", text: "CHOOSE FIRST" });
    await waitFor(
      () => evaluate(cdp, sessionId, `(() => {
        const button = [...document.querySelectorAll(".party-mode-flow button")]
          .find((node) => node.textContent?.includes("PLAY FIRST SONG"));
        return Boolean(button && !button.disabled);
      })()`),
      { timeoutMs: 30_000, message: "The first-song ready action did not become available." }
    );

    for (let queueCount = 0; queueCount < 2; queueCount += 1) {
      await trustedClick(cdp, sessionId, { selector: ".library-row button", text: "ADD TO QUEUE" });
      await waitFor(
        () => evaluate(cdp, sessionId, `document.querySelectorAll(".queue-item").length === ${queueCount + 1}`),
        { timeoutMs: 5_000, message: "A generated track did not enter the real queue." }
      );
    }

    await trustedClick(cdp, sessionId, {
      selector: ".party-mode-options label",
      text: "Keep a private Autopilot activity check in this tab",
      descendant: "input[type='checkbox']"
    });
    await trustedClick(cdp, sessionId, { selector: ".party-mode-flow button", text: "PLAY FIRST SONG" });
    await waitFor(
      () => evaluate(cdp, sessionId, `[...document.querySelectorAll(".party-mode-flow button")]
        .some((node) => node.textContent?.includes("FIRST SONG PLAYING"))`),
      { timeoutMs: 10_000, message: "The trusted first-song action did not start the Deck." }
    );
    await trustedClick(cdp, sessionId, { selector: ".party-mode-flow button", text: "START AUTOPILOT" });
    await waitFor(
      () => evaluate(cdp, sessionId, `document.activeElement?.querySelector?.("#party-readiness-title") != null`),
      { timeoutMs: 5_000, message: "The readiness summary did not receive focus." }
    );
    await trustedClick(cdp, sessionId, {
      selector: ".party-mode-readiness button",
      text: "START PARTY AUTOPILOT",
      exact: true
    });

    const reportText = await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelector("#party-app-journey-report")?.textContent || ""`),
      { timeoutMs: 110_000, intervalMs: 250, message: "The real App journey did not reach a bounded terminal report." }
    );
    const report = JSON.parse(reportText);
    for (const stopObserver of stopObservers.splice(0)) stopObserver();
    await cdp.closeAndDrainSubscriptions();
    if (!report?.passed || report.schemaVersion !== "party-app-journey-report/v1" ||
      cdpExceptions !== 0 || cdpExternalRequests !== 0 || cdp.observerFailed || cdp.backlogOverflowed) {
      const failureCodes = Array.isArray(report?.failureCodes) ? report.failureCodes.join(",") : "malformed-report";
      const aggregate = JSON.stringify({ counts: report?.counts, completion: report?.completion, terminal: report?.terminal });
      const visibleState = await evaluate(cdp, sessionId, `({
        transitionOwnershipLost: document.body.textContent?.includes("Transition completion ownership was lost") === true,
        sourceEndedUnexpectedly: document.body.textContent?.includes("playing song ended before") === true,
        deckStoppedDuringChange: document.body.textContent?.includes("deck stopped before Mazzy could verify") === true,
        deckCompletionConflict: document.body.textContent?.includes("song ended while Mazzy still had another automatic operation open") === true,
        transitionPreparationFailed: document.body.textContent?.includes("transition could not be prepared safely") === true,
        privateCheckNeedsAttention: document.body.textContent?.includes("PRIVATE ACTIVITY CHECK · NEEDS ATTENTION") === true,
        privateCheckCode: ([...document.querySelectorAll("p")]
          .find((node) => node.textContent?.includes("PRIVATE ACTIVITY CHECK · NEEDS ATTENTION"))
          ?.textContent?.split("·").at(-1)?.trim() || "none").replace(/[^a-z0-9-]/g, "")
      })`);
      throw new Error(`The full App browser report did not pass its strict terminal gates (${failureCodes}; cdp-exceptions=${cdpExceptions}; external-requests=${cdpExternalRequests}; observer-failed=${cdp.observerFailed}; event-overflow=${cdp.backlogOverflowed}; state=${JSON.stringify(visibleState)}; aggregate=${aggregate}).`);
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

const comparableReport = (report) => ({
  counts: report.counts,
  completion: {
    uniqueTransitionOwners: report.completion.uniqueTransitionOwners,
    cancelledTransitions: report.completion.cancelledTransitions,
    ownershipFailures: report.completion.ownershipFailures
  },
  terminal: report.terminal,
  focus: report.focus,
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
    const pageUrl = `http://127.0.0.1:${port}/party-app-journey-diagnostic.html`;
    await waitForHttp(pageUrl, preview);
    const reports = [];
    for (let runOrdinal = 1; runOrdinal <= 2; runOrdinal += 1) {
      process.stdout.write(`Running generated full App Party journey ${runOrdinal}/2…\n`);
      reports.push(await runOneJourney({ chromePath, pageUrl, runOrdinal }));
    }
    const reportsMatched = JSON.stringify(comparableReport(reports[0])) === JSON.stringify(comparableReport(reports[1]));
    if (!reportsMatched) throw new Error("The two fresh-profile journey runs produced different ownership counts.");
    const artifact = Object.freeze({
      schemaVersion: "party-app-browser-acceptance/v1",
      runnerContract: "party-app-browser-runner/v1",
      status: "passed",
      freshProfileRuns: 2,
      reportsMatched,
      reports,
      evidenceScope: "Two fresh-profile generated-WAV full React App journeys; not real music, physical speakers, codec breadth, process-death durability, or endurance.",
      privacy: "Aggregate fixed enums, booleans, capped counters, and bounded 48 kHz audio-health metrics only; no names, paths, IDs, hashes, timestamps, raw error text, user agent, or device identifiers. Temporary profiles and WAV files were deleted."
    });
    await writeFile(
      path.join(workspaceRoot, "PARTY_APP_BROWSER_ACCEPTANCE_REPORT.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      { mode: 0o644 }
    );
    process.stdout.write("Two full App Party journeys passed; aggregate report written.\n");
  } finally {
    if (preview.exitCode == null) preview.kill("SIGTERM");
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export {
  PipeCdp,
  evaluate,
  findChrome,
  makeStereoWav,
  reservePort,
  trustedClick,
  waitFor,
  waitForHttp
};
