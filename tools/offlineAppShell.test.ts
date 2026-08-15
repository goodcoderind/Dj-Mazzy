import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OFFLINE_SHELL_WORKER_CONTRACT, renderOfflineServiceWorker, selectOfflineShellFiles, writeOfflineAppShell } from "./offlineAppShell.mjs";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mazzy-offline-shell-"));
  roots.push(root);
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), '<script src="/assets/index-abc.js"></script><link href="/assets/index-abc.css">');
  for (const name of [
    "index-abc.js", "index-abc.css", "AudioEngine-one.js", "analysis.worker-one.js",
    "beatThisDiagnostic.worker-one.js", "ort-wasm-one.wasm"
  ]) writeFileSync(path.join(root, "assets", name), name);
  mkdirSync(path.join(root, "icons"));
  for (const name of ["manifest.webmanifest", "mazzy-icon.svg", "icons/mazzy-192.png", "icons/mazzy-512.png", "device-soak.html", "transition-rehearsal-diagnostic.html"]) {
    writeFileSync(path.join(root, name), name);
  }
  mkdirSync(path.join(root, "models", "private"), { recursive: true });
  writeFileSync(path.join(root, "models", "private", "beat_this.onnx"), "model");
  return root;
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("offline app shell", () => {
  it("allowlists only the production root shell and basic worker by default", () => {
    const root = fixture();
    expect(selectOfflineShellFiles(root)).toEqual([
      "assets/analysis.worker-one.js",
      "assets/index-abc.css",
      "assets/index-abc.js",
      "icons/mazzy-192.png",
      "icons/mazzy-512.png",
      "index.html",
      "manifest.webmanifest",
      "mazzy-icon.svg"
    ]);
  });

  it("keeps optional timing code, models, and diagnostic pages outside the app shell", () => {
    const root = fixture();
    const files = selectOfflineShellFiles(root);
    expect(files).not.toContain("assets/beatThisDiagnostic.worker-one.js");
    expect(files).not.toContain("assets/ort-wasm-one.wasm");
    expect(files).not.toContain("models/private/beat_this.onnx");
    expect(files).not.toContain("device-soak.html");
    expect(files).not.toContain("transition-rehearsal-diagnostic.html");
  });

  it("writes a content-versioned cache contract with exact-path fetch handling", () => {
    const root = fixture();
    const first = writeOfflineAppShell(root);
    const worker = readFileSync(path.join(root, "mazzy-sw.js"), "utf8");
    expect(first.schemaVersion).toBe("offline-app-shell-manifest/v2");
    expect(first.workerContract).toBe(OFFLINE_SHELL_WORKER_CONTRACT);
    expect(first.cacheContract).toMatch(/^mazzy-app-shell-v2-[a-f0-9]{8}-[a-f0-9]{16}$/);
    expect(first.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(worker).toContain('request.method !== "GET"');
    expect(worker).not.toContain("self.skipWaiting()");
    expect(worker).toContain('fetch(url, { cache: "reload" })');
    expect(worker).toContain('crypto.subtle.digest("SHA-256", body)');
    expect(worker).toContain("url.origin !== self.location.origin");
    expect(worker).toContain("if (!SHELL_PATHS.has(url.pathname)) return");
    expect(worker).not.toContain('cache.put("/index.html"');
    expect(worker).toContain("caches.open(CACHE_NAME)");
    expect(worker).toContain('cache.match(BASE_PATH + "index.html")');
    expect(worker).not.toContain("models/private");
    expect(worker).not.toContain("device-soak");

    writeFileSync(path.join(root, "assets", "index-abc.js"), "changed");
    const second = writeOfflineAppShell(root);
    expect(second.cacheContract).not.toBe(first.cacheContract);
  });

  it("generates a subpath-scoped shell", () => {
    const root = fixture();
    writeFileSync(path.join(root, "index.html"), '<script src="/Dj-Mazzy/assets/index-abc.js"></script>');
    const manifest = writeOfflineAppShell(root, { base: "/Dj-Mazzy/" });
    const worker = readFileSync(path.join(root, "mazzy-sw.js"), "utf8");
    expect(manifest.base).toBe("/Dj-Mazzy/");
    expect(manifest.files.map((entry) => entry.url)).toContain("/Dj-Mazzy/assets/index-abc.js");
    expect(worker).toContain('const BASE_PATH = "/Dj-Mazzy/"');
    expect(worker).toContain('cache.match(BASE_PATH + "index.html")');
  });

  it("rejects a successful response whose bytes do not match the build", async () => {
    let installHandler: ((event: { waitUntil: (promise: Promise<unknown>) => void }) => void) | undefined;
    let installPromise: Promise<unknown> | undefined;
    const deleteCache = vi.fn(async () => true);
    const put = vi.fn(async () => undefined);
    const worker = renderOfflineServiceWorker([
      { file: "index.html", sha256: "0".repeat(64) }
    ], "bad-body");
    const runWorker = new Function("self", "caches", "fetch", "crypto", "Response", "Headers", "URL", worker);
    runWorker(
      {
        location: { origin: "https://mazzy.invalid" },
        clients: { claim: async () => undefined },
        addEventListener: (type: string, handler: typeof installHandler) => {
          if (type === "install") installHandler = handler;
        }
      },
      { open: async () => ({ put, match: async () => undefined }), delete: deleteCache, keys: async () => [] },
      async () => new Response("this is an HTML fallback", { status: 200, headers: { "content-type": "text/html" } }),
      globalThis.crypto,
      Response,
      Headers,
      URL
    );
    installHandler?.({ waitUntil: (promise) => { installPromise = promise; } });
    await expect(installPromise).rejects.toThrow("integrity mismatch");
    expect(put).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledOnce();
  });
});
