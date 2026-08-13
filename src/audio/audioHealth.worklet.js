class MazzyAudioHealthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.expectedActive = false;
    this.resetCounters();
    this.port.onmessage = (event) => {
      if (event.data?.type === "expected-active") {
        this.expectedActive = event.data.value === true;
        if (!this.expectedActive) this.currentSilentFrames = 0;
      } else if (event.data?.type === "reset" && !this.expectedActive) {
        this.resetCounters();
        this.port.postMessage({ type: "reset-ack", token: event.data.token });
      }
    };
  }

  resetCounters() {
    this.framesSinceReport = 0;
    this.expectedActiveFrames = 0;
    this.silentFrames = 0;
    this.renderQuanta = 0;
    this.nonFiniteSamples = 0;
    this.clippedSamples = 0;
    this.peak = 0;
    this.currentSilentFrames = 0;
    this.longestSilentFrames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const frameCount = input[0]?.length ?? 128;
    this.renderQuanta += 1;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let framePeak = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        const sample = input[channel]?.[frame] ?? 0;
        if (!Number.isFinite(sample)) this.nonFiniteSamples += 1;
        else {
          const magnitude = Math.abs(sample);
          framePeak = Math.max(framePeak, magnitude);
          this.peak = Math.max(this.peak, magnitude);
          if (magnitude > 1) this.clippedSamples += 1;
        }
      }
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][frame] = input[channel % Math.max(1, input.length)]?.[frame] ?? 0;
      }
      if (this.expectedActive && framePeak <= 1e-5) {
        this.expectedActiveFrames += 1;
        this.silentFrames += 1;
        this.currentSilentFrames += 1;
        this.longestSilentFrames = Math.max(this.longestSilentFrames, this.currentSilentFrames);
      } else {
        if (this.expectedActive) this.expectedActiveFrames += 1;
        this.currentSilentFrames = 0;
      }
    }
    this.framesSinceReport += frameCount;
    if (this.framesSinceReport >= sampleRate) {
      this.port.postMessage({
        type: "health",
        frames: this.framesSinceReport,
        expectedActiveFrames: this.expectedActiveFrames,
        silentFrames: this.silentFrames,
        renderQuanta: this.renderQuanta,
        nonFiniteSamples: this.nonFiniteSamples,
        clippedSamples: this.clippedSamples,
        peak: this.peak,
        longestSilentFrames: this.longestSilentFrames,
        sampleRate
      });
      this.framesSinceReport = 0;
      this.expectedActiveFrames = 0;
      this.silentFrames = 0;
      this.renderQuanta = 0;
      this.nonFiniteSamples = 0;
      this.clippedSamples = 0;
      this.peak = 0;
      this.longestSilentFrames = 0;
    }
    return true;
  }
}

registerProcessor("mazzy-audio-health-v2", MazzyAudioHealthProcessor);
