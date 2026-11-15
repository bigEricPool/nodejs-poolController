// The range for where the next FC test is likely to read (AutoSwgResult.projectedFcRange, controller/AutoSwgService.ts). Its misses must come
// from the walk-forward projection (each past interval projected with the average and weighting in use then), not from today's average applied
// to every past interval: on 2026-11-14 that showed +/-5.0 ppm on the user's pool, where the projection had really missed by about +/-2, because
// the burn had fallen from about 2 ppm/day in the summer to 0.5 and every summer interval looked like a 2 ppm miss.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { AutoSwgParams, ArchivedHistory, buildProjectionAccuracy, computeRecommendation, fcRangeHalfWidth } from '../../controller/AutoSwgService';

const DAY = 86400000;
const HTML = '<html><body></body></html>';   // no cards: the history comes from the archive (a non-empty page, so nothing is fetched)

// FC tested every 2 days at noon UTC for 150 days, ending about now. The SWG makes exactly what the pool burns, so FC stays at 8 (plus a small
// deterministic test wobble of at most 0.1 ppm): 2 ppm/day until 50 days before the end, then 0.5 ppm/day.
const SWG_PPM_PER_PCT = 3.2 / 100;
function burnChangeHistory(): { archive: ArchivedHistory; changeAt: number; lastAt: number } {
    const today = new Date(); today.setUTCHours(12, 0, 0, 0);
    const lastAt = today.getTime() - (today.getTime() > Date.now() ? DAY : 0);
    const startAt = lastAt - 150 * DAY, changeAt = lastAt - 50 * DAY;
    const wobble = [0, 0.1, -0.05, 0.05, -0.1, 0.05, 0];
    const fc: { ts: Date; value: number }[] = [];
    for (let t = startAt, i = 0; t <= lastAt; t += 2 * DAY, i++) fc.push({ ts: new Date(t), value: 8 + wobble[i % wobble.length] });
    const swg = [
        { ts: new Date(startAt - 5 * DAY), pct: 2.0 / SWG_PPM_PER_PCT, hrs: 10, ppmPerDay: 2.0 },
        { ts: new Date(changeAt), pct: 0.5 / SWG_PPM_PER_PCT, hrs: 10, ppmPerDay: 0.5 },
    ];
    return { archive: { fc, swg, cya: [{ ts: new Date(startAt), value: 70 }], chlorine: [] }, changeAt, lastAt };
}

// The user's live weighting (65%, no taper) and range control; no daylight weighting, so a 2 day gap is exactly 2 days of consumption.
const params: AutoSwgParams = {
    shareCode: 'test', gallons: 15000, swgLbsPerDay: 1.47, swgStartTime: '07:00', swgStopTime: '17:00', timezone: 'UTC',
    windowDays: 14, targetFc: 8.5, targetPeriodsAbove: 1, targetPeriodsBelow: 1,
    projectionWeight: 0.65, projectionTaperStartDays: 3, projectionTaperEndDays: 0, overshootPpmPerDay: 0.1, troughFloor: true,
    band: { low: 7, high: 10, peakCap: true, integral: 0.5, scaledBias: true },
};

