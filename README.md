# MAZZY

### A two-deck DJ workstation built for the browser

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Web Audio API](https://img.shields.io/badge/audio-Web%20Audio%20API-c8a96e)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
[![License](https://img.shields.io/badge/license-ISC-green)](./package.json)

Mazzy is a local-first DJ application with two independent decks, waveform
navigation, tempo sync, three-band EQ, a music library, queue management, and
beat-aligned automatic transitions. It runs entirely in the browser—there is no
backend and your music is not uploaded to a server.

## Highlights

- Two fully independent playback decks
- Interactive waveforms and animated platters
- Automatic BPM and musical-key analysis
- Tempo control from `0.5x` to `1.5x`
- One-click BPM synchronization
- High, mid, and low EQ with kill switches
- Equal-power crossfader
- Folder-based library importing
- Persistent local library powered by IndexedDB
- Reorderable playback queue and “Play Next” controls
- Automatic transitions with beat alignment, tempo matching, crossfading, and bass swapping

## How auto mix works

Mazzy treats the currently playing deck as the master. When **AUTO MIX** is
triggered, it:

1. Matches the target deck to the master deck's BPM.
2. Finds the next 16-beat phrase boundary.
3. Starts the target deck with a short pre-roll.
4. Runs an eight-second equal-power crossfade.
5. Gradually swaps the low-frequency energy between the decks.
6. Stops the old deck, releases tempo sync, and prepares the next queued track.

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
Low EQ ─► Mid EQ ─► High EQ ─► Deck gain ─► Audio output
                                      ▲
                                      │
                           Crossfader / Auto Mix
```

WaveSurfer renders the visual waveform, while the Web Audio API handles the
actual playback, EQ, gain automation, synchronization, and transitions.

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

## Using Mazzy

1. Select **IMPORT** and choose a folder containing audio files.
2. Select a library track to load it into an available deck.
3. Use the context menu to explicitly load a track into Deck A or Deck B.
4. Press **Play**, adjust tempo and EQ, or use **SYNC** to match the other deck.
5. Drag the crossfader for a manual transition.
6. Add more tracks to the queue and use **AUTO MIX** for an assisted transition.

Audio format support depends on the browser's decoding capabilities. MP3, WAV,
and FLAC are the safest choices; M4A and AIFF support can vary by platform.

## Project structure

```text
src/
├── components/
│   └── Deck.jsx       # Playback engine and deck controls
├── App.jsx            # Mixer, library, queue, and auto-mix coordination
├── App.css            # Interface and deck styling
├── audioContext.js    # Shared Web Audio context
├── libraryDb.js       # IndexedDB library persistence
└── main.jsx           # React entry point
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

Clearing site data for the Mazzy origin will remove the saved local library.

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
