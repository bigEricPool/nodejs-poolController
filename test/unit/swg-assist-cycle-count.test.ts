// SWG Assist's cycle count (controller/AutoSwgCycleCount.ts and its use in controller/AutoSwgService.ts): for the hours the chlorinator's power log
// covers, generation is what the cell really made, counted by its 3-hour cycles from the power events, instead of the % over the run window.
// Synthetic cases first, then the real data from the pool (test/unit/fixtures/swg-cycle-count-real.json, read from the Pi on 2026-11-16):
// - per day, against an independent Python step simulation (pythonDaily in the fixture) and against the base layer's cell usage (ChlorinatorUsage);
// - the full calculation, linear (no power log) against wide, per FC interval and today, printed as tables.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { cycleGenerationPpm, parsePowerLog } from '../../controller/AutoSwgCycleCount';
import { AutoSwgParams, ArchivedHistory, LocalSwgEntry, computeRecommendation } from '../../controller/AutoSwgService';
import { cellUsageForHour, pctAtFromHours } from '../../controller/ChlorinatorUsage';
import type { CycleSettings, PowerEvent } from '../../controller/ChlorinatorUsage';
import type { SuperChlorRun } from '../../controller/AutoSwgSuperChlor';

const H = 3600000, MIN = 60000, DAY = 24 * H;
const CYCLE: CycleSettings = { cycleHours: 3, restartsOnPower: true, burstFirst: true };
const HTML = '<html><body></body></html>';

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Synthetic
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const GALLONS = 12000, LBS = 1.47;
const RATED = LBS * 1e6 / (GALLONS * 8.34);   // ppm per 24 h at 100%
const D0 = Date.UTC(2026, 10, 10);
const at = (h: number, m: number = 0) => D0 + h * H + m * MIN;
function day(drops: number[], gapS: number = 40, on: number = at(7), off: number = at(19)): PowerEvent[] {
    const ev: PowerEvent[] = [{ t: on, on: true }];
    for (const d of drops) { ev.push({ t: d, on: false }); ev.push({ t: d + gapS * 1000, on: true }); }
    ev.push({ t: off, on: false });
    return ev;
}
const ON_11 = 0.11 * 3 * RATED / 24;   // one on-period at 11%, ppm

describe('cycle count: synthetic', () => {
    it('12 h of power at 11%: four on-periods', () => {
        expect(cycleGenerationPpm(day([]), at(0), at(24), CYCLE, () => 11, RATED)).toBeCloseTo(4 * ON_11, 9);
    });
    it('a restart after the on-part adds one on-period; during it, the part already done', () => {
        expect(cycleGenerationPpm(day([at(8)]), at(0), at(24), CYCLE, () => 11, RATED)).toBeCloseTo(5 * ON_11, 9);
        expect(cycleGenerationPpm(day([at(7, 10)]), at(0), at(24), CYCLE, () => 11, RATED)).toBeCloseTo(4 * ON_11 + (10 / 60) * RATED / 24, 9);
    });
    it('a power-off part way through an on-period cuts it', () => {
        const ev: PowerEvent[] = [{ t: at(7), on: true }, { t: at(7, 10), on: false }];
        expect(cycleGenerationPpm(ev, at(0), at(24), CYCLE, () => 11, RATED)).toBeCloseTo((10 / 60) * RATED / 24, 9);
    });
    it('0%, no cycles, or no rating: nothing', () => {
        expect(cycleGenerationPpm(day([at(8)]), at(0), at(24), CYCLE, () => 0, RATED)).toBe(0);
        expect(cycleGenerationPpm(day([at(8)]), at(0), at(24), { cycleHours: 0, restartsOnPower: true, burstFirst: true }, () => 11, RATED)).toBe(0);
        expect(cycleGenerationPpm(day([at(8)]), at(0), at(24), CYCLE, () => 11, 0)).toBe(0);
    });
    it('reads the power log: one chlorinator, a torn line skipped', () => {
        const text = '{"t":"2026-11-10T07:00:00Z","id":50,"on":true}\n{"t":"2026-11-10T08:00:00Z","id":51,"on":false}\n{"t":"2026-11-10T19:00:00Z","id":50,"on":false}\n{"t":"2026';
        expect(parsePowerLog(text, 50)).toEqual([{ t: at(7), on: true }, { t: at(19), on: false }]);
    });
    it('a stall pair (cause "stall") reads and counts like any other off/on: the cycle restarts', () => {
        const text = '{"t":"2026-11-10T07:00:00Z","id":50,"on":true}\n{"t":"2026-11-10T08:00:00Z","id":50,"on":false,"cause":"stall"}\n'
            + '{"t":"2026-11-10T08:00:02Z","id":50,"on":true,"cause":"stall"}\n{"t":"2026-11-10T19:00:00Z","id":50,"on":false}';
        const ev = parsePowerLog(text, 50);
        expect(ev).toEqual([{ t: at(7), on: true }, { t: at(8), on: false }, { t: at(8) + 2000, on: true }, { t: at(19), on: false }]);
        expect(cycleGenerationPpm(ev, at(0), at(24), CYCLE, () => 11, RATED)).toBeCloseTo(5 * ON_11, 9);
    });
});

