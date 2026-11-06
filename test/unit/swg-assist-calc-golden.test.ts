// SWG Assist keeps one Intl.DateTimeFormat of each kind per time zone instead of building one at every call (controller/AutoSwgService.ts,
// dateTimeFormat). That is a speed change only: every number and every sentence must come out exactly the same. These tests run the helpers, the
// calculation and the two reports Tune is made of with the cache off (a new formatter at every call, as before) and on, and compare.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { AutoSwgParams, ArchivedHistory, __testables, buildProjectionAccuracy, buildWhatIfSweep, computeRecommendation } from '../../controller/AutoSwgService';

const DAY = 86400000;
const HTML = '<html><body></body></html>';   // no cards: the history comes from the archive below (a non-empty page, so nothing is fetched)

// A deterministic year of history ending now (the reports look back from now): FC tests every 2 to 4 days, an SWG % change every few days,
// a few liquid chlorine additions and water temperatures. It crosses both clock changes.
function makeHistory(): ArchivedHistory {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const end = Date.now() - 2 * 3600000;
    const start = end - 300 * DAY;
    const fc: { ts: Date; value: number }[] = [], swg: ArchivedHistory['swg'] = [], temp: { ts: Date; value: number }[] = [];
    const chlorine: ArchivedHistory['chlorine'] = [];
    let t = start, fcVal = 8;
    while (t < end) {
        fcVal = Math.max(4, Math.min(12, fcVal + (rnd() - 0.5) * 3));
        fc.push({ ts: new Date(t), value: Math.round(fcVal * 2) / 2 });
        temp.push({ ts: new Date(t), value: Math.round(70 + 15 * Math.sin((t - start) / (300 * DAY) * Math.PI) + rnd() * 3) });
        t += (2 + rnd() * 2) * DAY + Math.round(rnd() * 600) * 60000;
    }
    t = start - 5 * DAY;
    while (t < end) {
        const pct = Math.round(20 + rnd() * 50);
        swg.push({ ts: new Date(t), pct: pct, hrs: 10, ppmPerDay: Math.round(pct / 100 * 3.2 * 10) / 10 });
        t += (3 + rnd() * 5) * DAY + Math.round(rnd() * 300) * 60000;
    }
    for (let i = 1; i < 6; i++) chlorine.push({ ts: new Date(start + i * 47 * DAY + 3600000), percent: 10, ml: 1500 + i * 200 });
    return { fc, swg, cya: [{ ts: new Date(start), value: 70 }], chlorine, temp };
}
const archive = makeHistory();

// The user's live setup: range control 7 to 10, peak cap, integral, scaled bias, window 14, weighting 0.65 with no taper, daylight weighting.
const bandParams: AutoSwgParams = {
    shareCode: 'test', gallons: 15000, swgLbsPerDay: 1.47, swgStartTime: '07:00', swgStopTime: '17:00', timezone: 'America/New_York',
    windowDays: 14, targetFc: 8.5, targetPeriodsAbove: 1, targetPeriodsBelow: 1, sunriseTime: '06:45', sunsetTime: '17:10',
    projectionWeight: 0.65, projectionTaperStartDays: 3, projectionTaperEndDays: 0, overshootPpmPerDay: 0.1, troughFloor: true, nightBurnRatio: 0.5,
    band: { low: 7, high: 10, peakCap: true, integral: 0.5, scaledBias: true },
};
// The point target (the deadline bisection, the overnight floor, the moved-out date) with the water temperature adjustment and a taper.
const targetParams: AutoSwgParams = Object.assign({}, bandParams, { band: undefined, burnTempAdjust: true, projectionTaperStartDays: 3, projectionTaperEndDays: 8, targetPeriodsAbove: 1.5, swgStartTime: '22:00', swgStopTime: '04:00' });

afterEach(() => { __testables.setDateTimeFormatCache(true); });

async function both<T>(f: () => Promise<T> | T): Promise<[T, T]> {
    __testables.setDateTimeFormatCache(false);
    const before = await f();
    __testables.setDateTimeFormatCache(true);
    const after = await f();
    return [before, after];
}

