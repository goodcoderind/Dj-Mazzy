import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import MusicTempoModule from "music-tempo";
import { getAudioContext } from "../audioContext";

const clampTempo = (value) => Math.max(0.5, Math.min(1.5, value));
const MusicTempo = MusicTempoModule.default ?? MusicTempoModule;

const readFileAsArrayBuffer = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read audio file"));
    reader.readAsArrayBuffer(file);
  });

const formatTime = (seconds) => {
  const safe = Math.max(0, Math.floor(seconds));
  const min = Math.floor(safe / 60);
  const sec = String(safe % 60).padStart(2, "0");
  return `${min}:${sec}`;
};

const parseTimeToSeconds = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const sec = Number(parts[0]);
    return Number.isFinite(sec) ? sec : null;
  }
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!Number.isFinite(min) || !Number.isFinite(sec)) {
      return null;
    }
    return min * 60 + sec;
  }
  return null;
};

const Deck = forwardRef(function Deck(
  {
    title,
    channel,
    color,
    contextReadyRef,
    otherBpm,
    onBpmChange,
    onTrackLoaded,
    onKeyDetected,
    onDeckPlayStart,
    flash
  },
  ref
) {
  const waveformRef = useRef(null);
  const fileInputRef = useRef(null);
  const wavesurferRef = useRef(null);
  const lastObjectUrlRef = useRef(null);
  const rafRef = useRef(0);
  const releaseRafRef = useRef(0);

  const deckStateRef = useRef({
    buffer: null,
    gainNode: null,
    lowFilter: null,
    midFilter: null,
    highFilter: null,
    sourceNode: null,
    isPlaying: false,
    startTime: 0,
    startOffset: 0,
    playbackRate: 1,
    originalPlaybackRate: 1
  });

  const [fileReady, setFileReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [timeInput, setTimeInput] = useState("");
  const [trackName, setTrackName] = useState("NO TRACK LOADED");
  const [bpmLabel, setBpmLabel] = useState("--");
  const [keyLabel, setKeyLabel] = useState("--");
  const [tempo, setTempo] = useState(1);
  const [originalBpm, setOriginalBpm] = useState(null);
  const [syncActive, setSyncActive] = useState(false);
  const [syncTargetBpm, setSyncTargetBpm] = useState(null);
  const [scratch, setScratch] = useState(false);
  const [rotationDuration, setRotationDuration] = useState(1.8);
  const [eq, setEq] = useState({ low: 0, mid: 0, high: 0 });
  const [eqKill, setEqKill] = useState({ low: false, mid: false, high: false });
  const eqBeforeKillRef = useRef({ low: 0, mid: 0, high: 0 });
  const currentTrackIdRef = useRef(null);

  const ensureGraphReady = async () => {
    const audioContext = getAudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (!deckStateRef.current.gainNode) {
      const lowFilter = audioContext.createBiquadFilter();
      lowFilter.type = "lowshelf";
      lowFilter.frequency.value = 320;

      const midFilter = audioContext.createBiquadFilter();
      midFilter.type = "peaking";
      midFilter.frequency.value = 1000;
      midFilter.Q.value = 0.5;

      const highFilter = audioContext.createBiquadFilter();
      highFilter.type = "highshelf";
      highFilter.frequency.value = 3200;

      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1;
      lowFilter.connect(midFilter);
      midFilter.connect(highFilter);
      highFilter.connect(gainNode);
      gainNode.connect(audioContext.destination);
      deckStateRef.current.lowFilter = lowFilter;
      deckStateRef.current.midFilter = midFilter;
      deckStateRef.current.highFilter = highFilter;
      deckStateRef.current.gainNode = gainNode;
    }
    contextReadyRef.current = true;
    return audioContext;
  };

  const getCurrentTime = () => {
    const deck = deckStateRef.current;
    if (!deck.isPlaying || !deck.sourceNode) {
      return deck.startOffset;
    }
    const audioContext = getAudioContext();
    return deck.startOffset + (audioContext.currentTime - deck.startTime) * deck.playbackRate;
  };

  const stopSource = () => {
    const deck = deckStateRef.current;
    if (deck.sourceNode) {
      try {
        deck.sourceNode.stop();
      } catch (_err) {
        // Source might already be stopped.
      }
      deck.sourceNode.disconnect();
      deck.sourceNode = null;
    }
  };

  const play = async (offset = null, when = null, notifyMaster = true) => {
    const audioContext = await ensureGraphReady();
    const deck = deckStateRef.current;
    if (!deck.buffer) {
      return false;
    }

    stopSource();

    const requestedOffset = offset == null ? getCurrentTime() : offset;
    const safeOffset = Math.max(0, Math.min(requestedOffset, Math.max(deck.buffer.duration - 0.01, 0)));
    const startAt = when == null ? audioContext.currentTime : Math.max(when, audioContext.currentTime);

    const source = audioContext.createBufferSource();
    source.buffer = deck.buffer;
    source.playbackRate.value = deck.playbackRate;
    source.connect(deck.lowFilter);
    source.onended = () => {
      if (deckStateRef.current.sourceNode === source) {
        deckStateRef.current.sourceNode = null;
        deckStateRef.current.isPlaying = false;
        setIsPlaying(false);
      }
    };

    deck.startOffset = safeOffset;
    deck.startTime = startAt;
    deck.sourceNode = source;
    deck.isPlaying = true;
    setIsPlaying(true);

    if (when == null) {
      const logPrefix = title === "Deck A" ? "Playing deck A, gain:" : `Playing ${title}, gain:`;
      console.log(logPrefix, deck.gainNode.gain.value);
      source.start(0, safeOffset);
      if (notifyMaster) {
        onDeckPlayStart?.(channel);
      }
    } else {
      source.start(startAt, safeOffset);
    }
    return true;
  };

  const pause = () => {
    const deck = deckStateRef.current;
    deck.startOffset = getCurrentTime();
    deck.isPlaying = false;
    setIsPlaying(false);
    stopSource();
  };

  const seek = async (seconds) => {
    const deck = deckStateRef.current;
    if (!deck.buffer) {
      return;
    }
    const safeOffset = Math.max(0, Math.min(seconds, Math.max(deck.buffer.duration - 0.01, 0)));
    const wasPlaying = deck.isPlaying;

    if (wasPlaying) {
      await play(safeOffset);
    } else {
      deck.startOffset = safeOffset;
    }

    setScratch(true);
    window.setTimeout(() => setScratch(false), 140);

    wavesurferRef.current?.seekTo(safeOffset / deck.buffer.duration);
    setCurrentTimeSec(safeOffset);
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
        if (freq < 80 || freq > 4000) continue;
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

  const analyzeBpm = async (audioBuffer) => {
    try {
      const pcmData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const hopSize = Math.max(128, Math.round(sampleRate * 0.01));
      const mt = new MusicTempo(pcmData, {
        hopSize,
        timeStep: hopSize / sampleRate
      });
      const rawDetectedBpm = Number(mt.tempo);
      console.log(`[${title}] raw detected BPM:`, rawDetectedBpm);

      let detectedBpm = rawDetectedBpm;
      while (detectedBpm > 160) detectedBpm /= 2;
      while (detectedBpm < 70) detectedBpm *= 2;
      detectedBpm = Math.round(detectedBpm * 10) / 10;
      setOriginalBpm(detectedBpm);
      setBpmLabel(String(detectedBpm));
      onBpmChange(channel, detectedBpm);

      console.log("calling detectKey...");
      const keyResult = await detectKey(audioBuffer);
      console.log("key result:", keyResult);
      const keyString = `${keyResult.key} ${keyResult.scale === "major" ? "maj" : "min"}`;
      setKeyLabel(keyString);
      if (currentTrackIdRef.current) {
        onKeyDetected?.(currentTrackIdRef.current, keyString);
      }
    } catch {
      setOriginalBpm(null);
      setBpmLabel("n/a");
      setKeyLabel("--");
      onBpmChange(channel, null);
    }
  };

  const createWaveSurfer = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }
    wavesurferRef.current = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: `${color}88`,
      progressColor: color,
      cursorColor: "#f3f5ff",
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      height: 120,
      interact: true
    });
    wavesurferRef.current.on("click", (progress) => {
      const deck = deckStateRef.current;
      if (!deck.buffer) return;
      void seek(progress * deck.buffer.duration);
    });
  };

  useEffect(() => {
    createWaveSurfer();

    const updateDisplay = () => {
      const deck = deckStateRef.current;
      if (deck.buffer) {
        const current = getCurrentTime();
        const bounded = Math.min(current, deck.buffer.duration);
        setCurrentTimeSec(bounded);
        wavesurferRef.current?.seekTo(deck.buffer.duration > 0 ? bounded / deck.buffer.duration : 0);
      } else {
        setCurrentTimeSec(0);
      }
      rafRef.current = requestAnimationFrame(updateDisplay);
    };
    rafRef.current = requestAnimationFrame(updateDisplay);

    return () => {
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(releaseRafRef.current);
      wavesurferRef.current?.destroy();
      stopSource();
      deckStateRef.current.lowFilter?.disconnect();
      deckStateRef.current.midFilter?.disconnect();
      deckStateRef.current.highFilter?.disconnect();
      deckStateRef.current.gainNode?.disconnect();
      if (lastObjectUrlRef.current) {
        URL.revokeObjectURL(lastObjectUrlRef.current);
      }
    };
  }, [color]);

  const loadFileToDeck = async (file, trackId = null) => {
    if (!file) {
      return false;
    }

    const objectUrl = URL.createObjectURL(file);
    if (lastObjectUrlRef.current) {
      URL.revokeObjectURL(lastObjectUrlRef.current);
    }
    lastObjectUrlRef.current = objectUrl;
    createWaveSurfer();
    wavesurferRef.current?.load(objectUrl);

    setFileReady(false);
    setBpmLabel("...");
    setTrackName(file.name);
    setSyncActive(false);
    setTempo(1);

    const audioContext = await ensureGraphReady();
    const deck = deckStateRef.current;
    pause();
    deck.startOffset = 0;
    deck.playbackRate = 1;

    try {
      const arrayBuffer = await readFileAsArrayBuffer(file);
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      deck.buffer = null;
      deck.buffer = decoded;
      currentTrackIdRef.current = trackId;
      setFileReady(true);
      await analyzeBpm(decoded);
      onTrackLoaded?.(channel, trackId, file.name);
      return true;
    } catch {
      deck.buffer = null;
      setFileReady(false);
      setBpmLabel("n/a");
      onBpmChange(channel, null);
      return false;
    }
  };

  const onFileChange = async (event) => {
    const file = event.target.files?.[0];
    await loadFileToDeck(file, null);
  };

  const onPlayPause = async () => {
    const audioContext = getAudioContext();
    await audioContext.resume();
    if (!deckStateRef.current.buffer || !fileReady) {
      return;
    }
    if (deckStateRef.current.isPlaying) {
      pause();
      return;
    }
    deckStateRef.current.gainNode.gain.value = 1;
    await play();
  };

  const onTempoChange = async (event) => {
    const nextTempo = clampTempo(Number(event.target.value));
    setTempo(nextTempo);
    setSyncActive(false);
    setSyncTargetBpm(null);
    wavesurferRef.current?.setPlaybackRate(nextTempo);

    const deck = deckStateRef.current;
    const current = getCurrentTime();
    deck.playbackRate = nextTempo;
    if (deck.isPlaying) {
      await play(current);
    } else {
      deck.startOffset = current;
    }

    if (originalBpm) {
      onBpmChange(channel, Math.round(originalBpm * nextTempo * 10) / 10);
    }
  };

  useEffect(() => {
    const bpmNow = originalBpm ? originalBpm * tempo : null;
    if (!bpmNow || bpmNow <= 0) {
      setRotationDuration(1.8);
      return;
    }
    setRotationDuration((60 / bpmNow) * 2);
  }, [originalBpm, tempo]);

  const syncToBpm = async (targetBpm) => {
    if (!originalBpm || !targetBpm) {
      return null;
    }
    const syncedTempo = clampTempo(targetBpm / originalBpm);
    setTempo(syncedTempo);
    setSyncActive(true);
    setSyncTargetBpm(targetBpm);
    wavesurferRef.current?.setPlaybackRate(syncedTempo);

    const deck = deckStateRef.current;
    const current = getCurrentTime();
    deck.playbackRate = syncedTempo;
    if (deck.isPlaying) {
      await play(current);
    } else {
      deck.startOffset = current;
    }

    const currentBpm = Math.round(originalBpm * syncedTempo * 10) / 10;
    onBpmChange(channel, currentBpm);
    return syncedTempo;
  };

  const onSync = () => {
    if (!originalBpm || !otherBpm) {
      return;
    }
    void syncToBpm(otherBpm);
  };

  const releaseSyncInstant = async () => {
    const deck = deckStateRef.current;
    const current = getCurrentTime();
    setTempo(deck.originalPlaybackRate);
    setSyncActive(false);
    setSyncTargetBpm(null);
    wavesurferRef.current?.setPlaybackRate(deck.originalPlaybackRate);
    deck.playbackRate = deck.originalPlaybackRate;
    if (deck.isPlaying) {
      await play(current);
    } else {
      deck.startOffset = current;
    }
    if (originalBpm) {
      setBpmLabel(String(originalBpm));
      onBpmChange(channel, originalBpm);
    }
  };

  const startTempoRelease = (durationSeconds = 8) => {
    const deck = deckStateRef.current;
    const startRate = deck.playbackRate;
    const targetRate = deck.originalPlaybackRate;
    const audioContext = getAudioContext();
    if (deck.sourceNode) {
      const now = audioContext.currentTime;
      deck.sourceNode.playbackRate.cancelScheduledValues(now);
      deck.sourceNode.playbackRate.setValueAtTime(startRate, now);
      deck.sourceNode.playbackRate.linearRampToValueAtTime(targetRate, now + durationSeconds);
    }

    cancelAnimationFrame(releaseRafRef.current);
    const startedAt = performance.now();
    const tick = () => {
      const t = Math.min((performance.now() - startedAt) / (durationSeconds * 1000), 1);
      const nextRate = startRate + (targetRate - startRate) * t;
      setTempo(nextRate);
      wavesurferRef.current?.setPlaybackRate(nextRate);
      deck.playbackRate = nextRate;
      if (t < 1) {
        releaseRafRef.current = requestAnimationFrame(tick);
      } else {
        setTempo(targetRate);
        deck.playbackRate = targetRate;
        setSyncActive(false);
        setSyncTargetBpm(null);
        if (originalBpm) {
          setBpmLabel(String(originalBpm));
          onBpmChange(channel, originalBpm);
        }
      }
    };
    releaseRafRef.current = requestAnimationFrame(tick);
  };

  const setGain = (value) => {
    const deck = deckStateRef.current;
    const safe = Math.max(0, Math.min(1, Number(value)));
    if (deck.gainNode) {
      deck.gainNode.gain.value = safe;
    }
  };

  const applyBandGain = (band, gainValue) => {
    const deck = deckStateRef.current;
    const safe = Math.max(-12, Math.min(12, Number(gainValue)));
    if (band === "low" && deck.lowFilter) {
      deck.lowFilter.gain.value = safe;
    }
    if (band === "mid" && deck.midFilter) {
      deck.midFilter.gain.value = safe;
    }
    if (band === "high" && deck.highFilter) {
      deck.highFilter.gain.value = safe;
    }
  };

  const setEqBandGain = (band, gainValue) => {
    setEq((prev) => ({ ...prev, [band]: gainValue }));
    setEqKill((prev) => ({ ...prev, [band]: gainValue <= -12 }));
    applyBandGain(band, gainValue);
  };

  const toggleEqKill = (band) => {
    const nextEnabled = !eqKill[band];
    if (nextEnabled) {
      eqBeforeKillRef.current[band] = eq[band];
      setEq((prev) => ({ ...prev, [band]: -12 }));
      setEqKill((prev) => ({ ...prev, [band]: true }));
      applyBandGain(band, -12);
    } else {
      const restore = eqBeforeKillRef.current[band] ?? 0;
      setEq((prev) => ({ ...prev, [band]: restore }));
      setEqKill((prev) => ({ ...prev, [band]: false }));
      applyBandGain(band, restore);
    }
  };

  const scheduleEqBandRamp = (band, fromDb, toDb, startTime, duration) => {
    const deck = deckStateRef.current;
    let param = null;
    if (band === "low") {
      param = deck.lowFilter?.gain;
    } else if (band === "mid") {
      param = deck.midFilter?.gain;
    } else if (band === "high") {
      param = deck.highFilter?.gain;
    }
    if (!param) {
      return;
    }
    param.cancelScheduledValues(startTime);
    param.setValueAtTime(fromDb, startTime);
    param.linearRampToValueAtTime(toDb, startTime + duration);
    setEq((prev) => ({ ...prev, [band]: toDb }));
  };

  const scheduleGainCurve = (curve, startTime, duration) => {
    const gain = deckStateRef.current.gainNode?.gain;
    if (!gain || !curve?.length) {
      return;
    }
    gain.cancelScheduledValues(startTime);
    gain.setValueCurveAtTime(curve, startTime, duration);
  };

  useImperativeHandle(
    ref,
    () => ({
      isPlaying: () => deckStateRef.current.isPlaying,
      isReady: () => !!deckStateRef.current.buffer,
      getTransportAnchorTime: () =>
        deckStateRef.current.startTime - deckStateRef.current.startOffset / Math.max(deckStateRef.current.playbackRate, 0.001),
      getCurrentBpm: () => (originalBpm ? Math.round(originalBpm * tempo * 10) / 10 : null),
      play: async () => play(),
      playAt: async (startTime, offset = 0) => play(offset, startTime, false),
      loadTrack: async (file, trackId = null) => loadFileToDeck(file, trackId),
      getTrackId: () => currentTrackIdRef.current,
      pause: () => pause(),
      eject: () => {
        pause();
        deckStateRef.current.buffer = null;
        currentTrackIdRef.current = null;
        setFileReady(false);
        setTrackName("NO TRACK LOADED");
        setCurrentTimeSec(0);
      },
      syncToBpm: async (targetBpm) => syncToBpm(targetBpm),
      startTempoRelease: (durationSeconds = 8) => startTempoRelease(durationSeconds),
      releaseSyncInstant: async () => releaseSyncInstant(),
      setGain: (value) => setGain(value),
      setFilterCutoff: () => {},
      setEqBandGain: (band, db) => setEqBandGain(band, db),
      scheduleEqBandRamp: (band, fromDb, toDb, startTime, duration) =>
        scheduleEqBandRamp(band, fromDb, toDb, startTime, duration),
      scheduleGainCurve: (curve, startTime, duration) => scheduleGainCurve(curve, startTime, duration),
      scheduleFilterSweep: () => {}
    }),
    [originalBpm, tempo]
  );

  return (
    <section className={`deck ${flash ? "deck-flash" : ""}`}>
      <div className="deck-header">
        <h2>{title}</h2>
        <div className="bpm-display">{bpmLabel}</div>
      </div>
      <div className="track-name" title={trackName}>
        {trackName}
      </div>
      <div className="deck-top-actions">
        <button className="text-control-btn" type="button" onClick={() => fileInputRef.current?.click()}>
          LOAD TRACK
        </button>
      </div>
      <input ref={fileInputRef} className="file-input-hidden" type="file" accept="audio/*" onChange={onFileChange} />

      <div className="wave-section">
        <div
          className={`platter ${isPlaying ? "playing" : ""} ${scratch ? "scratch" : ""}`}
          style={{ animationDuration: `${rotationDuration}s` }}
        >
          <div className="platter-label" />
          <div className="platter-marker" />
        </div>
        <div className="waveform-wrap">
          <div className="waveform" ref={waveformRef} />
          <div className="playhead-line" />
        </div>
      </div>
      <div className="time-row">
        <span>{`${formatTime(currentTimeSec)} / ${formatTime(deckStateRef.current.buffer?.duration ?? 0)}`}</span>
        <input
          className="time-input"
          type="text"
          placeholder="0:34"
          value={timeInput}
          onChange={(event) => setTimeInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const parsed = parseTimeToSeconds(timeInput);
              if (parsed != null) {
                void seek(parsed);
              }
            }
          }}
          disabled={!fileReady}
        />
      </div>

      <div className="eq-panel">
        {["high", "mid", "low"].map((band) => (
          <div className="eq-band" key={band}>
            <label className="label-small">{band.toUpperCase()}</label>
            <div className="eq-track">
              <input
                className="eq-slider"
                type="range"
                min="-12"
                max="12"
                step="0.1"
                value={eq[band]}
                onChange={(event) => setEqBandGain(band, Number(event.target.value))}
                disabled={!fileReady}
              />
            </div>
            <button
              type="button"
              className={`kill-btn ${eqKill[band] ? "kill-on" : ""}`}
              onClick={() => toggleEqKill(band)}
              disabled={!fileReady}
            >
              K
            </button>
          </div>
        ))}
      </div>

      <div className="deck-row">
        <button className={`action-btn ${isPlaying ? "playing" : ""}`} type="button" onClick={onPlayPause} disabled={!fileReady}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          className={`secondary-btn ${syncActive ? "sync-active" : ""}`}
          type="button"
          onClick={onSync}
          disabled={!fileReady || !originalBpm || !otherBpm}
        >
          SYNC
        </button>
        <span className="bpm-pill">BPM {bpmLabel} | {keyLabel}</span>
      </div>
      {syncActive && syncTargetBpm && (
        <div className="sync-meta">
          <span>{`SYNCED TO ${Math.round(syncTargetBpm * 10) / 10} BPM`}</span>
          <button type="button" className="sync-release-btn" onClick={() => void releaseSyncInstant()}>
            X
          </button>
        </div>
      )}

      <label className="tempo">
        Tempo/Pitch: {tempo.toFixed(2)}x
        <div className="tempo-track">
          <input
            className="tempo-slider"
            type="range"
            min="0.5"
            max="1.5"
            step="0.01"
            value={tempo}
            onChange={onTempoChange}
            disabled={!fileReady}
          />
        </div>
      </label>
    </section>
  );
});

export default Deck;
