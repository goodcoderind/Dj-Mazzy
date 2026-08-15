# Mazzy AI DJ: Research, Product, and Build Plan

> Canonical specification for all automatic-DJ work in Mazzy.
>
> Status: Working specification
>
> Version: 1.1
>
> Last updated: 2026-08-15
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
type TransitionPlanV3 = {
  schemaVersion: "transition-plan/v3";
  fromTrackId: string;
  toTrackId: string;
  template: "phrase-blend" | "bass-swap" | "echo-drop" |
            "downbeat-cut" | "filtered-fade" | "safe-fade";
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

- the lightweight production analyzer still has provisional beats and no
  trusted downbeats; the optional enhanced detector can authorize only the
  narrowly bounded, no-stretch Bar Handoff, while long phrase blends remain
  locked pending human-scored calibration;
- the key-lock processor is isolated behind exact-load capability checks and
  has synthetic browser diagnostics, but it is intentionally not wired into
  live transitions until the human listening and device-acceptance gates pass;
- beat-synchronous energy and structural/vocal-frequency proxies now support
  safety-bounded cue ranking and Filtered Fade, but they are not calibrated as
  semantic vocal or musical-quality truth on annotated real music;
- stereo K-weighted integrated/short-term loudness, aggregate Tech 3342-style
  LRA, and conservative four-times decoded intersample-peak estimation replace
  the earlier raw-RMS estimate, but the party target still needs listening
  calibration, neither meter is compliance-certified, and post-master
  true-peak evaluation remains incomplete;
- the shared Autopilot coordinator now provides queue-first three-track
  lookahead, played-track exclusion, energy-storyline intent, Rescue, and
  deterministic final-track ownership, but live real-party validation and
  refresh/crash recovery remain open;
- production transition rehearsal, private listening tools, and synthetic
  sustained diagnostics exist; a fresh generated-WAV Chromium gate now composes
  the production React App through two automatic handoffs, while real-party,
  multi-browser, physical-output, and human key-lock listening judgment remain
  open.

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
- **Conservative level matching:** Each decoded mono/stereo track receives a
  local `program-level/v4` measurement and a separate per-deck trim stage. The
  worker preserves channel 1 for the existing rhythm path while measuring both
  level channels independently with sample-rate-adjusted K-weighting, 400 ms
  blocks at 75% overlap, a −70 LUFS absolute gate, and a −10 LU relative gate.
  Three-second windows at 10 Hz feed a −70 LUFS absolute/−20 LU relative gate
  and 10th-to-95th-percentile aggregate range; values from the first 60 seconds
  are marked provisional, and no per-window time series is persisted.
  A separately versioned provisional party policy caps trim from −6 to +3 dB
  toward −14 LUFS and limits boost against a conservative −2 dBTP per-file
  ceiling using a four-times decoded intersample-peak estimate based on the
  order-48, four-phase FIR coefficients published in ITU-R BS.1770-5 Annex 2.
  Phase-opposed stereo is not mistaken for silence;
  unsupported layouts, malformed input, and stale nested records receive neutral
  trim. Synthetic stereo calibration, EBU gate cases, and fixed independent
  FFmpeg `ebur128` reference readings are within 0.1 LU at 44.1, 48, and 96
  kHz. This is a
  BS.1770-derived consistency aid, not certified EBU Mode or true-peak
  metering. LRA is diagnostic only and cannot alter trim or transition choice.
  The target still needs listening calibration, and EQ, resampling,
  overlap, and master processing require separate post-DSP true-peak evidence.
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
  audio and memory safety. Missing basic/program facts form the high-priority
  lane, ordered as loaded decks, queued tracks, then the rest of the crate;
  optional enhanced timing is a separate lower-priority lane. Each read,
  decode, worker, render, and inference stage now has D-071's exact runtime
  lease and bounded settlement policy. Conservative program-level analysis
  remains in `basic-worker/v5`, avoiding a full-song UI-thread scan on deck
  load.
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
  `OfflineAudioContext` rendering are not reliably abortable. D-081 supersedes
  the formerly unbounded wait with an exact liveness owner and reload circuit.
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
  current `mazzy-audio-engine/v2` production-built one-minute run measured 60.2
  seconds on the wall clock and 60.1 seconds on the Web Audio clock, completed
  7/7 owned transitions, and reported no unexpected silence, invalid/clipped
  samples, processor errors, or warnings. `key-lock-crossfade-smoke/v4` adds a
  mode-bound one-minute minimum and completed 37/37 two-processor transitions
  across 2,958,336 expected-active frames with zero silent frames, invalid or
  clipped samples, or processor errors. That key-lock result and the one-minute
  device result are synthetic render-path smoke evidence only.
  These interval and completion-ownership semantics were versioned as
  `device-soak-report/v3` / `mazzy-device-soak-runner/v3`; earlier v2 reports do
  not constitute this evidence. A literal v3 two-hour run subsequently rendered
  7,201 healthy seconds and completed 923/923 owned transitions with no gaps,
  clipping, invalid samples, processor errors, ownership failures, or warnings,
  but failed its fixed one-second wall/audio-clock divergence limit at 1.6
  seconds. `device-soak-report/v4` therefore reports the measured divergence and
  replaces that duration-independent limit with a bounded 500 ppm device-clock
  rate tolerance (a one-second floor for short checks). Context-state and render
  coverage gates remain unchanged, and the v3 result is not retroactively a
  release pass. On 2026-08-14, a fresh visible production-built v4 run completed
  7,200.2 seconds on both wall and Web Audio clocks, with 32 ms measured clock
  divergence, 923/923 owned transitions, 28 ms maximum completion lateness,
  345,608,192 expected-active frames, and zero silent frames, invalid/clipped
  samples, processor errors, ownership failures, failure codes, or warnings.
  Its exact privacy-safe `device-soak-report/v4` artifact sets
  `releaseGatePassed: true` and is committed as
  `DEVICE_SOAK_ACCEPTANCE_REPORT.json`. This satisfies the synthetic production
  audio-engine render-path gate. It does not satisfy real-song listening,
  browser-to-speaker/output-device validation, full Party Autopilot behavior,
  musical-quality, or live key-lock authority requirements.
- **D-042 — Filtered Fade is a bounded fourth behavior, not a weaker safety
  ranking:** `transition-plan/v3` and `transition-dsp/v2` add a 4.5-second
  no-stretch equal-power handoff with one outgoing 20 kHz→420 Hz low-pass sweep.
  It is available only when current `basic-worker/v5` evidence aligned across
  the complete playing interval contains normalized beat-synchronous energy,
  vocal-frequency-proxy, and band-energy values through the full sweep, with
  audible energy, fewer vocal-like frequencies, and useful high-frequency
  material. Manual grids, disabled tracks, missing/stale evidence, proxy-heavy
  or near-silent sections, insufficient remaining audio,
  and every malformed input fall back to Safe Fade. Filtered Fade and Safe Fade
  share the same selection-safety rank, so presentation variety cannot bypass
  queue order, no-repeat rules, or prefer a weaker pair. Live scheduling and the
  offline rehearsal consume the same immutable sweep; completion, failure, and
  Rescue restore both decks' prior cutoff. The diagnostics-only v3
  transition-rehearsal check compares a 3 kHz filtered render with
  an otherwise identical unfiltered render in both early and late windows, so
  the ordinary gain fade cannot masquerade as filter evidence. Cue, stereo,
  continuity, trim, and determinism passed in the same fresh 48 kHz browser
  run; the early filtered/reference RMS ratio was 1.008 and the late ratio was
  0.062.
  `party-autopilot-decision/v3`,
  `party-autopilot-trace/v3`, `party-autopilot-evaluation/v3`, and the synthetic
  soak v3 carry the new allowlisted template. This closes the four-behavior code
  requirement, not real-song artistic preference, long-blend calibration,
  key-lock promotion, or the literal two-hour device gate.
  This narrowly supersedes D-013 only for choosing between equal-ranked,
  no-stretch fallback presentations: the vocal-frequency proxy may authorize a
  bounded filter sweep, but it still cannot authorize timing, tempo stretch,
  phrase alignment, or a higher-ranked song choice and is never described as
  verified vocal detection.
- **D-043 — Offline app-shell recovery is allowlisted and separate from user
  data:** `mazzy-offline-app-shell/v2` is generated only for the normal
  production artifact. After a successful online load, its content-derived
  cache holds only the root HTML, exact hashed UI modules, the basic analysis
  worker, manifest, and install icons. Each response body must match its
  build-embedded SHA-256 before the worker can install; a failed or partial
  deploy leaves the last healthy worker/cache in control. Updates do not use
  `skipWaiting`, so old tabs retain their matching hashed assets until those
  tabs close. Both standard and enhanced app shells exclude the separately
  consented timing worker/runtime/model pack, and the standard artifact omits
  the enhanced worker and ONNX runtime entirely. The standard build may detect
  a nonempty timing cache left by a prior enhanced build only to expose its
  deletion control; it cannot load or use that cached pack. The worker ignores all non-GET,
  cross-origin, music, IndexedDB, model, diagnostic, private-evaluation, device
  check, and arbitrary-route requests; navigation fallback is root-only.
  Its paths and registration scope derive from the configured Vite base, so a
  project-subpath build stays inside that project. Diagnostics builds do not
  register or emit the worker, manifest, or install icons. A clean Chromium
  profile installed the production worker online, then opened a new full Party
  Mode tab after the preview server stopped. This is app-shell recovery
  evidence, not storage permanence, session-state recovery, model availability,
  decoder/audio continuity, or an offline-first-use guarantee.
  Because optional worker/runtime code is not in this shell, the enhanced build
  treats a model-only cache as unavailable whenever the same-origin timing
  runtime cannot be reached; this prevents offline recovery from repeatedly
  queueing an analysis whose executable is absent.
- **D-044 — Folder import uses a local coarse-capacity preflight, not storage
  telemetry:** before creating library records, Mazzy sums the selected audio
  `File.size` values and compares them with `navigator.storage.estimate()` while
  preserving a 128 MB reserve. A selection that clearly exceeds available
  capacity is rejected before React or IndexedDB ownership; unknown, missing,
  malformed, or permission-withheld estimates do not block import and remain a
  visibly unknown state. The check retains and transmits no filename, path,
  per-file size, or storage estimate; only the existing in-tab UI receives a
  coarse formatted result. D-077 supersedes the original broad-lock detail:
  preparation remains outside the shared playback gate and the exact commit
  alone holds the local-library mutation lock through one serialized IndexedDB transaction. It publishes
  library rows or a success announcement only after that transaction completes.
  Concurrent import/remove/clear cannot pass against one stale estimate, and a
  quota/write rejection leaves no in-memory phantom library. Browser eviction
  after a successful commit remains external. Imports remain disabled through
  initial IndexedDB hydration. Each selected file is hashed sequentially as
  `file-content-sha256/v1`; the local record persists that identity so exact
  byte duplicates within one selection or against the restored library are
  skipped before capacity, storage, analysis, or queue ownership. The digest is
  never placed in diagnostics, reports, URLs, logs, or network requests. A
  unique IndexedDB identity index makes that invariant profile-wide across
  concurrent Mazzy tabs. Ordinary analysis persistence is update-only; imports
  are the only insertion path. Successful deletion is broadcast to other open
  tabs so their stale state and workers cannot recreate a removed record.
  Import/delete/clear share a profile-wide Web Lock where supported, and the
  clear broadcast invalidates an import generation that is still hashing,
  estimating, or waiting to publish in another tab.
  Routine analysis writes merge into the current IndexedDB record and preserve
  the fields owned by identity migration and timing-review/override patches;
  unrelated stale snapshots cannot roll those fields backward. Import errors
  and later analysis-save errors have separate UI ownership, and only a later
  successful analysis snapshot clears the latter.
- **D-045 — Party Autopilot owns a bounded screen wake-lock request:** entering
  Autopilot asks the browser for a `screen` wake lock; every state path that
  disables Autopilot converges on release through one state-owned effect, and
  unmount also releases. A hidden-tab release is reacquired only after the tab
  becomes visible while Autopilot is still enabled. Request failure never blocks
  playback and is announced in a polite live status with the actionable fallback
  to keep the computer powered and awake. This does not claim to override OS
  power policy or keep a closed laptop lid awake.
- **D-046 — Browser audio suspension fails closed to host recovery:** an
  AudioContext state listener treats `suspended`, `interrupted`, and `closed` as
  authoritative recovery events. If Autopilot is active it is paused through
  the same generation/clock/trace path used for host control, preventing later
  preload or arm authority from running against a stale audio clock. Suspended
  or interrupted audio gets a visible, keyboard-operable `RESUME AUDIO` gesture;
  a closed context asks for reload. Mazzy never claims or attempts a silent
  automatic restart without the browser gesture.
- **D-047 — Output-device change requires host confirmation without device
  enumeration:** when `navigator.mediaDevices` exposes the `devicechange`
  event, Mazzy arms a conservative listener only after audio has started. It
  does not call `enumerateDevices`,
  collect labels/IDs, or request microphone permission. A change pauses
  Autopilot through its normal authority-invalidating path and gates new
  playback, Auto Mix, and Autopilot until the host checks the speakers and uses
  the explicit recovery gesture; the current song may keep playing. Because the event covers the whole media-device
  set, microphone/camera changes can also trigger the pause; this is a bounded
  conservative interruption signal, not output-routing detection or proof that
  a physical speaker produced sound.
- **D-048 — Guard active tab-memory sessions from accidental navigation:**
  while Autopilot, an automatic transition, or transition rehearsal is active,
  Mazzy requests the browser's standard `beforeunload` confirmation. The guard
  is removed when those operations stop, and the browser may suppress its
  prompt. It cannot guarantee recovery after a
  crash, force-quit, browser eviction, or device loss and does not change the
  tab-memory-only session contract.
- **D-049 — Quarantine only proven-unplayable files for one party:** an exact,
  current Autopilot preload that fails browser file read or decode adds that
  track ID to a tab-memory session skip set. The shared v3 coordinator excludes
  it and immediately chooses the next queue-first candidate; the failed row
  remains visible with a plain-language reason. Cancellation, supersession,
  AudioContext recovery, and analysis failure do not quarantine a playable
  file. A later successful manual load or New Party clears the skip. Synthetic
  `party-autopilot-coordinator-soak/v4` can inject read/decode failures to prove
  failover and no-repeat behavior without claiming browser decode evidence.
- **D-050 — Version perceptual level measurement separately from party trim and
  output safety:** `program-level/v2` replaces the mono-left raw-RMS heuristic
  with a streaming mono/stereo BS.1770-derived measurement: per-channel
  sample-rate-adjusted K-weighting, 400 ms blocks with 75% overlap, a −70 LUFS
  absolute gate, and a −10 LU relative gate. Rhythm/key/features deliberately
  continue using channel 1 so this change cannot silently alter their evidence.
  `party-level-trim/v2` remains a distinct provisional policy: target −14 LUFS,
  range −6 to +3 dB, and boost bounded by a −2 dBFS decoded sample-peak ceiling.
  Old, malformed, silent, invalid, and unsupported-layout measurements apply
  0 dB; a new load resets prior trim immediately. The nested level schema is
  migrated lazily without relabelling or invalidating an otherwise current
  beat-grid/timing review. This is not an EBU compliance claim, a decoded dBTP
  measurement, a calibrated party target, or proof of post-EQ/overlap/master
  true-peak safety. Those remain separate acceptance milestones.
- **D-051 — Treat decoded intersample peak as a conservative estimate, not an
  output guarantee:** `program-level/v3` adds a four-times, per-channel decoded
  peak estimate using the order-48, four-phase FIR coefficient set published
  in ITU-R BS.1770-5 Annex 2. `party-level-trim/v3` uses the larger decoded
  estimate rather than sample peak when limiting boost to −2 dBTP. The original
  sample peak remains stored for audit, every persisted derived value is
  runtime-validated, and v2 records migrate through the existing bounded worker
  queue. A phase-offset quarter-rate regression proves that an intersample peak
  hidden by the stored samples tightens trim. The field is deliberately named
  `estimatedTruePeakDbtp`: current automated evidence is not a compliant meter
  test, and this per-file value cannot prove peaks after EQ, resampling,
  time-stretch, equal-power overlap, master limiting, conversion, or physical
  output. A post-master conformance/release gate remains a separate milestone.
- **D-052 — Add synthetic post-master peak evidence without promoting the
  master contract:** `transition-rehearsal-browser-check/v4` renders a
  deliberately hot, correlated stereo handoff with +3 dB trims through an
  `OfflineAudioContext` master graph configured by the same shared helper and
  immutable `mazzy-master/v1` settings as the live `AudioEngine`. The
  diagnostics-only `post-master-peak-check/v1` evaluates the post-limiter
  channels with the four-times decoded peak estimator introduced in D-051 and
  fails on silence,
  non-finite input, or an estimated peak above 0 dBTP. In a fresh 48 kHz browser
  run, all seven v4 checks passed; the stress path measured −2.5 dBFS sample
  peak and −2.5 dBTP estimated peak. The report retains only synthetic numeric
  evidence in the DOM and is excluded from normal builds. It checks a bounded
  offline browser graph/configuration, not real song content, live scheduling,
  main-thread load, output-device or speaker behavior, certified meter
  conformance, or a product true-peak ceiling. `mazzy-master/v1` therefore does
  not change, and a real post-master conformance/release gate remains open.
- **D-053 — Add aggregate short-term/LRA evidence without changing level
  policy:** `program-level/v4` extends the same per-channel K-weighted stream
  with complete 3-second windows every 100 ms. A Tech 3342-style range applies
  a −70 LUFS absolute gate, a −20 LU relative gate, then subtracts the 10th
  percentile from the 95th. The worker persists only fixed aggregate fields:
  complete-window count, gated count, minimum, maximum, range, and
  `stable|provisional|unavailable`; it does not retain a per-window party
  timeline. Values before 60 seconds are explicitly provisional as required by
  Tech 3341. The four formula-defined synthetic minimum-requirement cases land
  within their ±1 LU bands, and exact 2.999/3.000-second plus hostile-schema
  boundaries fail closed. `party-level-trim/v3` does not consume LRA, so this
  cannot silently alter playback or imply that high/low range is good or bad.
  It remains a local diagnostic descriptor, not certified EBU Mode, genre
  judgment, a calibrated party target, or output-safety evidence.
- **D-054 — Calibrate the party target only through private human listening:**
  the diagnostics-only `party-level-private-listening/v1` lab compares −16,
  −14, and −12 LUFS candidates without changing `party-level-trim/v3` or the
  production master. Two local mono/stereo songs are decoded and measured by
  the production analysis worker; the page then retains only anonymous
  eight-second stereo excerpts and normalized level records in tab memory.
  Playback applies the same bounded candidate trim and uses the protected
  `mazzy-master/v1` preview path. A rating is enabled only after both excerpts
  complete with bounded browser-audio health evidence and neither candidate is
  constrained away from the selected target by the −6/+3 dB trim or −2 dBTP
  decoded-peak policy. Cancel, interruption, unhealthy output, or a constrained
  pair cannot produce a rating. The DOM summary contains only aggregate counts
  by target and fixed judgment enum; it contains no audio, filenames, track or
  device identity, exact measurements, timestamps, persistence, upload, or
  export. A fresh Chromium run with generated stereo tones verified local
  preparation, two healthy protected playbacks, rating unlock, aggregate-only
  recording, and authoritative mid-play cancellation. That proves only the lab
  workflow. Selecting a production target still requires consented,
  counterbalanced real-music listening across the required genres and devices;
  this implementation does not manufacture that human evidence.
- **D-055 — Use formula-defined true-peak cases before restricted test audio:**
  the decoded four-times Annex 2 estimator now runs the exact sine frequency,
  amplitude, phase, and 10 ms taper definitions from EBU Tech 3341 cases 15–19
  at 48 kHz. All five land inside the document's asymmetric +0.2/−0.4 dBTP
  minimum-requirement tolerance, including the +3 dBTP overload case. The tests
  synthesize their samples at runtime and never download, commit, or render the
  EBU sequences, whose terms restrict use to internal R&D and prohibit
  redistribution. Cases 20–23 require the specified high-rate synthesis,
  anti-alias filtering, and four downsampling offsets, and remain open along
  with the full official set. This additional evidence does not rename the
  field, change the estimator schema, promote it to a compliant meter, or prove
  the live post-master/output path.
- **D-056 — Fail the current master before evaluating a bounded peak guard:**
  `post-master-peak-check/v2` lowers the diagnostics overload ceiling from 0 to
  −1 dBTP. `transition-rehearsal-browser-check/v6` keeps the existing hot
  transition check and adds a distinct-stereo mixed-frequency overload at
  44.1, 48, and 96 kHz. It renders the current master once and fans that exact
  PCM into direct, identity-4×, and guarded-4× branches, making the paired
  evidence materially different from the earlier v5 candidate-only result. In a
  fresh Chromium `OfflineAudioContext` run, the unchanged live
  `mazzy-master/v1` path reached +0.2 dBTP at 44.1/48 kHz and +0.1 dBTP at
  96 kHz, so it correctly fails the stronger gate. A separate
  `mazzy-master-peak-guard-candidate/v1` inserts a four-times-oversampled final
  safety curve that is identity below −3 dBFS and bounded above it; the same
  cells measured −2.7 dBFS sample peak and −2.5 dBTP estimated peak. All other
  v6 rehearsal checks passed. The report explicitly stores
  `liveMasterPromotionReady: false`, and normal builds do not import the
  candidate. A hard safety curve may introduce audible overload distortion, so
  real-music current/candidate listening, a new master/audio-engine contract,
  and a fresh device soak are mandatory before any live wiring. This is a
  viable diagnostics candidate, not output-device, speaker, certified-meter,
  or production peak-ceiling evidence.
- **D-057 — Keep peak-guard listening private, bounded, paired, and blind:** the
  diagnostics-only `master-peak-guard-private-listening/v2` lab does not create
  arbitrary adaptive overload. It constructs one fixed, bounded adversarial
  stress: two correlated copies at the equal-power midpoint, each using the
  existing +3 dB track-trim parameter limit (approximately 2× pre-master).
  Because the live peak-aware trim policy and no-repeat rule make that combined
  state unreachable, this is not production-fidelity transition evidence. A trial is
  eligible only when the current `mazzy-master/v1` branch exceeds −1 dBTP, the
  diagnostics candidate remains within the gate, its nonlinear delta is
  nonzero, and its peak reduction is at least 0.2 dB. The paired-render contract
  renders the current master once with identical padding, then fans that exact
  PCM into synchronized direct, identity-4×, and guarded-4× branches before
  cropping the same central program window. Runtime validation binds branch
  kind, variant, stage, master/candidate version, sample rate, frame count, and
  an ephemeral comparison ordinal. Distinct left/right stress signals make
  swaps and crosstalk observable. The identity path is checked by bounded RMS
  and estimated-peak deltas plus a delay-aligned stereo residual below −40 dB
  and aligned sample error no greater than 0.02; raw unaligned sample delta
  remains descriptive because oversampling latency by itself is not an
  audio-level failure.

  The private artifact audition uses attenuation only: the louder integrated-
  loudness arm is reduced to the quieter arm, one common safety attenuation is
  then applied, and both results are remeasured. A trial fails closed unless the
  residual difference is at most 0.1 LU and both estimated peaks are at or
  below −6 dBTP. Already-mastered buffers play at the live AudioContext sample
  rate through a diagnostics-only meter/health/output path that bypasses
  `masterGain` and the limiter, preventing double mastering and resampling. Each
  audition interval requires an acknowledged health reset, exact sample-rate
  support, full frame/report coverage, finite unclipped signal, no processor or
  context interruption, and expected-active false at settlement. Both arms
  must complete once under the same generation before one rating is accepted.

  Each eight-trial block starts with a cryptographically random arm order,
  alternates comparison order, and inserts a hidden identical-arm control every
  fourth trial. Arm mapping and variant-specific counts remain hidden until the
  block closes; a consumed trial cannot be replayed or rated again. Stop,
  visibility loss, context interruption, media-device change, pagehide, stale
  async completion, or unhealthy output invalidates rating authority. The page
  stops retaining the selected File, full decode, and unmatched renders after
  preparation and keeps only two short anonymous matched buffers plus aggregate
  fixed-enum counts in tab memory. It has no storage, cache, upload, network,
  export, clipboard, filename, measurement, order, timestamp, or device-ID
  report path. A fresh Chromium run with generated stereo PCM verified eligible
  preparation, both healthy neutral playbacks, hidden one-vote aggregation, and
  authoritative mid-play cancellation; it is workflow evidence, not a human
  real-music result. `candidatePromotionReady` remains false. Promotion still
  requires a predeclared multi-listener/genre/device protocol, remaining
  true-peak conformance, browser CPU/latency evidence, a new master/audio-engine
  contract covering every output path, a fresh two-hour device soak, and real
  party evidence.
- **D-058 — Bound every unattended preload with exact audio-clock ownership:**
  `party-autopilot-decision/v4` replaces the open-ended preload-busy boolean
  with an immutable operation/generation/deck/track/load lease whose deadline is
  at most 20 seconds of Web Audio clock time. The coordinator shortens the
  deadline to preserve five seconds of audible source runway and pauses before
  starting a load when even a half-second owned attempt cannot preserve that
  reserve. Before the deadline the coordinator waits;
  at or after it the coordinator returns the exact lease to expire. Production
  revalidates that full identity before invalidating the deck load, settling the
  trace, or changing eligibility, so a stale promise cannot clear, eject, or
  commit a successor. One expiry places only that song in a tab-memory
  “took too long” skip set and immediately replans queue-first while the source
  keeps playing. Two consecutive expiries pause Autopilot and its party clock,
  release the wake lock, preserve the current song, and require an explicit host
  restart. Any current non-timeout settlement breaks the consecutive run.
  Settlement rechecks the audio clock itself, so a completion at or after the
  deadline cannot beat the 500 ms watchdog poll. File reads are aborted and the
  operation-scoped analysis worker is terminated on invalidation. The Web Audio
  decode API has no cancellation primitive, so a browser-owned decode may finish
  in the background; its generation is invalid, and the two-attempt pause bounds
  concurrent abandoned work. Successful manual loading or **New Party** clears the timeout skip; a timeout
  is not classified as corrupt audio and is never persisted.

  `party-autopilot-trace/v4` records an allowlisted `timed-out` settlement and
  `preload-timeout` pause, rejects retrying the same session-local ordinal until
  a manual playability-restored event, and exposes only aggregate timeout count.
  `party-autopilot-coordinator-soak/v5` injects never-settling synthetic loads to
  prove one-song failover and the two-timeout safe pause. This is deterministic
  coordinator/ownership evidence, not browser decode, main-thread scheduling,
  audio continuity, or speaker-output evidence.
- **D-059 — Bound transition arming with exact load ownership and one retry:**
  `auto-pilot-arm-ownership/v1` gives every automatic arm an immutable operation,
  generation, transition key, source/target deck, track and load identity, plus a
  Web Audio clock deadline. The deadline is the earlier of eight seconds or the
  planned cue minus the template's minimum scheduling lead; a lease shorter than
  50 ms is rejected before async work starts. A silent Web Audio clock sentinel
  owns the deadline and a window timer is retained only as a backup wake-up;
  expiry, every async settlement, and every cancellation re-read the authoritative
  audio clock and exact load pair. Target start also rechecks that authority after
  its internal resume await and immediately before transport mutation. A late
  promise therefore cannot pause, schedule, restore DSP on, or clear a successor
  load.

  Failure cleanup keeps the owned source playing, restores the exact pre-arm deck
  gains and both owned filter/EQ snapshots, pauses only the owned target, clears arm
  ownership, and does not alter queue or played history. An Autopilot failure or
  timeout may retry once only with at least 4.25 seconds of source runway. A second
  consecutive failure, or the first without that runway, pauses Autopilot and its
  party clock and releases the wake lock; explicit restart, New Party, or a
  successfully scheduled transition resets the budget. Host/recovery cancellation
  and load replacement do not consume or reset it.

  `party-autopilot-trace/v8` records timeout and whether the owned settlement
  requires the immediately following `transition-arm` pause, rejects a missing or
  premature pause, and exposes only aggregate failure/timeout counts. It retains
  session-local ordinals and no metadata. `party-autopilot-coordinator-soak/v8`
  uses the same runway/deadline policy for fail-once/succeed, fail-twice/pause,
  timeout, and short-runway scenarios. These are deterministic state/ownership
  checks; they do not prove browser callback timing, audio continuity, or speaker
  output.
- **D-060 — Recover only a paused party plan, never live audio authority:**
  `party-session-checkpoint/v1` stores one strict, local IndexedDB recovery record
  only after the party has a stable source and no preload, arm, transition,
  rehearsal, library mutation, or audio/output recovery operation owns state. A
  coarse ten-second interval and settled semantic changes project the current
  session into a paused plan: unique played and remaining local track IDs, the
  last stable source ID, integer active seconds, planned duration, energy profile
  and bounded preference shift, and the explicit library-continuation choice. A
  committed idle-deck target is prepended exactly once if it has already left the
  visible queue. The record stores no File/Blob/audio, name/path/content identity,
  analysis, BPM/key/cue, exact position, wall-clock or Web Audio timestamp,
  device data, diagnostic trace, preload/arm/transition lease, wake-lock state,
  or Autopilot authority.

  IndexedDB v8 adds a `library-state/v1` epoch/revision and a versioned
  `partySessions` store. Checkpoint save, claim, clear, track deletion, and
  Remove All use atomic transactions and monotonic revisions; transaction-level
  compare-and-swap, rather than BroadcastChannel or Web Locks, owns correctness.
  Any track deletion conservatively invalidates the whole checkpoint, full clear
  increments the library epoch and writes an invalidation tombstone, and stale
  writers cannot recreate a consumed or cleared plan. Broadcast messages are
  versioned advisory notifications only. Database connections close on
  `versionchange`, and a blocked upgrade fails visibly instead of silently
  enabling mutation against a torn view.

  Hydration reads music, library state, and the checkpoint from one readonly
  transaction, then validates exact schema, counters, enums, array density,
  uniqueness/disjointness, library epoch/revision, and every referenced track.
  Invalid, stale, or missing-track records never partially restore. The ordinary
  Party Mode card offers **Restore paused plan**, **Delete saved plan**, and
  **Not now** without stealing initial focus. Restore first claims the exact
  record, always creates a paused clock with no prior AudioContext anchor, leaves
  decks and audio stopped, keeps Autopilot and wake lock off, starts no diagnostic,
  and requires a later host gesture to choose/play music. New Party, valid
  terminal completion, Remove All, and Discard clear the owned record; storage or
  cross-tab ownership failure is a persistent visible alert. This supersedes the
  tab-memory-only recovery limitation in D-048, but it is not gapless crash
  recovery: the last few seconds may repeat, browser storage may be evicted, and
  a crash before a stable write remains unrecoverable.
- **D-061 — Give the non-DJ host one synchronous Stop All Sound boundary:**
  `party-stop-all-sound/v1` is an always-reachable Party Mode safety action, not a
  transport reset or destructive library command. Its ordered best-effort
  coordinator first locks new starts, invalidates and settles the exact pending
  preload and transition-arm owners, cancels any active crossfade plus completion
  callback, restores deterministic source gain and owned low-EQ/filter state,
  cancels protected rehearsal and timing-click sources, then stops both deck
  transports, pauses the Party clock/diagnostic, and releases the wake lock. A
  failure in one independent cleanup stage cannot prevent either deck or the
  session from being stopped. Completion authority is revoked before any fallible
  Web Audio or DSP cleanup. `party-autopilot-trace/v8` records a stop-specific
  transition cancellation and pause while retaining the exact committed target,
  rather than misclassifying this safety action as Rescue. The visible result
  remains persistent and becomes an alert if any stage failed.

  Each Deck also owns a monotonic transport-start revision. Play and timing-click
  commands capture it before an asynchronous AudioContext resume and recheck it
  before scheduling; Stop All Sound, Pause, Eject, a replacement load, and unmount
  invalidate it. A late resume/load/click continuation therefore cannot restart
  sound after the safety action. Pending FileReader and isolated analysis work is
  aborted/disposed; browser-owned decode work may finish internally but cannot
  publish or start transport. The action preserves library records, queue order,
  played history, committed recovery intent, and ready deck buffers. Resuming any
  audible path requires a later explicit host gesture. The control is native,
  keyboard reachable from Party Mode and the focus-trapped timing dialog, at
  least 44 px high, has text rather than color-only meaning, and announces the
  durable outcome without adding persistence, networking, or media identifiers.
  Success is shown only after both Deck owners, the active crossfade, transition
  completion, preload, arm, and rehearsal owners are confirmed inactive. Any
  unverifiable audio-critical cleanup keeps the synchronous playback-start lock
  active and tells the host to retry and use system/device mute if sound remains.
- **D-062 — Lease post-schedule completion to two exact audio-clock owners:**
  `auto-pilot-transition-completion-ownership/v1` binds a scheduled crossfade to
  its arm operation and generation, exact engine schedule, source/target decks,
  track IDs, load keys, transition key, and a deadline exactly 500 ms after the
  scheduled end. A documented 20 ms callback-delivery tolerance absorbs audio
  quantum and browser event dispatch delay without moving that deadline. The primary oscillator completion, a separate silent
  audio-clock deadline, a window wake-up, and the Autopilot tick converge on one
  idempotent settlement function. Window time never establishes progress: every
  attempt re-reads the running Web Audio clock, active engine schedule, exact
  loaded pair, recovery lock, and active target.

  A valid primary completion promotes the target once. If that callback is
  missing, the watchdog may perform the identical promotion at the deadline. A
  signal observed more than 20 ms after that deadline—more than 520 ms after
  the scheduled end—may preserve the exact audible target,
  but it must immediately pause Autopilot, the Party clock, diagnostic, and wake
  lock with a persistent intervention. Schedule/load/target ownership loss never
  mutates a replacement deck; it revokes completion authority, locks new starts,
  and requires Rescue or Stop All Sound. Authority is revoked before fallible
  cleanup, and explicit engine finish/cancel cannot retain an old schedule.
  Rescue, Stop All Sound, audio/output recovery, cross-tab authority loss, and
  unmount cancel every primary/watchdog owner before deck mutation.

  `party-autopilot-trace/v8` records primary versus watchdog settlement, late
  completion and cleanup degradation independently (including when both occur),
  exact-target preservation on Stop, ownership failure, and the immediately following
  `transition-completion` safety pause without track metadata. The shared
  `party-autopilot-coordinator-soak/v8` creates and inspects the same lease for
  every scheduled handoff and injects missing-primary, exact-boundary, late, and
  replaced-target cases. These tests establish state and ownership liveness;
  they do not claim real-browser callback delivery, decoded-audio continuity,
  musical quality, or speaker output.
- **D-063 — Give every Autopilot tick an epoch-owned fatal boundary:**
  `party-autopilot-tick-boundary/v1` issues monotonic observation tickets inside
  a session epoch without serializing overlapping ticks. This preserves the
  independent 500 ms observer that can expire a stalled preload while another
  tick awaits browser work. Pause, restart, New Party, paused-plan restore,
  cross-tab authority loss, Stop All Sound, final completion, and unmount advance
  the epoch or make playback authority false, so late settlement cannot mutate a
  successor session.

  One unexpected current-epoch failure in decision, preload, transition arm, or
  transition-completion observation is claimed exactly once. The exact pending
  preload and arm are settled before `coordinator-failed`; then Autopilot, the
  Party clock, diagnostic, and wake lock pause with a persistent host-facing
  intervention while the current source is left alone. If a transition already
  owns audio, no deck is mutated and the existing completion uncertainty lock
  remains until verified Rescue or Stop. Stale resolve/reject callbacks and
  sibling failures cannot claim the fatal boundary.

  `party-autopilot-trace/v8` accepts only an operation ordinal, fixed phase, and
  mandatory immediate `coordinator-failure` pause; it adds no song metadata or
  error text. `party-autopilot-coordinator-soak/v8` includes one decision-phase
  failure/pause fixture. Pure ownership tests cover overlapping/stale tickets,
  while trace tests cover preload/arm settlement and paused Rescue/Stop ownership
  for an active transition. These establish state semantics; browser adapter
  exceptions and audible continuity remain separate live acceptance work.
- **D-064 — Lease native deck EOF to an exact audio-clock owner:**
  `deck-playback-completion-ownership/v1` binds each production native
  `AudioBufferSourceNode` to its deck, monotonic playback operation, runtime load,
  transport/source and rate-plan revisions, optional local track ID, source
  offset, duration, intended boundary, integrated expected Web Audio time, and a
  50 ms watchdog boundary. The source `onended` callback, an independent silent
  audio-clock sentinel, a bounded window wake, explicit deck reconciliation, and
  the Autopilot observer converge on one idempotent settlement. Wall time only
  wakes the inspector; a suspended/interrupted context cannot declare progress.

  Constant playback derives EOF from remaining media divided by the exact rate.
  Linear rate ramps integrate media consumption and solve the positive quadratic
  when EOF falls inside a ramp; completion is re-leased on every ramp, seek/rate
  restart, or source replacement. A ramp that would overlap a still-pending
  finite ramp is rejected because `cancelScheduledValues` cannot preserve the
  prior rendered slope exactly. Pause, eject, load, Stop All Sound, and source
  replacement revoke the old lease and both signals before calling stop or
  disconnect. `stopAt` is a separate `scheduled-stop` intent that settles to
  paused without emitting natural completion. An exact source callback arriving
  more than one render quantum before its integrated boundary becomes a
  recoverable premature-completion safety failure; it is never held and later
  relabelled as natural EOF.

  DeckEngine emits one typed completion event directly from the exact arbiter,
  rather than exposing a React status-edge inference that could replay after a
  remount. App rechecks the current Party deck/load before recording it. Verified
  final completion revokes Autopilot authority, pauses the Party clock, ends the
  trace, releases the wake lock, and terminally clears the paused checkpoint;
  premature completion pauses unattended authority and requires the existing
  host recovery action. The Autopilot tick explicitly reconciles both decks at
  its already-read Web Audio time and rechecks its epoch ticket before planning.

  `party-autopilot-trace/v10` allowlists only session-local deck/track/load
  ordinals, `source-onended | audio-clock | reconcile`, and bounded on-time,
  recovered, late, or premature outcomes. It
  rejects duplicate completion, requires premature failure to be followed by the
  exact safety pause, and requires a declared-final deck end to be followed
  immediately by terminal session cleanup. `party-autopilot-coordinator-soak/v10`
  creates and inspects the same final-deck lease for primary and missing-primary
  recovery fixtures. These tests establish deterministic ownership and state
  liveness only; they do not claim browser callback delivery, decoded-audio
  continuity, musical quality, or speaker output.

- **D-065 — Settle an exact preload synchronously before every Party pause:**
  `auto-pilot-preload-pause/v1` observes the current preload lease, exact pending
  load ordinal, published deck/load identity, and target activity. Host pause,
  recovery pause, Stop All Sound, remote authority loss, and the disabled-state
  fallback first claim and null the exact lease, increment its generation, clear
  only the matching pending owner, and record `preload-settled: superseded`
  before `session-paused`. Cleanup may abort/eject only the exact pending or
  published target, including an exact target that unexpectedly began playing;
  a different load ordinal or host replacement is never touched. A late load continuation cannot publish its
  result, silently clear a successor, or escape as an uncommitted target.

  The App lease also derives one opaque, session-only deck load-authority key.
  Deck owns that key from load start through publication and exposes only an
  exact `cancelLoadIfOwned` operation. This closes the preparation interval in
  which App's last-published load ordinal can still name the predecessor: pause
  revokes FileReader/decode/load-generation authority directly, while a newer
  manual/successor key fails the match and is preserved.

  `party-autopilot-trace/v10` and evaluation v10 reject any pause or resume while
  a preload remains open. `party-autopilot-coordinator-soak/v10` includes a
  deferred-preload fixture that pauses before settlement, records one exact
  supersession, resumes with a fresh operation, preserves queue order, and
  delivers the old settlement after that successor owns the deck to prove it
  cannot publish, mutate the queue, or clear the fresh operation. Adapter
  observation, cancellation, and eject failures keep the synchronous playback
  lock and interrupt private evidence until verified Stop All Sound cleanup.
  This is deterministic in-memory ownership
  evidence only: it adds no persisted schema, filename, track metadata, audio,
  wall-clock value, network path, or browser-cancellation claim.

- **D-066 — Bind native deck completion to exact Party-session ownership:**
  `party-deck-completion-ingestion/v1` accepts a Deck completion only when the
  callback deck/channel, current native operation and load revision, natural
  intent, settled Deck status, current track, and Party load identity all
  agree. A duplicate or stale same-track callback from a prior replay/reload is
  inert. Exact final ownership remains the only automatic terminal path.

  An exact non-final master ending is now a synchronous Party pause boundary,
  not a fact left for the next 500 ms coordinator poll. The handler first
  revokes the coordinator and Autopilot authority, settles any exact preload,
  cancels exact arm ownership, then pauses the Party clock/diagnostic, releases
  the wake request, and focuses a persistent recovery card that truthfully says
  no new song was started. A completion from either deck while a transition is
  active revokes completion callbacks and enters the existing Rescue/Stop
  recovery lock; it is never recorded as an ordinary current-song ending.

  `party-autopilot-trace/v11` adds only a positive recorder-local ordinal for
  each exact native owner to deck completion events; raw DeckEngine counters
  never enter the trace. It rejects duplicate
  native owners and requires each non-final natural ending to be followed
  immediately by `session-paused: source-stopped`. The v11 coordinator soak
  injects an exact non-final source completion through the shared ingestion
  helper and proves the paused trace remains valid. This is deterministic
  ownership/state evidence only. It adds no persisted schema, filename, track
  metadata, raw audio time, error text, network path, or promise of gapless
  automatic fallback playback.

- **D-067 — Start only an exact committed target after verified non-final EOF:**
  `party-committed-target-continuation/v1` is a second, deliberately narrow
  decision boundary after D-066 accepts an exact current-master completion. It
  permits one fallback start only when the opposite deck is the exact committed
  preload: current Deck snapshot, Party track/load ordinal, and committed marker
  all agree; the deck is ready and idle; the AudioContext is already running;
  and no preload, arm, transition, rehearsal, recovery, Stop, library mutation,
  checkpoint mutation, or writer-loss owner is open. Every other case takes the
  existing immediate `source-stopped` pause.

  The fallback path advances the coordinator epoch, installs an in-memory exact
  operation owner, mutes the target, and uses a synchronous running-context-only
  Deck start from offset zero at 1×. The target gain ramp checks the same owner
  immediately before AudioParam mutation. Only an exact active postcondition
  consumes the committed marker, promotes the target, and marks its exact load
  played. Start or gain failure revokes authority first, pauses only the same
  exact target load, and returns to D-066's focused paused recovery; uncertain
  cleanup retains the Stop All playback lock. No song is selected, decoded,
  analysed, resumed, or cue-inferred here, and no persisted checkpoint may
  restore this start owner.

  `party-autopilot-trace/v12` adds ordinal-only `fallback-started` and
  `fallback-settled` events. An unexpected exact deck end must be followed
  immediately by either the source-stopped pause or that exact fallback start;
  a failed fallback must then pause, while a scheduled fallback consumes the
  committed target once. Coordinator soak v12 runs both branches through the
  shared decisions and continues to final ownership after a successful fixture.
  This is deterministic state/ownership evidence, not browser callback,
  speaker-output, or gapless-continuity evidence. Product copy explicitly
  allows a short gap. No track ID/name, filename, raw native counter, audio-clock
  time, error text, audio, device value, persistence field, export, or network
  path was added.

- **D-068 — Compose native EOF through the production fallback audio transaction in a browser:**
  `party-committed-target-audio-transaction/v1` now owns the mutation sequence
  shared by App and the diagnostics runner: observe the exact ready/idle 1×
  target and its current deck gain, mute it, schedule a zero-offset native start
  with a render guard, install the owned 80 ms target ramp, verify the exact
  active postcondition, and revoke the operation. Every early rejection revokes
  the operation even before audio mutation. A post-mutation failure revokes
  first, then pauses and restores gain only while the same exact target remains;
  inability to prove inactivity, 1× rate, and restored gain keeps D-067's Stop
  recovery lock.

  The diagnostics-only `/party-continuation-diagnostic.html` runner composes a
  real DeckEngine native natural completion, D-066 Party ingestion, D-067 exact
  committed-target choice, that production audio transaction, a second native
  completion owner, and the post-master AudioWorklet health observer. Its strict
  `party-continuation-browser-report/v1` contains only fixed enums, safe counts,
  bounded relative timing/level metrics, and failure codes—never track IDs,
  filenames, audio, raw clock timestamps, error text, persistence, export, or a
  network path. A fresh 48 kHz Chromium run passed with one on-time source
  callback, one zero-offset target start, the 80 ms ramp, a 35 ms scheduled
  EOF-to-start gap,
  exact source inactivity/target activity, an installed target native-completion
  owner, the completed target gain, and 48,000 healthy monitored frames with an
  86 ms longest unexpected-silence interval and zero non-finite/clipped samples
  or processor errors.

  This is deliberately a composed synthetic state/audio-ownership gate, not a
  third Party simulator and not a claim that the React App, file decoding,
  analysis, background throttling, output hardware, or a sustained real party
  has passed. The page is absent from normal artifacts and its Stop/pagehide
  paths revoke both Deck sources and the AudioContext.

- **D-069 — Make Autopilot transport readiness decode-first and analysis-deferred:**
  `deck-load-readiness/v1` separates manual loads from exact Autopilot preloads.
  Manual loads retain the existing inline analysis contract. An Autopilot-owned
  load, however, publishes immediately after successful read/decode using one
  immutable per-load fact set: current stored basic analysis when valid,
  otherwise no trusted grid and Safe Fade only; independently, current valid
  program-level trim when available, otherwise an explicit 0 dB neutral trim
  without suppressing valid cached timing. Trim and planning
  facts are installed before `DeckEngine.loadBuffer`, so readiness never precedes
  the load's stable DSP decision.

  The Autopilot path creates no Deck-owned analysis worker and starts no enhanced
  analysis continuation. Missing or failed analysis cannot become an
  `unplayable-file` outcome, quarantine a decodable song, or consume the bounded
  preload lease. The existing local single-flight queue remains the only owner
  of missing enrichment and may update only the current library row with the
  same track ID, normalized content identity (or identical File object for a
  legacy identity-less row), analysis generation, and deletion state. Those
  results apply on a future reload; they cannot mutate a loaded
  Deck's trim, BPM, cue, transition eligibility, or committed plan.

  Load generation, exact track identity, the opaque D-065 authority key,
  playback-recovery lock, and running AudioContext are rechecked before cached
  facts, trim, buffer publication, and the loaded settlement. The final trim
  proof uses DeckEngine's accepted dB command and allows only 0.0001 dB of
  representation tolerance, far below the 0.1 dB policy step. Stop, Pause,
  source replacement, expiry, recovery, deletion, clear, and unmount therefore
  leave late decode settlement inert. The readiness object is runtime-only; no
  IndexedDB, analysis, trace, transition, checkpoint, export, or network schema
  changed. Focused tests include a never-settling unrelated analysis promise,
  cached and neutral decision matrices, authority loss before publication, and
  stale/removed/content-replaced background settlements. Browser decoding and
  sustained device behavior remain separate gates.

- **D-070 — Make the mandatory Party first-song action decode-first and cancellable:**
  `party-first-song-load/v1` gives Party Mode's **Choose First** path an exact,
  runtime-only operation, Deck, track, and opaque load-authority key. This path
  now shares `deck-load-readiness/v1`'s immutable post-decode facts with
  Autopilot: valid current timing may be reused, missing timing forces Safe
  Fade, valid current program level may be reused, and missing level freezes an
  explicit 0 dB trim. Trim and timing policy are installed before buffer
  publication. The path constructs no inline analysis client, while Advanced
  Mixer and direct manual Deck loads retain the previous inline-analysis
  contract.

  App accepts readiness only after re-reading the exact owner, current Deck
  track, idle/ready/1x transport, load-readiness key, and accepted-command trim
  proof, running AudioContext, current library File, deletion state, and recovery
  locks. Audio never starts automatically. Party Mode exposes a polite,
  atomic **Opening first song locally** state, an always-reachable 44 px
  **Cancel Opening** action, a truthful slow-opening notice after twelve seconds,
  and a focused persistent read/decode or cleanup error. Success says that the
  first song is ready and still requires **Play First Song**.

  Cancel claims App ownership first, then uses the exact Deck authority to
  abort FileReader, revoke the Deck generation, release isolated work, and
  eject only that same idle load. Stop All Sound, output/audio recovery,
  same-track deletion, library clear, remote destructive reconciliation, New
  Party, and unmount use the same boundary or the Deck's audio-only teardown.
  Unverifiable cleanup retains the existing playback lock and Stop All guidance;
  a late decode or replaced load is inert. A wall timer changes only the visible
  slow-opening copy and never decides transport authority. The owner/key is not
  persisted, traced, exported, uploaded, or restored from a checkpoint. Tests
  cover exact/stale settlement, all readiness postconditions, load invalidation
  before revocation, post-start authority checks, deferred interaction loss, the
  never-resolving inline-analysis factory trap, and manual-branch invariance.
  Browser codec breadth, large-file timing, background-analysis liveness, and
  physical-device behavior remain separate gates.

- **D-071 — Bound background-analysis liveness without changing playback authority:**
  `background-analysis-runtime/v1` splits missing basic/program facts from
  optional enhanced timing and assigns each in-memory job an exact generation,
  operation, track, content/File binding, stage, and deadline. All basic/program
  jobs run before queued enhanced jobs while preserving loaded, Party-queue,
  and library order inside each lane. Timeouts are session-only deferrals: they
  never persist `analysisStatus: failed`, quarantine a file, mutate a loaded
  Deck, or remove Safe Fade/neutral-loudness playback.

  File reads are abortable. A timed-out basic worker is terminated through a
  background-only `AnalysisClient`; it cannot interrupt Advanced Deck inline
  analysis. Background enhanced requests keep exact session cancellation, while
  a module-global inference arbiter serializes them with manual Deck inference
  and model preparation. The background owner releases an idle manual client
  before loading the same model and disposes its own client after settlement, so
  Mazzy does not retain two enhanced model workers. Session reset rejects every
  old background owner without rejecting a queued manual owner; dedupe cleanup
  is token-bound, so a late old same-key `finally` cannot delete a successor.
  Browser decode and enhanced offline
  rendering are not falsely described as cancelable: when either exceeds its
  hard liveness boundary or is abandoned during destructive cancellation, the
  corresponding background lane opens a tab-session circuit rather than
  starting overlapping background zombie work. Reload is required to retry
  that lane. An enhanced inference timeout also pauses further background
  enhanced work for the tab: this bounds decoded PCM retained behind an
  unresponsive manual/model owner while the global arbiter preserves one heavy
  inference at a time. Explicit manual Deck analysis remains host-owned but
  shares that inference arbiter.

  Removal, library clear, model removal, remote destructive reconciliation,
  and unmount revoke the exact active owner before abort/reset. Every result
  still revalidates generation, deletion, current track ID, normalized content
  identity, and—only for identity-less legacy rows—the identical File object
  before changing library state. The UI announces one polite, fixed-text
  session deferral while keeping playback available; a single explicit retry is
  offered only for safely resettable stages and only while Party/preview/load
  authority is idle. Runtime leases, stages, deadlines, errors, PCM, and File
  references are not persisted, traced, exported, uploaded, or restored.

  The exported deadlines are conservative liveness ceilings, not performance
  or device claims. Deterministic tests cover stage priority, exact lease loss,
  timeout/late-settlement idempotence, FileReader abort, fresh enhanced work
  after a hung epoch reset, and same-key successor safety. Real browser decode,
  long-file/model performance, analysis accuracy, and sustained physical-device
  behavior remain separate release gates.

- **D-072 — Bound checkpoint writes and terminal cleanup behind exact storage ownership:**
  `party-checkpoint-write-runtime/v1` replaces the unbounded promise chain with
  one active write and at most one latest pending stable plan. Each write owns
  an immutable epoch, operation, fingerprint, AbortSignal, monotonic start, and
  30-second deadline. Repeated periodic/state triggers coalesce to the newest
  fingerprint; returning to the active fingerprint removes a now-obsolete
  pending draft. An on-time save advances checkpoint/library revisions and the
  saved fingerprint once, then starts only that newest pending plan with the
  updated CAS expectation.

  The AbortSignal covers a queued Web Lock and the exact live IndexedDB
  transaction. At or after the deadline, the runtime revokes authority before
  abort, drops pending work, opens a tab-session recovery circuit, and ignores
  every late resolve, rejection, or stale result. Music may continue, but a
  persistent focused alert says recovery updates stopped and requires reload
  before a new party can rely on recovery. An ordinary on-time
  `stale-checkpoint` still executes the existing cross-tab writer-loss pause.

  Clear/terminal operations synchronously claim one exact
  `party-checkpoint-clear-owner/v1`, close all new-party admission, and wait only
  for the active bounded writer. Duplicate clear callers are refused. The exact
  IndexedDB/Web Lock clear then owns an AbortSignal and its own 30-second
  monotonic deadline. It proceeds after an on-time writer settlement with the
  current revision, or opens the visible reload-required circuit; final
  audio/session state does not wait on that asynchronous cleanup. Only an
  on-time exact clear restores admission. New Party, destructive library
  revision, ownership loss, and unmount revoke old epochs and clear tickets, so
  late operations cannot mutate React recovery state. The stored checkpoint,
  library, Party trace, and report schemas do not change. Deterministic tests
  cover one thousand coalesced triggers, exact deadline/late settlement,
  newest-pending revision use, on-time ownership loss, duplicate clear refusal,
  exact clear timeout/cancellation, abortable same-tab queue wait, and old-epoch
  revocation. Real crash durability, browser suspension, storage
  eviction, and physical-device behavior remain separate gates.

- **D-073 — Bound startup library/recovery hydration before unlocking the host UI:**
  `library-hydration-runtime/v1` gives the one startup recovery-bundle read an
  immutable epoch, operation, monotonic start/deadline, and AbortSignal. Only
  its exact on-time settlement may atomically publish restored tracks, library
  revision, checkpoint revision/recovery state, and then release the initial
  library/playback lock. A stale retry, unmount settlement, late error, or late
  success is inert.

  The 30-second boundary covers waiting for the cached IndexedDB open and the
  exact readonly track/meta/checkpoint transaction. Once that transaction
  exists, abort cancels it and removes its listener. Browser database-open
  requests are not themselves cancellable, so a timeout revokes application
  authority, retains the fail-closed library lock, and shows a focused
  **Reload Local Music** action instead of starting another open in the same
  document. An ordinary on-time rejection retains the existing bounded-owner
  **Retry Opening Local Music** flow. The visible polite opening status and the
  same synchronous lock cover Party actions plus direct Deck load/start/timing
  controls, while Pause and **Stop All Sound** remain available. Both retryable
  and reload-required failures focus their persistent alert. No File, Blob,
  filename, raw error,
  checkpoint payload, or operation timing is added to persistence, trace,
  report, export, or network paths; no stored schema changes.

  Deterministic tests cover exact on-time commit, exact-deadline abort, late
  success after timeout, ordinary retryable failure, unmount/retry revocation,
  malformed owner/clock rejection, and pre-aborted storage access. Existing
  recovery-bundle tests still prove valid library/checkpoint hydration. This is
  a startup-liveness and ownership gate, not browser durability evidence. The
  later paused-plan claim remains an explicit follow-up storage-liveness slice.

- **D-074 — Bound and coalesce routine analysis-row persistence without
  blocking party recovery:** `library-routine-write-runtime/v1` owns one active
  batch and one merged latest pending batch under immutable epoch/operation and
  monotonic 15-second deadline authority. Repeated full analysis snapshots
  replace the pending snapshot instead of retaining unbounded File/library
  copies. Manual timing patches merge per exact track/content owner and are
  applied after snapshot merging, so routine analysis cannot overwrite a newer
  host correction.

  The production adapter uses the shared cross-tab Web Lock and same-tab
  serializer with one AbortSignal covering queued admission, an
  authority-bounded wait for the shared database open, and the exact live
  readwrite transaction. The platform open request itself is not cancellable
  and remains available to unrelated recovery owners. Exact-deadline or delayed-timer
  settlement revokes authority first, aborts storage, drops pending work, and
  opens an analysis-persistence-only circuit. Late success/error is inert.
  Music, neutral trim, Safe Fade, and already imported rows remain available;
  a focused fixed-text **Reload Mazzy** alert explains that future analysis may
  not be saved. Ordinary on-time storage rejection retains a bounded retry on
  the next exact candidate rather than creating a hot loop.

  Import, single-track removal, and Remove All synchronously acquire one
  exclusive runtime handoff before membership mutation; duplicate exclusive
  owners are refused, and completion restores the prior running or circuit
  mode. Every generated-analysis publication first advances a synchronous dirty
  generation, independent of React-effect timing and the pending queue. An
  exclusive or remote membership boundary compares that generation with the
  last confirmed save and rebases the newest exact surviving snapshot before a
  clean committed snapshot may be skipped. Hydration and clean, successfully
  committed membership snapshots are therefore not rewritten without losing a
  locally published update. The database adapter updates only an existing exact
  content identity and reports mismatches instead of resurrecting or overwriting
  a replacement.
  Stored track/checkpoint schemas, trace, export, and network behavior do not
  change; owner/timer/batch/error details remain tab-memory-only.

  Deterministic evidence covers 1,000 triggers coalescing to one active/one
  pending batch, manual-patch merge priority, exact-deadline and throttled-timer
  timeout, abort plus late-settlement inertness, exclusive membership admission,
  preservation of an open analysis circuit, ordinary failure recovery,
  hydration no-op, synchronous dirty-generation replay across membership,
  exact IndexedDB snapshot/patch behavior, replacement-content rejection, and
  pre-aborted storage access. Real IndexedDB suspension, quota
  eviction, and crash durability remain browser/device gates. The paused-plan
  restore claim is bounded separately in D-075.

- **D-075 — Bound the exact paused-plan restore claim before applying any
  session state:** `party-checkpoint-claim-owner/v2` binds one runtime-only
  operation to the saved session/revision, previous and next writer tokens, and
  current library epoch/revision. Restore claims this authority synchronously,
  exposes the existing global storage-busy lock/status, and runs the production
  claim through the shared 30-second monotonic checkpoint-operation boundary.
  Duplicate Restore, Delete, New Party, first-song, Deck-start, and Autopilot
  entry remain refused while the owner is live; Stop All Sound remains reachable.

  `claimPartySessionCheckpoint` now accepts one AbortSignal across the Web Lock,
  abortable same-tab serializer wait, authority-bounded database open, and exact
  readwrite transaction. The App rechecks the exact owner, unchanged recovery
  object, library generation, stopped Decks, and absence of transition/preload
  authority after settlement and before applying anything. Exact on-time claim
  alone rebuilds the paused queue, elapsed-active clock, and settings. Timeout,
  failure, stale result, remote mutation, or unmount revokes the owner, leaves
  the plan unapplied, opens the checkpoint circuit, and focuses fixed reload
  guidance; late settlement is inert. A successful restore still never resumes
  AudioContext, starts a Deck, acquires wake lock, or starts diagnostics.

  The owner, AbortSignal, deadline, and errors remain tab-memory-only. No
  checkpoint, library, trace, export, network, or database schema changes.
  Deterministic evidence covers exact identity matching, already-aborted claim,
  exact deadline/cancel/late settlement through the shared bounded primitive,
  and the existing cross-tab one-winner claim transaction. Real IndexedDB/Web
  Lock suspension remains a browser gate.

- **D-076 — Bound and serialize cross-tab/focus library reconciliation before
  it may change live authority:** `library-reconciliation-runtime/v1` owns one
  exact read plus one replaceable latest trigger under immutable
  epoch/operation and a monotonic 30-second deadline. Validated BroadcastChannel
  mutations, focus, pageshow, and visible visibility changes therefore cannot
  create an unbounded fan-out of IndexedDB bundle reads. A newer trigger
  coalesces behind the current owner without resetting its deadline and starts
  one latest read after settlement; a local Import/Remove/Remove-All boundary
  revokes the read, preserves one newest trigger, and drains it only after the
  exact local mutation unlocks.

  The production read reuses `loadLibraryRecoveryBundle({ signal })`, covering
  the authority-bounded database-open wait and exact readonly transaction.
  Settlement must be strictly before the deadline and must cover the trigger's
  library epoch/revision and checkpoint revision without regressing current
  tab state. Exact current settlement alone may reconcile library membership,
  loaded-deck cleanup, and paused-plan presentation. Timeout, rejection,
  non-covering counters, circuit state, or unmount revokes authority; late
  success/error is inert.

  Every admitted reconciliation synchronously gates new automatic loads and
  transitions while the healthy current session and stable song may continue.
  A validated newer remote checkpoint mutation synchronously pauses Autopilot
  planning before the read, even when a clear retains the same stored
  session/writer identity. Failure or timeout also pauses the session.
  During reconciliation, the existing synchronous
  library/playback gate prevents Import, Deck starts, first-song, Restore,
  New Party, and Autopilot entry. A visible polite status says saved local
  changes are being checked and keeps **Stop All Sound** reachable. Any
  uncertain terminal settlement opens the actual checkpoint recovery circuit,
  retains the interaction lock, and focuses fixed **Reload Recovery State**
  guidance; it never silently retries in the same document.
  Final-track completion marks checkpoint authority terminal synchronously. A
  healthy in-flight reconciliation owns one deferred clear bound to the final
  session/writer and the exact reconciled revision. A foreign owner is never
  cleared; a reconciliation circuit retains fixed Reload guidance and admits
  no later checkpoint write.
  Checkpoint claim and clear owners are symmetrically exclusive with bundle
  reads: a focus or tab trigger arriving during either operation remains one
  pending reconciliation and resumes only after the exact owner releases busy
  authority.

  Runtime triggers, owners, deadlines, and errors remain tab-memory-only. No
  library, checkpoint, trace, report, export, network, or database schema
  changes. Deterministic evidence covers a 1,000-trigger burst with at most one
  active and one latest read, superseded-result inertness, exact and
  throttled-timer deadlines, failure circuit admission, local-mutation
  pause/drain, unmount abort, and same-owner/old versus newer-foreign checkpoint
  quiescence. Browser IndexedDB suspension and cross-process crash durability
  remain external gates.

- **D-077 — Bound exact local-library membership changes and keep import
  preparation outside the playback gate:**
  `library-membership-mutation-runtime/v1` gives Import, single-track Remove,
  and Remove All one immutable tab-memory owner with mutation kind,
  epoch/operation, expected library epoch/revision, stage ordinal, and monotonic
  deadline. A second membership action is refused while that owner is live.
  Selected audio is read and SHA-256 identified sequentially under bounded
  read/digest stages, and the coarse storage estimate has its own 10-second
  liveness boundary. The native file input is cleared immediately. Import
  preparation announces count-only progress and offers a keyboard-operable
  Cancel action, but does not acquire the broad playback/library gate; healthy
  current audio and Autopilot may continue. Uncancelled browser digest work may
  finish internally, but a revoked result has no Deck, library, or storage
  authority. A short-lived exact native-picker owner defers the picker-return
  focus reconciliation until `change` or `cancel` admission, so native event
  ordering cannot discard the selected folder and the cross-tab check is not
  lost. Preparation may overlap that bounded read, but precommit awaits its
  exact terminal settlement and then revalidates library authority.

  Immediately before mutation, App revalidates the exact owner and captured
  library state, claims the routine-write exclusive and shared playback gate,
  then starts one 30-second commit boundary. `saveImportedTracksToDb`,
  `deleteTrackFromDb`, and `clearTracksFromDb` carry the same AbortSignal through
  the profile Web Lock, abortable same-tab serializer, authority-bounded database
  open, and exact live IndexedDB transaction. Delete and clear perform the
  expected epoch/revision comparison inside that transaction before any write.
  Every pre-completion adapter exception aborts the exact transaction and is
  classified as definitely nonmutating only after the transaction abort is
  observed; DOMException names are not rollback evidence.
  Exact on-time `saved | deleted | cleared` settlement alone updates React,
  queue, Deck, and checkpoint state. A stale CAS is nonmutating and asks for a
  fresh host review. The old parallel compensating-delete guess after a stale
  import owner is removed. A final-session checkpoint clear cannot overlap a
  membership owner: it becomes one exact pending clear bound to session/writer
  and drains only from the canonical post-mutation checkpoint revision.

  A preparation cancel, failure, or timeout is definite and says nothing was
  saved. Once commit begins, timeout or an unclassified rejection is treated as
  outcome-uncertain: authority is revoked before abort, automatic planning is
  paused, the stable current song and **Stop All Sound** remain available, and a
  focused persistent **Reload Local Music** action owns recovery. Late success
  or rejection is inert and cannot publish, compensate, or unlock the circuit.
  Unmount, pagehide, New Party during preparation, and verified remote clear
  revoke the exact owner. After committed deletion, exact Deck ejection remains
  part of the owned cleanup. Unverified ejection retains a deck/track-bound
  recovery owner; Stop All Sound must retry and prove that exact buffer absent
  before releasing the playback lock, without ejecting a successor.

  No IndexedDB, track-analysis, checkpoint, trace, report, export, or network
  schema changes. Content identities remain only in existing local track rows;
  runtime owners, counts, deadlines, File/byte references, and raw errors remain
  tab-memory-only and are never placed in UI or diagnostics. Deterministic unit
  evidence covers exact and delayed-timer deadlines, phase-aware cancellation,
  reconciliation-circuit admission, post-exclusive owner/state checks, private
  rollback classification, active FileReader abort, queued Web-Lock abort,
  already-aborted adapters, stale delete/clear CAS, late settlement inertness,
  and standard storage atomicity. The production build proves only that the
  wiring bundles successfully; full React focus/page-lifecycle behavior and
  real browser process death during an IndexedDB commit remain external
  acceptance gates.

- **D-078 — Keep an independent Stop/Reload recovery surface after a React host
  failure:** `fatal-host-audio-safety/v1` wraps the full StrictMode App in a
  root Error Boundary. A descendant render or lifecycle failure first revokes
  creation/access authority for the shared audio-engine singleton, then acts
  only on the already-existing engine. `fatal-host-audio-shutdown/v1` latches a
  permanent start lock, mutes the protected master before fallible transport
  work, zeros both Deck gain owners, stops registered preview/audition sources,
  revokes crossfade completion callbacks, and independently shuts down Deck A
  and Deck B. A registered wake-lock release is requested without depending on
  the failed App subtree, and a rejected release retains its exact owner for a
  later Stop retry. Late App, transport, or
  completion callbacks cannot unmute or begin new playback through that engine.

  The boundary replaces the failed tree with one persistent, focusable
  assertive alert. It reports **Sound is stopped** only when the master mute,
  both inactive Decks, and cleared transition completion ownership are all
  observable. Any throw or missing proof produces fixed device/speaker-mute
  guidance. **Stop All Sound Again** is idempotent and ordered before the
  explicit **Reload Mazzy** action; neither action auto-plays, mutates library
  membership, writes a checkpoint, or deletes analysis. A hostile Error object
  is deliberately absent from boundary state and UI: error text, stack, local
  filenames/paths, track IDs, clocks, audio, and raw teardown detail are not
  persisted, exported, logged by Mazzy, or sent over a network.

  Deterministic evidence covers revoke-before-shutdown ordering, exact confirmed
  versus uncertain projection, independent retry after a thrown adapter,
  protected-master failure, active/scheduled Deck and crossfade teardown,
  permanent post-fatal start refusal, wake-lock release, and hostile-error
  privacy projection. A manual local Chromium fault smoke performed for this
  decision verified the focused fallback, action order, 44-pixel controls,
  fixed copy, idempotent retry, and absence of the hostile sentinel from the
  DOM; it is not an automated browser release gate. This boundary intentionally
  covers React descendant render/lifecycle faults only; arbitrary async event
  errors, browser/OS process death, physical speaker state, real-music App
  acceptance, and a machine-run fault-browser report remain separate gates.
  The generated-WAV full-App multi-handoff gate is D-079 below.

- **D-079 — Run the production React App through a generated-audio Chromium
  Party journey, and settle an exact transition source EOF through its existing
  completion owner:** `party-app-browser-runner/v1` launches an installed local
  Chrome/Chromium against the diagnostics build with no autoplay bypass, a
  fresh temporary profile, and three generated 48 kHz stereo WAVs. It uses the
  real hidden folder input, the production membership transaction, a hard
  reload and IndexedDB Blob hydration, Choose First, Play First Song, the
  readiness dialog, the production 500 ms coordinator, two Safe Fades, native
  final EOF, and terminal checkpoint cleanup. It runs twice with independent
  profiles and requires matching categorical ownership/count results. The
  runner uses Node built-ins only, blocks/counts non-loopback page and worker
  requests with persistent observers through report commit, closes observer
  admission and boundedly drains in-flight worker setup/request acknowledgements
  before pass, treats observer or bounded event-backlog failure as fatal, and
  deletes every temporary profile and WAV in `finally`.

  The first live run found a production browser ordering race that isolated
  state and audio harnesses had not composed: Safe Fade ends the source at the
  same audio-clock boundary as the crossfade, and Chromium may deliver the
  source Deck's native `onended` before the crossfade completion oscillator.
  `party-deck-completion-ingestion/v1` now returns
  `settle-transition-source` only for the exact successful source owned by the
  active transition. App invokes the existing exact transition-completion
  runtime; that runtime rechecks schedule, source/target load keys, target
  playback, context, lock state, and deadline before committing. Premature
  source completion, target completion, missing runtime ownership, or cleanup
  uncertainty retains the prior fail-closed Stop/Rescue behavior. No trace
  event shape or ordering changes.

  `party-app-journey-report/v1` fails closed unless each run proves three
  imported, hydrated, and retained rows; one immediate first start; two unique
  scheduled and completed Safe Fades; on-time exact completion with no
  cancellation, more than 10 ms earliness, or ownership loss; exactly two
  native source completions while those crossfade owners remain active; exactly
  two invocations of the production native-EOF settlement branch and zero
  recovered-signal or crossfade-sentinel dispatches for this fixture;
  terminal trace success; empty queue;
  Autopilot off; a cleared checkpoint; inactive Decks; no active crossfade or
  recovery UI; focus handoff through Import, Play First Song, and readiness;
  a reachable 44-pixel Stop; continuously running context-state snapshots; at
  least 18 seconds of internally consistent non-silent post-master coverage;
  at most 100 ms
  unexpected silence; and zero non-finite, clipped, processor, page,
  unhandled-rejection, visibility, or external-network failures. The committed
  `party-app-browser-acceptance/v1` artifact contains two passing reports.

  The diagnostic page, observer, runner, and report code are absent from the
  standard/enhanced artifact. Public evidence contains only fixed contracts,
  enums, booleans, counts, rounded lateness, and bounded audio-health metrics;
  no filename, path, track/content ID, hash, timestamp, error text, user agent,
  device identifier, File/PCM, or audio is retained. This adds report/runtime
  versions only: IndexedDB v8, `track-analysis/v5`, `transition-plan/v3`,
  `party-session-checkpoint/v1`, and trace/evaluation v12 do not change. The
  gate proves generated-WAV composition in the tested Chromium environment,
  not MP3/FLAC breadth, real music, musical quality, physical speakers,
  process-death durability, two-hour endurance, or Firefox/Safari support.
  The diagnostic has one idempotent teardown used by terminal settlement,
  timeout/setup failure, and `pagehide`; it unmounts App, stops and permanently
  latches the existing audio engine, disposes observers/health monitoring, and
  closes or suspends the context. Persisted BFCache restoration reloads rather
  than reviving stale patched authority.

- **D-080 — Transfer paused-plan ownership without consuming its only durable
  payload, and prove a second refresh in Chromium:** The D-075 claim transaction
  now performs an atomic CAS from one strict `available` checkpoint to another.
  It compares the exact session, revision, previous writer, and library
  epoch/revision, then changes only `revision + 1` and the next writer token.
  Every queue/history/progress/setting field and array order remains identical.
  The transaction commits before broadcasting and returns the full normalized
  transferred record. App rejects any returned shape that is not an exact
  ownership transfer, applies state only from that returned record, and retains
  it as the current stored owner. No Deck is loaded, AudioContext resumed,
  Autopilot or diagnostic started, or wake lock acquired.

  The restored card truthfully says that the minimized recovery remains saved
  across refresh until the host chooses **Remove Saved Recovery Copy**, starts
  a New Party, or reaches terminal cleanup. A second refresh therefore exposes
  the same paused plan again instead of losing it behind a payload-free
  tombstone. Legacy `claimed` tombstones remain accepted for compatibility but
  are no longer produced and cannot recover payload they never stored. A
  foreign transfer still makes the previous writer stale and enters the D-076
  ownership-loss path; old-writer saves and clears fail CAS, while the new exact
  writer may update or clear. The restored-card removal command also requires a
  healthy checkpoint runtime and an exact local session/writer match; it never
  falls back to a revision-only clear after another tab takes ownership. If an
  owned periodic save is already active, removal drains it, re-reads the same
  exact owner, and clears its newest revision; a foreign owner cannot pass that
  refresh. Track
  deletion and Remove All retain their atomic
  invalidation semantics. IndexedDB stays at v8 and
  `party-session-checkpoint/v1` does not change because the existing minimized
  `available` shape already carries this data.

  `party-checkpoint-transfer-browser-runner/v1` runs the diagnostics-only full
  App gate twice in fresh Chromium profiles. Each run imports four generated
  WAVs through the real folder input, creates one valid minimized paused fixture,
  reloads to the visible recovery card without stealing existing focus, restores through the real UI, reloads
  again before any song choice or playback, restores a second time, and removes
  the saved copy through the real App action. The strict
  `party-checkpoint-transfer-browser-report/v1` requires two recovery cards,
  two payload-preserving revision/writer transfers, two visible paused-state
  projections with exact queue order and source guidance, unchanged library
  counters, preserved startup focus plus exact restore/removal focus handoffs, zero Deck
  starts, AudioContext resumes, wake requests, active Decks, Autopilot,
  page/unhandled errors, or external requests, and a final `cleared` record whose
  revision, session/writer owner, and unchanged library counters are verified.
  The production-used paused-state projector is separately exhaustive-tested
  for duration, exact active seconds, profile, energy shift, include-library,
  played order, remaining order, and last stable source; the browser gate does
  not overclaim hidden React state from coarse visible text.
  The committed aggregate contains only fixed enums, booleans, and capped
  counts; no names, paths, IDs, tokens, hashes, timestamps, raw errors, File,
  audio, user-agent, or device data. Diagnostic code is absent from standard and
  enhanced artifacts. This proves the double-reload generated-WAV path in the
  tested Chromium environment, not process-crash durability, physical speaker
  state, real-music quality, or Firefox/Safari support.

- **D-081 — Bound unabortable transition-rehearsal preparation and fail closed
  before any preview may start:** `transition-rehearsal-runtime/v1` owns one
  exact host-requested preparation from the real offline stereo render through
  the browser AudioContext resume. Its 30-second `performance.now()` deadline is
  a conservative liveness ceiling, not a speed target. The runtime rechecks the
  absolute deadline on task fulfillment/rejection, so a throttled timer cannot
  convert a late render into success. One Cancel request remains attached to the
  same owner: on-time settlement becomes cancelled, while a render that remains
  unresolved through the deadline becomes a timeout instead of leaving the UI
  in `CANCELLING` forever. Late values are inert and cannot reach resume or the
  protected preview start.

  App holds a synchronous preparation owner before rendering, rejects duplicate
  rehearsal actions, and gates the exact imperative first-song, Deck load/play,
  Auto Mix, and Autopilot command boundaries as well as their visible controls.
  Both Decks recheck the mutable rehearsal start/load gate after browser-audio
  waits and again at transport publication, so an older pending command cannot
  cross a newly claimed rehearsal owner.
  Stop All Sound, cross-tab reconciliation, audio/output recovery, and explicit
  Cancel request cancellation without pretending that browser-internal offline
  work stopped. If the offline render or resume reaches the deadline, Mazzy
  opens a tab-session rehearsal circuit, focuses fixed **Reload Mazzy** guidance,
  starts no preview, and keeps new playback locked while the global Stop action
  stays available. Ordinary failure before the deadline remains retryable; a
  cancelled operation that settles before the deadline releases the preparation
  lock. Unmount revokes the exact owner before teardown.

  Deterministic tests cover success before the boundary, cancellation followed
  by settlement, cancellation followed by a never-settling timeout, settlement
  at a throttled exact deadline, late-value inertness, unmount revocation, every
  playback-owner projection, and prevention of a post-timeout resume/start
  phase. No audio, filename, track identity, error, deadline, or owner is stored,
  exported, traced, or sent over a network. IndexedDB, analysis, transition,
  checkpoint, and Party trace schemas remain unchanged. Real browser suspension
  and device contention remain external evidence gates.

- **D-082 — Bound the exact first-song transport start before any Party state
  may publish:** `party-first-song-start/v1` gives the primary non-DJ
  **Play First Song** action one immutable Deck/track/load owner and a 10-second
  absolute `performance.now()` deadline. A synchronous owner is installed
  before the browser-audio await, rejects duplicate clicks, and is rechecked
  after resume and at the Deck transport commit. Stop All Sound, Deck load
  replacement, rehearsal ownership, audio/output recovery, destructive
  cross-tab reconciliation, page hide, and unmount revoke an uncommitted owner.
  A stale or late native continuation cannot start a source, clear readiness,
  change the queue or played history, record a Party event, or arm output
  monitoring.

  The Deck claims the deadline synchronously after its exact source start and
  final authority check but before transport and Party callbacks. This is the
  acceptance boundary: a commit strictly before the deadline remains accepted
  even if Promise delivery is delayed, while a commit at or after the deadline
  rolls the exact source back and publishes nothing. The visible `STARTING…`
  state disables host controls without blocking the matching owner key; null or
  foreign imperative starts remain refused. The checkpoint stable-state
  projector also excludes this unresolved owner.

  A never-settling or deadline-edge start opens a tab-session reload circuit,
  focuses fixed **Reload Mazzy** guidance, and keeps all new playback locked;
  **Stop All Sound** remains available. Ordinary on-time failure is retryable,
  and uncertain post-commit observation escalates to the existing Stop/device-
  mute intervention instead of claiming silence. Tests cover duplicate
  admission, exact and throttled deadlines, pre-deadline commit followed by
  delayed settlement, exact-deadline rollback, revocation and late continuation,
  rendered-busy versus matching-key projection, and thrown authority observation
  rollback. A real rendered-App smoke additionally guards JSX/hook-order
  composition, and the D-079 full-App generated-WAV acceptance passed twice in
  fresh Chromium profiles after the final exact-owner fix. Owner keys,
  track/load identity, deadline, and errors remain
  tab-memory-only; IndexedDB, analysis, transition, checkpoint, diagnostic,
  export, network, and Party trace schemas are unchanged. The separate
  page-level async host-failure boundary is D-083 below.

- **D-083 — Route genuinely uncaught page tasks into the independent fatal
  audio latch without retaining their payload:** `fatal-host-event-boundary/v1`
  installs `error` and `unhandledrejection` listeners before offline-shell
  registration and React root mount. Each event prevents the browser's default
  projection, synchronously calls the existing `fatal-host-audio-safety/v1`
  Stop authority, and only then publishes a monotonic fixed state containing
  `failed`, the confirmed/uncertain outcome, and a revision. The original
  Error, rejection reason, event, message, stack, filename/path, track identity,
  audio, and clock are never stored in the controller, React state, DOM,
  diagnostics, persistence, trace, export, logs owned by Mazzy, or network.

  `AppFatalBoundary` consumes the same store, including a failure captured
  before its mount, focuses its existing assertive Stop-before-Reload card, and
  keeps the global pagehide retry. Duplicate events are idempotent; another
  exact shutdown call may improve `uncertain` to `confirmed-stopped` but can
  never downgrade confirmed proof. Listener/subscriber exceptions cannot bypass
  shutdown. React descendant errors use the same state path, while React 19
  caught/recoverable root handlers continue discarding their private arguments.
  Expected enhanced-timing cache inspection rejection is now explicitly
  contained and projected as offline so optional availability cannot falsely
  stop a party.

  Deterministic tests cover stop-before-notify ordering, both event types,
  `preventDefault`, hostile-payload absence, pre-mount state, duplicate capture,
  uncertain-to-confirmed retry, detached subscribers, and listener teardown.
  The diagnostics-only generated-audio fatal page adds `?fault=async`, and
  `npm run acceptance:fatal-host-async` runs it in a fresh Chromium profile. It
  requires fixed proof that protected preview and audition owners were armed
  before the deliberate rejection was dispatched, then verifies focused fixed
  copy, hostile-payload absence, Stop-before-Reload order, 44-pixel controls,
  and an exact confirmed Stop retry. This page boundary does not claim errors
  already caught inside third-party code, worker failures not forwarded to the
  page, browser/OS process death, physical speaker proof, or arbitrary recovery
  without reload. Audio, storage, analysis, transition, checkpoint, Party trace,
  and production report schemas remain unchanged.

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
   **Implemented in `transition-plan/v3`; live eligibility remains locked by the
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
15. [EBU Tech 3342 loudness-range specification](https://tech.ebu.ch/docs/tech/tech3342.pdf).

---

If a future implementation choice conflicts with this document, do not silently
work around it. Record the conflict, evidence, decision, schema impact, and test
plan here first.
