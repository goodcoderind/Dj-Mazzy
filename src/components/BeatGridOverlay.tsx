import { useEffect, useRef } from "react";

type BeatGridOverlayProps = {
  beatsSeconds: number[];
  downbeatsSeconds: number[];
  durationSeconds: number;
  color: string;
};

const roundedTime = (seconds: number) => Math.round(seconds * 1000);

export default function BeatGridOverlay({
  beatsSeconds,
  downbeatsSeconds,
  durationSeconds,
  color
}: BeatGridOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      if (!durationSeconds || bounds.width <= 0) return;

      const downbeatSet = new Set(downbeatsSeconds.map(roundedTime));
      let lastBeatX = -Infinity;
      for (const beat of beatsSeconds) {
        const x = (beat / durationSeconds) * bounds.width;
        const downbeat = downbeatSet.has(roundedTime(beat));
        if (!downbeat && x - lastBeatX < 2) continue;
        context.beginPath();
        context.moveTo(Math.round(x) + 0.5, downbeat ? 0 : bounds.height * 0.45);
        context.lineTo(Math.round(x) + 0.5, bounds.height);
        context.strokeStyle = downbeat ? "rgba(200, 169, 110, 0.9)" : `${color}66`;
        context.lineWidth = downbeat ? 2 : 1;
        context.stroke();
        lastBeatX = x;
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [beatsSeconds, color, downbeatsSeconds, durationSeconds]);

  return (
    <canvas
      ref={canvasRef}
      className="beat-grid-overlay"
      aria-label={`${beatsSeconds.length} beat markers and ${downbeatsSeconds.length} downbeat markers`}
    />
  );
}
