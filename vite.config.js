import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { createReadStream, statSync, mkdirSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateEvaluationRoot } from "./tools/privateEvaluationPaths.mjs";
import { writeOfflineAppShell } from "./tools/offlineAppShell.mjs";

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));
const htmlInputs = {
  index: path.join(workspaceRoot, "index.html"),
  "device-soak": path.join(workspaceRoot, "device-soak.html"),
  ...(process.env.MAZZY_INCLUDE_DIAGNOSTICS === "1"
    ? {
        "key-lock-benchmark": path.join(workspaceRoot, "key-lock-benchmark.html"),
        "key-lock-crossfade-diagnostic": path.join(workspaceRoot, "key-lock-crossfade-diagnostic.html"),
        "key-lock-listening": path.join(workspaceRoot, "key-lock-listening.html"),
        "master-peak-guard-listening": path.join(workspaceRoot, "master-peak-guard-listening.html"),
        "party-continuation-diagnostic": path.join(workspaceRoot, "party-continuation-diagnostic.html"),
        "party-level-listening": path.join(workspaceRoot, "party-level-listening.html"),
        "transition-rehearsal-diagnostic": path.join(workspaceRoot, "transition-rehearsal-diagnostic.html")
      }
    : {})
};
const legacyPrivateEvaluationRoot = path.join(workspaceRoot, ".mazzy-private-evaluation");
const privateRootRelativeToWorkspace = path.relative(workspaceRoot, privateEvaluationRoot);
if (!privateRootRelativeToWorkspace.startsWith("..") && !path.isAbsolute(privateRootRelativeToWorkspace)) {
  throw new Error("MAZZY_PRIVATE_EVAL_DIR must be outside the Vite workspace.");
}
const experimentRoot = path.join(privateEvaluationRoot, "beat-this-onnx-final0");
const experimentPrefix = "/models/beat-this-final0/v1/";
const contentTypes = {
  ".json": "application/json",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm"
};
const experimentAllowlist = new Set(["beat_this.onnx", "config.json", "mel-filterbank.bin"]);
const includeEnhancedTiming = process.env.MAZZY_INCLUDE_ENHANCED_TIMING === "1";
const includeDiagnostics = process.env.MAZZY_INCLUDE_DIAGNOSTICS === "1";
const appBase = process.env.MAZZY_BASE_URL || "/";
const buildOutputRoot = path.join(
  workspaceRoot,
  process.env.MAZZY_INCLUDE_DIAGNOSTICS === "1" ? "dist-diagnostics" : "dist"
);
const experimentHashes = new Map([
  ["beat_this.onnx", "078572af6ca47741e06a82d09525d13c793eaa8e311a8cf15e831dcd7e73f218"],
  ["config.json", "56cc961ddc588c57787c20c01ec6ab483b23af1049e65bd33d599a81803acd69"],
  ["mel-filterbank.bin", "1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533"]
]);
const sha256File = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");

const privateEvaluationGuard = () => ({
  name: "mazzy-private-evaluation-guard",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      let decodedUrl;
      try {
        decodedUrl = decodeURIComponent(request.url?.split("?")[0] ?? "");
      } catch {
        response.statusCode = 400;
        response.end("Invalid URL");
        return;
      }
      const legacyRequest = decodedUrl === "/.mazzy-private-evaluation" ||
        decodedUrl.startsWith("/.mazzy-private-evaluation/");
      // Vite's /@fs/ prefix is four characters before the absolute path's
      // leading slash (for example /@fs/Users/...). Preserve that slash.
      const fsPath = decodedUrl.startsWith("/@fs/") ? path.resolve(decodedUrl.slice(4)) : null;
      const insidePrivateRoot = fsPath && (
        fsPath === privateEvaluationRoot || fsPath.startsWith(`${privateEvaluationRoot}${path.sep}`) ||
        fsPath === legacyPrivateEvaluationRoot || fsPath.startsWith(`${legacyPrivateEvaluationRoot}${path.sep}`)
      );
      if (legacyRequest || insidePrivateRoot) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      next();
    });
  }
});

const beatThisExperimentAssets = () => ({
  name: "mazzy-beat-this-experiment-assets",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const assetRoot = request.url?.startsWith(experimentPrefix) ? experimentRoot : null;
      const prefix = experimentPrefix;
      if (!assetRoot) return next();
      const assetName = request.url.slice(prefix.length).split("?")[0];
      if (!assetName || path.basename(assetName) !== assetName) {
        response.statusCode = 400;
        response.end("Invalid experimental asset path");
        return;
      }
      if (!experimentAllowlist.has(assetName)) {
        response.statusCode = 404;
        response.end("Experimental asset not allowlisted");
        return;
      }
      const filePath = path.join(assetRoot, assetName);
      try {
        const fileStat = statSync(filePath);
        if (!fileStat.isFile()) throw new Error("not a file");
        response.statusCode = 200;
        response.setHeader("Content-Type", contentTypes[path.extname(filePath)] ?? "application/octet-stream");
        response.setHeader("Content-Length", String(fileStat.size));
        response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        createReadStream(filePath).pipe(response);
      } catch {
        response.statusCode = 404;
        response.end("Run npm run prepare:beat-this-onnx to prepare this development-only asset.");
      }
    });
  }
});

