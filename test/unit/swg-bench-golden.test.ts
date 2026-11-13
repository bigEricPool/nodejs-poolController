// SWG Assist Model Bench, golden replay: the bench's fit and projection must reproduce the 2026-11-13 offline run (cyamode.py, CYA held at the last
// test, 30-day fit, ridge 0.5, FC held at the start reading) from the same inputs, exported to fixtures/swg-bench-golden.json:
//   sun-CYA against the 14-day average, Jan 15 - Sep 20 2026 (52 tests): MAE 1.74 against 2.02
//   90% half-width of the misses, Jan 15 - Nov 12 2026 (79 tests): 3.2 against 4.0
// The fixture's pool sun is the offline run's (its own shade model), so this checks the fitting, projection and scoring, not the geometry.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { BenchHour, BenchVariant, CyaTest, Interval, quantile, replayVariant } from '../../controller/AutoSwgBenchModel';

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swg-bench-golden.json'), 'utf8'));
const intervals: Interval[] = fx.intervals.map((x: number[]) => ({ t1: x[0], f1: x[1], t2: x[2], f2: x[3], gen: x[4] }));
const rows: BenchHour[] = fx.hours.map((x: number[]) => ({ t: x[0], gen: 0, genFrom: 'none', sun: x[1], frac: 1, clear: 0 }));
const cya: CyaTest[] = fx.cya.map((x: number[]) => ({ t: x[0], ppm: x[1] }));
const FIRST = Date.UTC(2025, 10, 10);
const JAN15 = Date.UTC(2026, 0, 15), SEP20 = Date.UTC(2026, 8, 20), NOV14 = Date.UTC(2026, 10, 14);

const sunCya: BenchVariant = { id: 'sun-cya-30-held', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, minIntervals: 5, minGapDays: 0.3, fcPath: 'held' };
const plain14: BenchVariant = { id: 'plain14', version: 1, kind: 'plain', windowDays: 14, minGapDays: 0.3 };

const model = replayVariant(sunCya, intervals, rows, cya, JAN15, NOV14, FIRST);
const plain = replayVariant(plain14, intervals, rows, cya, JAN15, NOV14, FIRST);
const mae = (r: { miss: number }[]) => r.reduce((s, x) => s + Math.abs(x.miss), 0) / r.length;
const q90 = (r: { miss: number }[]) => quantile(r.map(x => Math.abs(x.miss)), 0.9);
function within<T extends { t1: number }>(r: T[], a: number, b: number): T[] { return r.filter(x => x.t1 >= a && x.t1 < b); }

describe('golden replay of the 2026-11-13 offline run', () => {
    it('scores the same 79 tests', () => {
        expect(model.length).toBe(fx.expected.jan15_nov12.n);
        expect(plain.length).toBe(fx.expected.jan15_nov12.n);
        expect(within(model, JAN15, SEP20).length).toBe(fx.expected.jan15_sep20.n);
    });
    it('projects each interval as the offline run did', () => {
        const byT = new Map<number, number[]>(fx.rows.map((r: number[]) => [r[0], r] as [number, number[]]));
        let worst = 0;
        for (const r of model) {
            const o = byT.get(r.t1);
            expect(o).toBeDefined();
            worst = Math.max(worst, Math.abs((r.miss + r.actual) - o[1]), Math.abs(r.actual - o[2]));
        }
        for (const r of plain) worst = Math.max(worst, Math.abs((r.miss + r.actual) - byT.get(r.t1)[3]));
        expect(worst).toBeLessThan(0.02);
    });
    it('reproduces MAE 1.74 against 2.02 over Jan 15 - Sep 20', () => {
        expect(Math.abs(mae(within(model, JAN15, SEP20)) - fx.expected.jan15_sep20.maeHeld)).toBeLessThan(0.05);
        expect(Math.abs(mae(within(plain, JAN15, SEP20)) - fx.expected.jan15_sep20.maePlain)).toBeLessThan(0.05);
        expect(mae(within(model, JAN15, SEP20))).toBeCloseTo(1.74, 1);
        expect(mae(within(plain, JAN15, SEP20))).toBeCloseTo(2.02, 1);
    });
    it('reproduces the 90% band of 3.2 against 4.0 over Jan 15 - Nov 12', () => {
        expect(Math.abs(q90(model) - fx.expected.jan15_nov12.q90Held)).toBeLessThan(0.05);
        expect(Math.abs(q90(plain) - fx.expected.jan15_nov12.q90Plain)).toBeLessThan(0.05);
        expect(q90(model)).toBeCloseTo(3.2, 0);
        expect(q90(plain)).toBeCloseTo(4.0, 0);
    });
});
