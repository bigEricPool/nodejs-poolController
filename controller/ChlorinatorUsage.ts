// Output reports normally arrive every few seconds. Longer intervals are estimates.
export const chlorinatorUsageGapMs = 60 * 1000;
const trackingStartedAt = Date.now();

/** Equivalent full-output hours between two observations; timestamps are epoch ms. */
export function chlorinatorUsageHours(previousOutput: number, output: number,
    previousAt: number, observedAt: number, sessionStartedAt: number = trackingStartedAt): number {
    if (!Number.isFinite(previousAt) || previousAt <= 0 || observedAt <= previousAt ||
        !Number.isFinite(observedAt) || !Number.isFinite(previousOutput) || !Number.isFinite(output)) return 0;
    const elapsed = observedAt - previousAt;
    const percent = elapsed > chlorinatorUsageGapMs || previousAt < sessionStartedAt
        ? (previousOutput + output) / 2 : previousOutput;
    return elapsed / 3600000 * Math.max(0, Math.min(100, percent)) / 100;
}
