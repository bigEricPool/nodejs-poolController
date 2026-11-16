// The njsPC restart credit in SWG Assist (controller/AutoSwgRestarts.ts, and restartCredit in controller/AutoSwgService.ts): a short power drop in the run
// window starts a new cycle with the current first, so the cell runs up to one more on-period than the SWG % entries say. The module's numbers are checked
// against a brute-force simulation of the cell (10 s steps); the wiring is checked through computeRecommendation.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { findRestarts, fillRestarts, parsePowerLog, restartExtraHours, restartReach } from '../../controller/AutoSwgRestarts';
import { AutoSwgParams, ArchivedHistory, computeRecommendation } from '../../controller/AutoSwgService';
import type { CycleSettings, PowerEvent } from '../../controller/ChlorinatorUsage';

const H = 3600000, MIN = 60000, DAY = 24 * H;
const CYCLE: CycleSettings = { cycleHours: 3, restartsOnPower: true, burstFirst: true };
const D0 = Date.UTC(2026, 10, 10);                          // a day, 00:00 UTC
const at = (h: number, m: number = 0, s: number = 0) => D0 + h * H + m * MIN + s * 1000;
const inWindow = (ms: number) => { const h = ((ms % DAY) + DAY) % DAY / H; return h >= 7 && h < 19; };   // 07:00-19:00 UTC
const constPct = (p: number) => () => p;

// the power on 07:00-19:00, with a drop of `gapS` seconds at each of `drops`
function day(drops: number[], gapS: number = 40, on: number = at(7), off: number = at(19)): PowerEvent[] {
    const ev: PowerEvent[] = [{ t: on, on: true }];
    for (const d of drops) { ev.push({ t: d, on: false }); ev.push({ t: d + gapS * 1000, on: true }); }
    ev.push({ t: off, on: false });
    return ev;
}
// hours current flowed, simulated: a cycle starts at each power-on, current for the first p of each 3 h
function simulate(ev: PowerEvent[], a: number, b: number, pct: number): number {
    let total = 0, onSince = -1;
    const step = 10000;
    for (let t = a; t < b; t += step) {
        const mid = t + step / 2;
        let last: PowerEvent | undefined;
        for (const e of ev) if (e.t <= mid) last = e;
        if (!last || !last.on) continue;
        onSince = last.t;
        if (((mid - onSince) % (3 * H)) < (pct / 100) * 3 * H) total += step;
    }
    return total / H;
}
function extra(ev: PowerEvent[], pct: number | ((ms: number) => number), a: number = at(0), b: number = at(24)) {
    const pctAt = typeof pct === 'number' ? constPct(pct) : pct;
    const rs = findRestarts(ev, inWindow);
    return restartExtraHours(ev, rs, a, b, CYCLE, pctAt);
}
const ON_PERIOD_11 = 0.11 * 3;   // hours

