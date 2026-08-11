import { useEffect, useMemo, useRef, useState } from "react";
import Deck from "./components/Deck";
import { getAudioContext } from "./audioContext";
import MusicTempoModule from "music-tempo";
import { loadLibraryFromDb, saveTracksToDb } from "./libraryDb";

const MusicTempo = MusicTempoModule.default ?? MusicTempoModule;
const audioExt = [".mp3", ".wav", ".flac", ".aiff", ".m4a"];
const stripExt = (name) => name.replace(/\.[^/.]+$/, "");

export default function App() {
  const [fade, setFade] = useState(0.5);
  const [autoMixing, setAutoMixing] = useState(false);
  const [autoMixBars, setAutoMixBars] = useState(null);
  const [masterDeck, setMasterDeck] = useState("a");
  const [bpmByDeck, setBpmByDeck] = useState({ a: null, b: null });
  const [library, setLibrary] = useState([]);
  const [analyzingIds, setAnalyzingIds] = useState({});
  const [loadedByDeck, setLoadedByDeck] = useState({ a: null, b: null });
  const [queue, setQueue] = useState([]);
  const [contextMenu, setContextMenu] = useState(null);
  const [deckFlash, setDeckFlash] = useState({ a: false, b: false });
  const [toast, setToast] = useState("");
  const [dragIndex, setDragIndex] = useState(null);
  const contextReadyRef = useRef(false);
  const autoMixCountdownFrameRef = useRef(0);
  const deckARef = useRef(null);
  const deckBRef = useRef(null);
  const importRef = useRef(null);
  const analyzingRef = useRef(false);

  const TRANSITION_DURATION_SECONDS = 8;
  const queueTracks = useMemo(
    () => queue.map((id) => library.find((t) => t.id === id)).filter(Boolean),
    [queue, library]
  );
  const queuePositionMap = useMemo(() => {
    const map = new Map();
    queue.forEach((id, idx) => {
      if (!map.has(id)) map.set(id, idx + 1);
    });
    return map;
  }, [queue]);

  useEffect(() => {
    if (importRef.current) {
      importRef.current.setAttribute("webkitdirectory", "");
      importRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    const restore = async () => {
      try {
        const records = await loadLibraryFromDb();
        if (!records.length) {
          return;
        }
        setLibrary(
          records.map((track) => ({
            id: track.id,
            name: track.name,
            file: track.file,
            duration: track.duration ?? null,
            bpm: track.bpm ?? null,
            key: track.key ?? null,
            scale: track.scale ?? null,
            loaded: false
          }))
        );
      } catch (_err) {
        // Ignore failed restore.
      }
    };
    void restore();
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  const showToast = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1400);
  };

  const onCrossFade = (event) => {
    const value = Number(event.target.value);
    setFade(value);
    const gainA = Math.cos(value * Math.PI * 0.5);
    const gainB = Math.sin(value * Math.PI * 0.5);
    deckARef.current?.setGain?.(gainA);
    deckBRef.current?.setGain?.(gainB);
  };

  const getDirectionLabel = () => (masterDeck === "a" ? "← A to B" : "B to A →");

  const onBpmChange = (channel, bpm) => {
    setBpmByDeck((prev) => ({
      ...prev,
      [channel]: bpm
    }));
  };

  const detectBpm = (audioBuffer) => {
    const pcmData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const hopSize = Math.max(128, Math.round(sampleRate * 0.01));
    const mt = new MusicTempo(pcmData, {
      hopSize,
      timeStep: hopSize / sampleRate
    });
    let bpm = Number(mt.tempo);
    while (bpm > 160) bpm /= 2;
    while (bpm < 70) bpm *= 2;
    return Math.round(bpm * 10) / 10;
  };

  const detectKey = async (audioBuffer) => {
    console.log("detecting key...");
    const rawData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const fftSize = 4096;
    const halfBins = fftSize / 2;
    const numSamples = 10;
    const chroma = new Float32Array(12);
    const majorTemplate = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const minorTemplate = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    const windowed = new Float32Array(fftSize);
    const real = new Float32Array(halfBins);
    const imag = new Float32Array(halfBins);

    for (let i = 0; i < numSamples; i++) {
      const center = Math.floor((rawData.length * (i + 1)) / (numSamples + 1));
      const start = Math.max(0, Math.min(center - Math.floor(fftSize / 2), rawData.length - fftSize));
      for (let n = 0; n < fftSize; n++) {
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (fftSize - 1)));
        windowed[n] = (rawData[start + n] || 0) * hann;
      }

      for (let k = 0; k < halfBins; k++) {
        let sumRe = 0;
        let sumIm = 0;
        for (let n = 0; n < fftSize; n++) {
          const angle = (2 * Math.PI * k * n) / fftSize;
          sumRe += windowed[n] * Math.cos(angle);
          sumIm -= windowed[n] * Math.sin(angle);
        }
        real[k] = sumRe;
        imag[k] = sumIm;
      }

      for (let bin = 1; bin < halfBins; bin++) {
        const freq = (bin * sampleRate) / fftSize;
        if (freq < 80 || freq > 4000) {
          continue;
        }
        const pitchClass = Math.round(12 * Math.log2(freq / 440)) % 12;
        const pc = ((pitchClass % 12) + 12) % 12;
        const magnitude = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]);
        chroma[pc] += magnitude;
      }
    }

    let bestScore = -Infinity;
    let bestKey = "C";
    let bestScale = "major";
    for (let root = 0; root < 12; root++) {
      let majorScore = 0;
      let minorScore = 0;
      for (let i = 0; i < 12; i++) {
        majorScore += chroma[(i + root) % 12] * majorTemplate[i];
        minorScore += chroma[(i + root) % 12] * minorTemplate[i];
      }
      if (majorScore > bestScore) {
        bestScore = majorScore;
        bestKey = noteNames[root];
        bestScale = "major";
      }
      if (minorScore > bestScore) {
        bestScore = minorScore;
        bestKey = noteNames[root];
        bestScale = "minor";
      }
    }
    console.log("detected key:", bestKey, bestScale);
    return { key: bestKey, scale: bestScale };
  };

  const decodeForAnalysis = async (file) => {
    const arrayBuffer = await file.arrayBuffer();
    const analysisCtx = new OfflineAudioContext(1, 1, 44100);
    return analysisCtx.decodeAudioData(arrayBuffer.slice(0));
  };

  const runBackgroundAnalysis = async (tracks) => {
    if (analyzingRef.current) {
      return;
    }
    analyzingRef.current = true;

    for (const track of tracks) {
      if (track.bpm != null && track.duration != null && track.key != null && track.scale != null) {
        continue;
      }
      setAnalyzingIds((prev) => ({ ...prev, [track.id]: true }));
      try {
        const decoded = await decodeForAnalysis(track.file);
        const bpm = detectBpm(decoded);
        console.log("calling detectKey...");
        const keyInfo = await detectKey(decoded);
        console.log("key result:", keyInfo);
        const duration = decoded.duration;
        setLibrary((prev) =>
          prev.map((t) =>
            t.id === track.id
              ? { ...t, bpm, duration, key: keyInfo.key, scale: keyInfo.scale }
              : t
          )
        );
      } catch (_err) {
        setLibrary((prev) =>
          prev.map((t) => (t.id === track.id ? { ...t, bpm: null, duration: null, key: null, scale: null } : t))
        );
      } finally {
        setAnalyzingIds((prev) => ({ ...prev, [track.id]: false }));
      }
    }
    analyzingRef.current = false;
  };

  useEffect(() => {
    if (!library.length) {
      return;
    }
    void saveTracksToDb(
      library.map((track) => ({
        id: track.id,
        name: track.name,
        file: track.file,
        duration: track.duration,
        bpm: track.bpm,
        key: track.key ?? null,
        scale: track.scale ?? null
      }))
    );
  }, [library]);

  useEffect(() => {
    if (library.some((t) => t.bpm == null || t.duration == null)) {
      void runBackgroundAnalysis(library);
    }
  }, [library]);

  const handleImportFolder = async (event) => {
    const files = Array.from(event.target.files || []);
    const audioFiles = files.filter((file) => {
      const lower = file.name.toLowerCase();
      return audioExt.some((ext) => lower.endsWith(ext));
    });

    const tracks = audioFiles.map((file) => ({
      id: crypto.randomUUID(),
      name: stripExt(file.name),
      file,
      duration: null,
      bpm: null,
      key: null,
      scale: null,
      loaded: false
    }));

    setLibrary((prev) => [...prev, ...tracks]);
    if (importRef.current) {
      importRef.current.value = "";
    }
  };

  const formatDuration = (seconds) => {
    if (seconds == null) {
      return "--:--";
    }
    const safe = Math.max(0, Math.floor(seconds));
    const min = Math.floor(safe / 60);
    const sec = String(safe % 60).padStart(2, "0");
    return `${min}:${sec}`;
  };

  const onTrackLoaded = (deck, trackId) => {
    setLoadedByDeck((prev) => ({ ...prev, [deck]: trackId }));
  };

  const onKeyDetected = (trackId, keyString) => {
    const [key, mode] = keyString.split(" ");
    const scale = mode?.toLowerCase() === "maj" ? "major" : mode?.toLowerCase() === "min" ? "minor" : null;
    setLibrary((prev) =>
      prev.map((track) =>
        track.id === trackId
          ? {
              ...track,
              key: key ?? track.key,
              scale: scale ?? track.scale,
              keyLabel: keyString
            }
          : track
      )
    );
  };

  const loadTrackToDeck = async (deck, track) => {
    const ref = deck === "a" ? deckARef : deckBRef;
    const ok = await ref.current?.loadTrack?.(track.file, track.id);
    if (ok) {
      setLoadedByDeck((prev) => ({ ...prev, [deck]: track.id }));
    }
  };

  const addToQueue = (trackId, playNext = false) => {
    setQueue((prev) => {
      const filtered = prev.filter((id) => id !== trackId);
      return playNext ? [trackId, ...filtered] : [...filtered, trackId];
    });
  };

  const loadByDoubleClick = async (track) => {
    const deckAEmpty = !deckARef.current?.isReady?.();
    const deckBEmpty = !deckBRef.current?.isReady?.();

    if (deckAEmpty && deckBEmpty) {
      await loadTrackToDeck("a", track);
      return;
    }
    if (deckAEmpty) {
      await loadTrackToDeck("a", track);
      return;
    }
    if (deckBEmpty) {
      await loadTrackToDeck("b", track);
      return;
    }
    addToQueue(track.id);
    showToast("+ Added to Queue");
    setDeckFlash({ a: true, b: true });
    window.setTimeout(() => setDeckFlash({ a: false, b: false }), 260);
  };

  const deckATrack = library.find((t) => t.id === loadedByDeck.a);
  const deckAPlaying = !!deckARef.current?.isPlaying?.();

  const startAutoMix = async () => {
    if (autoMixing) {
      return;
    }
    const audioContext = getAudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    contextReadyRef.current = true;

    const sourceDeck = masterDeck;
    const targetDeck = sourceDeck === "a" ? "b" : "a";
    const sourceRef = sourceDeck === "a" ? deckARef : deckBRef;
    const targetRef = targetDeck === "a" ? deckARef : deckBRef;

    const sourceBpm = sourceRef.current?.getCurrentBpm?.() ?? bpmByDeck[sourceDeck];
    if (!sourceBpm || !sourceRef.current?.isPlaying?.()) {
      return;
    }

    targetRef.current?.syncToBpm?.(sourceBpm);

    if (!targetRef.current?.isReady?.()) {
      return;
    }

    const beatDuration = 60 / sourceBpm;
    const now = audioContext.currentTime;
    const sourceAnchor = sourceRef.current?.getTransportAnchorTime?.() ?? now;
    const currentBeat = (now - sourceAnchor) / beatDuration;
    const nextBoundaryBeat = Math.ceil(currentBeat / 16) * 16;
    const beatsUntilBoundary = Math.max(nextBoundaryBeat - currentBeat, 0);
    const crossfadeStartTime = now + beatsUntilBoundary * beatDuration;
    const transitionDuration = TRANSITION_DURATION_SECONDS;
    const targetStartTime = crossfadeStartTime - transitionDuration / 2;

    try {
      await targetRef.current.playAt(targetStartTime, 0);
      sourceRef.current?.setGain?.(1);
      targetRef.current?.setGain?.(0);
      sourceRef.current?.setEqBandGain?.("low", 0);
      targetRef.current?.setEqBandGain?.("low", -12);

      const points = 512;
      const gainCurveA = new Float32Array(points);
      const gainCurveB = new Float32Array(points);
      for (let i = 0; i < points; i++) {
        const t = i / (points - 1);
        gainCurveA[i] = Math.cos(t * Math.PI * 0.5);
        gainCurveB[i] = Math.sin(t * Math.PI * 0.5);
      }

      const sourceGainCurve = gainCurveA;
      const targetGainCurve = gainCurveB;
      sourceRef.current?.scheduleGainCurve?.(sourceGainCurve, crossfadeStartTime, transitionDuration);
      targetRef.current?.scheduleGainCurve?.(targetGainCurve, crossfadeStartTime, transitionDuration);
      const halfDuration = transitionDuration / 2;
      sourceRef.current?.scheduleEqBandRamp?.("low", 0, -12, crossfadeStartTime, halfDuration);
      targetRef.current?.scheduleEqBandRamp?.("low", -12, 0, crossfadeStartTime + halfDuration, halfDuration);
      setAutoMixing(true);

      const uiTick = () => {
        const currentTime = audioContext.currentTime;
        const remainingBeats = Math.max((crossfadeStartTime - currentTime) / beatDuration, 0);
        setAutoMixBars(Math.ceil(remainingBeats));

        const t = Math.min(Math.max((currentTime - crossfadeStartTime) / transitionDuration, 0), 1);
        setFade(sourceDeck === "a" ? t : 1 - t);

        if (currentTime < crossfadeStartTime + transitionDuration) {
          autoMixCountdownFrameRef.current = requestAnimationFrame(uiTick);
        } else {
          sourceRef.current?.pause();
          targetRef.current?.startTempoRelease?.(8);
          sourceRef.current?.setGain?.(1);
          targetRef.current?.setGain?.(1);
          sourceRef.current?.setEqBandGain?.("low", 0);
          targetRef.current?.setEqBandGain?.("low", 0);
          setFade(targetDeck === "b" ? 1 : 0);
          setAutoMixBars(0);
          setAutoMixing(false);
          setMasterDeck(targetDeck);
          const nextId = queue[0];
          if (nextId) {
            const nextTrack = library.find((t) => t.id === nextId);
            if (nextTrack) {
              void loadTrackToDeck(sourceDeck, nextTrack);
            }
            setQueue((prev) => prev.slice(1));
          }
        }
      };
      autoMixCountdownFrameRef.current = requestAnimationFrame(uiTick);
    } catch (_err) {
      setAutoMixing(false);
      setAutoMixBars(0);
    }
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(autoMixCountdownFrameRef.current);
    };
  }, []);

  return (
    <main className="app">
      <section className="decks-section">
        <div className="mixer-layout">
          <Deck
            ref={deckARef}
            title="Deck A"
            channel="a"
            color="#4a9eff"
            contextReadyRef={contextReadyRef}
            ownBpm={bpmByDeck.a}
            otherBpm={bpmByDeck.b}
            onBpmChange={onBpmChange}
            onTrackLoaded={onTrackLoaded}
            onKeyDetected={onKeyDetected}
            onDeckPlayStart={setMasterDeck}
            flash={deckFlash.a}
          />

          <section className="crossfader-panel">
            <div className="wordmark">MAZZY</div>
            <div className="direction-indicator">{getDirectionLabel()}</div>
            <label htmlFor="crossfader">Crossfader</label>
            <input
              id="crossfader"
              className="crossfader"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={fade}
              onChange={onCrossFade}
            />
            <button className="auto-mix-btn" type="button" onClick={startAutoMix} disabled={autoMixing}>
              {autoMixing ? `AUTO MIX: ${autoMixBars ?? 0} bars` : "AUTO MIX"}
            </button>
            <div className="crossfader-labels">
              <span>A</span>
              <span>B</span>
            </div>
          </section>

          <Deck
            ref={deckBRef}
            title="Deck B"
            channel="b"
            color="#ff4a6e"
            contextReadyRef={contextReadyRef}
            ownBpm={bpmByDeck.b}
            otherBpm={bpmByDeck.a}
            onBpmChange={onBpmChange}
            onTrackLoaded={onTrackLoaded}
            onKeyDetected={onKeyDetected}
            onDeckPlayStart={setMasterDeck}
            flash={deckFlash.b}
          />
        </div>
      </section>

      <section className="library-section">
        <section className="library-panel">
          <div className="queue-header">
            <div className="queue-title">{`QUEUE (${queue.length} tracks)`}</div>
            <div className="library-top-spacer" />
            <button className="library-top-btn" type="button" onClick={() => importRef.current?.click()}>
              IMPORT
            </button>
            <input ref={importRef} type="file" multiple accept=".mp3,.wav,.flac" onChange={handleImportFolder} hidden />
            <button className="library-top-btn" type="button" onClick={() => setQueue([])}>
              CLEAR
            </button>
          </div>

          <div className="queue-panel">
            {queueTracks.length ? (
              queueTracks.map((track, index) => (
                <div
                  key={`${track.id}-${index}`}
                  className="queue-item"
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragIndex == null || dragIndex === index) return;
                    setQueue((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(dragIndex, 1);
                      next.splice(index, 0, moved);
                      return next;
                    });
                    setDragIndex(null);
                  }}
                >
                  <span className="queue-pos">{index + 1}.</span>
                  <span className="queue-name">{track.name}</span>
                  <span className="queue-meta">{track.bpm != null ? track.bpm.toFixed(1) : "--"} BPM</span>
                  <span className="queue-meta">
                    {track.keyLabel || (track.key && track.scale ? `${track.key} ${track.scale === "major" ? "maj" : "min"}` : "--")}
                  </span>
                  <button
                    type="button"
                    className="queue-remove"
                    onClick={() => setQueue((prev) => prev.filter((_, idx) => idx !== index))}
                  >
                    X
                  </button>
                </div>
              ))
            ) : (
              <div className="queue-empty">QUEUE EMPTY - click tracks to add</div>
            )}
          </div>

          <div className="library-title">LIBRARY ({library.length} tracks)</div>

          <div className="library-grid">
            <div className="library-header-row">
              <div className="library-head">TRACK NAME</div>
              <div className="library-head">DURATION</div>
              <div className="library-head">BPM</div>
              <div className="library-head">KEY</div>
            </div>

            {library.map((track, index) => {
              const loadedA = loadedByDeck.a === track.id;
              const loadedB = loadedByDeck.b === track.id;
              const analyzing = !!analyzingIds[track.id];
              const keyCompatible =
                deckAPlaying &&
                deckATrack?.key &&
                deckATrack?.scale &&
                track.key &&
                track.scale &&
                deckATrack.key === track.key &&
                deckATrack.scale === track.scale;
              return (
                <div
                  key={track.id}
                  className={`library-row ${index % 2 ? "odd" : "even"} ${loadedA || loadedB ? "selected" : ""} ${
                    loadedA ? "loaded-a" : loadedB ? "loaded-b" : ""
                  } ${keyCompatible ? "key-compatible" : ""}`}
                  onClick={() => void loadByDoubleClick(track)}
                  onDoubleClick={() => void loadByDoubleClick(track)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, trackId: track.id });
                  }}
                >
                  <div className="cell name-cell">
                  {loadedA && <span className="row-indicator row-a">[A]</span>}
                  {loadedB && <span className="row-indicator row-b">[B]</span>}
                    {!loadedA && !loadedB && queuePositionMap.has(track.id) && (
                    <span className="row-indicator row-q">{`[${queuePositionMap.get(track.id)}]`}</span>
                    )}
                    {track.name}
                  </div>
                  <div className="cell">{formatDuration(track.duration)}</div>
                  <div className="cell">{analyzing ? <span className="spin">○</span> : track.bpm != null ? track.bpm.toFixed(1) : "--"}</div>
                  <div className="cell">
                    {track.keyLabel || (track.key && track.scale ? `${track.key} ${track.scale === "major" ? "maj" : "min"}` : "--")}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </section>
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            type="button"
            onClick={() => {
              const track = library.find((t) => t.id === contextMenu.trackId);
              if (track) {
                void loadTrackToDeck("a", track);
              }
              setContextMenu(null);
            }}
          >
            Load to Deck A
          </button>
          <button
            type="button"
            onClick={() => {
              const track = library.find((t) => t.id === contextMenu.trackId);
              if (track) {
                void loadTrackToDeck("b", track);
              }
              setContextMenu(null);
            }}
          >
            Load to Deck B
          </button>
          <button
            type="button"
            onClick={() => {
              addToQueue(contextMenu.trackId);
              setContextMenu(null);
            }}
          >
            Add to Queue
          </button>
          <button
            type="button"
            onClick={() => {
              addToQueue(contextMenu.trackId, true);
              setContextMenu(null);
            }}
          >
            Play Next
          </button>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
