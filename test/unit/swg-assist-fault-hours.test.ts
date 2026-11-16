// SWG Assist's cycle count leaves out the clock hours in which the cell reported that it was not generating (CELL_FAULT in the output log), the same
// rule as the base layer's cell usage (ChlorinatorUsage.ts) and the Model Bench. Clean cell (16) and communication lost (128) change nothing, and with
// no output log the count is the power log alone, as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger/Logger', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {}, verbose: () => {}, debug: () => {}, silly: () => {} } }));

import { clearFaultHoursCache, cycleGenerationPpm, parseFaultHours, readFaultHours } from '../../controller/AutoSwgCycleCount';
import { AutoSwgParams, ArchivedHistory, LocalSwgEntry, computeRecommendation } from '../../controller/AutoSwgService';
import { cycleConduction } from '../../controller/ChlorinatorUsage';
import type { CycleSettings, PowerEvent } from '../../controller/ChlorinatorUsage';
import type { SuperChlorRun } from '../../controller/AutoSwgSuperChlor';

const H = 3600000, MIN = 60000, DAY = 24 * H;
const CYCLE: CycleSettings = { cycleHours: 3, restartsOnPower: true, burstFirst: true };
const HTML = '<html><body></body></html>';
const GALLONS = 12000, LBS = 1.47;
const RATED = LBS * 1e6 / (GALLONS * 8.34);
const D0 = Date.UTC(2026, 10, 10);
const at = (h: number, m: number = 0) => D0 + h * H + m * MIN;
const DAY_POWER: PowerEvent[] = [{ t: at(7), on: true }, { t: at(19), on: false }];
const ON_11 = 0.11 * 3 * RATED / 24;
const line = (h: number, st?: number[], id: number = 50) => JSON.stringify(Object.assign({ t: new Date(at(h)).toISOString(), id, n: 6, on: 6, out: 11, max: 11, set: 11, tgt: 11, salt: 3300 }, st ? { st } : {}));

describe('fault hours: the count', () => {
    it('a fault hour in the run window takes out exactly that hour\'s conduction', () => {
        const full = cycleGenerationPpm(DAY_POWER, at(0), at(24), CYCLE, () => 11, RATED);
        expect(full).toBeCloseTo(4 * ON_11, 9);
        // 07:00-08:00 holds the whole first on-period (07:00-07:19.8)
        expect(cycleGenerationPpm(DAY_POWER, at(0), at(24), CYCLE, () => 11, RATED, [at(7)])).toBeCloseTo(3 * ON_11, 9);
        // an hour with no current in it changes nothing
        expect(cycleGenerationPpm(DAY_POWER, at(0), at(24), CYCLE, () => 11, RATED, [at(8)])).toBeCloseTo(full, 12);
        // at 50% the 10:00 on-period runs 10:00-11:30: a fault at 11:00 takes out its last half hour, and the drop equals cycleConduction of the hour
        const half = cycleGenerationPpm(DAY_POWER, at(0), at(24), CYCLE, () => 50, RATED);
        const drop = cycleConduction(DAY_POWER, at(11), at(12), CYCLE, () => 50) * RATED / 24;
        expect(drop).toBeCloseTo(0.5 * RATED / 24, 9);
        expect(cycleGenerationPpm(DAY_POWER, at(0), at(24), CYCLE, () => 50, RATED, [at(11)])).toBeCloseTo(half - drop, 12);
        // only the part of a fault hour inside [a, b] is taken out
        expect(cycleGenerationPpm(DAY_POWER, at(7, 10), at(24), CYCLE, () => 11, RATED, [at(7)])).toBeCloseTo(3 * ON_11, 9);
        expect(cycleGenerationPpm(DAY_POWER, at(8), at(24), CYCLE, () => 11, RATED, [at(7)])).toBeCloseTo(3 * ON_11, 9);
    });
    it('reads CELL_FAULT hours only: clean cell (16) and communication lost (128) are not faults', () => {
        const text = [line(6, [128]), line(7, [16]), line(8, [16, 128]), line(9, [2]), line(10), line(11, [1]), line(12, [64, 128]), line(13, [32], 51),
            line(14, []), '{"t":"2026'].join('\n');
        expect(parseFaultHours(text, 50)).toEqual([at(11), at(12)]);
        expect(parseFaultHours(text)).toEqual([at(11), at(12), at(13)]);
        // two lines for one hour (a restart within it): one fault drops the hour, once
        expect(parseFaultHours([line(9), line(9, [8])].join('\n'), 50)).toEqual([at(9)]);
        // each status bit that stops the cell, alone
        for (const b of [1, 4, 8, 32, 64]) expect(parseFaultHours(line(9, [b]), 50)).toEqual([at(9)]);
    });
    it('clean cell and communication lost hours give the same count as no output log', () => {
        const hours = parseFaultHours([line(7, [16]), line(10, [128]), line(13, [16, 128])].join('\n'), 50);
        expect(hours).toEqual([]);
        expect(cycleGenerationPpm(DAY_POWER, at(0), at(24), CYCLE, () => 11, RATED, hours)).toBe(cycleGenerationPpm(DAY_POWER, at(0), at(24), CYCLE, () => 11, RATED));
    });
    describe('reading the file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swg-fault-'));
        const f = path.join(dir, 'chlorinatorOutputLog.jsonl');
        afterEach(() => clearFaultHoursCache());
        it('no output log: no fault hours', () => {
            expect(readFaultHours(50, path.join(dir, 'missing.jsonl'))).toEqual([]);
        });
        it('reads the file, and again when it changes', () => {
            fs.writeFileSync(f, line(11, [1]) + '\n');
            expect(readFaultHours(50, f)).toEqual([at(11)]);
            fs.appendFileSync(f, line(12, [4]) + '\n');
            const t = new Date(Date.now() + 5000);
            fs.utimesSync(f, t, t);
            expect(readFaultHours(50, f)).toEqual([at(11), at(12)]);
        });
    });
});