// Through the calculation, synthetic: 11% all along, power 07:00-19:00 UTC each day (the run window), readings every 2 days.
const T0 = Date.UTC(2026, 9, 1, 12);
const READINGS = [T0, T0 + 2 * DAY, T0 + 4 * DAY, T0 + 6 * DAY];
const sBase: AutoSwgParams = {
    shareCode: 'test', gallons: GALLONS, swgLbsPerDay: LBS, swgStartTime: '07:00', swgStopTime: '19:00', timezone: 'UTC',
    windowDays: 14, targetFc: 8, targetPeriodsAbove: 1, targetPeriodsBelow: 1,
    projectionWeight: 0.65, projectionTaperStartDays: 3, projectionTaperEndDays: 0, troughFloor: true,
    chlorCycle: { id: 50, cycleHours: 3, restartsOnPower: true, burstFirst: true },
};
const sArchive: ArchivedHistory = {
    fc: READINGS.map((t, i) => ({ ts: new Date(t), value: 8 + (i % 2) * 0.5 })),
    swg: [{ ts: new Date(T0 - 5 * DAY), pct: 11, hrs: 12, ppmPerDay: RATED * 0.11 * 12 / 24 }],
    cya: [{ ts: new Date(T0), value: 70 }], chlorine: [],
};
function power(drops: number[], from: number = -1): PowerEvent[] {
    const ev: PowerEvent[] = [];
    const d0 = Date.UTC(2026, 9, 1);
    for (let d = from; d < 9; d++) {
        const on = d0 + d * DAY + 7 * H, off = d0 + d * DAY + 19 * H;
        ev.push({ t: on, on: true });
        for (const x of drops) if (x > on && x < off) { ev.push({ t: x, on: false }); ev.push({ t: x + 40000, on: true }); }
        ev.push({ t: off, on: false });
    }
    return ev;
}
const DROP = Date.UTC(2026, 9, 2, 9);
const AFTER = READINGS[READINGS.length - 1] + 60000;
async function sCalc(extra: Partial<AutoSwgParams>) {
    let rows: any[] = [];
    const r = await computeRecommendation(Object.assign({}, sBase, { asOf: new Date(AFTER), superChlorRuns: [], onIntervals: (x: any[]) => { rows = x; } }, extra), HTML, [], undefined, sArchive);
    return { r, rows };
}

