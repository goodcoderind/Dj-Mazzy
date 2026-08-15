import { BeatThisDiagnosticClient } from "./BeatThisDiagnosticClient";
import { scoreEvents } from "../diagnostics/rhythmBenchmark";
import type { BeatThisTrackDiagnosticResult } from "./beatThisContract";

const runButton = document.querySelector<HTMLButtonElement>("#run");
const trackInput = document.querySelector<HTMLInputElement>("#track");
const analyzeTrackButton = document.querySelector<HTMLButtonElement>("#analyze-track");
const downloadResultButton = document.querySelector<HTMLButtonElement>("#download-result");
const oracleInput = document.querySelector<HTMLInputElement>("#oracle");
const compareOracleButton = document.querySelector<HTMLButtonElement>("#compare-oracle");
const status = document.querySelector<HTMLElement>("#status");
const result = document.querySelector<HTMLElement>("#result");

if (!runButton || !trackInput || !analyzeTrackButton || !downloadResultButton || !oracleInput || !compareOracleButton || !status || !result) {
  throw new Error("Beat This diagnostic page is incomplete");
}

const labels: Record<string, string> = {
  "checking-capabilities": "Checking WebGPU and model contract…",
  "loading-83mb-model": "Loading and compiling the 83.1 MB ONNX model…",
  "running-zero-window": "Running a zero-valued 1500 × 128 feature window…",
  "loading-contract": "Loading the pinned Beat This preprocessing contract…",
  "computing-log-mel": "Computing the centered STFT and 128-bin log-mel spectrogram…"
};

const client = new BeatThisDiagnosticClient();
const forceWasm = new URLSearchParams(window.location.search).get("backend") === "wasm";
let lastPrivateResult: unknown = null;
let lastTrackResult: BeatThisTrackDiagnosticResult | null = null;
oracleInput.addEventListener("change", () => {
  compareOracleButton.disabled = !lastTrackResult || !oracleInput.files?.[0];
});
compareOracleButton.addEventListener("click", async () => {
  const oracleFile = oracleInput.files?.[0];
  if (!lastTrackResult || !oracleFile) return;
  try {
    const oracle = JSON.parse(await oracleFile.text()) as {
      schemaVersion?: string;
      checkpointSha256?: string;
      featureFrames?: number;
      beatsSeconds?: number[];
      downbeatsSeconds?: number[];
    };
    if (
      !["beat-this-final0-python-oracle/v1", "beat-this-final0-python-oracle/v2"].includes(oracle.schemaVersion ?? "") ||
      !Array.isArray(oracle.beatsSeconds) ||
      !Array.isArray(oracle.downbeatsSeconds)
    ) throw new Error("Selected file is not a supported final0 Python oracle result.");
    const parity = {
      schemaVersion: "beat-this-browser-python-parity/v1",
      pythonCheckpointSha256: oracle.checkpointSha256 ?? null,
      featureFramesEqual: oracle.featureFrames === lastTrackResult.featureFrames,
      beatCountEqual: oracle.beatsSeconds.length === lastTrackResult.beatsSeconds.length,
      downbeatCountEqual: oracle.downbeatsSeconds.length === lastTrackResult.downbeatsSeconds.length,
      strict20ms: {
        beat: scoreEvents(lastTrackResult.beatsSeconds, oracle.beatsSeconds, 0.02),
        downbeat: scoreEvents(lastTrackResult.downbeatsSeconds, oracle.downbeatsSeconds, 0.02)
      },
      evaluation70ms: {
        beat: scoreEvents(lastTrackResult.beatsSeconds, oracle.beatsSeconds, 0.07),
        downbeat: scoreEvents(lastTrackResult.downbeatsSeconds, oracle.downbeatsSeconds, 0.07)
      },
      experimentalOnly: true,
      eligibilityConfidence: 0
    };
    status.textContent = `Python/browser parity: beat F1 ${parity.strict20ms.beat.fMeasure.toFixed(3)}, downbeat F1 ${parity.strict20ms.downbeat.fMeasure.toFixed(3)} at ±20 ms.`;
    result.textContent = JSON.stringify(parity, null, 2);
  } catch (error) {
    status.textContent = "Oracle comparison failed; production analysis remains unchanged.";
    result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  }
});
downloadResultButton.addEventListener("click", () => {
  if (!lastPrivateResult) return;
  const blob = new Blob([`${JSON.stringify(lastPrivateResult, null, 2)}\n`], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "mazzy-beat-this-private-result.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});
runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  result.textContent = "Diagnostic running…";
  try {
    const diagnostic = await client.diagnose({
      preferWebGpu: !forceWasm,
      onProgress: (stage) => {
        status.textContent = labels[stage] ?? stage;
      }
    });
    status.textContent = diagnostic.finiteOutput
      ? `Passed with ${diagnostic.backend.toUpperCase()}; still experimental-only.`
      : "Failed output validation.";
    result.textContent = JSON.stringify(diagnostic, null, 2);
    lastPrivateResult = diagnostic;
    downloadResultButton.disabled = false;
  } catch (error) {
    status.textContent = "Diagnostic failed; production analysis remains unchanged.";
    result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    runButton.disabled = false;
  }
});

window.addEventListener("pagehide", () => client.dispose(), { once: true });

const decodeAndCanonicalize = async (file: File) => {
  const decodeContext = new AudioContext();
  try {
    const decoded = await decodeContext.decodeAudioData(await file.arrayBuffer());
    const sourceSampleRate = decoded.sampleRate;
    const analysisSampleRate = 22_050;
    const outputFrames = Math.ceil(decoded.duration * analysisSampleRate);
    const offline = new OfflineAudioContext(1, outputFrames, analysisSampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    const splitter = offline.createChannelSplitter(decoded.numberOfChannels);
    source.connect(splitter);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const gain = offline.createGain();
      gain.gain.value = 1 / decoded.numberOfChannels;
      splitter.connect(gain, channel);
      gain.connect(offline.destination);
    }
    source.start(0);
    const rendered = await offline.startRendering();
    return {
      pcm: new Float32Array(rendered.getChannelData(0)),
      sourceSampleRate,
      durationSeconds: decoded.duration
    };
  } finally {
    await decodeContext.close();
  }
};

analyzeTrackButton.addEventListener("click", async () => {
  const file = trackInput.files?.[0];
  if (!file) {
    status.textContent = "Choose one local audio file first.";
    return;
  }
  runButton.disabled = true;
  analyzeTrackButton.disabled = true;
  result.textContent = "Track diagnostic running…";
  try {
    status.textContent = `Decoding and resampling ${file.name} locally…`;
    const decoded = await decodeAndCanonicalize(file);
    const diagnostic = await client.analyzePcm(
      decoded.pcm,
      decoded.sourceSampleRate,
      decoded.durationSeconds,
      {
        preferWebGpu: !forceWasm,
        onProgress: (stage) => {
          status.textContent = labels[stage] ?? stage.replaceAll("-", " ");
        }
      }
    );
    status.textContent = `Extracted ${diagnostic.beatsSeconds.length} beats and ${diagnostic.downbeatsSeconds.length} downbeats with ${diagnostic.backend.toUpperCase()}; still experimental-only.`;
    result.textContent = JSON.stringify(diagnostic, null, 2);
    lastPrivateResult = diagnostic;
    lastTrackResult = diagnostic;
    downloadResultButton.disabled = false;
    compareOracleButton.disabled = !oracleInput.files?.[0];
  } catch (error) {
    status.textContent = "Track diagnostic failed; production analysis remains unchanged.";
    result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    runButton.disabled = false;
    analyzeTrackButton.disabled = false;
  }
});
