import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AppFatalBoundary from "../AppFatalBoundary";
import { getAudioEngine } from "../audio/audioEngineSingleton";
import { MASTER_DSP_V1 } from "../audio/masterDsp";
import { MAZZY_ROOT_ERROR_OPTIONS } from "../reactRootErrorOptions";
import { installFatalHostEventBoundary } from "../audio/fatalHostEventBoundary";
import "../App.css";

const ThrowPrivateDiagnosticError = () => {
  throw new Error("private-song.wav track-private-id /private/local/path");
};

const asyncFault = new URLSearchParams(window.location.search).get("fault") === "async";

const FatalRecoveryLauncher = () => {
  const [crash, setCrash] = useState(false);
  const [status, setStatus] = useState(null);
  if (crash) return <ThrowPrivateDiagnosticError />;
  const run = async () => {
    try {
      const engine = getAudioEngine();
      await engine.resume();
      const frames = Math.round(engine.context.sampleRate * 2);
      const channel = new Float32Array(frames).fill(0.08);
      engine.playProtectedPreview({
        kind: "pre-master-stereo/v1",
        requiredMasterVersion: MASTER_DSP_V1.version,
        sampleRate: engine.context.sampleRate,
        channels: [channel, channel]
      });
      document.documentElement.dataset.mazzyFatalPreviewArmed = "true";
      engine.scheduleAuditionClicks([{ audioTime: engine.clock.now() + 0.75, downbeat: true }]);
      document.documentElement.dataset.mazzyFatalAuditionArmed = "true";
      if (asyncFault) {
        queueMicrotask(() => {
          document.documentElement.dataset.mazzyFatalFaultDispatched = "true";
          void Promise.reject(new Error("private-song.wav track-private-id /private/local/path"));
        });
      } else {
        setCrash(true);
      }
    } catch {
      setStatus("Diagnostic audio setup did not complete. No deliberate fault was dispatched.");
    }
  };
  return (
    <main className="fatal-host-recovery">
      <section className="fatal-host-recovery-card">
        <p className="fatal-host-recovery-kicker">DIAGNOSTIC · GENERATED AUDIO ONLY</p>
        <h1>Fatal host recovery check</h1>
        <p>{asyncFault
          ? "This starts a local generated tone, then deliberately rejects an unhandled page task."
          : "This starts a local generated tone, then deliberately fails the React child tree."}</p>
        <div className="fatal-host-recovery-actions">
          <button type="button" onClick={() => void run()}>START ACTIVE AUDIO AND CRASH TEST</button>
        </div>
        {status && <p role="alert">{status}</p>}
      </section>
    </main>
  );
};

installFatalHostEventBoundary();
createRoot(document.getElementById("root"), MAZZY_ROOT_ERROR_OPTIONS).render(
  <AppFatalBoundary>
    <FatalRecoveryLauncher />
  </AppFatalBoundary>
);
