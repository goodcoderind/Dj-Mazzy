# Mazzy Rhythm Benchmark Report

> Benchmark version: `rhythm-benchmark/v1`
>
> Fixture set: `generated-rhythm-fixtures/v1`
>
> Run date: 2026-08-12
>
> Status: Harness validation only; no detector is approved for autonomous long blends

## Why this exists

Mazzy needs more than a plausible BPM number. A long DJ blend requires a beat
grid, a downbeat grid, and confidence that falls when the audio is ambiguous or
non-rhythmic. This benchmark gives every candidate detector the same input,
annotations, metrics, and failure cases.

Run it with:

```bash
npm run benchmark:rhythm
```

## Current fixture set

The first fixture set is entirely procedurally generated and contains no
third-party music:

- clean 120 BPM 4/4 pulses;
- clean 90 BPM 4/4 pulses;
- a 100 BPM pattern with strong eighth-note offbeats;
- a sustained C-major chord with no beat;
- digital silence.

This set validates benchmark plumbing and catches obvious false positives. It
does **not** represent house, Bollywood, hip-hop, pop, live drums, swing, tempo
drift, or production audio. A detector cannot be selected for shipping from
these results.

## Metrics

- Tempo accuracy allows explicit half/double-time interpretations and a 4%
  tolerance.
- Beat and downbeat precision, recall, and F1 use one-to-one matching within
  ±70 ms, a commonly used beat-tracking evaluation window.
- Non-rhythmic rejection requires both a null BPM and an empty beat grid.
- Confidence Brier score checks whether high confidence corresponds to a
  correct tempo and a beat F1 of at least 0.7; lower is better.
- Runtime includes detector execution but is only a local development
  measurement, not a cross-device performance result.

## Compared pipelines

1. `music-tempo+accent/v1` — the current MIT-licensed runtime candidate plus a
   simple four-beat accent-phase downbeat baseline.
2. `essentia-degara+accent/v1` — Essentia's faster Degara beat tracker plus the
   same downbeat baseline.
3. `essentia-multifeature+accent/v1` — Essentia's MultiFeature tracker plus the
   same downbeat baseline.

Essentia is **research-only** here. Its AGPL/commercial licensing means this
comparison is not permission to distribute it in Mazzy's current ISC product.

## Results

| Detector | Distribution | Rhythmic tempo | Rhythmic beat F1 | Rhythmic downbeat F1 | Non-rhythmic rejection | Confidence Brier ↓ | Mean runtime ms |
|---|---|---:|---:|---:|---:|---:|---:|
| music-tempo+accent/v1 | runtime candidate | 100.0% | 88.9% | 89.9% | 50.0% | 0.435 | ~854 |
| essentia-degara+accent/v1 | research only | 100.0% | 98.3% | 93.3% | 0.0% | 0.326 | ~839 |
| essentia-multifeature+accent/v1 | research only | 100.0% | 66.7% | 62.2% | 0.0% | 0.177 | ~805 |

Important case-level failures:

- MusicTempo followed the offbeat subdivision grid: beat F1 `0.667` and
  downbeat F1 `0.696`, while its gating confidence remained `1.000`.
- MusicTempo hallucinated `83.5 BPM` on the sustained chord.
- Essentia Degara hallucinated `132.4 BPM` on the chord and `92.3 BPM` on
  silence, both with high derived confidence.
- Essentia MultiFeature failed the offbeat-heavy grid (beat F1 `0.033`) and
  also emitted tempo estimates for both negative controls.

Runtime numbers vary between runs. The accuracy and failure results are the
evidence that matters at this stage.

## Decision

No candidate is promoted. In particular, interval regularity is not calibrated
confidence: a consistently wrong grid can look perfectly regular. Long
beatmatched and phrase-aware transition templates remain disabled.

The next benchmark revision needs a legally usable real-audio set with manually
verified beats and downbeats across the target party genres. Beat This is a
promising MIT-licensed code/model candidate for a local companion process, but
its Python/PyTorch runtime must be evaluated separately from the browser path.

## Primary references

- [Beat This official implementation](https://github.com/CPJKU/beat_this)
- [Essentia RhythmExtractor2013](https://essentia.upf.edu/reference/std_RhythmExtractor2013.html)
- [Essentia licensing](https://essentia.upf.edu/licensing_information.html)
- [ISMIR downbeat evaluation using ±70 ms F-measure](https://archives.ismir.net/ismir2014/paper/000265.pdf)
