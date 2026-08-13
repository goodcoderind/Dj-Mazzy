# Mazzy AI DJ: Research, Product, and Build Plan

> Canonical specification for all automatic-DJ work in Mazzy.
>
> Status: Working specification
>
> Version: 1.1
>
> Last updated: 2026-08-13
>
> Scope: House-party automation for roughly 20–50 people using locally supplied music

## How to use this document

Read this document completely before changing Mazzy's analysis, sequencing,
transition, transport, or audio-engine code. This file exists to prevent the
project from drifting into disconnected features or relying on remembered
assumptions.

Every important statement uses one of these labels:

- **Research:** supported by a paper, standard, or authoritative documentation.
- **Decision:** an agreed architectural or product constraint for Mazzy.
- **Hypothesis:** a promising idea that must be tested with listeners.
- **Target:** a measurable quality goal, not a claim about current behavior.
- **Open question:** unresolved and must not be silently assumed.

When implementation evidence changes this plan:

1. Update the relevant section in the same change as the code.
2. Add an entry to the decision log.
3. Increase the analysis or transition-plan schema version when stored results
   would otherwise become stale.
4. Preserve test results that justified the change.

## 1. Product thesis

**Decision:** Mazzy is not a virtual copy of a professional DJ console and not
a streaming playlist with a crossfade. It is a local-first **party autopilot**:

> Give Mazzy a crate of music, a party duration, and a desired energy journey;
> it prepares, sequences, and performs a continuous mix while the host remains
> one action away from control.

The primary user is a group of friends holding a house party without the budget,
equipment, or skills for a human DJ. The experience must work on an ordinary
laptop connected to speakers.

### Product promise

Mazzy should:

- keep music continuous without awkward silence;
- make transitions on musically meaningful boundaries;
- avoid clashing beats, vocals, bass lines, and loudness jumps;
- build and release energy intentionally over the whole party;
- accept requests without letting one guest hijack the session;
- explain what it plans to do next;
- fail safely when analysis is uncertain;
- keep music local and remain usable without an internet connection;
- let the host override any choice immediately.

### What makes Mazzy distinctive

These are the product pillars. Features that do not strengthen one should be
questioned.

1. **Party Storyline** — the host shapes an energy journey instead of manually
   ordering every track.
2. **Confidence-Aware Autopilot** — Mazzy knows when its analysis is unreliable
   and chooses a safer transition.
3. **Transition Rehearsal** — before the party, the host can audition planned
   transitions and correct beat grids or cue points.
4. **Guest Democracy** — guests can request and vote, while fairness and host
   constraints protect the flow.
5. **Rescue Mode** — one action safely exits a bad transition and continues the
   party.
6. **Why Next** — Mazzy can say that a track was chosen for tempo, energy,
   request demand, harmonic fit, or a planned peak moment.
7. **Local Mix Memory** — host overrides and ratings improve future sessions
   without uploading the music library.

### Non-goals for the first shippable release

- Replacing a skilled club or festival DJ
- Scratching, turntablism, or battle-DJ performance
- Generating new songs
- Live microphone or camera surveillance of the crowd
- Mixing Spotify streams or bypassing streaming-service restrictions
- Supporting every musical genre with one identical transition policy
- Depending on stem separation for basic operation
- Training a large custom model before the deterministic system works

## 2. Research conclusions that drive the design

### 2.1 DJ automation is a pipeline, not one AI model

**Research:** Spotify researchers modeled playlist sequencing as a graph problem
and transition selection as an optimization problem. Their transition features
included beat/downbeat position, structural boundaries, timbre, chroma,
loudness, and vocal activity. Professional curators rated most generated
transitions good or acceptable, while beat/downbeat errors were the primary
bottleneck.