const beatThisProductionAssets = () => ({
  name: "mazzy-beat-this-production-assets",
  apply: "build",
  closeBundle() {
    if (!includeEnhancedTiming) {
      console.warn("Building without the optional enhanced timing pack. Use npm run build:enhanced after preparing assets to include it.");
      return;
    }
    const requiredAssets = [
      ...[...experimentAllowlist].map((assetName) => path.join(experimentRoot, assetName))
    ];
    if (!requiredAssets.every(existsSync)) {
      throw new Error("Enhanced timing build requested, but checksum-pinned assets are absent. Run npm run prepare:beat-this-onnx first.");
    }
    for (const assetName of experimentAllowlist) {
      const source = path.join(experimentRoot, assetName);
      if (sha256File(source) !== experimentHashes.get(assetName)) {
        throw new Error(`Refusing to copy unverified enhanced timing asset: ${assetName}`);
      }
    }
    const modelDestination = path.join(buildOutputRoot, "models", "beat-this-final0", "v1");
    mkdirSync(modelDestination, { recursive: true });
    for (const assetName of experimentAllowlist) {
      copyFileSync(path.join(experimentRoot, assetName), path.join(modelDestination, assetName));
    }
  }
});

const legalArtifacts = () => ({
  name: "mazzy-legal-artifacts",
  apply: "build",
  closeBundle() {
    copyFileSync(path.join(workspaceRoot, "LICENSE"), path.join(buildOutputRoot, "LICENSE"));
    copyFileSync(path.join(workspaceRoot, "THIRD_PARTY_NOTICES.md"), path.join(buildOutputRoot, "THIRD_PARTY_NOTICES.md"));
    copyFileSync(path.join(workspaceRoot, "APACHE-2.0.txt"), path.join(buildOutputRoot, "APACHE-2.0.txt"));
  }
});

const offlineAppShell = () => ({
  name: "mazzy-offline-app-shell",
  apply: "build",
  closeBundle() {
    if (!includeDiagnostics) writeOfflineAppShell(buildOutputRoot, { base: appBase });
  }
});

const diagnosticInstallBoundary = () => ({
  name: "mazzy-diagnostic-install-boundary",
  apply: "build",
  transformIndexHtml(html, context) {
    if (!includeDiagnostics || context.path !== "/index.html") return html;
    return html.replace(/\s*<link rel="manifest"[^>]*>/, "");
  },
  closeBundle() {
    if (!includeDiagnostics) return;
    for (const relativePath of ["manifest.webmanifest", "mazzy-icon.svg", "icons"]) {
      rmSync(path.join(buildOutputRoot, relativePath), { recursive: true, force: true });
    }
  }
});

const standardArtifactBoundary = () => ({
  name: "mazzy-standard-artifact-boundary",
  apply: "build",
  closeBundle() {
    if (includeEnhancedTiming || includeDiagnostics) return;
    const assetsRoot = path.join(buildOutputRoot, "assets");
    const forbidden = existsSync(assetsRoot)
      ? readdirSync(assetsRoot).filter((name) => /^beatThisDiagnostic\.worker-|^ort-wasm-.*\.wasm$/.test(name))
      : [];
    if (forbidden.length) {
      throw new Error(`Standard build unexpectedly contains enhanced timing runtime: ${forbidden.join(", ")}`);
    }
  }
});

export default defineConfig({
  base: appBase,
  plugins: [privateEvaluationGuard(), react(), beatThisExperimentAssets(), beatThisProductionAssets(), legalArtifacts(), offlineAppShell(), diagnosticInstallBoundary(), standardArtifactBoundary()],
  resolve: {
    alias: {
      "@mazzy/enhanced-rhythm": path.join(
        workspaceRoot,
        includeEnhancedTiming ? "src/analysis/enhancedRhythmRuntime.ts" : "src/analysis/enhancedRhythmUnavailable.ts"
      )
    }
  },
  define: {
    __MAZZY_ENHANCED_TIMING_INCLUDED__: JSON.stringify(includeEnhancedTiming),
    __MAZZY_OFFLINE_SHELL_INCLUDED__: JSON.stringify(!includeDiagnostics)
  },
  server: {
    fs: {
      deny: [`${privateEvaluationRoot}/**`, `${legacyPrivateEvaluationRoot}/**`]
    }
  },
  build: {
    outDir: process.env.MAZZY_INCLUDE_DIAGNOSTICS === "1" ? "dist-diagnostics" : "dist",
    rollupOptions: { input: htmlInputs }
  }
});