describe('fcRangeHalfWidth', () => {
    it('uses the default spread with fewer than 6 misses', () => {
        const r = fcRangeHalfWidth([0.1, -0.2, 0.3, 0.1, 0.2], 0);
        expect(r.basis).toBe('default');
        expect(r.halfWidth).toBeCloseTo(1.97 * 1.8, 6);
    });

    it('takes the 90th percentile of the absolute misses, interpolated between ranks', () => {
        const misses = [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8, 0.9, -1.0];
        const r = fcRangeHalfWidth(misses, 0);
        expect(r.basis).toBe('history');
        expect(r.baseHalfWidth).toBeCloseTo(0.91, 6);       // rank 8.1 of 0..9: 0.9 + 0.1 x 0.1
        expect(r.halfWidth).toBeCloseTo(0.91, 6);
        expect(r.sd).toBeCloseTo(Math.sqrt(misses.reduce((a, m) => a + m * m, 0) / misses.length), 6);
    });

    it('is not pulled out by one large miss the way z x sd is', () => {
        const misses = [0.2, -0.3, 0.1, 0.4, -0.2, 0.3, -0.1, 0.2, -0.4, 0.3, 0.1, -0.2, 0.3, -0.3, 0.2, 0.1, -0.2, 0.3, 0.2, 4.0];
        const r = fcRangeHalfWidth(misses, 0);
        expect(r.halfWidth).toBeLessThan(0.5);
        expect(1.97 * r.sd).toBeGreaterThan(1.7);
    });

    it('grows with the age of the last reading, in quadrature', () => {
        const misses = [0.5, -0.5, 0.5, -0.5, 0.5, -0.5];
        expect(fcRangeHalfWidth(misses, 4).halfWidth).toBeCloseTo(Math.sqrt(0.25 + Math.pow(1.97 * 0.4, 2)), 6);
    });
});

describe('the range for the next test', () => {
    const { archive, changeAt, lastAt } = burnChangeHistory();
    const asOf = new Date(lastAt + 60000);   // a minute after the last test, so the range has not grown with its age

    it('is not widened by intervals from before a large change in the burn', async () => {
        const r = await computeRecommendation(Object.assign({}, params, { asOf }), HTML, [], undefined, archive);
        expect(r.avgConsumptionPpmPerDay).toBeCloseTo(0.5, 1);
        const range = r.projectedFcRange;
        expect(range.basis).toBe('history');
        expect(range.intervals).toBe(45);                          // the last 90 days at one test every 2 days
        // The projection only missed in the week after the change, while the 14 day average caught up (about 1.95 ppm on the first test,
        // less on each after); the 90th percentile of the 45 misses is about half a ppm.
        expect(range.halfWidth).toBeGreaterThan(0.3);
        expect(range.halfWidth).toBeLessThan(1.0);
        // What scoring every interval with today's 0.5 ppm/day gave: each of the 20 intervals before the change looks like a 1.95 ppm miss.
        let oldSumSq = 0, oldN = 0;
        const fc = archive.fc;
        for (let i = 1; i < fc.length; i++) {
            if (fc[i - 1].ts.getTime() < lastAt - 90 * DAY) continue;
            const rate = fc[i - 1].ts.getTime() < changeAt ? 2.0 : 0.5;
            const miss = 0.65 * (rate * 2 - r.avgConsumptionPpmPerDay * 2) - (fc[i].value - fc[i - 1].value);
            oldSumSq += miss * miss; oldN++;
        }
        expect(1.97 * Math.sqrt(oldSumSq / oldN)).toBeGreaterThan(2.2);
        expect(range.halfWidth).toBeLessThan(0.5 * 1.97 * Math.sqrt(oldSumSq / oldN));
    });

    it('matches the misses the Projection Accuracy report scores for the same intervals', async () => {
        const r = await computeRecommendation(Object.assign({}, params, { asOf }), HTML, [], undefined, archive);
        const report = await buildProjectionAccuracy(params, { lookbackDays: 100, html: HTML, archive });
        const rows = report.rows.filter(x => new Date(x.previousTs).getTime() >= lastAt - 90 * DAY && new Date(x.ts).getTime() <= lastAt);
        expect(rows.length).toBe(r.projectedFcRange.intervals);
        const fromReport = fcRangeHalfWidth(rows.map(x => x.error), 0);
        expect(r.projectedFcRange.halfWidth).toBeCloseTo(fromReport.halfWidth, 1);
        expect(Math.abs(r.projectedFcRange.halfWidth - fromReport.halfWidth)).toBeLessThan(0.03);   // the report rounds each projection to 0.01
    }, 60000);
});
