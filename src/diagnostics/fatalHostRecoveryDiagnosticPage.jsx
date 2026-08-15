import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AppFatalBoundary from "../AppFatalBoundary";
import { getAudioEngine } from "../audio/audioEngineSingleton";
import { MASTER_DSP_V1 } from "../audio/masterDsp";
import { MAZZY_ROOT_ERROR_OPTIONS } from "../reactRootErrorOptions";
import "../App.css";

const ThrowPrivateDiagnosticError = () => {
  throw new Error("private-song.wav track-private-id /private/local/path");
};

const FatalRecoveryLauncher = () => {
  const [crash, setCrash] = useState(false);
  if (crash) return <ThrowPrivateDiagnosticError />;
  const run = async () => {
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
    engine.scheduleAuditionClicks([{ audioTime: engine.clock.now() + 0.75, downbeat: true }]);
    setCrash(true);
  };
  return (
    <main className="fatal-host-recovery">
      <section className="fatal-host-recovery-card">
        <p className="fatal-host-recovery-kicker">DIAGNOSTIC · GENERATED AUDIO ONLY</p>
        <h1>Fatal host recovery check</h1>
        <p>This starts a local generated tone, then deliberately fails the React child tree.</p>
        <div className="fatal-host-recovery-actions">
          <button type="button" onClick={() => void run()}>START ACTIVE AUDIO AND CRASH TEST</button>
        </div>
      </section>
    </main>
  );
};

createRoot(document.getElementById("root"), MAZZY_ROOT_ERROR_OPTIONS).render(
  <AppFatalBoundary>
    <FatalRecoveryLauncher />
  </AppFatalBoundary>
);