describe('restart credit: the extra on-time', () => {
    it('a restart after the cycle\'s on-part ended adds one on-period', () => {
        const ev = day([at(8)]);
        expect(extra(ev, 11)).toBeCloseTo(ON_PERIOD_11, 6);
        expect(extra(ev, 11)).toBeCloseTo(simulate(ev, at(0), at(24), 11) - simulate(day([]), at(0), at(24), 11), 2);
    });
    it('a restart during the on-part adds the part already done before it (the on-period starts again)', () => {
        const ev = day([at(7, 10)]);
        expect(extra(ev, 11)).toBeCloseTo(10 / 60, 6);
        expect(extra(ev, 11)).toBeLessThanOrEqual(ON_PERIOD_11 + 1e-9);
    });
    it('nine restarts in a day match the simulation', () => {
        const drops = [at(7, 22), at(7, 45), at(9, 0), at(11, 30), at(12, 5), at(14, 40), at(15, 2), at(16, 55), at(18, 50)];
        const ev = day(drops);
        const sim = simulate(ev, at(0), at(24), 11) - simulate(day([]), at(0), at(24), 11);
        expect(extra(ev, 11)).toBeCloseTo(sim, 2);
        expect(extra(ev, 11)).toBeGreaterThan(0);
        expect(extra(ev, 11)).toBeLessThanOrEqual(9 * ON_PERIOD_11 + 1e-9);
    });
    it('splitting the span changes nothing', () => {
        const ev = day([at(8), at(12, 31), at(15)]);
        const whole = extra(ev, 11);
        const parts = extra(ev, 11, at(0), at(10)) + extra(ev, 11, at(10), at(13, 7)) + extra(ev, 11, at(13, 7), at(24));
        expect(parts).toBeCloseTo(whole, 9);
    });
    it('a restart outside the run window gives nothing', () => {
        const ev = day([at(6)], 40, at(5), at(19));
        expect(findRestarts(ev, inWindow)).toEqual([]);
        expect(extra(ev, 11)).toBe(0);
    });
    it('a gap of 5 minutes or more is an outage, not a restart', () => {
        expect(extra(day([at(8)], 10 * 60), 11)).toBe(0);
        expect(extra(day([at(8)], 5 * 60), 11)).toBe(0);
        expect(extra(day([at(8)], 4 * 60), 11)).toBeGreaterThan(0);
    });
    it('0% gives nothing', () => { expect(extra(day([at(8), at(12)]), 0)).toBe(0); });
    it('no credit when the cycles do not restart at power-on, or there are no cycles', () => {
        const ev = day([at(8)]);
        const rs = findRestarts(ev, inWindow);
        expect(restartExtraHours(ev, rs, at(0), at(24), { cycleHours: 3, restartsOnPower: false, burstFirst: true }, constPct(11))).toBe(0);
        expect(restartExtraHours(ev, rs, at(0), at(24), { cycleHours: 0, restartsOnPower: true, burstFirst: true }, constPct(11))).toBe(0);
    });
    it('the reach ends at the next real power-off; filling removes only the restart lines', () => {
        const ev = day([at(8), at(8, 30)]);
        const rs = findRestarts(ev, inWindow);
        expect(restartReach(ev, rs)).toEqual([{ s: at(8), e: at(19) }]);
        expect(fillRestarts(ev, rs)).toEqual([{ t: at(7), on: true }, { t: at(19), on: false }]);
    });
    it('the 11-13 log: 9 restarts, but the % went to 0 at 12:36Z, so only the first two count (about +0.40 ppm)', () => {
        const log = [
            ['2026-11-13T11:46:03.348Z', true], ['2026-11-13T12:08:01.857Z', false], ['2026-11-13T12:08:41.434Z', true], ['2026-11-13T12:30:56.464Z', false],
            ['2026-11-13T12:31:36.092Z', true], ['2026-11-13T14:00:38.049Z', false], ['2026-11-13T14:01:17.419Z', true], ['2026-11-13T19:24:40.550Z', false],
            ['2026-11-13T19:25:20.636Z', true], ['2026-11-13T19:59:22.707Z', false], ['2026-11-13T20:00:02.833Z', true], ['2026-11-13T20:05:27.135Z', false],
            ['2026-11-13T20:06:06.663Z', true], ['2026-11-13T20:52:31.409Z', false], ['2026-11-13T20:53:11.299Z', true], ['2026-11-13T21:57:24.260Z', false],
            ['2026-11-13T21:58:03.476Z', true], ['2026-11-13T22:08:41.957Z', false], ['2026-11-13T22:09:21.313Z', true], ['2026-11-13T22:34:06.386Z', false],
        ].map(([t, on]) => JSON.stringify({ t, id: 50, on })).join('\n');
        const ev = parsePowerLog(log + '\n{"t":"2026-11-13T12:00:00Z","id":51,"on":false}\n{torn', 50);
        expect(ev.length).toBe(20);
        // the run window then: 06:49-18:49 America/New_York = 11:49-23:49Z
        const win = (ms: number) => { const m = (((ms % DAY) + DAY) % DAY) / MIN; return m >= 11 * 60 + 49 && m < 23 * 60 + 49; };
        const rs = findRestarts(ev, win);
        expect(rs.length).toBe(9);
        const setTo0 = new Date('2026-11-13T12:36:07.611Z').getTime();
        const rate = 1.47e6 / (12000 * 8.34) / 24;   // ppm per hour at 100%
        const ppm = restartExtraHours(ev, rs, ev[0].t, ev[ev.length - 1].t, CYCLE, ms => ms < setTo0 ? 11 : 0) * rate;
        expect(ppm).toBeCloseTo(2 * ON_PERIOD_11 * rate, 3);
        expect(ppm).toBeGreaterThan(0.38);
        expect(ppm).toBeLessThan(0.42);
        // at 11% all day it would be the guiding estimate's +1.17 or so
        const allDay = restartExtraHours(ev, rs, ev[0].t, ev[ev.length - 1].t, CYCLE, constPct(11)) * rate;
        expect(allDay).toBeGreaterThan(1.0);
        expect(allDay).toBeLessThan(1.4);
    });
});

