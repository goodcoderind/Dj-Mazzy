import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory, privateEvaluationRoot } from "./privateEvaluationPaths.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const musicDirectory = path.resolve(
  process.env.MAZZY_REAL_MUSIC_DIR ?? path.join(homedir(), "Desktop", "music small")
);
const executable = process.env.MAZZY_BEAT_THIS_BIN ?? "beat_this";
const model = process.env.MAZZY_BEAT_THIS_MODEL ?? "small0";
const outputDirectory = path.join(privateEvaluationRoot, `beat-this-${model}`);
const supportedExtensions = new Set([".mp3", ".wav", ".flac", ".aiff", ".m4a"]);

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Beat This executable not found: ${command}. Set MAZZY_BEAT_THIS_BIN to an installed beat_this command.`
          )
        );
      } else reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(performance.now() - startedAt);
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const parseBeatFile = async (filePath) => {
  const rows = (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && Number.isFinite(Number(parts[0])));
  const beatsSeconds = rows.map((parts) => Number(parts[0]));
  const positions = rows.map((parts) => Number(parts[1]));
  const downbeatsSeconds = beatsSeconds.filter((_, index) => positions[index] === 1);
  const intervals = beatsSeconds
    .slice(1)
    .map((beat, index) => beat - beatsSeconds[index])
    .filter((interval) => interval > 0);
  const typicalInterval = median(intervals);
  const medianDeviation = typicalInterval == null
    ? null
    : median(intervals.map((interval) => Math.abs(interval - typicalInterval)));
  return {
    bpm: typicalInterval ? 60 / typicalInterval : null,
    beatsSeconds,
    downbeatsSeconds,
    meterCandidates: [...new Set(positions.filter((position) => position > 0))].sort(
      (left, right) => left - right
    ),
    intervalMedianSeconds: typicalInterval,
    intervalMedianDeviationSeconds: medianDeviation
  };
};

const sourceFiles = (await readdir(musicDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
  .sort((left, right) => left.name.localeCompare(right.name));
if (!sourceFiles.length) throw new Error(`No supported audio files found in ${musicDirectory}`);

await ensurePrivateDirectory(privateEvaluationRoot);
await ensurePrivateDirectory(outputDirectory);
const runtimeMs = await run(executable, [
  "--model",
  model,
  "--gpu",
  "-1",
  musicDirectory,
  "-o",
  outputDirectory
]);

const records = [];
for (const source of sourceFiles) {
  const beatFile = path.join(outputDirectory, source.name.replace(/\.[^/.]+$/, ".beats"));
  const parsed = await parseBeatFile(beatFile);
  records.push({
    fileName: source.name,
    bpm: parsed.bpm,
    beatCount: parsed.beatsSeconds.length,
    downbeatCount: parsed.downbeatsSeconds.length,
    firstBeatSeconds: parsed.beatsSeconds[0] ?? null,
    firstDownbeatSeconds: parsed.downbeatsSeconds[0] ?? null,
    meterCandidates: parsed.meterCandidates,
    intervalMedianSeconds: parsed.intervalMedianSeconds,
    intervalMedianDeviationSeconds: parsed.intervalMedianDeviationSeconds
  });
}

const report = {
  schemaVersion: "beat-this-private-prototype/v1",
  detector: `beat-this/${model}`,
  createdAt: new Date().toISOString(),
  musicDirectory,
  trackCount: records.length,
  totalRuntimeMs: runtimeMs,
  meanRuntimeMs: runtimeMs / records.length,
  confidenceAvailable: false,
  tracks: records
};
const reportPath = path.join(outputDirectory, "prototype-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await chmod(reportPath, 0o600);

console.log(`\nBeat This ${model}: ${records.length} tracks in ${(runtimeMs / 1000).toFixed(2)}s`);
console.log(`Mean runtime: ${(runtimeMs / records.length / 1000).toFixed(2)}s/track`);
console.log("CLI beat files do not contain calibrated confidence; results remain prototype-only.");
for (const record of records) {
  console.log(
    `${record.fileName}: ${record.bpm?.toFixed(1) ?? "none"} BPM, ${record.beatCount} beats, ${record.downbeatCount} downbeats`
  );
}