Source: [Automatic Playlist Sequencing and Transitions](https://archives.ismir.net/ismir2017/paper/000086.pdf)

**Decision:** Mazzy will separate the system into:

1. perception and offline analysis;
2. track and transition planning;
3. deterministic, clock-driven audio rendering;
4. user feedback and adaptation.

An ML model may recommend a plan. It must not improvise sample-level scheduling
inside the live audio loop.

### 2.2 BPM alone is insufficient

**Research:** Beatmatching consists of both tempo matching and beat-phase
alignment. Automatic synchronization requires an accurate BPM and beat grid.

Source: [Mixxx: Beatmatching and Mixing](https://manual.mixxx.org/2.6/en/chapters/djing_with_mixxx)

**Decision:** A track is not eligible for a long beatmatched transition unless
Mazzy has beat positions, downbeats, and confidence values. A single global BPM
value is not a beat grid.

### 2.3 Phrases and structure determine where transitions belong

**Research:** An analysis of 1,557 real-world DJ mixes found transition-length
peaks at phrase multiples. In dance music, 32 beats is commonly treated as a
phrase, and DJs show meaningful agreement around cue regions.

Source: [A Computational Analysis of Real-World DJ Mixes](https://archives.ismir.net/ismir2020/paper/000352.pdf)

**Decision:** Transition length and placement will be expressed in beats and
musical boundaries, never only in fixed wall-clock seconds.

### 2.4 Track selection and transition selection are coupled

**Research:** Tracks that differ sharply in tempo, key, style, or acoustic
character are harder to transition between. The best ordering depends on which
transitions are feasible.

**Decision:** Mazzy must score the pair `(track choice, transition plan)`, not
choose a track first and blindly crossfade it afterward.

### 2.5 Interpretable rules come before learned policy

**Research:** The Spotify study found that a small set of interpretable features
could produce useful results and could be tuned by use case.

**Decision:** The first planner will use explicit feature costs, constraints,
and transition templates. Learned ranking will be introduced only after Mazzy
has collected structured transition ratings and override data.

## 3. The complete Mazzy pipeline

```text
Party intent
    │
    ▼
Library ingestion ──► decoding and validation ──► analysis workers
                                                   │
                                                   ▼
                                           TrackAnalysis records
                                                   │
                     requests / votes / skips ─────┤
                                                   ▼
                                            Session planner
                                                   │
                                                   ▼
                                          Transition planner
                                                   │
                                confidence gate ───┤
                                   │               │
                            safe fallback          ▼
                                   └──────► deterministic renderer
                                                   │
                                                   ▼
                                          master bus / limiter
                                                   │
                                                   ▼
                                                speakers
```

### Stage 0: Party intent

The host supplies constraints before playback:

- approximate party duration;
- allowed crates, genres, and explicit-content preference;
- must-play and do-not-play tracks;
- initial vibe;
- desired energy storyline;
- willingness to accept guest requests;
- preferred transition aggressiveness;
- optional closing time or final track.

**Decision:** These values are constraints, not vague prompt text. A natural
language prompt may populate them later, but the planner consumes structured
values.

### Stage 1: Library ingestion

For every imported file:

1. validate that the browser/runtime can decode it;
2. compute a stable content fingerprint or file hash;
3. read duration, sample rate, channel count, and tags where available;
4. avoid duplicate analysis of identical content;
5. record the analysis algorithm version;
6. queue analysis without blocking the interface;
7. retain the original file locally.

**Decision:** The party preflight must show which tracks are ready, uncertain,
unsupported, duplicated, or still analyzing.

### Stage 2: Offline musical analysis

Analysis runs before playback in workers or a local companion process. It must
never execute expensive Fourier or ML loops on the UI thread.

Required analysis layers, in order:

1. **Decode and canonicalize**
   - preserve stereo for playback;
   - create a lower-rate mono analysis signal;
   - record resampling and downmix parameters.
2. **Loudness and level**
   - integrated LUFS;
   - short-term loudness curve;
   - loudness range;
   - sample peak and, when available, true peak;
   - silence regions.
3. **Rhythm**
   - BPM candidates, not only one number;
   - beat positions;
   - downbeat positions;
   - meter estimate;
   - local tempo drift;
   - separate confidence for tempo, beats, and downbeats.
4. **Tonal information**
   - tuning frequency;
   - global key and mode;
   - key confidence;
   - beat-synchronous chroma or HPCP;
   - optional local key changes.
5. **Structure**
   - section boundaries;
   - phrase-boundary candidates;
   - intro, build, drop, breakdown, chorus, verse, and outro hypotheses;
   - boundary confidence rather than pretending labels are certain.
6. **Energy and timbre**
   - beat-synchronous loudness;
   - low, mid, and high frequency energy ratios;
   - spectral centroid, flux, and contrast;
   - timbre embedding;
   - normalized energy curve.
7. **Vocal activity**
   - probability of vocals per beat or bar;
   - vocal-onset and vocal-ending candidates;
   - confidence and smoothing.
8. **Optional semantic layer**
   - mood and genre probabilities;
   - audio embedding;
   - natural-language similarity embedding.

Reference capabilities: [Essentia algorithms](https://essentia.upf.edu/algorithms_overview.html),
[MSAF structural analysis](https://msaf.readthedocs.io/en/latest/), and
[Beat This beat/downbeat tracker](https://github.com/CPJKU/beat_this).

### Stage 3: Analysis validation and correction

Before a track is trusted, validation checks should include:

- BPM is within a plausible range after half/double-tempo alternatives;
- beat intervals are sufficiently stable for the detected genre;
- downbeats align with recurring energy/accent patterns;
- section boundaries snap to nearby downbeats when appropriate;
- duration and final beat do not disagree catastrophically;
- key confidence is not treated as certainty;
- loudness values are finite and within plausible numeric limits.

The host must be able to:

- tap or halve/double BPM;
- move the first beat and first downbeat;
- mark an intro, drop, or outro;
- exclude a track from Auto mode;
- audition a metronome over the beat grid.

**Decision:** Corrections are stored separately from generated analysis so a
new analyzer version cannot erase human knowledge.

### Stage 4: Track descriptor construction

Proposed versioned record:

```ts
type TrackAnalysisV4 = {
  trackId: string;
  contentHash: string;
  schemaVersion: "track-analysis/v4";
  analyzerVersion: string;
  durationSeconds: number;
  sampleRate: number;

  loudness: {
    integratedLufs: number | null;
    shortTermLufs: number[];
    loudnessRange: number | null;
    samplePeakDb: number | null;
    truePeakDbtp: number | null;
  };

  rhythm: {
    bpm: number | null;
    bpmCandidates: Array<{ bpm: number; confidence: number }>;
    beatsSeconds: number[];
    downbeatsSeconds: number[];
    meter: number | null;
    tempoConfidence: number;
    beatConfidence: number;
    downbeatConfidence: number;
  };

  tonal: {
    key: string | null;
    scale: "major" | "minor" | null;
    confidence: number;
    tuningHz: number | null;
    beatChroma: number[][];
  };

  structure: {
    boundaries: Array<{
      beatIndex: number;
      type: string;
      confidence: number;
    }>;
    phraseCandidates: Array<{
      beatIndex: number;
      confidence: number;
    }>;
  };

  features: {
    energyByBeat: number[];
    bandEnergyByBeat: Array<{ low: number; mid: number; high: number }>;
    vocalProbabilityByBeat: number[];
    timbreByBeat: number[][];
    semanticEmbedding?: number[];
  };

  overrides: {
    schemaVersion: "beat-grid-overrides/v1";
    correctedBpm?: number;
    firstBeatSeconds?: number;
    firstDownbeatBeatIndex?: number;
    manualBoundaries?: number[];
    autoMixDisabled?: boolean;
  };
};
```

### Stage 5: Candidate generation

The planner must not compare every possible sample position. Candidate cue
points are generated from musically plausible locations.

Outgoing candidates:

- downbeats in the final portion of the track;
- starts of breakdowns or outros;
- section boundaries after a chorus or drop;
- low-vocal regions;
- points that leave 8, 16, 32, or 64 beats for a transition.

Incoming candidates:

- intro downbeats;
- section boundaries in the early portion of the track;
- low-vocal openings;
- build sections that can resolve as the outgoing track ends;
- drop points for cut or echo-out transitions.

Candidates are pruned when:

- beat/downbeat confidence is below the template requirement;
- time-stretch exceeds the allowed range;
- two vocal regions overlap excessively;
- both tracks have dominant low-frequency energy simultaneously;
- the incoming cue skips a must-hear part without a reason;
- the transition would produce silence or clip the session length constraints.

### Stage 6: Track-pair compatibility

Tempo distance should be octave-aware:

```text
dTempo(A, B) = min over k in {-1, 0, 1} of
               abs(log2((BPM_B × 2^k) / BPM_A))
```

This treats common half/double-tempo ambiguity explicitly.

Proposed pair cost:

```text
pairCost(A, B) =
    wTempo  × tempoDistance
  + wKey    × harmonicDistance
  + wTimbre × timbreDistance
  + wStyle  × semanticDistance
  + wEnergy × energyStoryDeviation
  + wRepeat × artistAndTrackRepetition
  + wRisk   × analysisUncertainty
  - wVote   × requestDemand
  - wMust   × mustPlayUrgency
```

**Decision:** Key compatibility is a soft feature, not a gate. Exact key equality
is not required, and a high-confidence rhythmic/structural match may outweigh a
weak key estimate.

### Stage 7: Transition-point optimization

For transition candidate `p` from A to B:

```text
transitionCost(p) =
    wBeat       × beatAlignmentError
  + wDownbeat   × downbeatMismatch
  + wBoundary   × structuralBoundaryPenalty
  + wVocal      × averageVocalOverlap
  + wBass       × lowBandCollision
  + wLoudness   × loudnessDiscontinuity
  + wChroma     × chromaDistance
  + wTimbre     × timbreDistance
  + wStretch    × timeStretchDiscomfort
  + wConfidence × uncertaintyPenalty
```

The chosen plan minimizes a combination of pair and transition cost:

```text
totalCost = pairCost(A, B) + transitionCost(bestPlan(A, B))
```

Current transition record:

```ts
type TransitionPlanV2 = {
  schemaVersion: "transition-plan/v2";
  fromTrackId: string;
  toTrackId: string;
  template: "phrase-blend" | "bass-swap" | "echo-drop" |
            "downbeat-cut" | "safe-fade";
  targetBpm: number | null;
  sourceStartBeat: number | null;
  targetStartBeat: number | null;
  lengthBeats: number | null;
  sourcePlaybackRate: number;
  targetPlaybackRate: number;
  score: number;
  confidence: number;
  scoreBreakdown: Record<string, number>;
  eligibility: {
    longBlendEligible: boolean;
    reasons: string[];
  };
  schedule: {
    requestedAt: number;
    startTime: number;
    endTime: number;
    durationSeconds: number;
    targetCueSeconds: number;
  };
  automation: {
    sourceGain: number[];
    targetGain: number[];
    sourceEq: Array<{ low: number; mid: number; high: number }>;
    targetEq: Array<{ low: number; mid: number; high: number }>;
    filter?: number[];
    echo?: number[];
  };
  explanation: string[];
};
```

### Stage 8: Session sequencing

The session planner chooses a short horizon, not a frozen four-hour playlist.

Recommended approach:

1. Build a compatibility graph for currently eligible tracks.
2. Use beam search or limited lookahead over the next 3–5 tracks.
3. Score both sequence flow and available transition plans.
4. Replan after a request, skip, host change, failed analysis, or completed
   transition.
5. Lock only the currently playing and immediately preloaded tracks.

The planner must respect hard constraints:

- do-not-play and explicit-content settings;
- already played tracks;
- minimum artist-repeat interval;
- maximum stretch ratio;
- tracks excluded from Auto mode;
- party end time and optional closing track;
- host-selected Play Now action.

Soft constraints include:

- guest votes;
- must-play urgency;
- energy storyline;
- genre diversity;
- harmonic and timbral continuity;
- fairness between requesters;
- avoiding multiple long vocal tracks without breathing space.

### Stage 9: Deterministic rendering

**Invariant:** `AudioContext.currentTime` is the authoritative performance clock.
React state, timers, and `requestAnimationFrame` may display progress but must
not determine when audio events occur.

The renderer receives an immutable `TransitionPlan` and schedules:

- target start time and file offset;
- pitch-preserving stretch automation;
- source and target gain curves;
- EQ and filter curves;
- optional loop, echo, or effect timing;
- transition completion and deck handoff;
- a recovery checkpoint before the transition starts.

All schedulable audio changes should use Web Audio clock automation. Custom DSP
belongs in an `AudioWorklet`, which runs outside the UI thread.

Sources: [Web Audio specification](https://webaudio.github.io/web-audio-api/)
and [AudioWorklet guidance](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Using_AudioWorklet).

### Stage 10: Feedback and adaptation

Signals captured locally:

- host skipped the proposed or playing track;
- host changed Energy Up/Down;
- host replaced the next track;
- transition was aborted;
- guest request and vote counts;
- track played to planned completion;
- host rating after transition rehearsal;
- manual cue or beat-grid correction.

**Decision:** Initial learning adjusts interpretable weights and remembers
pair-specific feedback. It does not fine-tune a large model.

## 4. Transition templates

Templates make behavior testable and genre-aware. Each template has explicit
eligibility requirements and a safe abort path.

### 4.1 Phrase blend

Best for house, techno, and rhythmically stable dance music.

- Typical candidates: 32 or 64 beats
- Requires: high beat and downbeat confidence
- Incoming track begins on an intro or low-density phrase
- Outgoing track leaves on an outro, breakdown, or section boundary
- Gain uses equal-power or measured-loudness-adjusted curves
- Bass ownership changes once, deliberately

### 4.2 Bass-swap blend

Best when both tracks are beat-compatible but overlapping kick/bass energy would
sound muddy.

- Typical candidates: 16 or 32 beats
- Incoming low band begins attenuated
- Midpoint or structural boundary transfers bass ownership
- Never leave both low bands at full gain during the overlap
- Full-mix loudness and peak remain protected by the master bus

### 4.3 Echo/filter out into a drop

Best for pop, Bollywood, hip-hop, open-format sets, or larger tempo changes.

- Short overlap or no rhythmic overlap
- Outgoing phrase ends cleanly or enters an echo/filter tail
- Incoming track starts at a recognizable downbeat or drop
- Does not require long-term beat compatibility
- Effect tail must be rendered and peak-tested, not improvised by UI timers

### 4.4 Downbeat cut

Best when contrast is desirable and a blend would weaken both songs.

- Cut occurs on an agreed phrase/downbeat boundary
- Loudness is matched before the cut
- Optional very short impact or tail treatment
- Must sound intentional rather than like a playback failure

### 4.5 Safe fallback

Used whenever required confidence is missing.

- No long percussion overlap
- Prefer a detected low-energy outro and clean incoming start
- Conservative short fade or boundary cut
- No aggressive tempo or key manipulation
- Host sees why Auto mode chose the fallback

## 5. Genre profiles

**Hypothesis:** Different genres need different default policies. These profiles
must be evaluated and tuned; they are not universal music laws.

| Profile | Preferred behavior | Main risks |
|---|---|---|
| House / Techno | 32–64 beat blends, strict beat grid, bass swap | drifting grids, double kicks |
| Pop / Bollywood | shorter phrase transitions, hook preservation, vocal avoidance | cutting lyrics, missing recognizable sections |
| Hip-hop / R&B | half/double-tempo reasoning, short cuts or blends | vocal collision, swing and tempo ambiguity |
| Open format | template selection based on confidence and contrast | forcing incompatible tracks into long blends |
| Chill / Ambient | timbre and loudness continuity, less emphasis on beat matching | unnatural compression or unnecessary effects |

## 6. Audio mathematics and invariants

### Tempo estimate

For detected beat times `b_i`:

```text
BPM = 60 / median(b_(i+1) - b_i)
```

Local deviations must also be recorded; a global BPM can hide live-drum drift.

### Tempo matching

For a stable master track:

```text
incomingStretch = masterBpm / incomingBpm
```

**Target:** Begin evaluation with a preferred adjustment of no more than about
6% and a hard template limit of about 10%. These are product starting points,
not established universal thresholds, and must be tuned through listening tests.

For offline symmetric planning, a geometric-mean target can minimize combined
log-tempo movement:

```text
targetBpm = sqrt(bpmA × bpmB)
```

Live mode normally keeps the playing deck authoritative unless a long gradual
tempo journey has been planned.

### Phrase duration

```text
transitionSeconds = transitionBeats × 60 / targetBpm
```

This replaces fixed eight-second transitions.

### Equal-power gain curves

For normalized transition progress `u` from 0 to 1:

```text
sourceGain(u) = cos(πu / 2)
targetGain(u) = sin(πu / 2)
```

These curves reduce the perceived dip of a linear amplitude crossfade, but they
do not guarantee peak safety when correlated content overlaps. The master bus
still needs headroom and limiting.

### Loudness and peak safety

**Decision:** Normalize by perceptual loudness, not file peak. Store EBU R128-like
integrated and short-term descriptors, choose an internal party target through
tests, preserve musical dynamics, and enforce a true-peak ceiling at the output.

Reference: [EBU R128](https://tech.ebu.ch/publications/r128).

### Confidence gate

Proposed combined confidence:

```text
planConfidence = min(
  sourceBeatConfidence,
  targetBeatConfidence,
  sourceDownbeatConfidence required by template,
  targetDownbeatConfidence required by template,
  transitionModelConfidence
)
```

The minimum is deliberate: one badly understood track can ruin an otherwise
good transition.

## 7. Audio-engine architecture

Target graph:

```text
Deck A source ─► time stretch ─► EQ ─► deck gain ─┐
                                                   ├─► master gain ─► limiter ─► output
Deck B source ─► time stretch ─► EQ ─► deck gain ─┘
```

### Engine invariants

1. One shared audio context and one authoritative transport clock.
2. UI rendering cannot interrupt scheduled audio.
3. Expensive analysis never runs on the main thread.
4. Audio plans are immutable after entering the scheduling safety window.
5. Every transition has an abort/recovery plan.
6. Starting playback must not silently reset crossfader gain.
7. Master output always has controlled headroom and peak protection.
8. Playback state is owned by the engine, not inferred from React refs.
9. Only necessary tracks are decoded/preloaded; the full library is not held as
   decoded audio.
10. Refresh, sleep, device change, and suspended audio context are explicit
    states, not unexpected exceptions.

### Pitch-preserving time stretch

The current `AudioBufferSourceNode.playbackRate` changes tempo and pitch
together. A shippable engine needs key lock.

**Proposed dependency:** [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch)
provides MIT-licensed time/pitch processing and a Web Audio WASM/AudioWorklet
release. Version 1.3.2 is exact-pinned for a developer-only buffer-mode spike.
The spike uses one unconnected worklet input because the upstream inactive path
terminates with zero declared inputs, and bounds every remote operation and
cleanup. The historical `key-lock-smoke/v1` direct-adapter run preserved a 440 Hz
carrier within one cent and changed an 8 Hz timing marker with worst observed
tempo error below 0.1%. The historical 48 kHz `key-lock-smoke/v2` browser run used
the isolated DeckEngine and protected stereo master; distinct 440/660 Hz channel
carriers remained within one cent, a 16 Hz marker tracked 0.94×/1.00×/1.06×,
and opposite-channel leakage remained below -49 dB. Historical v3 added a
single combined onset measure; v4 split channels and acknowledged observation;
v5 added balance/prominence. The current `key-lock-smoke/v6` ran separately at
48 and 44.1 kHz and kept full-cell peak/non-finite monitoring active. Both
passed: pitch stayed within one cent, per-channel tempo error stayed below
0.09%, carrier prominence stayed 18–22 dB, level balance stayed within 3.4 dB,
leakage stayed below -48 dB, observer coverage began at least 260 ms early,
pre-start output and invalid samples were zero, and both channel onsets arrived
5.9–9.1 ms after the requested frame. None of these results is device approval, musical-quality
evidence, speaker-output evidence, or transition authority. Production still
passes no key-lock capability and therefore refuses tempo-changing phrase
blends. Runtime preparation is owned by each deck's monotonic load revision and
cannot survive replacement/eject; native Safe Fade remains available if this
optional preparation fails.

### Master bus

The master bus is responsible for:

- loudness compensation between tracks;
- transition headroom;
- final dynamics control;
- true-peak or conservative peak protection;
- meters for deck, master, and limiter reduction;
- preventing effects or overlapping correlated audio from clipping.

## 8. Proposed repository architecture

The current `App.jsx` and `Deck.jsx` combine product state, analysis, planning,
and audio behavior. New work should move toward these boundaries:

```text
src/
├── analysis/
│   ├── AnalysisCoordinator
│   ├── RhythmAnalyzer
│   ├── TonalAnalyzer
│   ├── StructureAnalyzer
│   ├── LoudnessAnalyzer
│   ├── VocalAnalyzer
│   └── confidence
├── audio/
│   ├── AudioEngine
│   ├── DeckEngine
│   ├── TransportClock
│   ├── MasterBus
│   ├── TimeStretchProcessor
│   ├── TransitionScheduler
│   └── effects/
├── planning/
│   ├── CandidateGenerator
│   ├── PairScorer
│   ├── TransitionPlanner
│   ├── SessionPlanner
│   ├── EnergyStoryline
│   └── templates/
├── domain/
│   ├── TrackAnalysis
│   ├── TransitionPlan
│   ├── PartySession
│   └── versions
├── storage/
│   ├── LibraryRepository
│   ├── AnalysisRepository
│   └── SessionRepository
├── workers/
│   ├── analysis.worker
│   └── render.worker
├── components/
│   ├── host/
│   ├── guest/
│   ├── rehearsal/
│   └── decks/
└── diagnostics/
    ├── AudioHealth
    ├── TransitionInspector
    └── EventLog
```

**Proposed:** New engine and domain modules should use TypeScript, with existing
JSX migrated incrementally rather than through an unrelated rewrite.

## 9. Product experience

### Before the party: Prepare

1. Create a party.
2. Import one or more crates.
3. Watch analysis progress and readiness.
4. Fix uncertain beat grids using a guided review queue.
5. Select must-play, blocked, and explicit tracks.
6. Draw or choose an energy storyline.
7. Audition the highest-risk planned transitions.
8. Run an audio/output health check.

### During the party: Host cockpit

The default screen should emphasize:

- now playing;
- next track and why it was chosen;
- time to transition;
- session energy versus target energy;
- requests and votes;
- analysis/transition confidence;
- Play Now, Skip, Energy Up, Energy Down, and Rescue controls.

The professional deck controls can remain available in an advanced view. They
should not dominate the party-autopilot experience.

### Guest experience

Guests join through a QR code and can:

- search the host-approved library;
- request a track;
- vote on existing requests;
- see request status;
- optionally choose broad vibe feedback.

Guests cannot:

- access host files;
- force immediate playback;
- change explicit-content or do-not-play rules;
- control volume or the audio engine;
- cast unlimited duplicate votes.

### After the party: Review

Store locally:

- set history;
- skipped and rescued transitions;
- highly rated pairings;
- host corrections;
- request response times;
- energy-storyline deviations;
- optional exportable diagnostic report without music audio.

## 10. Implementation milestones

Milestones are sequential. Later AI features must not bypass earlier quality
gates.

### Milestone 0: Baseline and measurement

Deliverables:

- preserve the current prototype as a tagged baseline;
- add unit-test and integration-test tooling;
- create an offline transition-render harness;
- create a versioned analysis schema;
- define a small legally usable development audio set;
- record current build size, analysis time, and transition behavior;
- fix obvious duplicated UI actions and state inconsistencies that make testing
  unreliable.

Acceptance:

- the same transition plan renders deterministically;
- audio tests can inspect alignment, loudness, and peaks;
- current behavior can be compared with later milestones.

### Milestone 1: Reliable audio foundation

Deliverables:

- central `AudioEngine` and `TransportClock`;
- deck state removed from UI refs as the source of truth;
- master gain, meters, headroom, and limiter;
- sample-clock scheduling for all transition automation;
- consistent manual crossfader behavior;
- preload and recovery states;
- two-hour playback soak-test harness.

Acceptance:

- no transition is scheduled by `setTimeout` or animation frames;
- Play does not overwrite the intended deck gain;
- no clipping in the golden transition suite;
- a two-hour unattended session produces no audio gap or uncaught engine error.

### Milestone 2: Beat/downbeat analysis

Deliverables:

- analysis worker pipeline;
- BPM candidates and half/double handling;
- beat and downbeat arrays with confidence;
- correction UI with metronome audition;
- cached versioned results;
- remove the duplicated hand-written key DFT from live deck loading.

Acceptance:

- no analysis blocks deck/UI interaction;
- corrected results survive reanalysis;
- benchmark metrics are recorded for tempo, beats, and downbeats;
- low-confidence tracks are visibly excluded from long-blend templates.

### Milestone 3: Phrase-aware transition engine

Deliverables:

- boundary and energy analysis;
- vocal-probability baseline;
- candidate cue generation;
- phrase blend, bass swap, downbeat cut, and safe fallback templates;
- beat-count transition duration;
- transition inspector with score breakdown;
- pitch-preserving time-stretch spike and benchmark.

Acceptance:

- every automatic transition names its musical boundary and template;
- no transition label confuses beats and bars;
- low-confidence input reliably selects a fallback;
- blind listeners rate at least 90% of the golden-suite transitions OK or good.

### Milestone 4: Session planner

Deliverables:

- pair compatibility graph;
- 3–5 track lookahead;
- energy storyline;
- must-play, blocked, repetition, and party-end constraints;
- replan after host actions;
- “Why Next” explanation.

Acceptance:

- no already-played or blocked track is selected;
- host Play Now is honored safely;
- planner avoids known transition dead ends in test libraries;
- generated sessions follow the requested energy curve within a documented
  tolerance.

### Milestone 5: Party product

Deliverables:

- setup/preflight flow;
- simplified host cockpit;
- Auto, Assisted, and Manual modes;
- Rescue Mode;
- transition rehearsal;
- guest request and vote interface;
- offline/session recovery behavior;
- installable PWA experiment.

Acceptance:

- a new host can prepare and start a party without understanding deck controls;
- guest access cannot control host audio or files;
- refresh/restart recovery is documented and tested;
- at least one real two-hour 20+ person party completes with structured feedback.

### Milestone 6: Semantic AI

Deliverables:

- optional audio/text embeddings;
- structured natural-language vibe translation;
- semantic similarity in track selection;
- local transition-weight adaptation;
- privacy and model-license review.

Candidate: [Microsoft CLAP](https://github.com/microsoft/CLAP) is MIT-licensed
code for audio/text embeddings, but model weights and dependencies must be
audited before distribution.

Acceptance:

- prompt controls change measurable planner features;
- semantic ranking improves blind preference over the non-semantic baseline;
- the feature can be disabled without weakening core transitions.

### Milestone 7: Optional stems and advanced learning

Deliverables:

- offline stem-preparation experiment;
- vocal and bass stem transition templates;
- artifact detection and non-stem fallback;
- learned transition ranking from real ratings;
- desktop packaging decision if computation exceeds browser practicality.

Candidate: [Demucs](https://github.com/facebookresearch/demucs) provides
MIT-licensed source-separation code, but the maintained status, model weights,
runtime cost, and artifacts must be evaluated.

Acceptance:

- stems improve listener ratings on selected transitions;
- audible separation artifacts cause automatic fallback;
- core party operation never requires stems.

## 11. Test and evaluation plan

### Golden library

Create a legally usable internal test library covering:

- steady electronic dance music;
- live-drum tracks with tempo drift;
- pop and Bollywood with dense vocals;
- hip-hop with half/double-tempo ambiguity;
- quiet intros and outros;
- abrupt starts and endings;
- unusual meters or tracks unsuitable for Auto mode;
- intentionally incompatible track pairs.

Each golden track should have manually checked:

- BPM and tempo interpretation;
- beat/downbeat positions;
- selected section boundaries;
- vocal regions;
- good and bad cue candidates;
- approximate loudness;
- analysis notes.

### Automated analysis metrics

- tempo accuracy with octave-aware scoring;
- beat precision, recall, and F-measure using one-to-one ±70 ms matching;
- downbeat precision, recall, and F-measure using one-to-one ±70 ms matching;
- section-boundary tolerance metrics;
- vocal activity precision/recall;
- key accuracy with related-key reporting;
- analysis runtime and peak memory;
- confidence calibration.

### Rendered transition metrics

- beat-onset alignment error in milliseconds;
- downbeat mismatch count;
- vocal-overlap percentage;
- simultaneous low-band energy;
- loudness change before, during, and after transition;
- sample and true-peak ceiling violations;
- unintended silence;
- effect-tail clipping;
- schedule lateness or audio underruns.

### Human listening protocol

1. Render transitions without revealing the algorithm/version.
2. Randomize A/B order.
3. Ask listeners to rate smoothness, timing, energy, song choice, and artifacts.
4. Record the reason for bad ratings.
5. Compare against the current Mazzy transition and a simple fixed crossfade.
6. Do not tune on the final evaluation set.

### Party-level metrics

- skips and host interventions per hour;
- transition rescues per hour;
- percentage of requested tracks eventually played;
- requester fairness;
- energy-storyline deviation;
- audio gaps or crashes;
- guest and host end-of-session rating;
- two-hour and four-hour reliability.

## 12. Reliability and recovery

The engine state machine must explicitly cover:

```text
idle
  → preparing
  → ready
  → playing
  → transition-armed
  → transitioning
  → handoff
  → playing

Any active state
  → recoverable-error
  → safe-fallback or stopped-with-explanation
```

Recovery cases:

- target file disappears or fails to decode;
- browser suspends audio;
- output device changes;
- CPU cannot sustain time stretching;
- transition analysis is missing or stale;
- planned track is removed or blocked;
- user presses Skip during a transition;
- page refreshes or application restarts;
- guest network becomes unavailable.

**Decision:** Guest/request failure must never stop local audio playback.

## 13. Privacy, rights, and licensing

### Music sources

**Decision:** The first release operates on local files the host has the right to
use. Mazzy will not ship music or circumvent DRM.

Spotify's current developer policy prohibits segueing, remixing, or overlapping
Spotify content and prohibits using Spotify content for AI analysis. Spotify
audio therefore cannot power Mazzy's mix engine.

Source: [Spotify Developer Policy](https://developer.spotify.com/policy).

### Local-first privacy

- Audio remains local by default.
- Analysis records are local and deletable.
- Guest interfaces receive searchable metadata only for the active party.
- Diagnostic exports exclude audio unless the host explicitly chooses otherwise.
- Camera and microphone crowd surveillance are out of scope.
- Any future cloud analysis must be opt-in and separately documented.

### Dependency licensing

- Web Audio: browser platform API.
- Signalsmith Stretch: MIT; proposed for pitch/time processing.
- Beat This: MIT code/model claim in its official repository; dependencies and
  packaged weights still require audit.
- Essentia/Essentia.js: AGPL/non-commercial path or commercial licence; do not
  integrate into an ISC/commercial distribution without a deliberate decision.
  Its current Mazzy use is a development-only benchmark comparator and not part
  of the production analysis worker.
- Demucs: MIT code; model and dependency audit still required.
- CLAP: MIT code; model-weight and dataset-derived restrictions require audit.

**Decision:** A dependency/license inventory is a release artifact, not an
afterthought.

## 14. Current prototype gap analysis

The existing Mazzy prototype proves several useful concepts:

- two decks and local file loading;
- Web Audio gain and three-band EQ graph;
- waveform navigation;
- a persistent browser library;
- BPM estimation;
- manual sync;
- equal-power gain curves;
- queueing and a basic automatic transition.

The original research baseline had fixed-second, UI-timed transitions, no safe
fallback, duplicated main-thread analysis, and no protected master bus. The
foundation updates below resolve those architectural failures. Remaining gaps
before musical or operational reliability are:

- the production analyzer has provisional beats but no trusted downbeats;
- tempo control still changes pitch because key-lock/time-stretch is not built;
- beat-synchronous energy and a structural-change/vocal-likelihood baseline now
  exist, but neither is calibrated on annotated real music;
- real tracks therefore remain restricted to the conservative Safe Fade;
- master peak protection exists, but perceptual loudness normalization and true
  peak evaluation are not complete;
- queue ordering is manual and has no session lookahead or energy storyline;
- Rescue Mode, transition rehearsal, and real-party validation are not built.

These are the active backlog, not reasons to discard the prototype.

### Implemented foundation updates

- **2026-08-12:** Web Audio playback and transition timing now use a central
  `AudioEngine`, `DeckEngine`, and `TransportClock` with a protected master bus.
- **2026-08-12:** Basic rhythm/key analysis moved to a transferable Web Worker.
  The duplicated main-thread key DFT was removed, the A440 pitch-class offset
  was corrected, and stale cached records are invalidated by analyzer version.
- **Limitation:** The current worker produces a provisional beat array from
  `music-tempo` but does not yet provide downbeats or benchmark-calibrated
  confidence. Long phrase-blend eligibility must remain disabled until those
  acceptance criteria are met.
- **Implementation evidence:** A browser smoke test on a sustained synthetic
  chord produced a spurious tempo estimate. Therefore the current tempo and
  beat-confidence values are diagnostic only; they must be benchmarked and
  recalibrated before becoming an Auto-mode eligibility signal.
- **2026-08-12:** Added detector-neutral tempo, beat, downbeat, confidence, and
  runtime metrics plus five procedurally generated golden fixtures. The harness
  compares MusicTempo, Essentia Degara, and Essentia MultiFeature through a
  shared accent-phase downbeat baseline. See
  [`RHYTHM_BENCHMARK_REPORT.md`](./RHYTHM_BENCHMARK_REPORT.md).
- **Benchmark evidence:** All approaches found the three generated rhythmic
  tempos, but none safely rejected every non-rhythmic input. MusicTempo followed
  the wrong metrical level on the offbeat-heavy fixture while reporting maximum
  gating confidence. Essentia produced tempo/beat outputs for digital silence.
  The current regularity-based confidence is therefore not calibrated.
- **Limitation:** Generated pulses validate the harness, not real music quality.
  No detector is promoted until a legally usable, manually annotated real-audio
  set covers the required genres and failure cases.
- **2026-08-12:** Added canvas beat/downbeat overlays, playhead-based beat and
  downbeat correction, ±10 ms phase nudging, manual half/double BPM correction,
  and a 16-click Web Audio-clock metronome audition. Generated analysis remains
  immutable; corrections are stored separately as `beat-grid-overrides/v1`.
- **Persistence evidence:** IndexedDB schema version 3 introduced downbeat fields
  and human overrides. A live browser test confirmed that manual BPM, beat, and
  downbeat corrections updated both deck and library, survived reload, reloaded
  into a deck, and reset cleanly to generated analysis. Regression tests verify
  that reanalysis preserves human corrections and that an incompatible
  downbeat phase is cleared after half/double-tempo reinterpretation rather than
  silently moved to the wrong bar.
- **Safety limitation:** Manual correction is visible as `GRID: MANUAL`, but it
  does not yet unlock long phrase blends. The interface continues to display
  `LONG BLENDS LOCKED` until real-audio benchmarks promote a detector and its
  confidence values.
- **2026-08-12:** Added the pure, deterministic `transition-plan/v2` planner.
  A phrase blend is eligible only when both tracks have beat and downbeat
  confidence of at least `0.8`, the required target tempo change is at most 10%,
  and each track has a complete 32-beat window beginning on a real downbeat.
  Qualified plans are deeply immutable and express their duration in beats.
- **Safe-fallback evidence:** Any missing or low-confidence requirement produces
  a 3.5-second equal-power Safe Fade with target playback fixed at `1.0`, no EQ
  collision automation, and explicit rejection reasons. Since the production
  analyzer currently emits no trusted downbeats, this is the intentional live
  behavior rather than an accidental degraded phrase mix.
- **Renderer evidence:** Target start, gain curves, optional bass transfer, and
  source stop are scheduled against `AudioContext.currentTime`; the animation
  frame loop only displays progress and completes non-audio UI handoff. The
  mixer names the active/last template and displays the first fallback reason.
- **Test evidence:** Planner tests cover qualified 32-beat selection,
  determinism, immutability, missing downbeats, low confidence, excessive
  stretch, and incomplete phrase windows.
- **2026-08-12:** Analyzer `basic-worker/v3` and `track-analysis/v4` add
  beat-synchronous normalized energy, low/mid/high energy ratios, a deliberately
  labelled vocal-likelihood spectral proxy, energy-change boundaries, and
  low-confidence phrase candidates. The worker computes these in one linear PCM
  pass after rhythm analysis; IndexedDB schema version 4 invalidates older
  records and persists the new arrays.
- **Feature-safety evidence:** Structural confidence is capped at `0.7` and
  phrase-candidate confidence at `0.55`; the vocal proxy is not used as a vocal
  truth label or autonomous transition gate. The analyzer still emits no
  generated downbeats, so this change intentionally does not unlock phrase
  blends. Tests cover empty evidence, deterministic bounded outputs, energy
  changes, and bass-versus-mid-band behavior. The full suite contains 68
  passing tests, with TypeScript checking and the production build also passing.
- **2026-08-12:** Added a private real-track audit that reads a user-supplied
  folder without copying or modifying audio. Source filenames, annotations, and
  outputs live outside the repository in Mazzy's private application-support
  directory. Vite explicitly denies private evaluation paths and only exposes
  the three allowlisted model-contract assets through a development route.
  The supplied private MP3 crate spans multiple full-length tracks; exact
  counts, sizes, and durations remain in external evaluation storage.
- **Real-track baseline evidence:** At the audit's 11,025 Hz analysis rate,
  `basic-worker/v3` completed the private crate quickly but missed at least one
  rhythmically clear track. This is throughput evidence, not accuracy evidence:
  human annotations were not yet complete, and the existing regularity
  confidence cannot resolve musical half/double tempo. Exact counts and timings
  remain private under D-018.
- **Beat This prototype evidence:** Official Beat This `1.1.0` `small0` ran
  locally on CPU outside the application dependency graph. Its 8.1 MB model
  produced beats and downbeats across the private crate, including evidence on
  material rejected by the current analyzer, with some metrical-level
  disagreements. The CLI provides timestamps
  and metrical positions but no calibrated per-track confidence, so these
  outputs remain prototype evidence and cannot satisfy the `>= 0.8` production
  gate. The disposable Python runtime was about 592 MB, further motivating a
  browser ONNX/WebGPU deployment experiment instead of shipping Python/PyTorch.
- **Browser deployment evidence:** A checksum-pinned, development-only Beat This
  `final0` ONNX export now loads in a dedicated browser worker through ONNX
  Runtime Web `1.23.2`. On the development Mac/Chromium run, WebGPU compiled the
  83,143,431-byte model in `1.16 s` and inferred one zero-valued `1500 × 128`
  feature window in `1.46 s`; both beat and downbeat outputs were finite and had
  the expected `[1, 1500]` shape. A forced single-thread WASM run also passed,
  loading in `0.75 s` and inferring in `4.83 s` on the same machine. These are
  development measurements rather than cross-device performance promises. The
  model, ONNX runtime assets, and diagnostic
  HTML were initially excluded from the production build, whose generated
  application assets remained about 316 KB at that milestone. This established
  browser startup feasibility only; at that point it did not
  yet implement audio preprocessing, postprocessing, calibrated confidence, or
  real-track accuracy evaluation. Diagnostic eligibility is hard-coded to zero.
- **Browser real-audio evidence:** The isolated `final0` worker now implements
  the official preprocessing and minimal-postprocessing contracts: 22,050 Hz
  mono PCM; centered reflect-padded 1,024-point magnitude STFT with periodic
  Hann and frame-length normalization; the checksum-pinned `[513, 128]` Slaney
  mel matrix; `log1p(1000 × mel)`; sequential 1,500-frame windows; six-frame
  border removal with `keep_first`; raw-logit local maxima; deduplication; and
  downbeat-to-beat snapping. A private real-audio smoke test completed
  end-to-end in-browser across multiple sequential windows within interactive
  analysis time on the development machine. This proves pipeline feasibility, not
  accuracy or confidence calibration; browser resampling also remains an
  explicitly separate parity question. Eligibility remains hard-coded to zero.
- **2026-08-12 parity and evaluation hardening:** A reproducible official
  Beat This `1.1.0`/`final0` Python oracle now records the exact checkpoint,
  canonical PCM, preprocessing dimensions, environment, and full event arrays
  in atomic private files. Hash-selected multi-track browser/Python smoke tests
  matched every Python beat at ±70 ms. Downbeat and strict ±20 ms parity were
  close but not exact, demonstrating that browser decode/resampling and peak
  selection remain a real engineering variable. This is model-contract parity,
  not detector accuracy; accuracy still requires human event annotations.
- **Evaluation-safety evidence:** Human annotation schema v2 uses full content
  identity, explicit half-open reviewed regions, the browser timebase, and full
  beat/downbeat grids. The scorer validates malformed, duplicate, and unsorted
  predictions before filtering, scores regions independently, uses globally
  optimal monotonic one-to-one event matching, rejects empty evidence and mixed
  detector contracts, and reports a macro headline plus micro counts. Public
  summaries require at least ten tracks, an allowlisted detector contract, and
  release only bucketed/rounded aggregate metrics without track identities.
- **Private-storage evidence:** Private reports, annotations, audio, model
  assets, and oracle arrays live outside the repository/Vite root with private
  filesystem modes. Vite explicitly rejects a private root inside the workspace,
  blocks direct legacy URLs and `/@fs` access, and serves only checksum-pinned
  experimental model assets from an exact allowlist.
- **2026-08-12 non-DJ timing repair:** The deck's expert grid buttons are now
  fronted by a guided Check Timing wizard. A host listens to scheduled clicks,
  describes a half/double-tempo problem in plain language, taps a natural pulse,
  optionally aligns one click and the first beat of a group, then rechecks the
  beginning and later in the song. All edits remain draft-only until the final
  confirmation; Cancel, Escape, and track replacement discard the draft.
  Eight-tap estimation uses robust interval outlier screening and never calls
  tap quality detector confidence. Audio and adjustments remain local.
- **Repair-safety evidence:** Every manual timing mutation explicitly disables
  Auto Mix for that track, and the transition planner independently rejects any
  manually repaired grid even if stale detector confidence is high. Manual
  repair is labelled adjusted, not verified, and cannot unlock long blends.
  Click audition now maps events from one authoritative audio/track-time anchor
  and skips events inside the scheduling lead instead of shifting the entire
  click grid late.
- **Audition audibility correction:** Listening feedback showed that the former
  50 ms low-level sine cue could be masked by normal program audio. Timing
  audition now uses a short, higher-frequency square pulse with a stronger
  protected level, routed directly into the master limiter/meter rather than
  through the music headroom gain. The wizard also flashes a synchronized
  visual CLICK indicator so hosts can distinguish a silent cue from a timing
  disagreement. This monitoring cue is never included in rendered transitions.
- **2026-08-13 timing-response persistence:** The Check Timing wizard now saves
  only a final, versioned `timing-review/v1` response for library tracks. The
  record includes the host's initial plain-language verdict, chosen tempo/beat/
  downbeat actions, explicit beginning and later verdicts, a minimized tap
  summary when tapping was used, and a date-only completion stamp. Raw tap
  timestamps, intervals, playhead positions, filenames, hashes, and partial or
  cancelled sessions are not stored. Save waits for the per-track IndexedDB
  transaction, the restored deck exposes the saved answers and a removal
  control, and direct-loaded tracks remain session-only. Each response is bound
  to its analysis, analyzer, and override schemas; reanalysis clears the prior
  review so stale human feedback is never presented as current. These answers
  remain qualitative product research and never create detector confidence or
  long-blend eligibility.
- **2026-08-13 automatic-analysis product pivot:** Manual timing review is no
  longer part of the happy path. `automatic-rhythm-trust/v2` evaluates machine
  evidence for validity, coverage, robust tempo/phase stability, bar-start
  coherence, and signal activity, and persists the diagnostic tier without
  calling it a probability. The library and decks show plain-language Mix
  Readiness; raw grid details and Review Timing live under Advanced. The
  checksum-pinned Beat This `final0` browser pipeline is now available as an
  optional local automatic detector with a shared sequential queue, one cached
  worker session, WebGPU-to-WASM fallback, production model-pack assets, and
  Cache Storage reuse. Its real first-use pack is approximately 109 MB when the
  WASM runtime is counted. Model failure never blocks basic analysis, playback,
  or Safe Fade. Strong uncalibrated automatic grids may select a 0.35-second
  bar-aligned handoff with no stretch; 32-beat phrase blends still require an
  allowlisted real-music calibrator. This removes user expertise from operation
  without pretending correlated model self-consistency proves accuracy.
- **2026-08-13 local-cue trust correction:** Real final0 outputs exposed a bad
  whole-song phase metric: tiny 20 ms event-grid variations accumulated into
  seconds of apparent error, rejecting locally stable transition sections.
  Trust v2 fits each 16-beat downbeat window independently, retains only exact
  usable cue indices, requires local signal activity and coherent bar spacing,
  and gives explicit measured rejection reasons. The planner can use only those
  retained cues for its no-stretch 0.35-second handoff. Saved enhanced results
  now include detector, experiment, model checksum, backend, and trust schema;
  missing or stale provenance fails closed. Long blends remain separately
  calibration-gated.
- **Private automatic-handoff audit:** The official final0 oracle found usable
  beat/bar evidence across a multi-track private crate, and the conservative
  local rule retained exact short-handoff cues while abstaining where bar
  grouping was weaker. Exact counts and per-track results remain in external
  private evaluation storage under D-018. This is machine-consistency evidence
  for a short no-stretch cut, not human-scored detector accuracy or long-blend
  calibration.
- **Pair preview and Party Autopilot:** The center control previews the exact
  plan produced by the shared transition planner for the loaded pair and
  current source position. Party Autopilot is explicit opt-in: it preloads the
  next queued track onto the free deck, waits for either a nearby qualified bar
  cue or the protected end-of-track fade window, then calls the same audited
  Auto Mix path. Failed arming cancels scheduled gains, restores source audio,
  resets bass EQ, and pauses the target instead of leaving partial automation.
  Queue selection ranks transition safety first, then confident harmonic fit
  and octave-aware tempo distance; equal scores preserve host queue order. The
  chosen track and primary reason are visible, and low-confidence key estimates
  are treated as unknown rather than musical fact.
- **Conservative level matching:** Each decoded track receives a local active
  program RMS/sample-peak estimate and a separate per-deck trim stage. The trim
  is capped from −6 to +3 dB and boost is additionally limited by a −1 dBFS
  sample-peak ceiling. Stereo energy is measured per channel so phase-opposed
  material is not mistaken for silence. This improves party-to-party level
  consistency without calling the approximation standards-compliant LUFS;
  master headroom and the limiter remain final protection.
- **Local data deletion:** Library context actions now remove the selected
  IndexedDB record through an awaited delete transaction, remove it from the
  queue and analysis backlog, and safely eject it from either loaded deck. This
  deletes the browser-stored audio, analysis, and review instead of merely
  hiding a React row until reload.
- **Pre-party readiness:** Enabling Party Autopilot now opens a compact check
  that requires a playing source and at least one next track, reports analyzed
  queue coverage, and distinguishes full enhanced timing from protected-fade
  operation. Enhanced timing is never required for basic party continuity.
- **Priority/background analysis:** Background work remains single-flight for
  audio and memory safety, but the waiting list is dynamically reordered so
  loaded decks are analyzed first, queued tracks follow, and the rest of the
  crate completes afterward. Conservative program-level analysis now runs in
  the analysis worker and is versioned under `basic-worker/v5`, avoiding a
  full-song UI-thread scan on deck load.
- **Role-aware musical cue selection:** Enhanced Beat This contract v2 computes
  beat-synchronous energy, band balance, vocal-likelihood proxy, and structure
  against the exact final0 event grid in the worker. Timing trust remains the
  hard eligibility set. Within those exact cue indices, the planner ranks
  outgoing regions toward later/lower-vocal musical changes and incoming
  regions toward audible, moderate-energy, lower-vocal openings, then scores
  the complete source/target cue pair for normalized energy continuity and
  likely vocal-overlap risk. Missing soft evidence deterministically falls back
  to the earliest schedulable trusted cue. The vocal value remains a spectral
  proxy and never becomes safety confidence or creates timing eligibility.
- **One-action transition rescue:** An armed crossfade retains a cancellable
  recovery checkpoint instead of irreversibly scheduling the outgoing source
  to stop. Rescue uses authoritative audio-clock progress to keep the stronger
  side of the equal-power transition, cancels pending gain automation, restores
  both low-band EQ states, pauses the losing deck, and disables Party Autopilot
  so it cannot immediately repeat the failed handoff. Normal completion pauses
  the silent outgoing source only after its clock-scheduled gain curve ends.
  Auto Mix uses a synchronous single-owner arming lock, replans after asynchronous
  preparation, requires remaining Web Audio lead before scheduling, and locks
  conflicting deck/mixer controls while Rescue remains available. Rescue gain
  ownership settles with a short de-click ramp, and the host's prior low-EQ
  values are restored rather than being replaced with zero.
- **Three-track session horizon:** Party Autopilot now evaluates
  `current → next → after next` with a bounded six-path beam over at most the
  first 20 unique queued tracks. Path comparison is safety-first: the weakest
  template across both legs, then immediate and second-leg safety, precede cue,
  key, tempo, and energy preferences. Already-played, duplicate, current, and
  Auto-Mix-disabled tracks are excluded. The advisory third leg never exposes
  an executable schedule; the live transition is recomputed from the real Web
  Audio clock before arming.
- **Queue-first crate continuation:** Party Autopilot preserves explicit queue
  order as its candidate prefix and, with a visible pre-start option enabled,
  may fill the remaining horizon from the eligible local library. Current,
  loaded, played, duplicate, and Auto-Mix-disabled tracks are excluded. The
  option is locked while Autopilot runs so selection scope cannot silently
  change mid-session.
- **Host energy storyline baseline:** Hosts can select Steady, Build to a peak,
  or Warm up/Peak/Cool down. A pure deterministic module linearly interpolates
  a normalized target and computes transparent heuristic distance from mean
  beat activity. Missing or malformed evidence is unscored, never assigned a
  fabricated neutral probability. Energy is only a tie-break inside equivalent
  transition-safety paths because current activity is normalized per track and
  is not calibrated absolute perceived energy.
- **Audio-clock party progress:** The host selects a planned duration from one
  to six hours. A versioned immutable session clock derives energy progress
  from accumulated active Autopilot time using injected Web Audio timestamps;
  queue edits cannot move the storyline backward, paused time does not advance
  it, and overtime is reported without stopping audio. Played-track history is
  used only for repeat exclusion, never as a proxy for elapsed party time.
- **Live energy override:** While Autopilot runs, the host may shift the next
  selection's relative beat-activity target in 10% steps within ±30%. This is a
  bounded session-only adjustment to the energy heuristic, resets for New
  Party, and never changes transition eligibility or the safety-first ordering.
- **Safe host skip:** During Autopilot the host can request an immediate skip,
  but the action delegates to the same immutable transition planner and renderer
  as every other handoff. It uses the currently available trusted cue or Safe
  Fade and retains the one-action Rescue checkpoint; it is not a hard stop.
- **Local current-pair rehearsal baseline:** With both decks stopped, a host can
  render and hear a short local excerpt around the currently planned cue. The
  renderer consumes the actual cue offsets and transition duration, adds two
  seconds of pre/post-roll, applies equal-power gain with conservative headroom,
  and reports bounded sample-peak/silence/discontinuity diagnostics. Preview
  PCM is ephemeral and never persisted. This baseline does not yet share the
  live scheduler's stereo, EQ, playback-rate, limiter, or true-peak path, so its
  technical result is explicitly not presented as proof of musical safety.
- **Multi-hour Autopilot coordinator soak:** The live React adapter and the
  deterministic three-hour harness now call the same
  `party-autopilot-decision/v1` pure coordinator for queue-versus-library
  selection, two-leg horizon ranking, blocked-target rejection, final-track
  declaration, current-pair transition planning, and arm timing. The synthetic
  adapter advances exact source positions from plan duration and target cue
  offsets, emits the production `party-autopilot-trace/v1` lifecycle, and is
  judged by `party-autopilot-evaluation/v1`. Rescue pauses the run as production
  does; the selected party length is an observation horizon, not an instruction
  to stop playback. This checks shared decision/state invariants only, not
  browser async timing, decode/model execution, Web Audio continuity, speaker
  output, or musical quality.

## 15. Risk register

| Risk | Consequence | Mitigation |
|---|---|---|
| Wrong beat/downbeat grid | visibly bad transition | confidence gate, correction UI, safe fallback |
| Time-stretch artifacts | metallic or unstable audio | strict ratios, benchmarked key lock, alternate template |
| Vocal collision | chaotic mix | beat-level vocal probability, stem option later |
| Loudness/peak failure | unpleasant or unsafe output | LUFS compensation, headroom, limiter, render tests |
| Main-thread overload | audio glitch | workers, AudioWorklet, pre-analysis, profiling |
| Browser storage quota | lost/unavailable library | preflight, file handles where supported, desktop option |
| Model/licence conflict | cannot ship or monetize | dependency audit and explicit licence decision |
| Overfitting to house music | bad open-format behavior | genre profiles and template fallback |
| Guest abuse | poor party experience | host approval, vote limits, fairness rules |
| Planner opacity | host distrust | Why Next and score breakdown |
| Overambitious AI scope | unreliable core never ships | milestone gates; semantic AI after core quality |

## 16. Decision log

### Accepted

- **D-001 — Local-first:** Music and analysis remain local by default.
- **D-002 — Deterministic renderer:** AI proposes; clock-driven DSP performs.
- **D-003 — Phrase-aware timing:** Automatic transitions use detected musical
  boundaries and beat-count durations.
- **D-004 — Confidence-aware fallback:** Uncertain analysis changes behavior
  instead of being hidden.
- **D-005 — Joint planning:** Track choice and transition feasibility are scored
  together.
- **D-006 — Core before stems:** Stem separation is optional and late-stage.
- **D-007 — Structured party intent:** The planner consumes constraints and an
  energy storyline, even if natural language populates them later.
- **D-008 — Spotify audio excluded:** Current Spotify policy is incompatible
  with Mazzy's mix engine.
- **D-009 — Worker analyzer v2:** Native browser decoding may complete on the
  main thread, but CPU-heavy rhythm and tonal analysis runs in a Web Worker.
  Analyzer `basic-worker/v2` fixes the former A-relative/C-labelled pitch-class
  mapping; records from earlier analyzers are stale rather than silently reused.
- **D-010 — Rhythm benchmark v1 does not select a detector:** Synthetic fixtures
  and ±70 ms event metrics now expose metrical and non-rhythmic false positives.
  Essentia remains research-only because of licensing, and the current
  MusicTempo result remains diagnostic until real-audio accuracy and confidence
  calibration are measured. This decision does not change stored analysis
  schemas because no runtime detector was promoted.
- **D-011 — Human beat-grid overrides are a separate versioned layer:** Analyzer
  output is never edited in place. BPM, first-beat phase, and downbeat phase are
  stored as `beat-grid-overrides/v1`, reapplied after reanalysis, and removable
  without destroying generated evidence. Track records use schema
  `track-analysis/v3`; the underlying analyzer remains `basic-worker/v2` because
  its detection algorithm did not change.
- **D-012 — Transition Plan v2 is confidence-gated and immutable:** Long blends
  require beat and downbeat confidence `>= 0.8`, complete 32-beat downbeat
  windows, and no more than 10% target stretch. Failure of any requirement
  creates a visible, no-stretch Safe Fade. Audio-clock timestamps and fallback
  reasons are stored in `transition-plan/v2`; React animation timing is not part
  of the performance schedule.
- **D-013 — Musical-features v1 is evidence, not truth:** Analyzer
  `basic-worker/v3` stores beat-synchronous energy, band balance, structural
  novelty, and a vocal-likelihood spectral proxy in `track-analysis/v4`. The
  proxy and inferred boundaries remain below autonomous gating confidence until
  evaluated on annotated real audio. They cannot manufacture downbeats or
  bypass the Safe Fade policy.
- **D-014 — SUPERSEDED BY D-031. Beat This was selected as the deployment prototype, not yet the runtime
  detector:** Official Beat This code and published weights are MIT-licensed,
  and `small0` produced useful CPU throughput and complete beat/downbeat output
  on the private crate. Production integration is blocked on human annotation,
  confidence calibration, browser ONNX/WebGPU profiling, and model-loading UX.
  Until those gates pass, `basic-worker/v3` remains production and Safe Fade
  remains the only live template for generated grids.
- **D-015 — SUPERSEDED BY D-031. The ONNX browser path was feasible but isolated:** The
  published Beat This `final0` ONNX model successfully creates and infers with
  WebGPU and single-thread WASM in a dedicated development worker. Model/runtime
  files are served only from external private application storage and never enter
  `dist`; the experiment reports `eligibilityConfidence: 0`. Promotion still
  requires browser/Python resampling and feature parity, human-scored accuracy,
  calibrated confidence, memory profiling, and an explicit 83 MB loading UX.
- **D-016 — SUPERSEDED BY D-031. Browser `final0` initially analyzed real audio only as an experiment:** The
  official STFT/log-mel, chunk aggregation, and minimal peak contracts are now
  implemented and exercised on one private track in a development worker. The
  worker is single-flight, releases sessions in `finally`, validates the full
  configuration and tensor names, rejects malformed output, and retries WASM
  if WebGPU session creation fails. This does not change `track-analysis/v4` or
  `basic-worker/v3`: promotion remains blocked on browser/Python resampling and
  feature parity, human-scored `final0` accuracy, confidence calibration,
  cross-device memory/runtime evidence, and model-loading product design.
- **D-017 — Parity is separate from accuracy:** Browser/Python event agreement
  is measured against the exact official `final0` contract and canonical
  preprocessing metadata. Decoder/resampler parity is reported separately and
  no phase shift or tempo warp may be applied to headline scores. Model
  agreement cannot substitute for human ground truth.
- **D-018 — Private evaluation is a security boundary:** Raw audio, filenames,
  content hashes, annotations, model outputs, and per-track reports remain in
  external private application storage. Public evidence requires cohorts of at
  least ten and exposes only allowlisted, rounded aggregate fields.
- **D-019 — Ear-led repair is assistance, not ground truth:** A non-DJ may
  repair pulse tempo, phase, and an optional bar-one phase through listening and
  tapping, but the result remains a separate manual override with Auto Mix
  disabled. Only a future versioned verification contract backed by measured
  accuracy and calibrated confidence may promote a repaired grid to long-blend
  eligibility.
- **D-020 — Rescue preserves the stronger live side:** An active automatic
  transition keeps a cancellable audio-clock checkpoint. Rescue selects the
  source before the equal-power midpoint and the target from the midpoint
  onward, restores stable gain/EQ ownership, pauses the other deck, and disables
  Autopilot. It never attempts to reverse already-heard audio or guess which
  song a crowd prefers.
- **D-021 — Session planning is bounded and safety-lexicographic:** Autopilot
  looks exactly two transitions ahead. The weakest known transition tier wins
  before musical preference, energy, key, or tempo; the future leg is advisory
  and is never sent to the renderer. Host queue order is the final tie-break.
- **D-022 — Energy intent is a heuristic tie-break:** The first energy
  storyline uses bounded per-track beat activity and never calls its fit a
  confidence or probability. It cannot promote a weaker transition tier and
  must remain visibly distinct from loudness normalization.
- **D-023 — Rehearsal audio is ephemeral and advisory:** A rehearsal may decode
  local library files and render a short preview only after a host action while
  live playback is stopped. Rendered PCM, filenames, and waveform samples are
  never persisted. Automated sample checks are diagnostics, not evidence that a
  transition is musically good or calibrated safe.
- **D-024 — State soak and device soak are separate gates:** Deterministic
  simulation proves bounded planning/state invariants cheaply, but cannot prove
  browser scheduling, decoder, output-device, memory, or audio-underrun behavior.
  A wall-clock browser/device soak remains mandatory before shipment.
- **D-025 — Rehearsal is local, ephemeral, and subordinate to the live plan:**
  The current renderer produces a short stereo pre-master window using the
  compiled playback rates, program trims, EQ/bass ramps, gain curves, and shared
  deck filter chain, then auditions it once through the real master path. Pair
  and analysis identity are revalidated after every asynchronous stage, natural
  completion releases the UI lock, and no rehearsal PCM or outcome is persisted.
  Pre-master diagnostics are not allowed to claim musical quality, true-peak
  compliance, device stability, or human preference.
- **D-026 — Autopilot owns transport and honors the queue as a partition:**
  While active, it locks manual deck/mixer mutations and plans only among
  eligible queued tracks. The remaining library becomes a candidate pool only
  after the queue is empty. Audio-clock completion, rather than animation-frame
  progress, owns the handoff; host takeover, Rescue, or Stop Autopilot
  invalidates outstanding preload and arm generations.
- **D-027 — Transition DSP is compiled after planning, never during it:** An
  approved `transition-plan/v2` plus the live decks' trim/EQ snapshot compiles
  into immutable `transition-dsp/v1`. The live scheduler consumes its copied
  gain curves and explicit bass ramps; the compiler cannot promote eligibility
  or substitute a template. Master headroom and limiter settings are bound to
  `mazzy-master/v1`, which is also the required output contract for the future
  pre-master stereo rehearsal renderer.
- **D-028 — Party Mode is the non-DJ default; the mixer is advanced:** The first
  surface presents Import → Play First Song → Start Autopilot, then only Now,
  Next, tentative Later, calmer/more energetic, skip with a fade, pause, and
  emergency transition stop. The dual-deck mixer stays mounted but collapsed
  under an explicit Advanced action. Primary controls use readable type and
  approximately 44 px targets; library selection, queue reordering, and
  preflight are keyboard operable. Party state remains tab-memory-only and says
  so visibly.
- **D-029 — Party continuation is explicit and local-first includes the UI:**
  Party Mode exposes the planned duration and the choice to continue beyond the
  queue before Autopilot starts; library continuation defaults off. The shipped
  UI uses local system fonts rather than making an unsolicited third-party font
  request. Rehearsal cancellation keeps live transport locked until the active
  local decode/render step settles, because browser decoding and
  `OfflineAudioContext` rendering are not reliably abortable.
- **D-030 — Device acceptance uses post-limiter evidence, not UI polling:** A
  local wall-clock runner uses the production audio/deck engine and synthetic
  stereo buffers. `audio-health/v2` counts render quanta, non-finite and clipped
  samples, peak, and unexpected silent runs after the limiter without retaining
  PCM. `device-soak-report/v2` includes only anonymous aggregate evidence and
  fails closed when the run is short, render evidence is missing, transitions
  are orphaned, context state is interrupted, output is invalid/clipped, an
  unexpected gap exceeds 100 ms, or completion lateness exceeds 500 ms. A
  one-minute run is diagnostic only; a visible, awake, two-hour run remains the
  release gate.
- **D-031 — Beat This `final0` is an optional production timing tool with a
  deliberately narrow authority:** This supersedes D-014 through D-016. The
  checksum-pinned model, configuration, filterbank, and one bundled ORT runtime
  may enter `dist` and Cache Storage only after the host chooses the enhanced
  timing download. The browser worker runs sequentially, retries WebGPU with
  WASM, and persists exact detector/model/trust provenance. Uncalibrated local
  consistency may authorize only exact retained 0.35-second, no-stretch bar
  handoff cues. It cannot authorize a 32-beat phrase blend; missing/stale
  provenance, a manual grid, weak local evidence, or absent assets fails closed
  to Safe Fade. This is production runtime plumbing, not a claim of human-scored
  detector accuracy or calibrated long-blend safety.
- **D-032 — Device soak v2 is an audio-engine gate, not whole-product proof:**
  The synthetic wall-clock runner validates finite post-limiter render output,
  near-total expected-active frame coverage, worklet health, transition balance,
  and context continuity. Its report distinguishes a short diagnostic pass from
  a literal two-hour release-gate pass. It does not prove decoding, analysis,
  Party Autopilot state, browser-to-speaker delivery, or musical quality; those
  require separate integration and listening evidence.
- **D-033 — Production Autopilot state evidence is private, bounded, and
  separate from audio evidence:** A host may explicitly enable
  `party-autopilot-trace/v1` before starting a party. The synchronous recorder
  keeps only allowlisted event enums, coarse active seconds, and session-local
  track/load/operation ordinals in tab memory. `party-autopilot-evaluation/v1`
  fails closed on stale preload adoption, repeated tracks, mismatched transition
  or final-track ownership, unresolved operations, malformed ordering,
  interruption, or overflow. It records no song metadata, musical analysis,
  exact wall time, audio, filenames, device identity, or network activity. This
  is production-session state evidence only; D-030/D-032 remain the separate
  render-continuity gate, and neither constitutes musical-quality proof.
- **D-034 — Live Autopilot and deterministic state soak share one decision
  coordinator:** `party-autopilot-decision/v1` receives immutable deck
  observations and one injected Web Audio clock time, then returns only a
  preload, blocked-target eject, final declaration, wait, pause, or arm intent.
  It invokes the production crate partition, two-song horizon planner,
  transition planner, and arm gate. React remains responsible for async loading,
  ownership revalidation, audio scheduling, and UI effects. The synthetic soak
  executes the same intents with synthetic track identities and validates the
  resulting production trace. No speculative second-leg schedule is treated as
  live authority, Rescue pauses instead of auto-continuing, and target cue time
  is subtracted from later track lifetime. This supersedes the earlier simplified
  arithmetic soak and is coordinator/state evidence only; D-030/D-032 remain
  mandatory for audio-render continuity.
- **D-035 — Pitch-preserving tempo sync is load-bound and fail-closed:**
  Signalsmith Stretch Web 1.3.2 is exact-pinned under MIT for a developer-only
  AudioWorklet spike. The current `key-lock-smoke/v6` measures synthetic stereo pitch,
  tempo, and channel separation through the isolated DeckEngine and protected master path at
  0.94×, 1.00×, and 1.06× but can never satisfy the separate
  `key-lock-device-acceptance/v1` planner contract. Diagnostics build to
  `dist-diagnostics`; normal production excludes the spike. `DeckEngine` owns a
  monotonic runtime-load revision, single-flight optional preparation state,
  stale-result disposal, and a transport gate that mutes native sources before
  stop/restart. No persisted track analysis carries this authority. Live phrase
  promotion additionally requires the exact source/target load to be using or
  prepared for an accepted processor, renderer/rehearsal parity, browser stress,
  memory and listening gates; until then App supplies no capability.
- **D-036 — Two-deck key-lock render evidence remains non-authoritative:** a
  built-diagnostics `key-lock-crossfade-smoke/v1` run prepares two simultaneous
  Signalsmith decks at 0.94×/1.06×, schedules Mazzy's actual four-second
  equal-power crossfade, and observes the protected master with audio-health/v2.
  The first run completed under exact schedule ownership with 274,176
  expected-active frames, zero silent frames, non-finite/clipped samples, or
  processor errors. This is one deterministic render-path handoff—not sustained
  device, real-file, listening, or production authority. App remains unwired.
- **D-037 — Repeated two-deck key-lock stress is clean but still synthetic:**
  `key-lock-crossfade-smoke/v2` alternated twelve 1.5-second equal-power
  transitions between simultaneously prepared 0.94×/1.06× decks. All twelve
  schedule completions were owned exactly once across 967,680 expected-active
  frames. The longest silence was one sample (0.021 ms); invalid samples,
  clipping, and processor errors were zero. This closes the bounded repeated
  render-path slice only. Real-song artifact listening, longer CPU/memory soak,
  control semantics, and exact load-bound planner/executor authority stay open.
- **D-038 — Real-file key-lock judgment requires a human and stays private:**
  the diagnostics-only `/key-lock-listening.html` flow decodes two host-selected
  local files, retains only anonymous twelve-second stereo excerpts in memory,
  clears filename inputs, and offers original/0.94×/1.06×/two-deck comparisons.
  Ratings are fixed Clean / Artifacts / Not sure counters held only in the tab;
  no name, path, timestamp, audio, storage, export, or upload is permitted. The
  workflow was exercised with two files from the external private crate, but no
  subjective rating was manufactured. Human listening remains a promotion gate.
- **D-039 — Key-lock diagnostics fail closed around lifecycle and evidence:**
  `key-lock-crossfade-smoke/v3` adds explicit Stop/pagehide cancellation,
  bounded audio-clock completion waits, exact unique schedule/completion IDs,
  completion lateness, uninterrupted-context checks, and internally consistent
  expected/rendered-frame coverage. The private listening lab reuses one
  persistent two-deck graph per AudioContext, requires at least ten seconds per
  excerpt, resumes and monitors the context on every trial, cancels active fade
  ownership, and exposes ratings only after a healthy natural completion.
  A fresh v3 built-diagnostics browser run completed all twelve transitions
  across 967,680 expected-active frames, with zero silent frames,
  invalid/clipped samples or processor errors after an acknowledged interval
  reset, and a clean Stop/restart cycle.
  The separate human listening judgment remains open.
- **D-040 — Key-lock authority is exact-load and context-bound:** the dormant
  `key-lock-capability/v1` planner path now requires an independently accepted
  capability plus matching current AudioContext sample rate, exact source and
  target runtime load keys, and the Signalsmith backend on both decks. Missing,
  stale, wrong-load, wrong-context, or synthetic-only evidence stays closed.
  App intentionally supplies neither capability nor runtime binding yet.
- **D-041 — Diagnostic intervals begin on audio authority and sustained key-lock
  evidence is still non-authoritative:** the device runner now waits for the
  first scheduled frame on the Web Audio clock and receives an acknowledged
  audio-health reset before starting wall/audio duration measurement. A fresh
  production-built one-minute run matched both clocks at 60.2 seconds, completed
  7/7 owned transitions, and reported no unexpected silence, invalid/clipped
  samples, processor errors, or warnings. `key-lock-crossfade-smoke/v4` adds a
  mode-bound one-minute minimum and completed 37/37 two-processor transitions
  across 2,958,336 expected-active frames with zero silent frames, invalid or
  clipped samples, or processor errors. Both results are synthetic render-path
  smoke evidence only. They do not satisfy the visible two-hour device gate,
  real-song listening, musical-quality, or live key-lock authority requirements.

### Open questions

- **Q-001:** Remain browser/PWA-first through launch, or package a desktop app
  once analysis and file access become demanding?
- **Q-002:** Keep the whole product permissively licensed, adopt an AGPL path, or
  budget for commercial analysis licences?
- **Q-003:** Which platforms are release targets: Chromium laptops only, macOS,
  Windows, or all modern browsers?
- **Q-004:** Can a deployable Beat This variant meet the human-scored accuracy,
  confidence-calibration, memory, and model-loading targets required for
  production now that `final0` WebGPU startup feasibility is established?
- **Q-005:** Should guest requests use a local-LAN service, optional cloud relay,
  or both?
- **Q-006:** What legally usable benchmark audio set will be committed or
  downloaded in CI?
- **Q-007:** What party genres are required for version 1?

## 17. Immediate work order

Do these in order when implementation begins:

1. Establish tests and an offline transition-render harness.
2. Define TypeScript domain schemas and versioned IndexedDB migrations.
3. Extract a centralized audio engine and authoritative transport clock.
4. Add master metering, headroom, loudness compensation, and limiting.
5. Fix current gain/crossfader and duplicated library-click behavior.
6. Move current analysis off the main thread and remove duplicated key analysis.
7. Benchmark at least two beat/downbeat approaches on a small golden set.
8. Add beat-grid storage, visualization, confidence, and manual correction.
9. Replace fixed-second Auto Mix with a deterministic 32-beat phrase transition.
   **Implemented in `transition-plan/v2`; live eligibility remains locked by the
   analyzer limitation.**
10. Implement safe fallback before adding more impressive templates.
    **Implemented as the visible, no-stretch Safe Fade.**
11. Add boundary, energy, and vocal analysis. **A deterministic feature baseline
    is implemented in `basic-worker/v3`; real-audio calibration and a validated
    vocal detector remain open.**
12. Implement bass swap, downbeat cut, and echo/filter templates.
13. Add pair scoring and short-horizon session planning.
14. Build the host preflight/cockpit and transition rehearsal experience.
15. Test at a real party and use structured feedback to revise weights.
16. Only then begin semantic AI, stems, and learned ranking.

## 18. Definition of the first shippable Mazzy

Mazzy version 1 is ready to ship when:

- a host can prepare a local library without DJ knowledge;
- analysis uncertainty is visible and correctable;
- automatic transitions use real beat/downbeat and phrase positions;
- at least four transition behaviors exist, including a safe fallback;
- tempo changes preserve pitch within the supported range;
- loudness is consistent and output is peak-protected;
- the planner controls repetition, requests, and an energy storyline;
- host override and Rescue Mode work during any transition state;
- a two-hour party can run without gaps, crashes, or manual babysitting;
- blind testing meets the documented transition-quality target;
- licence, privacy, and dependency audits are complete;
- the README clearly states supported platforms and limitations.

## 19. Primary references

1. Bittner et al., [Automatic Playlist Sequencing and Transitions](https://archives.ismir.net/ismir2017/paper/000086.pdf), ISMIR.
2. Kim et al., [A Computational Analysis of Real-World DJ Mixes](https://archives.ismir.net/ismir2020/paper/000352.pdf), ISMIR.
3. Ishizaki et al., [Full-Automatic DJ Mixing System with Optimal Tempo Adjustment](https://archives.ismir.net/ismir2009/paper/000043.pdf), ISMIR.
4. [Mixxx DJ and beatmatching manual](https://manual.mixxx.org/2.6/en/chapters/djing_with_mixxx).
5. [Essentia algorithm overview](https://essentia.upf.edu/algorithms_overview.html).
6. [Essentia licensing](https://essentia.upf.edu/licensing_information.html).
7. [Beat This reference implementation](https://github.com/CPJKU/beat_this).
8. [MSAF music-structure framework](https://msaf.readthedocs.io/en/latest/).
9. [Web Audio API specification](https://webaudio.github.io/web-audio-api/).
10. [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch).
11. [EBU R128 loudness recommendation](https://tech.ebu.ch/publications/r128).
12. [Demucs source separation](https://github.com/facebookresearch/demucs).
13. [Microsoft CLAP](https://github.com/microsoft/CLAP).
14. [Spotify Developer Policy](https://developer.spotify.com/policy).

---

If a future implementation choice conflicts with this document, do not silently
work around it. Record the conflict, evidence, decision, schema impact, and test
plan here first.
