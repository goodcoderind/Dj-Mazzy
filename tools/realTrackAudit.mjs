import { createHash } from "node:crypto";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { ensurePrivateDirectory, privateEvaluationRoot } from "./privateEvaluationPaths.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const musicDirectory = path.resolve(
  process.env.MAZZY_REAL_MUSIC_DIR ?? path.join(homedir(), "Desktop", "music small")
);
const outputDirectory = privateEvaluationRoot;
const supportedExtensions = new Set([".mp3", ".wav", ".flac", ".aiff", ".m4a"]);
const analysisSampleRate = 11_025;

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString()}`));
    });
  });

const decodeMono = async (filePath) => {
  const output = await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    filePath,
    "-ac",
    "1",
    "-ar",
    String(analysisSampleRate),
    "-f",
    "f32le",
    "pipe:1"
  ]);
  return new Float32Array(
    output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
  );
};

const average = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const displayName = (fileName) => fileName.replace(/\.[^/.]+$/, "").replace(/\s*\[[^\]]+]$/, "");

const loadReviewManifest = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return { schemaVersion: "private-rhythm-review/v2", tracks: [] };
  }
};

const markdownTable = (records) => [
  "| Track | BPM | Beat conf. | Beats | Downbeats | Energy | Vocal proxy | Changes | Runtime |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...records.map((record) =>
    `| ${record.displayName.replaceAll("|", "\\|")} | ${record.bpm?.toFixed(1) ?? "none"} | ${(record.beatConfidence * 100).toFixed(0)}% | ${record.beatCount} | ${record.downbeatCount} | ${record.averageEnergy == null ? "--" : `${(record.averageEnergy * 100).toFixed(0)}%`} | ${record.averageVocalProxy == null ? "--" : `${(record.averageVocalProxy * 100).toFixed(0)}%`} | ${record.structureChangeCount} | ${(record.runtimeMs / 1000).toFixed(2)}s |`
  )
].join("\n");

const vite = await createServer({ root: workspaceRoot, server: { middlewareMode: true }, appType: "custom" });
try {
  const { analyzePcm } = await vite.ssrLoadModule("/src/analysis/analyzePcm.ts");
  const entries = (await readdir(musicDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!entries.length) throw new Error(`No supported audio files found in ${musicDirectory}`);

  await ensurePrivateDirectory(outputDirectory);
  const reviewPath = path.join(outputDirectory, "rhythm-review.json");
  const reviewManifest = await loadReviewManifest(reviewPath);
  const existingReviews = new Map(reviewManifest.tracks.map((track) => [track.trackHash, track]));
  const records = [];
  const reviewTracks = [];

  for (const [index, entry] of entries.entries()) {
    const filePath = path.join(musicDirectory, entry.name);
    const trackHash = createHash("sha256").update(await readFile(filePath)).digest("hex");
    process.stdout.write(`[${index + 1}/${entries.length}] ${displayName(entry.name)} ... `);
    const pcm = await decodeMono(filePath);
    const durationSeconds = pcm.length / analysisSampleRate;
    const startedAt = performance.now();
    const analysis = analyzePcm(pcm, analysisSampleRate, durationSeconds);
    const runtimeMs = performance.now() - startedAt;
    const record = {
      trackHash,
      displayName: displayName(entry.name),
      durationSeconds,
      bpm: analysis.bpm,
      tempoConfidence: analysis.tempoConfidence,
      beatConfidence: analysis.beatConfidence,
      beatCount: analysis.beatsSeconds.length,
      downbeatCount: analysis.downbeatsSeconds.length,
      downbeatConfidence: analysis.downbeatConfidence,
      averageEnergy: average(analysis.energyByBeat),
      averageVocalProxy: average(analysis.vocalProbabilityByBeat),
      structureChangeCount: analysis.structureBoundaries.length,
      runtimeMs
    };
    records.push(record);
    reviewTracks.push({
      trackHash,
      fileName: entry.name,
      reviewStatus: existingReviews.get(trackHash)?.reviewStatus ?? "unreviewed",
      suitability: existingReviews.get(trackHash)?.suitability ?? "unreviewed",
      canonicalTimebase: "browser-web-audio/v1",
      regions: existingReviews.get(trackHash)?.regions ?? [],
      notes: existingReviews.get(trackHash)?.notes ?? ""
    });
    process.stdout.write(`${analysis.bpm?.toFixed(1) ?? "none"} BPM, ${(analysis.beatConfidence * 100).toFixed(0)}% beat conf, ${(runtimeMs / 1000).toFixed(2)}s\n`);
  }

  const baseline = {
    schemaVersion: "private-real-track-baseline/v1",
    analyzerVersion: "basic-worker/v3",
    createdAt: new Date().toISOString(),
    musicDirectory,
    analysisSampleRate,
    trackCount: records.length,
    tracks: records
  };
  const privateFiles = [
    [path.join(outputDirectory, "real-track-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`],
    [reviewPath, `${JSON.stringify({ schemaVersion: "private-rhythm-review/v2", musicDirectory, tracks: reviewTracks }, null, 2)}\n`],
    [path.join(outputDirectory, "real-track-baseline.md"), `# Mazzy private real-track baseline\n\nGenerated locally with \`basic-worker/v3\` in external private application storage. Values are estimates, not ground truth.\n\n${markdownTable(records)}\n`]
  ];
  for (const [filePath, contents] of privateFiles) {
    await writeFile(filePath, contents, { mode: 0o600 });
    await chmod(filePath, 0o600);
  }
  console.log(`\nWrote private reports to ${outputDirectory}`);
} finally {
  await vite.close();
}
