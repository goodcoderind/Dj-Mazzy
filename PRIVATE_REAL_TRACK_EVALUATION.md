# Private real-track evaluation

Mazzy can evaluate a local music crate without copying audio into the repository
or committing filenames, annotations, or analysis results.

## Run the current baseline

By default the audit reads `~/Desktop/music small`:

```bash
npm run benchmark:real-tracks
```

Use another folder when needed:

```bash
MAZZY_REAL_MUSIC_DIR="/absolute/path/to/music" npm run benchmark:real-tracks
```

The command decodes each supported track to temporary in-memory mono PCM at
11,025 Hz, runs the same deterministic analyzer used by Mazzy, and writes:

- `~/Library/Application Support/Mazzy/private-evaluation/real-track-baseline.json`
- `~/Library/Application Support/Mazzy/private-evaluation/real-track-baseline.md`
- `~/Library/Application Support/Mazzy/private-evaluation/rhythm-review.json`

The private directory is outside the repository and Vite filesystem root. Set
`MAZZY_PRIVATE_EVAL_DIR` to override it. The command never edits source audio.

## Human review

Machine output is not ground truth. Review schema v2 identifies audio by its
full content SHA-256 (so renames do not break identity) and requires explicit
human-checked regions in the canonical `browser-web-audio/v1` timebase. Each
rhythmic region contains its half-open `[startSeconds, endSeconds)` bounds and
the complete, strictly increasing `beatsSeconds` and `downbeatsSeconds` arrays.
A downbeat must also be a beat. Keep model-seeded drafts `unreviewed`; only a
human-auditioned grid may be marked reviewed.

Prefer 32–64-beat regions at the beginning, middle, end, and candidate mix
windows. Exclude ambiguous gaps explicitly instead of inventing a constant
grid. The scorer evaluates each region independently at the documented ±70 ms
tolerance, preventing matches across unannotated gaps.

Do not promote a detector from agreement with another detector. Beat and
downbeat accuracy must ultimately be scored against these human-checked event
grids or a legally usable annotated dataset.

## Beat This prototype

Install Beat This in a disposable environment outside the repository, then run:

```bash
MAZZY_BEAT_THIS_BIN="/absolute/path/to/beat_this" npm run benchmark:beat-this
```

The default model is `small0`; choose another with
`MAZZY_BEAT_THIS_MODEL=final0`. Results are written under the same external
private application directory. This command is deliberately not part of the
application dependency graph.

Beat This's CLI output contains beat timestamps and metrical positions, but no
calibrated per-track confidence. Consequently, successful inference alone is
not sufficient to satisfy Mazzy's `>= 0.8` confidence gate.

## Browser ONNX startup diagnostic

Prepare the checksum-pinned development assets and start Vite:

```bash
npm run prepare:beat-this-onnx
npm run dev
```

Then open `/beat-this-diagnostic.html`. The page lazy-loads ONNX Runtime in a
dedicated worker, uses WebGPU when available, and otherwise uses WASM. It loads
the published `final0` export and runs a zero-valued `1500 × 128` log-mel window
to measure model startup and one-window inference.

Append `?backend=wasm` to force the fallback path during development.

Historical note: the model originally lived only in Mazzy's external
private-evaluation directory and was served through an allowlisted Vite
development route. D-031 supersedes the former “not copied into `dist`” rule.
The standard build still excludes the pack; `npm run build:enhanced` explicitly
copies all three checksum-verified assets into `dist`. Other private files remain
denied, and the diagnostic page is not a production build entry. The startup
button itself does not evaluate audio accuracy.

On the 2026-08-12 development Mac/Chromium run, WebGPU loaded and compiled the
83,143,431-byte model in about `1.16 s` and inferred the zero window in about
`1.46 s`. Forced single-thread WASM loaded in about `0.75 s` and inferred in
about `4.83 s`. Both returned finite beat and downbeat tensors with shape
`[1, 1500]`. Those numbers prove startup feasibility on one machine, not
accuracy, broad browser support, or production readiness. Every diagnostic
result reports `eligibilityConfidence: 0` by design.

The same private page can now select one local file and run the complete
experimental browser path: Web Audio decode, arithmetic-mean mono downmix,
22,050 Hz offline resampling, centered reflect-padded STFT, pinned mel matrix,
sequential ONNX windows, exact border aggregation, and Beat This's minimal peak
postprocessing. The audio and event output remain in memory and are never
persisted by this page.

The page can also load a private official-Python oracle JSON and compare the
event arrays without uploading or persisting them. Hash-selected multi-track
smoke tests matched every official Python beat at the ±70 ms evaluation
tolerance. Downbeat parity was near-perfect but not exact, and the stricter
±20 ms comparison showed decoder/resampler-sensitive peak differences. This is
implementation-parity evidence only: no human annotation was used, so `final0`
accuracy remains unscored.

The reproducible oracle helper is `tools/beatThisFinal0Oracle.py`. Run it from a
disposable Beat This 1.1.0 environment with the checksum-verified official
`final0` checkpoint and an output directory under private application storage.
It records content/canonical-PCM hashes, versions, timing, full event arrays,
and writes each result atomically with private permissions.

## Current detector decision

The earlier Safe-Fade-only decision is superseded by canonical decision D-031.
Beat This `final0` is now an optional, checksum-pinned local production timing
tool and may emit beats, downbeats, and exact locally trusted bar-handoff cues.
That uncalibrated machine evidence may authorize only a 0.35-second no-stretch
handoff at a retained cue. Safe Fade remains the fallback for weak, missing,
manual, or stale timing, and all 32-beat phrase blends remain locked until
human-ground-truth evaluation and an allowlisted calibrator pass the documented
promotion gates. Private-crate outputs are evaluation evidence, never a shortcut
around those gates.
