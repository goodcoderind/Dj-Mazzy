export const KEY_LOCK_SMOKE_SCHEMA_VERSION = "key-lock-smoke/v6" as const;
export const KEY_LOCK_SMOKE_RATES = Object.freeze([0.94, 1, 1.06] as const);
export const KEY_LOCK_SMOKE_PULSE_HZ = 16;

export type KeyLockSmokeMeasurement = Readonly<{
  rate: number;
  frequencyHz: number;
  centsError: number;
  rightFrequencyHz: number;
  rightCentsError: number;
  stereoLeakageDb: number;
  pulseRateHz: number;
  rightPulseRateHz: number;
  expectedPulseRateHz: number;
  tempoErrorPercent: number;
  rightTempoErrorPercent: number;
  leftOnsetErrorMs: number;
  rightOnsetErrorMs: number;
  leftPreStartPeak: number;
  rightPreStartPeak: number;
  armedLeadMs: number;
  finite: boolean;
  leftPeak: number;
  rightPeak: number;
  channelBalanceDb: number;
  leftCarrierProminenceDb: number;
  rightCarrierProminenceDb: number;
}>;

export const evaluateKeyLockSmoke = (
  sampleRate: number,
  measurements: readonly KeyLockSmokeMeasurement[]
) => {
  const failures: string[] = [];
  if (sampleRate !== 44_100 && sampleRate !== 48_000) failures.push("unsupported-sample-rate");
  if (measurements.length !== KEY_LOCK_SMOKE_RATES.length) failures.push("incomplete-rate-set");
  const seen = new Set<number>();
  for (const expectedRate of KEY_LOCK_SMOKE_RATES) {
    const matching = measurements.filter((candidate) => candidate?.rate === expectedRate);
    const cell = matching[0];
    if (!cell || matching.length !== 1 || seen.has(cell.rate)) {
      failures.push(`missing-or-duplicate-rate-${expectedRate}`);
      continue;
    }
    seen.add(cell.rate);
    const numeric = [cell.frequencyHz, cell.centsError, cell.rightFrequencyHz, cell.rightCentsError,
      cell.stereoLeakageDb, cell.pulseRateHz, cell.rightPulseRateHz,
      cell.expectedPulseRateHz, cell.tempoErrorPercent, cell.rightTempoErrorPercent,
      cell.leftOnsetErrorMs, cell.rightOnsetErrorMs,
      cell.leftPreStartPeak, cell.rightPreStartPeak, cell.armedLeadMs, cell.leftPeak, cell.rightPeak,
      cell.channelBalanceDb, cell.leftCarrierProminenceDb, cell.rightCarrierProminenceDb];
    if (!cell.finite || !numeric.every(Number.isFinite)) failures.push(`non-finite-${expectedRate}`);
    if (!(cell.leftPeak > 0.001)) failures.push(`left-silent-${expectedRate}`);
    if (!(cell.rightPeak > 0.001)) failures.push(`right-silent-${expectedRate}`);
    if (cell.leftPeak > 1) failures.push(`left-clipped-${expectedRate}`);
    if (cell.rightPeak > 1) failures.push(`right-clipped-${expectedRate}`);
    const derivedChannelBalanceDb = 20 * Math.log10(Math.max(cell.leftPeak, 1e-12) / Math.max(cell.rightPeak, 1e-12));
    if (!Number.isFinite(derivedChannelBalanceDb) || Math.abs(derivedChannelBalanceDb) > 6 ||
      Math.abs(derivedChannelBalanceDb - cell.channelBalanceDb) > 1e-6) failures.push(`channel-balance-${expectedRate}`);
    if (cell.leftCarrierProminenceDb < 15) failures.push(`left-carrier-prominence-${expectedRate}`);
    if (cell.rightCarrierProminenceDb < 15) failures.push(`right-carrier-prominence-${expectedRate}`);
    if (cell.leftPreStartPeak > 0.001 || cell.rightPreStartPeak > 0.001) failures.push(`pre-start-output-${expectedRate}`);
    if (cell.leftOnsetErrorMs < 0 || cell.leftOnsetErrorMs > 13 ||
      cell.rightOnsetErrorMs < 0 || cell.rightOnsetErrorMs > 13) failures.push(`onset-${expectedRate}`);
    if (cell.armedLeadMs < 25) failures.push(`onset-coverage-${expectedRate}`);
    const derivedCentsError = 1200 * Math.log2(cell.frequencyHz / 440);
    const derivedRightCentsError = 1200 * Math.log2(cell.rightFrequencyHz / 660);
    const derivedTempoErrorPercent = Math.abs(cell.pulseRateHz - KEY_LOCK_SMOKE_PULSE_HZ * expectedRate) /
      (KEY_LOCK_SMOKE_PULSE_HZ * expectedRate) * 100;
    const derivedRightTempoErrorPercent = Math.abs(cell.rightPulseRateHz - KEY_LOCK_SMOKE_PULSE_HZ * expectedRate) /
      (KEY_LOCK_SMOKE_PULSE_HZ * expectedRate) * 100;
    if (!Number.isFinite(derivedCentsError) || Math.abs(derivedCentsError) > 10 ||
      Math.abs(derivedCentsError - cell.centsError) > 1e-6) failures.push(`pitch-${expectedRate}`);
    if (!Number.isFinite(derivedRightCentsError) || Math.abs(derivedRightCentsError) > 10 ||
      Math.abs(derivedRightCentsError - cell.rightCentsError) > 1e-6) failures.push(`right-pitch-${expectedRate}`);
    if (cell.stereoLeakageDb > -30) failures.push(`stereo-leakage-${expectedRate}`);
    if (!Number.isFinite(derivedTempoErrorPercent) || derivedTempoErrorPercent > 0.2 ||
      Math.abs(derivedTempoErrorPercent - cell.tempoErrorPercent) > 1e-6) failures.push(`tempo-${expectedRate}`);
    if (!Number.isFinite(derivedRightTempoErrorPercent) || derivedRightTempoErrorPercent > 0.2 ||
      Math.abs(derivedRightTempoErrorPercent - cell.rightTempoErrorPercent) > 1e-6) failures.push(`right-tempo-${expectedRate}`);
    if (Math.abs(cell.expectedPulseRateHz - KEY_LOCK_SMOKE_PULSE_HZ * expectedRate) > 1e-9) failures.push(`expected-tempo-${expectedRate}`);
  }
  return Object.freeze({ passed: failures.length === 0, failureCodes: Object.freeze(failures) });
};
