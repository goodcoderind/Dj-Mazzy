import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OFFLINE_SHELL_MANIFEST_VERSION = "offline-app-shell-manifest/v2";
export const OFFLINE_SHELL_CACHE_PREFIX = "mazzy-app-shell-v2-";
export const OFFLINE_SHELL_WORKER_CONTRACT = "mazzy-offline-worker/v2.1";

const normalizedBase = (base = "/") => {
  const pathname = new URL(base, "https://mazzy.invalid").pathname;
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
};
const publicUrl = (relativePath, base = "/") => `${normalizedBase(base)}${relativePath.split(path.sep).join("/")}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const scopedCachePrefix = (base = "/") => `${OFFLINE_SHELL_CACHE_PREFIX}${sha256(normalizedBase(base)).slice(0, 8)}-`;

export const selectOfflineShellFiles = (outputRoot, { base = "/" } = {}) => {
  const indexPath = path.join(outputRoot, "index.html");
  if (!existsSync(indexPath)) throw new Error("Offline shell requires a production index.html");
  const index = readFileSync(indexPath, "utf8");
  const files = new Set(["index.html"]);
  const basePath = normalizedBase(base);
  for (const match of index.matchAll(/(?:src|href)="([^"?#]+)"/g)) {
    const pathname = new URL(match[1], `https://mazzy.invalid${basePath}`).pathname;
    if (!pathname.startsWith(basePath)) continue;
    const relativePath = pathname.slice(basePath.length);
    if (relativePath && existsSync(path.join(outputRoot, relativePath))) files.add(relativePath);
  }
  const assetsRoot = path.join(outputRoot, "assets");
  if (existsSync(assetsRoot)) {
    for (const name of readdirSync(assetsRoot)) {
      if (/^analysis\.worker-[A-Za-z0-9_-]+\.js$/.test(name)) files.add(path.join("assets", name));
    }
  }
  for (const name of ["manifest.webmanifest", "mazzy-icon.svg", "icons/mazzy-192.png", "icons/mazzy-512.png"]) {
    if (existsSync(path.join(outputRoot, name))) files.add(name);
  }
  return [...files].sort();
};

export const renderOfflineServiceWorker = (entries, cacheRevision, base = "/") => {
  const basePath = normalizedBase(base);
  const files = entries.map((entry) => ({ url: publicUrl(entry.file, basePath), sha256: entry.sha256 }));
  const urls = files.map((entry) => entry.url);
  const cachePrefix = scopedCachePrefix(basePath);
  const workerRevision = sha256(`${OFFLINE_SHELL_WORKER_CONTRACT}\0${cacheRevision}`).slice(0, 16);
  const cacheName = `${cachePrefix}${workerRevision}`;
  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};
const BASE_PATH = ${JSON.stringify(basePath)};
const SHELL_FILES = Object.freeze(${JSON.stringify(files)});
const SHELL_URLS = Object.freeze(${JSON.stringify(urls)});
const SHELL_PATHS = new Set(SHELL_URLS);
const toHex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");

const fetchVerified = async ({ url, sha256 }) => {
  const response = await fetch(url, { cache: "reload" });
  if (!response.ok) throw new Error("offline shell asset unavailable");
  const body = await response.arrayBuffer();
  const actual = toHex(await crypto.subtle.digest("SHA-256", body));
  if (actual !== sha256) throw new Error("offline shell asset integrity mismatch");
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
};

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all(SHELL_FILES.map(fetchVerified))
    .then((responses) => caches.open(CACHE_NAME)
      .then((cache) => Promise.all(responses.map((response, index) => cache.put(SHELL_FILES[index].url, response)))))
    .catch((error) => caches.delete(CACHE_NAME).then(() => { throw error; })));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const rootNavigation = request.mode === "navigate" && (
    url.pathname === BASE_PATH ||
    url.pathname === BASE_PATH.slice(0, -1) ||
    url.pathname === BASE_PATH + "index.html"
  );
  if (rootNavigation) {
    event.respondWith(caches.open(CACHE_NAME)
      .then((cache) => cache.match(BASE_PATH + "index.html"))
      .then((cached) => cached || fetch(request)));
    return;
  }
  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE_NAME)
    .then((cache) => cache.match(url.pathname))
    .then((cached) => cached || fetch(request)));
});
`;
};

export const writeOfflineAppShell = (outputRoot, options = {}) => {
  const files = selectOfflineShellFiles(outputRoot, options);
  const entries = files.map((file) => ({ file, sha256: sha256(readFileSync(path.join(outputRoot, file))) }));
  const revision = sha256(entries.map((entry) => `${entry.file}\0${entry.sha256}`).join("\n")).slice(0, 16);
  const workerRevision = sha256(`${OFFLINE_SHELL_WORKER_CONTRACT}\0${revision}`).slice(0, 16);
  const manifest = Object.freeze({
    schemaVersion: OFFLINE_SHELL_MANIFEST_VERSION,
    workerContract: OFFLINE_SHELL_WORKER_CONTRACT,
    cacheContract: `${scopedCachePrefix(options.base)}${workerRevision}`,
    base: normalizedBase(options.base),
    files: Object.freeze(entries.map((entry) => Object.freeze({
      url: publicUrl(entry.file, options.base),
      sha256: entry.sha256
    })))
  });
  writeFileSync(path.join(outputRoot, "mazzy-sw.js"), renderOfflineServiceWorker(entries, revision, options.base), { mode: 0o644 });
  writeFileSync(path.join(outputRoot, "offline-shell-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
};