// Through the calculation: 11% all along, power 07:00-19:00 UTC each day (the run window), readings every 2 days.
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
function power(from: number = -1): PowerEvent[] {
    const ev: PowerEvent[] = [];
    const d0 = Date.UTC(2026, 9, 1);
    for (let d = from; d < 9; d++) { ev.push({ t: d0 + d * DAY + 7 * H, on: true }); ev.push({ t: d0 + d * DAY + 19 * H, on: false }); }
    return ev;
}
const AFTER = READINGS[READINGS.length - 1] + 60000;
async function sCalc(extra: Partial<AutoSwgParams>) {
    let rows: any[] = [];
    const r = await computeRecommendation(Object.assign({ powerEvents: power() }, sBase, { asOf: new Date(AFTER), superChlorRuns: [], onIntervals: (x: any[]) => { rows = x; } }, extra), HTML, [], undefined, sArchive);
    return { r, rows };
}

describe('fault hours: in the calculation (synthetic)', () => {
    const FAULT = Date.UTC(2026, 9, 2, 7);   // 07:00 on the 2nd: the first on-period of that day, inside the first interval
    it('a fault hour in a burn interval takes its on-period out of that interval only', async () => {
        const flat = await sCalc({});
        const fault = await sCalc({ faultHours: [FAULT] });
        expect(flat.rows[0].gen - fault.rows[0].gen).toBeCloseTo(ON_11, 9);
        for (let i = 1; i < flat.rows.length; i++) expect(fault.rows[i].gen).toBeCloseTo(flat.rows[i].gen, 12);
        expect(fault.r.dataKey).not.toBe(flat.r.dataKey);
        expect(fault.r.rationale.some(l => /^1 hour in which the cell reported a fault \(not generating\) is not credited\.$/.test(l))).toBe(true);
        expect((fault.r as any).inputs.faultHours).toBeUndefined();
    });
    it('no fault hours: the same result as before, to the data key and the rationale', async () => {
        const flat = await sCalc({});
        const empty = await sCalc({ faultHours: [] });
        expect(empty.r).toEqual(flat.r);
        expect(empty.rows).toEqual(flat.rows);
        expect(flat.r.rationale.some(l => /reported a fault/.test(l))).toBe(false);
    });
    it('a past calculation sees only the fault hours that had ended by then', async () => {
        // a fault hour after the calculation's time changes nothing
        const later = await sCalc({ faultHours: [AFTER + H] });
        const flat = await sCalc({});
        expect(later.r).toEqual(flat.r);
    });
});

// The real data from the pool, 2026-11-08 to 2026-11-16 (test/unit/fixtures/swg-cycle-count-real.json): its output hours have no fault, only
// communication lost and clean cell, so the results are identical with the output log and without it.
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
const CAPTURED = new Date(fx.capturedAt).getTime();

describe('fault hours: real data from the pool', () => {
    const text = fx.outputHours.map((h: any) => JSON.stringify(h)).join('\n');
    it('the output hours hold no cell fault', () => {
        const statuses = new Set<number>();
        for (const h of fx.outputHours) for (const s of (h.st || [])) statuses.add(s);
        console.log(`statuses in the fixture's output hours: ${Array.from(statuses).join(', ') || 'none'}`);
        expect(parseFaultHours(text, fx.chlorCycle.id)).toEqual([]);
    });
    it('every FC interval and today: identical with the output log and without it', async () => {
        const faultHours = parseFaultHours(text, fx.chlorCycle.id);
        const base = Object.assign({}, fx.inputs, { shareCode: 'fixture', chlorCycle: fx.chlorCycle, powerEvents: realEvents, superChlorRuns: realRuns });
        const times = realArchive.fc.map(f => f.ts.getTime()).filter(t => t >= realEvents[0].t).flatMap(t => [t - MIN, t + MIN]).concat([CAPTURED]);
        for (const t of times) {
            let rowsA: any[] = [], rowsB: any[] = [];
            const a = await computeRecommendation(Object.assign({}, base, { asOf: new Date(t), onIntervals: (x: any[]) => { rowsA = x; } }), HTML, realLocal, undefined, realArchive);
            const b = await computeRecommendation(Object.assign({}, base, { asOf: new Date(t), faultHours, onIntervals: (x: any[]) => { rowsB = x; } }), HTML, realLocal, undefined, realArchive);
            expect(b).toEqual(a);
            expect(rowsB).toEqual(rowsA);
        }
    }, 120000);
});
