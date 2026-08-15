export const PRIVATE_LISTENING_EXCERPT_SECONDS = 12;
export const PRIVATE_LISTENING_MINIMUM_SECONDS = 10;

export type PrivateExcerptPlan = Readonly<{
  frameCount: number;
  startFrame: number;
}>;

export const planPrivateExcerpt = (
  decodedFrames: number,
  sampleRate: number,
  seconds = PRIVATE_LISTENING_EXCERPT_SECONDS
): PrivateExcerptPlan => {
  if (!Number.isInteger(decodedFrames) || decodedFrames < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
    !Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError("invalid private excerpt input");
  }
  const frameCount = Math.min(decodedFrames, Math.round(seconds * sampleRate));
  if (frameCount < sampleRate * PRIVATE_LISTENING_MINIMUM_SECONDS) {
    throw new RangeError("audio is too short for the complete listening trial");
  }
  const maxStart = Math.max(0, decodedFrames - frameCount);
  return Object.freeze({
    frameCount,
    startFrame: Math.min(maxStart, Math.round(decodedFrames * 0.34))
  });
};
