import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory, privateEvaluationRoot } from "./privateEvaluationPaths.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(privateEvaluationRoot, "beat-this-onnx-final0");
const revision = "4e971bd43753023e1bf961c34a0cb74985cfcb88";
const baseUrl = `https://huggingface.co/musetric/beat-this-onnx/resolve/${revision}`;
const assets = [
  {
    file: "beat_this.onnx",
    sha256: "078572af6ca47741e06a82d09525d13c793eaa8e311a8cf15e831dcd7e73f218"
  },
  {
    file: "mel-filterbank.bin",
    sha256: "1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533"
  },
  {
    file: "config.json",
    sha256: "56cc961ddc588c57787c20c01ec6ab483b23af1049e65bd33d599a81803acd69"
  }
];

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

await ensurePrivateDirectory(privateEvaluationRoot);
await ensurePrivateDirectory(outputDirectory);
for (const asset of assets) {
  const outputPath = path.join(outputDirectory, asset.file);
  let buffer = null;
  try {
    const existing = await readFile(outputPath);
    if (digest(existing) === asset.sha256) buffer = existing;
  } catch {
    // Download below.
  }
  if (!buffer) {
    const response = await fetch(`${baseUrl}/${asset.file}`);
    if (!response.ok) throw new Error(`Failed to download ${asset.file}: ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
    const actual = digest(buffer);
    if (actual !== asset.sha256) {
      throw new Error(`${asset.file} checksum mismatch: expected ${asset.sha256}, received ${actual}`);
    }
    await writeFile(outputPath, buffer, { mode: 0o600 });
  }
  await chmod(outputPath, 0o600);
  console.log(`${asset.file}: ${(buffer.byteLength / 1_000_000).toFixed(2)} MB verified`);
}

console.log(`Prepared development-only Beat This assets in ${outputDirectory}`);