// Through the calculation: 11% all along, the power on 07:00-19:00 every day, FC readings every 2 days.
const GALLONS = 12000, LBS = 1.47;
const RATED = LBS * 1e6 / (GALLONS * 8.34);
const T0 = Date.UTC(2026, 9, 1, 12);
const READINGS = [T0, T0 + 2 * DAY, T0 + 4 * DAY, T0 + 6 * DAY];
const base: AutoSwgParams = {
    shareCode: 'test', gallons: GALLONS, swgLbsPerDay: LBS, swgStartTime: '07:00', swgStopTime: '19:00', timezone: 'UTC',
    windowDays: 14, targetFc: 8, targetPeriodsAbove: 1, targetPeriodsBelow: 1,
    projectionWeight: 0.65, projectionTaperStartDays: 3, projectionTaperEndDays: 0, troughFloor: true,
    chlorCycle: { id: 50, cycleHours: 3, restartsOnPower: true, burstFirst: true },
};
const archive: ArchivedHistory = {
    fc: READINGS.map((t, i) => ({ ts: new Date(t), value: 8 + (i % 2) * 0.5 })),
    swg: [{ ts: new Date(T0 - 5 * DAY), pct: 11, hrs: 12, ppmPerDay: RATED * 0.11 * 12 / 24 }],
    cya: [{ ts: new Date(T0), value: 70 }], chlorine: [],
};
function power(drops: number[]): PowerEvent[] {
    const ev: PowerEvent[] = [];
    const d0 = Date.UTC(2026, 9, 1);
    for (let d = -1; d < 9; d++) {
        const on = d0 + d * DAY + 7 * H, off = d0 + d * DAY + 19 * H;
        ev.push({ t: on, on: true });
        for (const x of drops) if (x > on && x < off) { ev.push({ t: x, on: false }); ev.push({ t: x + 40000, on: true }); }
        ev.push({ t: off, on: false });
    }
    return ev;
}
const DROP = Date.UTC(2026, 9, 2, 9);   // 09:00 on the day after the first reading
const AFTER = READINGS[READINGS.length - 1] + 60000;
const calc = (extraParams: Partial<AutoSwgParams>) => computeRecommendation(Object.assign({}, base, { asOf: new Date(AFTER), superChlorRuns: [] }, extraParams), '<html><body></body></html>', [], undefined, archive);

describe('restart credit: in the calculation', () => {
    it('credits one on-period in the burn, notes it, and leaves it out of the recorded inputs', async () => {
        const r = await calc({ powerEvents: power([DROP]) });
        const without = await calc({ powerEvents: power([]) });
        expect(r.restarts.count).toBe(1);
        expect(r.restarts.creditPpm).toBeCloseTo(ON_PERIOD_11 * RATED / 24, 2);
        expect(without.restarts).toBeUndefined();
        expect(r.avgConsumptionPpmPerDay).toBeGreaterThan(without.avgConsumptionPpmPerDay);
        expect(r.rationale.some(l => /^njsPC restarts in the run window: 1, \+0\.20 ppm from new cycles \(current first\)\.$/.test(l))).toBe(true);
        expect((r as any).inputs.powerEvents).toBeUndefined();
        expect(r.dataKey).not.toBe(without.dataKey);
    });
    it('no chlorCycle, or cycles that do not restart: no credit', async () => {
        const a = await calc({ powerEvents: power([DROP]), chlorCycle: undefined });
        const b = await calc({ powerEvents: power([DROP]), chlorCycle: { cycleHours: 3, restartsOnPower: false, burstFirst: true } });
        const none = await calc({ powerEvents: power([]) });
        expect(a.restarts).toBeUndefined();
        expect(b.restarts).toBeUndefined();
        expect(a.avgConsumptionPpmPerDay).toBe(none.avgConsumptionPpmPerDay);
    });
    it('a restart inside a super chlorinate run gets no restart credit', async () => {
        const run = { startMs: DROP - 2 * H, endMs: DROP + 4 * H, poweredHours: 6 };
        const r = await calc({ powerEvents: power([DROP]), superChlorRuns: [run] });
        const without = await calc({ powerEvents: power([]), superChlorRuns: [run] });
        expect(r.restarts.creditPpm).toBeCloseTo(0, 6);
        expect(r.avgConsumptionPpmPerDay).toBe(without.avgConsumptionPpmPerDay);
    });
    it('a restart since the last reading raises the projection by the weighted credit', async () => {
        const drop = READINGS[READINGS.length - 1] + 23 * H;   // 11:00 the next day (after the 10:00 cycle's on-part)
        const asOf = READINGS[READINGS.length - 1] + 30 * H;
        const r = await calc({ powerEvents: power([drop]), asOf: new Date(asOf) });
        const without = await calc({ powerEvents: power([]), asOf: new Date(asOf) });
        expect(r.restarts.sinceReadingPpm).toBeCloseTo(0.65 * ON_PERIOD_11 * RATED / 24, 2);
        expect(r.projectedCurrentFc - without.projectedCurrentFc).toBeCloseTo(0.65 * ON_PERIOD_11 * RATED / 24, 1);
    });
});
