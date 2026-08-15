# MAZZY

### A local-first party autopilot built for the browser

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Web Audio API](https://img.shields.io/badge/audio-Web%20Audio%20API-c8a96e)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
[![License](https://img.shields.io/badge/license-ISC-green)](./LICENSE)

Mazzy is a local-first party-mixing application that guides a non-DJ host through
library setup, first playback, and safety-first Autopilot. An optional advanced
surface exposes its two independent decks, waveform navigation, tempo sync,
three-band EQ, queue management, and beat-aligned automatic transitions. It runs
entirely in the browser—there is no backend and your music is not uploaded to a
server.

## Project direction

Mazzy is evolving from a two-deck prototype into a confidence-aware house-party
autopilot. The research, musical rules, system architecture, implementation
order, risks, and release gates are maintained in the canonical
[AI DJ Research and Build Plan](./AI_DJ_RESEARCH_AND_BUILD_PLAN.md).

## Highlights

- Plain-language Party Mode as the default surface, with the technical two-deck mixer collapsed under Advanced
- Two fully independent playback decks
- Interactive waveforms and animated platters
- Automatic BPM and musical-key analysis
- Background analysis in a transferable Web Worker
- Beat-synchronous energy, frequency-band, vocal-likelihood proxy, and structural-change analysis
- Waveform beat-grid markers with saved manual BPM, beat, and downbeat correction
- Web Audio-clock metronome audition for grid review
- Guided non-DJ timing repair with local click preview and tap-to-find-pulse
- Versioned local timing-review answers that survive reload and can be removed
- Automatic machine-only rhythm trust checks; manual review is optional and advanced
- Role-aware cue ranking over trusted timing cues using aligned energy, structure, and vocal-likelihood proxies
- Optional checksum-pinned Beat This `final0` browser model with WebGPU-to-WASM fallback
- Tempo control from `0.5x` to `1.5x`
- One-click BPM synchronization
- High, mid, and low EQ with kill switches
- Stereo-aware K-weighted per-track loudness trim, separate from crossfader automation
- Equal-power crossfader
- Folder-based library importing
- Persistent local library powered by IndexedDB
- Strict local paused party-plan checkpoint and host-confirmed restore after refresh
- Per-track local deletion that removes the stored audio, analysis, and timing review
- Reorderable playback queue and “Play Next” controls
- Confidence-gated automatic transitions with a visible safe fallback
- Opt-in Party Autopilot that preloads the queue and arms the audited transition near track end
- One-action Rescue that keeps the stronger side of an active transition and pauses Autopilot
- Always-reachable **Stop All Sound** safety control that pauses both decks and every local preview without deleting the party plan
- Three-track safety-first lookahead with played-track exclusion and a host-selected energy journey
- Queue ranking by transition safety, cue continuity, energy intent, confident key, and octave-aware tempo
- Pre-party readiness check for source playback, next-track availability, queue analysis, and timing-tool state

## How auto mix works

Mazzy treats the currently playing deck as the master. When **AUTO MIX** is
triggered, it:

1. Builds an immutable transition plan from the two tracks and live deck state.
2. Checks the exact candidate cue, detector/model provenance, local beat-line
   residuals, bar grouping, and signal activity.
3. For locally trusted automatic cues, performs a 0.35-second **Bar Handoff**
   on the selected bar starts with no tempo stretch.
4. For future calibrated grids, the same planner can perform an exact 32-beat
   phrase blend with one deliberate bass handoff.
5. When current basic analysis finds an audible outgoing section with fewer
   vocal-like frequencies,
   performs a 4.5-second **Filtered Fade**: an equal-power handoff plus one
   bounded outgoing low-pass sweep, with no beat matching or tempo stretch.
6. Otherwise, performs a conservative 3.5-second **Safe Fade** with no tempo
   stretch or long percussion overlap.
7. Shows the selected template and the first reason a long blend was rejected.
8. Schedules starts, gain curves, filter/EQ automation, and restoration against the Web Audio
   clock; animation frames only update the display.

The current `transition-plan/v3` is compiled into immutable `transition-dsp/v2`
using
the decks' actual trim and EQ state. Live scheduling consumes that description;
the DSP compiler cannot change transition eligibility or silently substitute a
different template.

Decoded mono and stereo tracks now receive a local `program-level/v4`
measurement in the existing analysis worker. It keeps the rhythm detector on
channel 1, but measures level from both channels independently using
sample-rate-adjusted K-weighting, 400 ms blocks with 75% overlap, the −70 LUFS
absolute gate, and the −10 LU relative gate. Three-second windows sampled at
10 Hz also produce a Tech 3342-style 10th-to-95th-percentile loudness range
after −70 LUFS/−20 LU gating. Only aggregate range/count/min/max values are
stored; the first 60 seconds are visibly marked as an early estimate. A
separately versioned provisional
party policy applies at most −6 to +3 dB of deck trim toward −14 LUFS, while a
four-times decoded intersample-peak estimate based on the FIR coefficients in
ITU-R BS.1770-5 Annex 2 can reduce that boost against a conservative −2 dBTP
per-file ceiling. Old or malformed level records are ignored and regenerated;
a new deck load starts at 0 dB trim instead of inheriting the previous song's
value. Synthetic stereo
calibration and EBU gate vectors cover 44.1, 48, and 96 kHz; four synthetic
Tech 3342 range cases run at 48 kHz. Fixed 50 Hz and
10 kHz results are within 0.1 LU of FFmpeg 8.1.1's independent `ebur128`
meter. A phase-offset quarter-rate vector proves that the decoded peak estimate
can detect a peak between stored samples. Formula-defined EBU Tech 3341
minimum-requirement cases 15–19 also fall inside their asymmetric +0.2/−0.4
dBTP tolerances without committing or playing the restricted EBU audio files.
Cases 20–23 and the complete official test set remain open. This is a
BS.1770-derived local
consistency aid, not certified EBU Mode or true-peak metering: range is not yet
used to change playback, and it does not certify a −14 LUFS product target or
prove the post-EQ, overlapped master output is true-peak safe. Files with more than two channels
receive neutral trim until a verified layout-aware measurement exists.

A diagnostics-only **private party-level listening lab** now provides a bounded
way to compare −16, −14, and −12 LUFS candidates before changing that
provisional policy. It analyzes two local songs through the production stereo
worker, keeps only anonymous eight-second excerpts and measurements in tab
memory, and plays them through the protected `mazzy-master/v1` path. A rating
unlocks only after both excerpts complete with healthy browser-audio evidence
and both can reach the selected target inside Mazzy's trim/decoded-peak bounds.
The visible summary contains aggregate human judgments only—no audio,
filenames, level measurements, timestamps, persistence, upload, or export. A
fresh Chromium run exercised preparation, two clean protected playbacks,
rating, and mid-play cancellation with synthetic stereo tones. This is lab
workflow evidence, not a chosen target, listening result, real-music coverage,
output-device proof, or permission to change `party-level-trim/v3`.

During an active transition, **STOP TRANSITION SAFELY** cancels pending gain automation,
keeps whichever deck owns more of the mix, restores stable bass EQ, pauses the
other deck, and turns Party Autopilot off until the host starts it again.
Deck transport, loading, tempo, EQ, and the manual crossfader lock while Party
Autopilot owns the decks or an automatic transition is being armed/performed,
preventing a half-manual state from silently invalidating its plan or recovery
checkpoint. Turning Autopilot off returns full manual control. The host's
pre-transition bass EQ values are restored on completion, failure, or Rescue.

Party Autopilot plans `current → next → after next`, rather than greedily
choosing only the immediate song. The weakest transition across those two legs
is considered first, so a tempting handoff cannot knowingly lead straight into
a dead end. The host can choose **Steady**, **Build to a peak**, or **Warm up ·
peak · cool down**. Energy remains a soft tie-break from normalized local
analysis; it can never outrank transition safety, and already-played songs are
excluded from automatic selection.

Party Mode guides a first-time host through three large steps: import music,
play the first song, and start Autopilot. While it runs, the primary controls use
plain language—prefer later choices that are calmer or more energetic, change
song using the current planned transition,
pause Autopilot, or stop an automatic transition. The technical mixer remains
available under **Show Advanced Mixer**. Library tracks and queue ordering are
keyboard operable, and preflight focus moves to its result when opened.
An always-enabled **Stop All Sound** action is kept in the ordinary Party Mode
surface and inside the advanced timing dialog. It immediately revokes pending preload and transition starts, cancels
automatic gain/EQ/filter automation, transition rehearsal, and timing clicks,
then pauses both decks, the Party clock, and the private activity check. It does
not eject ready songs, erase the queue or played-song history, delete music, or
discard the paused recovery plan. Starting sound again always requires a fresh
host action. Mazzy unlocks new starts only after both decks and every scheduled
audio owner are confirmed inactive; if that cannot be verified, the lock remains
in place and the host is told to retry and use system/device mute if sound remains.
The host also chooses a one- to six-hour target and explicitly chooses whether
Mazzy may continue beyond the queue; library continuation is off by default.
Progress comes from accumulated
active Party Autopilot time on the Web Audio clock, not from queue length or UI
timers; pauses do not advance the storyline and overtime never stops playback.
Mazzy requests the browser's standard confirmation before a reload or tab close
while Autopilot, an automatic transition, or a local rehearsal is active. The
browser may suppress that prompt. During a settled party state, Mazzy also keeps
one strict local **paused party-plan checkpoint** in IndexedDB. After a refresh,
the host may restore the remaining order, played-song repeat protection, settings,
and coarse active-party progress. Restore never loads a song, starts audio,
resumes the AudioContext, enables Autopilot, or reconstructs exact playback
position; the host must explicitly choose and play a song. Recent seconds may
repeat, browser storage may be evicted, and a crash before a settled checkpoint
is written remains unrecoverable.
While Autopilot runs, **Energy Down** and **Energy Up** temporarily shift the
next-song activity target by up to 30%. This remains a soft selection preference
and cannot promote a weaker transition or bypass Safe Fade.
**Skip Current Song Safely** immediately asks the same planner to perform the
currently available Bar Handoff or Safe Fade; it never hard-stops the playing
song or bypasses Rescue.

Before a party, a stopped library-backed pair can be auditioned with **Hear
Transition Rehearsal**. Mazzy locally renders a short stereo pre-master window
using the same versioned playback rates, track trims, EQ/bass ramps, gain curves,
and deck filter chain as the live transition, then plays it once through the real
protected master chain and discards it. Live deck controls and Auto Mix are
locked during rendering and playback. Its pre-master diagnostics catch
non-finite audio, sample-peak excess, silence gaps, and large sample
discontinuities; they do not certify musical quality, true-peak compliance,
device stability, or human preference. No rehearsal audio or feedback is
persisted.

The diagnostics-only `transition-rehearsal-browser-check/v4` also routes a
synthetic, deliberately hot correlated-stereo handoff through an offline graph
configured by the same `mazzy-master/v1` settings as production, then applies
the decoded intersample-peak estimator after the limiter. A fresh 48 kHz browser
run measured −2.5 dBFS sample peak and −2.5 dBTP estimated peak against a
0 dBTP overload ceiling. This catches a master-graph/configuration regression;
it is not live scheduling, decoded-music, output-device, speaker, or certified
true-peak evidence.

The current diagnostics-only `transition-rehearsal-browser-check/v6` tightens
that overload gate to −1 dBTP and adds a deliberately harsher mixed-frequency
stress at 44.1, 48, and 96 kHz. It correctly exposes that the live
`mazzy-master/v1` compressor can reach about +0.3 dBTP on this bounded overload.
A separate non-production `mazzy-master-peak-guard-candidate/v1`—a 4×
oversampled final safety curve that stays linear below −3 dBFS—measured −2.5
dBTP at all three rates. The current check now renders the master once, then
fans the same PCM into direct, identity-4×, and guarded-4× branches. It requires
the current branch to fail, the candidate to pass, at least 0.2 dB of peak
reduction, nonzero nonlinear engagement, bounded identity-branch RMS/peak
change, a delay-aligned stereo residual below −40 dB, and aligned sample error
no greater than 0.02. The report hard-codes
`liveMasterPromotionReady: false`; the candidate is not bundled into the normal
app graph.

A diagnostics-only private listening lab is now available for the required
human artifact check. It uses one local song to create a bounded adversarial
stress—two correlated copies at the equal-power midpoint, each using the +3 dB
trim parameter limit—and rejects a trial unless the unchanged current master
actually exceeds −1 dBTP while the candidate contains it. This deliberately
strict combination is not a reachable Autopilot normalization state or a
production-fidelity transition. Both central
ten-second renders are matched by attenuation only to within 0.1 LU and then
share enough additional attenuation to remain at or below −6 dBTP. They play at
the live context's native rate through a neutral post-master path, not through
the master a second time. A rating unlocks only after both anonymous versions
complete with reset-owned browser-audio health evidence. Orders alternate from
a cryptographically random start, every fourth trial is a hidden identical-arm
control, and each immutable trial accepts one rating. Mapping remains hidden
until an eight-trial block closes. Only aggregate counts remain in tab memory;
there is no filename/audio/measurement/order persistence, upload, or export. A
fresh Chromium run with a generated stereo fixture verified preparation, both
healthy playbacks, one-vote ownership, hidden aggregation, and mid-play
cancellation. It did not provide a human real-music judgment. A predeclared
multi-listener/genre/device protocol, a newly versioned live graph, and a fresh
device soak are still required before promotion.

A deterministic three-hour Party Autopilot coordinator soak now drives the same
`party-autopilot-decision/v4` function used by the live app. It therefore exercises the real
queue-first two-song lookahead, library continuation, transition-plan arm
windows, target cue offsets, no-repeat history, exact final-track ownership, and
`party-autopilot-trace/v12` evaluator. A Rescue correctly ends the unattended observation
in a paused state. This is state/coordinator evidence only: it does not exercise
browser decoding, Web Audio rendering, analysis workers, musical quality, or
speaker output, and it does not replace the visible two-hour device check.
The v4 coordinator also receives a session-only list of files that genuinely
failed browser read/decode. Autopilot skips each such song instead of retrying it
every half-second, preserves it visibly in the queue/library, and immediately
tries the next eligible song. Manual successful loading or **New Party** clears
the skip; analysis failure and cancelled/audio-blocked loads never poison a song.
Every automatic preload also owns an exact, at-most-20-second Web Audio clock
lease. The deadline shortens when needed to preserve five seconds of source-song
runway; if even a half-second attempt cannot preserve that reserve, Autopilot
pauses before starting another load. If a read/decode/analysis operation never settles, Mazzy invalidates that exact load,
marks the song as “took too long” for this party, and tries the next queue-first
candidate without touching the playing source. Two consecutive lease expiries
pause Autopilot and leave the current song playing so the host can retry a song
manually or choose **New Party**. Synthetic soak coverage includes one-time
failover, the two-timeout pause, and no retry of an excluded song. Separate
exact-ownership tests reject late settlement at and after the deadline; the soak
does not claim that browser decoding or late browser callbacks were exercised.
Every Party pause now synchronously claims and settles an exact in-flight
preload before recording the pause. A deck-owned per-load token revokes the
matching FileReader/decode generation even when App still shows the predecessor's
published load ordinal. The matching pending, ready, or unexpectedly playing
target is stopped/ejected, while a different host replacement is never touched.
Late load settlement cannot publish, clear a successor, or survive as an
uncommitted target. If exact cancellation/ejection cannot be verified, Mazzy
keeps new playback locked and exposes the persistent Stop All Sound recovery
instead of claiming success. Trace/evaluation v10 rejects pause or resume with an open
preload, and coordinator soak v10 pauses a deferred preload before its settlement,
then resumes with a fresh operation and the queue unchanged.

Automatic transition preparation is bounded too. Each arm owns the exact source
and target loads and expires no later than eight seconds—or earlier when its cue
can no longer be scheduled with safe lead time. A timeout or preparation failure
restores the exact pre-arm deck gains, mutes/stops only the owned target when that
was its pre-arm state, and leaves
the queue/history unchanged. Mazzy retries once only when enough source-song
runway remains; a second consecutive failure, or one without retry runway, pauses
Autopilot while the current song keeps playing. Host control, recovery, or load
replacement cancels the exact arm without consuming that budget, and late async
settlement cannot schedule or clear a successor. The v10 synthetic coordinator
soak covers fail-once/succeed, two-failure pause, timeout, and short-runway pause;
it remains state evidence rather than browser timing or audible-output evidence.

Scheduled transitions now have a second exact completion owner. The primary
audio-clock callback and an independent half-second watchdog both inspect the
same immutable source/target load identities and engine schedule; wall timers
only wake the check and never infer audio progress. Either signal can promote
the target exactly once. A missing primary callback is recovered after the
500 ms grace with a bounded 20 ms browser-delivery tolerance, while a later,
cleanup-degraded, or ownership-lost completion pauses Autopilot or locks new
playback with a persistent host action. Rescue, Stop All
Sound, recovery, remote authority loss, and unmount revoke both completion
signals before touching deck audio. The v10 trace distinguishes primary,
watchdog, late, cleanup-degraded, combined late-and-degraded, and failed
settlement; Stop also records whether the exact target remained preserved. The
v10 soak injects missing, late, and replaced-target outcomes. This is deterministic ownership evidence, not
proof of browser callback delivery or speaker continuity.

Every live coordinator observation also owns a session epoch and monotonic tick
ticket. Overlapping ticks remain available to expire a stalled preload, but
pause, restart, restore, New Party, remote authority loss, and unmount invalidate
older tickets. One current-epoch unexpected planning, preload, arm, or transition
watchdog failure is claimed exactly once, settles its owned operation, pauses
Autopilot and the Party clock, releases the wake lock, and shows a persistent
host action while leaving the current song alone. Trace v10 requires the matching
immediate safety pause; the v10 coordinator soak includes a decision-phase failure
fixture, while pure boundary and trace tests cover overlapping tickets and
active-transition recovery ownership. This is fail-closed state evidence, not
proof that every browser or file error has been reproduced.

Native deck playback now has its own exact natural-completion lease. Each source
binds its local load, transport, source, and playback-rate-plan revisions to an
integrated Web Audio end time. The source `onended` signal, a separate silent
audio-clock sentinel 50 ms later, a bounded window wake, the deck display loop,
and the Autopilot observer all converge on one idempotent arbiter; window time
never declares progress. Constant rates, offsets, and linear rate ramps use
media-time integration; an overlapping ramp is rejected when its rendered slope
cannot be preserved. Every seek, rate restart, pause, eject, replacement
load, or Stop All Sound revokes the old owner before stopping its source. A
scheduled `stopAt` becomes paused and never masquerades as natural EOF. An exact
source that ends materially early becomes a recoverable safety failure rather
than being relabelled later as a valid end.

`party-autopilot-trace/v12` records only session-local deck/load and rebased
native-owner ordinals plus the fixed
`source-onended`, `audio-clock`, or `reconcile` provenance, distinguishes a
source callback observed after the watchdog boundary, and requires a final
deck end to be followed immediately by terminal session cleanup. The current v12 soak
creates and inspects the same final-deck lease and models a missing source
callback recovered by either the silent audio-clock sentinel or explicit
audio-clock reconciliation. This is deterministic
ownership/state evidence; it does not prove callback delivery, decoded-audio
continuity, or speaker output in a real browser.

Verified native completion now passes through a second, session-level
`party-deck-completion-ingestion/v1` boundary before it may change Party state.
The callback channel, native operation and load revision, natural-completion
intent, settled Deck status, and current Party load must all match. A stale
same-song callback from an earlier play or reload is ignored. An exact final
owner still ends the Party once. Without an eligible exact committed target,
any exact non-final master ending revokes Autopilot immediately in the callback,
settles pending preload/arm authority, pauses the Party clock, releases the
screen-wake request, and presents a focused persistent recovery card. No new
song is then started automatically; the host chooses and plays one before
restarting Autopilot. A completion from
either deck of an active transition enters the existing Rescue/Stop safety lock
instead of allowing that transition to commit a stopped deck. Trace v12 binds
the native ordinals and requires a non-final ending to be followed immediately
by either the source-stopped pause or one exact committed-target fallback
attempt.

When the opposite deck is already the exact committed preload—decoded,
level-checked, ready, idle, and bound to the current Party load ordinal—Mazzy
now makes one bounded fallback start after verified non-final EOF. It starts
from the beginning at 1×, applies a short target-only gain ramp, and does not
select, decode, resume audio, infer a cue, or attempt beat matching in this
path. The context must already be running and every preload, arm, transition,
rehearsal, recovery, storage, and Stop authority must be clear. Any mismatch or
unverified start falls back to the existing focused paused recovery; a target
that may have started is stopped only when its exact load still owns the deck.
This is a best-effort continuation and a short audible gap may occur—it is not
seamless or gapless playback. Soak v12 covers both the ordinary pause and the
exact committed-target continuation through the shared pure decisions.

Tempo-changing phrase blends also remain fail-closed until pitch-preserving
playback is ready on the exact loaded decks. A developer-only Signalsmith
AudioWorklet spike now passes local 44.1 and 48 kHz synthetic smoke checks at 0.94×,
1.00×, and 1.06× through the isolated DeckEngine and protected stereo master:
both channels change a 16 Hz timing marker with measured error below 0.09%, keep
distinct 440/660 Hz carriers within one cent with 18–22 dB prominence, hold
stereo level balance within 3.4 dB, and measure opposite-channel leakage below
-48 dB. A diagnostics-only audio-frame observer ACKs at least 260 ms before the
requested frame, then monitors the full cell: zero pre-start output, no invalid
samples, and both channels beginning 5.9–9.1 ms late. This `key-lock-smoke/v6` result is deliberately
not production approval or a musical-quality result. The smoke page, worklet,
and package chunk are excluded from the normal build; runtime preparation state
is load-bound, failures leave ordinary Safe Fade playback available, and the
live app still grants no key-lock capability.
The dormant planner contract now also requires a capability to match the exact
current AudioContext sample rate, source/target runtime load keys, and the
Signalsmith backend on both decks. A document-shaped or stale capability cannot
authorize a phrase blend, and the App still supplies none.

A separate `key-lock-crossfade-smoke/v1` built-diagnostics run exercises two
simultaneous prepared stretch processors at 0.94×/1.06× through Mazzy's real
equal-power crossfade and post-limiter health monitor. Its first deterministic
handoff completed under exact schedule ownership with 274,176 expected-active
frames, no silent frames, invalid samples, clipping, or processor errors. This
is render-path evidence only and still does not authorize live phrase blends.
A later `key-lock-crossfade-smoke/v2` stress run alternated 12 transitions
between the two prepared decks. All 12 completed exactly once across 967,680
expected-active frames; the longest measured silence was one sample (0.021 ms),
with zero invalid/clipped samples or processor errors. It remains synthetic and
does not replace real-song listening or the sustained device gate.
The executable diagnostic is now `key-lock-crossfade-smoke/v4`: it adds a Stop
path, bounded completion timeouts, exact schedule/completion IDs and lateness,
context-continuity checks, and internally consistent expected/rendered-frame
coverage plus a one-minute sustained mode with enforced duration/transition
minimums. The v2/v3 measurements above remain historical evidence. A fresh v4
built-diagnostics browser run passed all 37 sustained transitions across
2,958,336 expected-active frames, with zero silent frames, invalid samples,
clipping, or processor errors after an acknowledged interval reset. This remains
synthetic render-path evidence and does not authorize live phrase blends.

The diagnostics artifact now also includes `/key-lock-listening.html`, an
advanced private listening lab. The host chooses two local songs; Mazzy keeps
only anonymous 12-second in-memory excerpts, clears the filename inputs, and
offers original, 0.94×, 1.06×, and two-song handoff comparisons. Clean / artifact
/ not-sure counts stay in tab memory with no filenames, timestamps, persistence,
or upload. It reuses one bounded two-deck graph, rejects excerpts too short to
finish a trial, resumes and watches the browser audio context, cancels owned
fades on Stop, and enables rating only after a healthy natural completion. The
workflow has been exercised on two files from the private local crate, but no
subjective rating has been inferred or recorded automatically.

Party setup also offers an opt-in **private Autopilot activity check**. It watches
the production preload, handoff, Rescue, repeat, and final-track ownership state
using bounded session-local numbers only. It stays in tab memory, records no song
names, files, library IDs, BPM/key data, wall-clock listening times, or audio, and
is never uploaded. Its “healthy so far” result covers Autopilot state invariants
only; refresh, overflow, incomplete identity, or impossible ordering fails closed.

Advanced Mixer now links to **Run Local Device Party Check**. This opens a
copyright-free wall-clock diagnostic using the production `AudioEngine`, real
Web Audio transitions, and a post-limiter AudioWorklet health tap. The report
fails closed on short/aborted duration, malformed or incomplete render evidence,
worklet failure, orphan transitions, context interruption, non-finite output,
post-limiter clipping, gaps over 100 ms, or completion lateness over 500 ms. It
contains no audio, filenames, paths, track identifiers, exact timestamps, or
device identifiers. The current interval-authoritative report is
`device-soak-report/v4`; the one-minute run is only a smoke check. Only a visible,
awake two-hour run can pass this audio-engine gate. It still does not prove
decoding, music analysis, complete Party Autopilot behavior, physical speaker
output, or musical quality. A development-only synthetic transition-rehearsal
page verifies browser cue timing, 1.25× source playback, stereo isolation,
continuity, deterministic rendering, and trim at 48 kHz without playing or
saving its generated signals; it is excluded from the production build.

Filtered Fade is the fourth implemented transition behavior. It is deliberately
not ranked above Safe Fade when choosing a song: both are no-beat fallbacks, and
the feature only changes presentation after safety and host intent have chosen
the pair. It requires current `basic-worker/v5` energy, vocal-frequency proxy,
and band-energy evidence aligned through the full outgoing sweep; missing,
stale, vocal-like-frequency-heavy, near-silent,
manual, disabled, or too-short inputs use plain Safe Fade. The v3 browser
rehearsal compares filtered and unfiltered renders of the same outgoing 3 kHz
signal in matching early and late windows, preventing the ordinary gain fade
from being mistaken for filter evidence. In the fresh 48 kHz browser run the
early filtered/reference RMS ratio was 1.008 and the late ratio was 0.062. Cue,
stereo, continuity, trim, and determinism passed in the same run. This is
deterministic DSP evidence, not a claim that every song will sound artistically
good.

The production-built `mazzy-audio-engine/v2` literal v4 gate completed 7,200.2
seconds on both the wall and Web Audio clocks. It completed 923/923 owned
transitions, with 32 ms wall/audio-clock divergence and 28 ms maximum completion
lateness. Across 345,608,192 expected-active frames it reported zero silence,
invalid or clipped samples, processor errors, ownership failures, failures, or
warnings. The report sets `releaseGatePassed: true`; its exact privacy-safe JSON
is committed as [DEVICE_SOAK_ACCEPTANCE_REPORT.json](./DEVICE_SOAK_ACCEPTANCE_REPORT.json).
This closes the synthetic production audio-engine render-path gate only. It does
not prove decoding, music analysis, full Party Autopilot behavior, browser-to-
speaker delivery, output-device behavior, or musical quality.

By default, queued songs retain first priority and Autopilot may continue from
the remaining eligible library only when that queue is exhausted. The host can
turn that option off before starting; played, loaded, duplicate, and
Auto-Mix-disabled tracks are never silently reintroduced.

Imported music files, filenames, and analysis are stored in this browser
profile until removed; they are not uploaded. Tracks can be removed one at a
time or with **Remove All Local Music**. The optional timing model is fetched
from the app's server only after the host chooses the download action, then
cached for later reuse; browser storage may evict it.
Mazzy uses a local system monospace font stack and makes no third-party font
request when the app opens.

Before adding a selected folder, Mazzy sums the local audio-file sizes and uses
the browser's coarse storage estimate when one is available. It keeps a 128 MB
reserve and refuses only a selection that clearly cannot fit, with a plain
message to choose less music or remove saved tracks. If the browser withholds
or rejects the estimate, import remains available and the UI says capacity was
unknown. Import owns the local-library mutation through its IndexedDB commit;
Mazzy publishes rows and says “Saved” only after that transaction succeeds, and
a quota/write failure leaves no session-only phantom tracks. No filename, path,
or file size is stored in diagnostics or uploaded. Byte-identical files receive
a versioned local SHA-256 content identity, computed one file at a time and kept
only in the IndexedDB track record; re-imported and within-folder duplicates are
skipped before storage and analysis. Import stays disabled until the saved
library has finished hydrating, so startup restore cannot overwrite a new batch.
The IndexedDB content-identity index is unique across Mazzy tabs. Routine
analysis saves update existing rows only, and deletion is broadcast to other
open tabs, so a stale tab cannot silently recreate music removed elsewhere.
Cross-tab import/delete/clear transactions also use the browser's profile-wide
Web Lock when available; a received clear invalidates any local import still
hashing or waiting to publish.
Automatic analysis updates preserve the separately committed content identity,
manual timing overrides, and timing-review record; a later background save
cannot roll those fields backward. Analysis-save failures stay visible until a
subsequent analysis snapshot commits successfully.

The production build also installs a versioned, same-origin offline app shell
after one successful online load. It caches only the root UI, its exact hashed
JavaScript/CSS modules, the basic analysis worker, and install icons. It does
not intercept or cache music, IndexedDB records, optional timing-model files,
device checks, private diagnostics, or arbitrary routes. A fresh Chromium
profile reopened the full Party Mode after the production preview server was
stopped. This proves app-shell reopening only: browser storage may evict it,
imported music still follows the IndexedDB controls above, and first-time use
still requires one online load. Every cached code file is SHA-256 checked before
installation, and an update waits for existing Mazzy tabs to close instead of
taking over an active party. Root and configured project-subpath deployments
use the same build base. The standard build excludes the optional Beat This
worker and ONNX runtime; even the enhanced build keeps that optional timing code
and model pack outside the automatic app-shell cache. If a timing pack remains
from a previously opened enhanced build, the lightweight build detects it only
to offer removal; it cannot use that pack for analysis. The enhanced build also
keeps timing unavailable when its same-origin runtime cannot be reached, even
if model files remain cached, so offline shell recovery cannot trigger a failed
analysis retry loop.

The lightweight analyzer does not provide bar starts, so tracks using only that
analyzer use Safe Fade. The optional enhanced detector can unlock a short local
Bar Handoff automatically when both tracks expose qualified cue indices. Long
phrase blends remain locked until a real-audio benchmark promotes a calibrated
detector.
Mazzy analyzes timing automatically; a host does not need to count beats,
understand BPM, or approve a grid. Each track receives a versioned machine-only
trust profile covering grid validity, coverage, tempo drift, phase stability,
bar-start coherence, and signal activity. The optional Beat This `final0` model
pack finds beats and bar starts locally through WebGPU with automatic WASM
fallback. The first setup is approximately 109 MB, is checksum-verified, and is
cached in the browser for offline reuse. Music is never sent with that download.

When automatic checks support it, Mazzy can use a 0.35-second bar-aligned
handoff with no tempo stretching or long percussion overlap. Otherwise it uses
Safe Fade. Long 32-beat phrase blends remain locked until a detector/calibrator
passes the real-music release gate; self-consistency is not presented as an
accuracy probability.

Timing eligibility and musical preference are intentionally separate. Enhanced
analysis first creates the exact set of allowed cues. Energy, structure, and a
spectral vocal-likelihood proxy then rank only that set: outgoing cues favor a
later, calmer handoff region, while incoming cues favor an audible opening with
less likely vocal overlap. The final source/target pair also favors similar
normalized energy so a handoff is less likely to feel like an accidental jump.
Soft features can choose among safe cues but cannot make an unsafe cue eligible.

On a private development crate, the official detector produced usable beat and
bar evidence across multiple tracks, while the conservative local-cue rule
abstained on less coherent bar grouping. Exact per-track/cohort results remain
in private evaluation storage under D-018. This is engineering coverage
evidence, not a human-annotated accuracy claim.

The **Review Timing (Advanced)** wizard remains available for troubleshooting,
but is not required for import, playback, or Auto Mix. Adjustments stay local
and still use Safe Fade; “adjusted” is never treated as professionally verified.
For library tracks, the final plain-language answers are stored in IndexedDB
only after **Save Answers**, restored after reload, and shown beside the deck.
Raw tap times, playhead locations, filenames, and free-form notes are not part
of the review record. Cancel leaves no record, and **Remove Saved Timing
Review** deletes the stored answers. Direct-loaded tracks remain session-only.
Energy, structural-change, and vocal-likelihood evidence is now analyzed for
future cue selection, but the vocal value is explicitly a spectral proxy—not a
validated vocal detector—and does not unlock long blends.

A checksum-pinned Beat This ONNX/WebGPU pipeline can now analyze tracks locally
in a browser worker, with a one-time model setup and automatic WASM fallback.
Its results feed automatic timing and the conservative bar-aligned handoff, but
remain ineligible for long phrase blends until human-scored accuracy,
confidence calibration, memory, and loading UX pass their release gates. See
[Private real-track evaluation](./PRIVATE_REAL_TRACK_EVALUATION.md) for the
reproducible workflow and measured evidence.

## Audio architecture

```text
Imported audio file
        │
        ├──► BPM and key analysis
        │
        ▼
Decoded AudioBuffer
        │
        ▼
Transport gate ─► Low/Mid/High EQ ─► transition filter ─► track trim
        │                                                        │
        └────────────────────────────────────────────────────────▼
                    Deck gain / crossfade automation
                                   │
                                   ▼
                   Master headroom ─► limiter ─► meter ─► output
```

WaveSurfer renders the visual waveform, while the Web Audio API handles the
actual playback, EQ, gain automation, synchronization, and transitions.

Current BPM/beat confidence is provisional and is not yet reliable enough for
autonomous long phrase blends. The reproducible comparison and known failures
are documented in the [Rhythm Benchmark Report](./RHYTHM_BENCHMARK_REPORT.md).
Manual corrections survive reload and reanalysis, but they intentionally do not
manufacture confidence or unlock long-blend Auto Mix.
Timing-review answers are bound to the analyzer and grid schema they assessed;
a new analysis clears the old review instead of presenting stale listening
feedback as current.

## Getting started

### Requirements

- Node.js 20 or newer
- A modern Chromium, Firefox, or Safari browser

### Install and run

```bash
git clone https://github.com/goodcoderind/Dj-Mazzy.git
cd Dj-Mazzy
npm install
npm run dev
```

Open the local address printed by Vite, usually
[`http://localhost:5173`](http://localhost:5173).

### Production build

```bash
npm run build
npm run preview
```

`npm run build` intentionally creates the Safe-Fade-capable build without the
83 MB model/configuration/filterbank pack (the shared browser runtime may still
be present in the JavaScript build). To create the enhanced local-analysis build, first
prepare and verify the pinned assets, then opt in explicitly:

```bash
npm run prepare:beat-this-onnx
npm run build:enhanced
npm run preview
```

The enhanced build fails if any model/configuration/filterbank asset is missing
or has the wrong SHA-256. The standard build labels enhanced timing as not
included instead of presenting a download that cannot succeed.

### Validation and rhythm benchmark

```bash
npm test
npm run typecheck
npm run benchmark:rhythm
npm run benchmark:real-tracks
```

For the local audio-engine check, start the preview server and open
`/device-soak.html`. Keep the page visible and the computer awake. Reports are
private local evidence; do not commit individual reports.

The experimental key-lock smoke page is built into a separate diagnostics
directory so it cannot be mixed into a production artifact:

```bash
npm run build:diagnostics
npm run preview:diagnostics
```

Then open `/key-lock-benchmark.html`. It uses generated synthetic audio only and
does not unlock live phrase blends. Add `?sampleRate=44100` to run the separate
44.1 kHz check; the default is 48 kHz.

The real-track command reads `~/Desktop/music small` by default and writes only
to external private application storage outside the repository and Vite root. See
[Private real-track evaluation](./PRIVATE_REAL_TRACK_EVALUATION.md) for the
annotation and Beat This prototype workflow.

## Using Mazzy

1. Select **IMPORT** and choose a folder containing audio files.
2. Select a library track to load it into an available deck.
3. Use the context menu to explicitly load a track into Deck A or Deck B.
4. Press **Play**, adjust tempo and EQ, or use **SYNC** to match the other deck.
5. Drag the crossfader for a manual transition.
6. Add more tracks to the queue and use **AUTO MIX** for an assisted transition.
7. Select **START PARTY AUTOPILOT** for hands-off queue playback; select it again
   at any time to stop automatic arming. Autopilot may reorder queued tracks to
   prefer a qualified transition, then uses confident key and tempo fit to break
   ties. Its current choice and reason remain visible. A readiness check appears
   before activation; Safe-Fade-only operation remains available without the
   enhanced timing model.

Audio format support depends on the browser's decoding capabilities. MP3, WAV,
and FLAC are the safest choices; M4A and AIFF support can vary by platform. A
decode failure is labelled **FILE COULDN’T BE READ · TRY ANOTHER FORMAT**; it is
not presented as transition-ready.

While Party Autopilot is running, Mazzy requests the browser's screen wake lock
and releases it when Autopilot pauses or the page closes. Browsers and operating
systems may refuse or later release that request, so the UI reports the actual
state and still tells the host to keep the computer powered and awake when the
lock is unavailable. It cannot keep a closed laptop lid awake.

If the browser suspends or the device interrupts its AudioContext, Mazzy pauses
Autopilot authority and shows a host-operated **RESUME AUDIO** control. It does
not silently arm against a stale audio clock or attempt an automatic restart
without a user gesture. A permanently closed AudioContext asks the host to
reload instead.

After audio has started, a generic browser media-device-set change makes Mazzy
conservatively pause Autopilot and ask the host to check the speakers before
continuing. The event can also be caused by a microphone or camera change; it is
not proof that output routing changed. Mazzy does not enumerate device
names or IDs, request microphone permission, or claim that speaker output was
verified.

Right-click a library row and choose **Remove from Library** to delete that
track's stored browser copy, automatic analysis, and timing-review record. If it
is loaded, Mazzy safely ejects it from the corresponding deck as well.

## Project structure

```text
src/
├── analysis/           # Worker client, versioning, and grid corrections
├── audio/              # AudioEngine, DeckEngine, transport, and metering
├── components/         # Deck controls and beat-grid visualization
├── diagnostics/        # Rhythm benchmark and soak simulation
├── domain/             # Versioned analysis and transition schemas
├── planning/           # Deterministic transition planner and music math
├── workers/            # Background audio analysis worker
├── App.jsx             # Mixer, library, queue, and plan execution
└── libraryDb.js        # IndexedDB library persistence
```

## Built with

- [React](https://react.dev/) for the interface and application state
- [Vite](https://vite.dev/) for development and production builds
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) for playback and mixing
- [WaveSurfer.js](https://wavesurfer.xyz/) for waveform visualization
- [Music Tempo](https://www.npmjs.com/package/music-tempo) for BPM estimation
- IndexedDB for browser-local music and metadata storage

## Privacy

Mazzy is local-first. Imported audio and analysis metadata are stored in your
browser's IndexedDB database. Nothing in the application uploads your tracks to
an external service.

While a party is in progress, the same local database may contain one paused-plan
checkpoint: opaque local track IDs, remaining order, played history, coarse
active-party seconds, and the selected duration/energy/continuation settings. It
does not contain filenames, audio, content hashes, analysis, BPM/key data, exact
positions, wall-clock or Web Audio timestamps, device information, or diagnostic
traces. Restore or Delete consumes the visible recovery copy; New Party, terminal
completion, track deletion, and Remove All clear or invalidate it.

Clearing site data for the Mazzy origin will remove the saved local library and
any paused party-plan checkpoint.

## Project status

Mazzy is an experimental DJ workstation and active prototype. It is best suited
for exploration and casual mixing rather than performance-critical live sets.

Potential future additions include:

- Hot cues and looping
- Headphone cue and channel monitoring
- Mix recording and export
- Improved background audio analysis
- Harmonic-mixing recommendations
- MIDI controller support

## Contributing

Ideas, bug reports, and pull requests are welcome. For larger changes, open an
issue first so the approach can be discussed.

## License

Distributed under the ISC license.