describe('cycle count: in the calculation (synthetic)', () => {
    it('with the power exactly the run window and no drops, the burn is the same as by the run window', async () => {
        const wide = await sCalc({ powerEvents: power([]) });
        const linear = await sCalc({ chlorCycle: undefined });
        expect(wide.r.avgConsumptionPpmPerDay).toBeCloseTo(linear.r.avgConsumptionPpmPerDay, 2);
        for (let i = 0; i < wide.rows.length; i++) expect(wide.rows[i].gen).toBeCloseTo(linear.rows[i].gen, 6);
        expect(wide.r.cycleCount).toBeDefined();
        expect(wide.r.rationale.some(l => /^Generation since .* counted from the power log \(3-h cycles, current first\): [\d.]+ ppm vs [\d.]+ ppm by the run window\.$/.test(l))).toBe(true);
        expect((wide.r as any).inputs.powerEvents).toBeUndefined();
        expect((wide.r as any).inputs.onIntervals).toBeUndefined();
    });
    it('a restart adds one on-period to its interval, and nothing is counted twice', async () => {
        const wide = await sCalc({ powerEvents: power([DROP]) });
        const flat = await sCalc({ powerEvents: power([]) });
        expect(wide.rows[0].gen - flat.rows[0].gen).toBeCloseTo(ON_11, 9);
        expect(wide.rows[1].gen).toBeCloseTo(flat.rows[1].gen, 9);
        expect(wide.r.dataKey).not.toBe(flat.r.dataKey);
    });
    it('hours before the power log keep the run window; an interval that starts before the log is split', async () => {
        const logStart = Date.UTC(2026, 9, 2, 7);   // the log begins 07:00 on the 2nd, inside the first interval
        const wide = await sCalc({ powerEvents: power([], 1) });
        const linear = await sCalc({ chlorCycle: undefined });
        // before the log: the run window from 12:00 to 19:00 on the 1st (7 of 12 h); then the cycles: four on-periods on the 2nd and two (07:00, 10:00)
        // on the morning of the 3rd. The old even spread over the clock day gave 2 days' worth; the cell really ran 7 + 12 + 5 window hours, and the
        // cycles put two whole on-periods in the 5 hours of the 3rd.
        const ppmPerDay = RATED * 0.11 * 12 / 24;
        expect(wide.rows[0].gen).toBeCloseTo(ppmPerDay * 7 / 12 + 4 * ON_11 + 2 * ON_11, 6);
        expect(linear.rows[0].gen).toBeCloseTo(2 * ppmPerDay, 6);
        expect(wide.r.cycleCount.since).toBe(new Date(Math.max(logStart, AFTER - 14 * DAY)).toISOString());
    });
    it('cycleHours 0 or no chlorCycle: no cycle count', async () => {
        const a = await sCalc({ powerEvents: power([DROP]), chlorCycle: { cycleHours: 0, restartsOnPower: true, burstFirst: true } });
        const b = await sCalc({ powerEvents: power([DROP]), chlorCycle: undefined });
        expect(a.r.cycleCount).toBeUndefined();
        expect(b.r.cycleCount).toBeUndefined();
        expect(a.r.avgConsumptionPpmPerDay).toBe(b.r.avgConsumptionPpmPerDay);
    });
    it('a super chlorinate run: full rate less what the cycles at the normal % made in it, so the burn does not change', async () => {
        const run: SuperChlorRun = { startMs: Date.UTC(2026, 9, 2, 8), endMs: Date.UTC(2026, 9, 2, 14), poweredHours: 6 };
        const withRun = await sCalc({ powerEvents: power([]), superChlorRuns: [run] });
        const without = await sCalc({ powerEvents: power([]) });
        // the cycles at 11% inside 08:00-14:00: the on-parts of 10:00 and 13:00 = 2 on-periods
        expect(withRun.rows[0].added).toBeCloseTo(RATED * 6 / 24 - 2 * ON_11, 6);
        expect(withRun.rows[0].gen).toBeCloseTo(without.rows[0].gen, 9);
    });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Real data
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swg-cycle-count-real.json'), 'utf8'));
const realEvents: PowerEvent[] = fx.powerEvents.map((e: any) => ({ t: new Date(e.t).getTime(), on: e.on }));
const realLocal: LocalSwgEntry[] = fx.localSwg;
const realArchive: ArchivedHistory = {
    fc: fx.archive.fc.map((x: any) => ({ ts: new Date(x.ts), value: x.value })),
    swg: fx.archive.swg.map((x: any) => ({ ts: new Date(x.ts), ppmPerDay: x.ppmPerDay, hrs: x.hrs, pct: x.pct })),
    cya: fx.archive.cya.map((x: any) => ({ ts: new Date(x.ts), value: x.value })),
    chlorine: fx.archive.chlorine.map((x: any) => ({ ts: new Date(x.ts), percent: x.percent, ml: x.ml })),
    temp: fx.archive.temp.map((x: any) => ({ ts: new Date(x.ts), value: x.value })),
};
const realRuns: SuperChlorRun[] = fx.superChlorRuns.map((r: any) => ({ startMs: new Date(r.start).getTime(), endMs: new Date(r.end).getTime(), poweredHours: r.poweredHours }));
const REAL_RATED = fx.inputs.swgLbsPerDay * 1e6 / (fx.inputs.gallons * 8.34);
const CAPTURED = new Date(fx.capturedAt).getTime();
const LOG_START = realEvents[0].t;
// the % in effect: the local SWG % changes, with PoolMath's entries that are not within an hour of one (the calculation's merge)
const realEntries = realLocal.map(e => ({ t: new Date(e.ts).getTime(), pct: e.pct }))
    .concat(realArchive.swg.filter(p => !realLocal.some(l => Math.abs(new Date(l.ts).getTime() - p.ts.getTime()) < H)).map(p => ({ t: p.ts.getTime(), pct: p.pct })))
    .sort((a, b) => a.t - b.t);
const realPctAt = (ms: number) => { let p = 0; for (const e of realEntries) { if (e.t <= ms) p = e.pct; else break; } return p; };
// local (America/New_York) midnight of a day key, from the Python output's day list
const tzMidnight = (day: string): number => {
    const guess = new Date(`${day}T05:00:00Z`).getTime();
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' });
    const h = Number(f.format(new Date(guess)));
    return guess - h * H;
};

describe('cycle count: real data from the pool, 2026-11-08 to 2026-11-16', () => {
    const daily = fx.pythonDaily.map((d: { day: string; ppm: number }) => {
        const a = Math.max(tzMidnight(d.day), LOG_START), b = Math.min(tzMidnight(d.day) + DAY + 2 * H, CAPTURED);
        // a day is midnight to the next midnight (DST: 23 or 25 h; none in this span, but the next midnight is found by the same rule)
        const next = tzMidnight(new Date(tzMidnight(d.day) + 26 * H).toISOString().slice(0, 10));
        const end = Math.min(next, CAPTURED);
        return { day: d.day, a, b: end, py: d.ppm, ts: cycleGenerationPpm(realEvents, a, end, CYCLE, realPctAt, REAL_RATED) };
    });
    it('per day, the TypeScript count matches the independent Python simulation within 1%', () => {
        console.log('\nday         python   typescript');
        for (const d of daily) console.log(`${d.day}  ${d.py.toFixed(4)}   ${d.ts.toFixed(4)}`);
        for (const d of daily) {
            if (d.py < 0.01) expect(d.ts).toBeLessThan(0.01);
            else expect(Math.abs(d.ts / d.py - 1)).toBeLessThan(0.01);
        }
        const total = daily.reduce((s: number, d: any) => s + d.ts, 0);
        expect(total).toBeGreaterThan(4.5);
    });
    it('per day, it matches the base layer\'s cell usage (ChlorinatorUsage) within 2% on the hours the base layer counts exactly', () => {
        // The base layer (cellUsageForHour) counts each logged hour by the same cycles, with the % from the output log. Two of its approximations make
        // whole days differ, so the 2% check is made on the hours where it is exact: one line for the hour, six samples, no status that means the cell
        // was not generating, not stale. The approximations (printed below, not asserted):
        // - the hour the power comes on each morning carries the overnight "communication lost" status, so the base layer leaves the whole hour out,
        //   and with it the day's first on-period;
        // - an hour split by an njsPC restart has two or three lines, each credited with the whole hour's cycles scaled by its share of samples, which
        //   can come to more than the hour.
        // The cycle count here uses SWG Assist's own % (the SWG entries), so this also checks that the two % sources agree.
        const hours = fx.outputHours;
        const ctx = { cycle: CYCLE, events: realEvents, since: LOG_START, pctAt: pctAtFromHours(hours) };
        const linesPerHour = new Map<string, number>();
        for (const h of hours) linesPerHour.set(h.t, (linesPerHour.get(h.t) || 0) + 1);
        const dayOf = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(t));
        const base: { [d: string]: number } = {}, baseClean: { [d: string]: number } = {}, oursClean: { [d: string]: number } = {};
        for (const h of hours) {
            const t = new Date(h.t).getTime();
            if (t < LOG_START || t + H > CAPTURED) continue;
            const u = cellUsageForHour(h, fx.inputs.swgLbsPerDay, ctx).hours * REAL_RATED / 24;
            const day = dayOf(t);
            base[day] = (base[day] || 0) + u;
            const clean = linesPerHour.get(h.t) === 1 && h.n >= 6 && !(Array.isArray(h.st) && h.st.length) && !(typeof h.age === 'number' && h.age > 15 * 60);
            if (!clean) continue;
            baseClean[day] = (baseClean[day] || 0) + u;
            oursClean[day] = (oursClean[day] || 0) + cycleGenerationPpm(realEvents, t, t + H, CYCLE, realPctAt, REAL_RATED);
        }
        console.log('\nday         base layer (whole day)   cycle count (whole day)   base layer (exact hours)   cycle count (exact hours)');
        for (const d of daily) console.log(`${d.day}  ${(base[d.day] || 0).toFixed(4)}                   ${d.ts.toFixed(4)}                    ${(baseClean[d.day] || 0).toFixed(4)}                     ${(oursClean[d.day] || 0).toFixed(4)}`);
        let n = 0;
        for (const d of daily) {
            const u = baseClean[d.day] || 0, o = oursClean[d.day] || 0;
            if (u < 0.01) expect(o).toBeLessThan(0.01);
            else { expect(Math.abs(o / u - 1)).toBeLessThan(0.02); n++; }
        }
        expect(n).toBeGreaterThanOrEqual(4);
    });

    const realBase: AutoSwgParams = Object.assign({}, fx.inputs, {
        shareCode: 'fixture', chlorCycle: fx.chlorCycle, powerEvents: realEvents, superChlorRuns: realRuns,
    });
    const calc = async (asOf: number, wide: boolean) => {
        let rows: any[] = [];
        const p = Object.assign({}, realBase, { asOf: new Date(asOf), onIntervals: (x: any[]) => { rows = x; } });
        if (!wide) delete p.chlorCycle;
        const r = await computeRecommendation(p, HTML, realLocal, undefined, realArchive);
        return { r, rows };
    };

    it('full calculation, linear vs wide: per FC interval, and today', async () => {
        const readings = realArchive.fc.map(f => f.ts.getTime());
        const lines: string[] = ['', '| interval (UTC) | days | FC | gen linear | gen wide | burn linear | burn wide | miss linear | miss wide |', '|---|---|---|---|---|---|---|---|---|'];
        let checked = 0;
        for (let i = 1; i < readings.length; i++) {
            const t1 = readings[i - 1], t2 = readings[i];
            if (t2 < LOG_START) continue;
            const after = [await calc(t2 + MIN, false), await calc(t2 + MIN, true)];
            const before = [await calc(t2 - MIN, false), await calc(t2 - MIN, true)];
            const iv = after.map(c => c.rows.find((x: any) => x.t1.getTime() === t1 && x.t2.getTime() === t2));
            const miss = before.map(c => c.r.projectedCurrentFc - realArchive.fc[i].value);
            const fmt = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
            lines.push(`| ${fmt(t1)} to ${fmt(t2)} | ${((t2 - t1) / DAY).toFixed(2)} | ${realArchive.fc[i - 1].value} to ${realArchive.fc[i].value} | ${iv[0].gen.toFixed(2)} | ${iv[1].gen.toFixed(2)} | ${iv[0].perDay.toFixed(3)} | ${iv[1].perDay.toFixed(3)} | ${miss[0] >= 0 ? '+' : ''}${miss[0].toFixed(2)} | ${miss[1] >= 0 ? '+' : ''}${miss[1].toFixed(2)} |`);
            // the wide generation of an interval is the cycle count over its covered part (plus the run window before the log)
            if (t1 >= LOG_START) expect(iv[1].gen).toBeCloseTo(cycleGenerationPpm(realEvents, t1, t2, CYCLE, realPctAt, REAL_RATED), 6);
            checked++;
        }
        const now = [await calc(CAPTURED, false), await calc(CAPTURED, true)];
        lines.push('', `today (${fx.capturedAt}): burn linear ${now[0].r.avgConsumptionPpmPerDay} / wide ${now[1].r.avgConsumptionPpmPerDay} ppm/day; projected FC ${now[0].r.projectedCurrentFc} / ${now[1].r.projectedCurrentFc}; ` +
            `recommended % for the target ${now[0].r.recommendedPctForTarget} / ${now[1].r.recommendedPctForTarget}; maintenance % ${now[0].r.recommendedPct} / ${now[1].r.recommendedPct}`);
        lines.push(...now[1].r.rationale.filter(l => /^Generation since|^Super chlorinate/.test(l)));
        console.log(lines.join('\n'));
        expect(checked).toBeGreaterThanOrEqual(2);
        expect(now[1].r.cycleCount).toBeDefined();
        expect(now[0].r.cycleCount).toBeUndefined();
    }, 120000);

    it('the 11-16 super chlorinate run (07:57-08:01 local): the cell was past the 4% on-part, so the credit is the full 4 minutes at 100%', async () => {
        const run = realRuns[0];
        expect(cycleGenerationPpm(realEvents, run.startMs, run.endMs, CYCLE, realPctAt, REAL_RATED)).toBe(0);
        const wide = (await calc(CAPTURED, true)).r;
        expect(wide.superChlor).toBeDefined();
        expect(wide.superChlor[0].creditPpm).toBeCloseTo(REAL_RATED * (4 / 60) / 24, 2);
        // the burn interval holding the run does not exist yet (no reading since), so the projection carries it: full less the weighted cycles (0)
        expect(wide.rationale.some(l => /plus 0\.04 ppm for super chlorinate/.test(l))).toBe(true);
    }, 60000);
});
