#!/usr/bin/env python3
"""Create a private, reproducible Beat This final0 event oracle for one audio file."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import tempfile
import time

import beat_this
import numpy as np
import soxr
import torch
from beat_this.inference import Audio2Beats
from beat_this.preprocessing import load_audio


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    arguments = parser.parse_args()

    audio = arguments.audio.resolve(strict=True)
    checkpoint = arguments.checkpoint.resolve(strict=True)
    output_dir = arguments.output_dir.resolve()
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(output_dir, 0o700)

    track_hash = sha256(audio)
    signal, source_sample_rate = load_audio(audio)
    if signal.ndim == 2:
        signal = signal.mean(1)
    canonical_pcm = soxr.resample(signal, in_rate=source_sample_rate, out_rate=22050)
    canonical_pcm = np.asarray(canonical_pcm, dtype=np.float32)
    canonical_pcm_hash = hashlib.sha256(canonical_pcm.tobytes()).hexdigest()

    load_started = time.perf_counter()
    analyzer = Audio2Beats(
        checkpoint_path=str(checkpoint), device="cpu", float16=False, dbn=False
    )
    load_ms = (time.perf_counter() - load_started) * 1000

    preprocess_started = time.perf_counter()
    spectrogram = analyzer.signal2spect(signal, source_sample_rate)
    preprocessing_ms = (time.perf_counter() - preprocess_started) * 1000
    inference_started = time.perf_counter()
    beat_logits, downbeat_logits = analyzer.spect2frames(spectrogram)
    inference_ms = (time.perf_counter() - inference_started) * 1000
    postprocess_started = time.perf_counter()
    # Postprocessor returns (beats, downbeats); the upstream File2File wrapper's
    # local variable names are reversed, so keep the actual contract explicit.
    beats, downbeats = analyzer.frames2beats(beat_logits, downbeat_logits)
    postprocessing_ms = (time.perf_counter() - postprocess_started) * 1000

    result = {
        "schemaVersion": "beat-this-final0-python-oracle/v2",
        "trackHash": track_hash,
        "checkpointSha256": sha256(checkpoint),
        "decoder": "beat-this/load_audio",
        "resampler": f"soxr/{soxr.__version__}",
        "sourceSampleRate": int(source_sample_rate),
        "canonicalPcmSha256": canonical_pcm_hash,
        "canonicalPcmFrames": int(canonical_pcm.size),
        "featureFrames": int(spectrogram.shape[0]),
        "beatsSeconds": [float(value) for value in beats],
        "downbeatsSeconds": [float(value) for value in downbeats],
        "timingMs": {
            "load": load_ms,
            "preprocessing": preprocessing_ms,
            "inference": inference_ms,
            "postprocessing": postprocessing_ms,
        },
        "environment": {
            "python": platform.python_version(),
            "beatThis": getattr(beat_this, "__version__", "1.1.0"),
            "torch": torch.__version__,
        },
    }

    destination = output_dir / f"{track_hash[:16]}.json"
    handle, temporary_name = tempfile.mkstemp(prefix=".oracle-", suffix=".json", dir=output_dir)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as target:
            json.dump(result, target, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, destination)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    print(destination)


if __name__ == "__main__":
    main()