describe('the formatter cache changes no result', () => {
    it('the time zone helpers give the same answers', async () => {
        const zones = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata', 'UTC'];
        const run = () => {
            const out: any[] = [];
            // every 37 minutes and 13.5 seconds through the spring and fall clock changes of 2026, zones interleaved so one zone's formatter never serves another
            for (const base of [Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 28), Date.UTC(2026, 3, 4), Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 24), Date.UTC(2026, 10, 1)]) {
                for (let ms = base; ms < base + 3 * DAY; ms += 37 * 60000 + 13500) {
                    const d = new Date(ms);
                    for (const z of zones) {
                        const ymd = __testables.localYmd(d, z);
                        out.push(__testables.tzOffsetMinutes(d, z), __testables.localMinutesOfDay(d, z), __testables.localMinuteOfDay(d, z), ymd,
                            __testables.zonedTimeToUtc(ymd.year, ymd.month, ymd.day, { hour: 2, minute: 30, second: 0 }, z).getTime());
                    }
                }
            }
            return out;
        };
        const [before, after] = await both(run);
        expect(after.length).toBeGreaterThan(5000);
        expect(after).toEqual(before);
    });

    it('a bad time zone still throws', () => {
        __testables.setDateTimeFormatCache(true);
        expect(() => __testables.tzOffsetMinutes(new Date(), 'Not/AZone')).toThrow();
        expect(() => __testables.tzOffsetMinutes(new Date(), 'Not/AZone')).toThrow();
    });

    it('computeRecommendation gives the same result (range control and the point target, now and as of past readings)', async () => {
        const fcTimes = archive.fc.map(e => e.ts.getTime());
        // "now" is pinned (a calculation without asOf reads the clock, which moves between the two runs)
        const asOfs = [new Date(Date.now()), ...[10, 25, 40, 60, 75].map(i => new Date(fcTimes[i] - 60000))];
        for (const params of [bandParams, targetParams]) {
            for (const asOf of asOfs) {
                const [before, after] = await both(() => computeRecommendation(Object.assign({}, params, { asOf }), HTML, [], undefined, archive));
                expect(after).toEqual(before);
            }
        }
    }, 60000);

    it('the projection accuracy report gives the same result', async () => {
        const [before, after] = await both(() => buildProjectionAccuracy(bandParams, { lookbackDays: 120, html: HTML, archive }));
        expect(after.rows.length).toBeGreaterThan(20);
        expect(after).toEqual(before);
    }, 60000);

    it('the what-if sweep gives the same result', async () => {
        const [before, after] = await both(() => buildWhatIfSweep(bandParams, { lookbackDays: 45, html: HTML, archive }));
        expect(after.count).toBeGreaterThan(5);
        expect(after).toEqual(before);
    }, 120000);
});

describe('the what-if sweep variants', () => {
    it('scores 15 alternatives for the live setup (window 14, weighting 65%, no taper, night burn 0.5, water temperatures logged)', async () => {
        const sweep = await buildWhatIfSweep(bandParams, { lookbackDays: 20, html: HTML, archive });
        expect(sweep.variants[0].key).toBe('current');
        expect(sweep.variants.slice(1).map(v => v.key).sort()).toEqual([
            'burnTemp', 'creditToggle', 'night0.25', 'night0.75', 'noDaylight', 'taper5_14', 'tol1', 'tol3',
            'weight0.5', 'weight0.75', 'weight0.85', 'weight1', 'window10', 'window21', 'window28'].sort());
        const taper = sweep.variants.find(v => v.key === 'taper5_14');
        expect(taper.settings).toEqual({ projectionTaperStartDays: 5, projectionTaperEndDays: 14 });
    }, 60000);

    it('offers no taper when a taper is set, and leaves out the value in use', async () => {
        const p = Object.assign({}, bandParams, { windowDays: 21, projectionWeight: 0.5, projectionTaperStartDays: 3, projectionTaperEndDays: 8, nightBurnRatio: 1 });
        const keys = (await buildWhatIfSweep(p, { lookbackDays: 20, html: HTML, archive })).variants.map(v => v.key);
        expect(keys).toContain('noTaper');
        expect(keys).not.toContain('window21');
        expect(keys).not.toContain('weight0.5');
        expect(keys.filter(k => k.indexOf('night') === 0)).toEqual(['night0.75']);
    }, 60000);
});
