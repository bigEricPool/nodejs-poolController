// SWG Assist Model Bench, the closed-loop simulator (controller/AutoSwgBenchSim.ts) with the REAL range control (SwgAssistBand.bandDecision):
//   - on the 2026-11-04 simulation's inputs and plant, the live controller reproduces that run (twice a week about 94.5% of hours in 7-10, daily
//     swing 0.6 to 0.7 ppm), within the spread of seeds;
//   - a noisier projection gives more SWG % churn and no less swing;
//   - the range control gets the inputs the live check builds;
//   - the outcome table (live projection, plain averages, sun x FC/CYA) is printed to the test log, for the user's criteria.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { BenchHour, BenchVariant, CyaTest, quantile } from '../../controller/AutoSwgBenchModel';
import {
    bandInputFor, buildCalendar, DEFAULT_SIM_SETTINGS, fitModelPlant, liveProjector, modelProjector, outcome, plainProjector, Projector, SimData, SimOutcome,
    simulate, summarizeOutcomes, testsFor, twiceWeeklyTests, weeklyTests
} from '../../controller/AutoSwgBenchSim';

const sfx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swg-bench-sim-nov4.json'), 'utf8'));
const gfx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swg-bench-golden.json'), 'utf8'));
const PPM_H = 1.47 * 1e6 / (12000 * 8.34) / 24;
const rows: BenchHour[] = gfx.hours.map((x: number[]) => ({ t: x[0], gen: 0, genFrom: 'none', sun: x[1], frac: 1, clear: 0 }));
const cya: CyaTest[] = gfx.cya.map((x: number[]) => ({ t: x[0], ppm: x[1] }));
const data: SimData = {
    start: sfx.start, end: sfx.end, lat: 28.5, lon: -81.5,
    fc: sfx.fc.map((x: number[]) => ({ t: x[0], fc: x[1] })),
    swg: sfx.swg.map((x: number[]) => ({ t: x[0], ppmPerDay: x[1], hrs: x[2], pct: x[3] })),
    adds: sfx.adds.map((x: number[]) => ({ t: x[0], ppm: x[1] })),
    rows: rows, cya: cya, ppmPerHourAtFull: PPM_H
};
const s = DEFAULT_SIM_SETTINGS;
const cal = buildCalendar(data, s);
const SEEDS = 20;
const runMany = (pr: () => Projector, rhythm: 'twiceWeekly' | 'weekly' | 'real', plant: any = 'k', seeds = SEEDS): SimOutcome[] => {
    const out: SimOutcome[] = [];
    for (let k = 0; k < seeds; k++) out.push(outcome(simulate(data, cal, s, pr(), testsFor(rhythm, 1000 + k, data), 1000 + k, plant), s));
    return out;
};

describe('the 2026-11-04 plant', () => {
    it('has the same burn constant as the Python simulation', () => {
        expect(quantile(cal.kh, 0.5)).toBeCloseTo(sfx.python.kMedian, 2);
        expect(Math.min(...cal.kh)).toBeCloseTo(sfx.python.kMin, 2);
        expect(Math.max(...cal.kh)).toBeCloseTo(sfx.python.kMax, 2);
    });
    it('draws the user\'s testing habits', () => {
        const tw = twiceWeeklyTests(1000, data.start, data.end), wk = weeklyTests(1000, data.start, data.end);
        const weeks = (data.end - data.start) / (7 * 86400000);
        expect(tw.length / weeks).toBeGreaterThan(2);
        expect(tw.length / weeks).toBeLessThan(2.5);
        expect(Math.abs(wk.length - weeks)).toBeLessThan(2);
    });
});

describe('closed loop with the real range control', () => {
    it('reproduces the 2026-11-04 result for the live controller, twice a week', () => {
        const list = runMany(liveProjector, 'twiceWeekly');
        const sm = summarizeOutcomes(list);
        console.log(`live, twice a week, 'k' plant, ${SEEDS} seeds: in 7-10 ${sm.median.in710.toFixed(1)}% (${sm.p10.in710.toFixed(1)}-${sm.p90.in710.toFixed(1)}), swing ${sm.median.swing.toFixed(2)}, low ${sm.median.low.toFixed(2)}, high ${sm.median.high.toFixed(2)}, typical ${sm.median.typicalPct}%`);
        expect(Math.abs(sm.median.in710 - sfx.python.twiceWeeklyIn710)).toBeLessThan(3);
        expect(sm.median.swing).toBeGreaterThan(sfx.python.swing[0] - 0.1);
        expect(sm.median.swing).toBeLessThan(sfx.python.swing[1] + 0.1);
    }, 120000);
    it('churns the SWG % more with a noisier projection', () => {
        const noisy = (): Projector => {
            const base = liveProjector();
            let k = 0;
            return { name: 'noisy', project: c => { const r = base.project(c); if (r) r.projected += 1.2 * Math.sin(++k * 2.39996); return r; } };
        };
        const a = summarizeOutcomes(runMany(liveProjector, 'twiceWeekly', 'k', 6)).median;
        const b = summarizeOutcomes(runMany(noisy, 'twiceWeekly', 'k', 6)).median;
        expect(b.meanChangePerCheck).toBeGreaterThan(a.meanChangePerCheck);
        expect(b.swing).toBeGreaterThanOrEqual(a.swing - 0.02);
    }, 120000);
    it('gives the range control the inputs the live check builds', () => {
        const i = cal.lhour.findIndex(h => h === 10);
        const hrs = cal.windows.get(cal.day[i]).hrs;
        const r = { projected: 8.2, avg: 1.1, elDays: 2.4, lastT: data.start, lastV: 8.5 };
        const input = bandInputFor(cal, s, PPM_H, i, r, hrs, false, [8, 8.5, 9]);
        expect(input.maintenancePct).toBeCloseTo(1.1 / (PPM_H * hrs) * 100, 6);
        expect(input.marginPpm).toBeCloseTo(Math.min(1, 0.15 * 2.4), 9);
        expect(input.ppmPerHourAtFull).toBe(PPM_H);
        expect(input.periodRunHours).toBeCloseTo(hrs, 1);
        expect(input.peakRunHours).toBeGreaterThan(0);
        expect(input.peakCap).toBe(true);
        expect(input.integral).toBe(0.3);
        expect(input.scaledBias).toBe(true);
        expect(input.lastReading).toBe(8.5);
        expect(input.recentReadings).toEqual([8, 8.5, 9]);
        expect([input.low, input.high]).toEqual([7, 10]);
    });
});

describe('outcome table', () => {
    it('prints the user\'s criteria for the live projection, the plain averages and sun x FC/CYA', () => {
        const sunCya: BenchVariant = { id: 'sun-cya-30', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, fcPath: 'model' };
        const sunCya45: BenchVariant = Object.assign({}, sunCya, { id: 'sun-cya-45', fitDays: 45 });
        const projectors: [string, () => Projector][] = [['live', liveProjector], ['plain14', () => plainProjector(14)], ['plain7', () => plainProjector(7)], ['sun-cya-30', () => modelProjector(sunCya)], ['sun-cya-45', () => modelProjector(sunCya45)]];
        const mp = fitModelPlant(data, sunCya);
        expect(mp).toBeDefined();
        const plants: [string, any][] = [['k', 'k'], ['model', mp]];
        const lines: string[] = [`SWG Assist Model Bench, closed loop, ${SEEDS} seeds, ${new Date(data.start).toISOString().slice(0, 10)} to ${new Date(data.end).toISOString().slice(0, 10)}, range ${s.low}-${s.high}; median (10%-90% of seeds)`,
            `model plant: a ${mp.fit.a.toFixed(2)}, b ${mp.fit.b.toFixed(2)} ppm/day, ${mp.residuals.length} real intervals resampled`,
            'plant  rhythm       projector    in7-10            <7    <6    >10   >10.5  low   high   swing  drift  chg/wk  size  typ%'];
        for (const [pn, plant] of plants) {
            for (const rhythm of ['twiceWeekly', 'weekly', 'real'] as const) {
                for (const [name, mk] of projectors) {
                    const sm = summarizeOutcomes(runMany(mk, rhythm, plant));
                    const m = sm.median;
                    lines.push(`${pn.padEnd(6)} ${rhythm.padEnd(12)} ${name.padEnd(12)} ${m.in710.toFixed(1).padStart(5)} (${sm.p10.in710.toFixed(1)}-${sm.p90.in710.toFixed(1)})`.padEnd(54) +
                        ` ${m.below7.toFixed(1).padStart(4)}  ${m.below6.toFixed(1).padStart(4)}  ${m.above10.toFixed(1).padStart(4)}  ${m.above105.toFixed(1).padStart(4)}  ${m.low.toFixed(2)}  ${m.high.toFixed(2).padStart(5)}  ${m.swing.toFixed(2)}   ${m.drift.toFixed(2)}   ${m.changesPerWeek.toFixed(1).padStart(4)}   ${m.changeSize.toFixed(1).padStart(4)}  ${m.typicalPct.toFixed(0)}`);
                    expect(m.in710).toBeGreaterThan(0);
                }
            }
        }
        console.log('\n' + lines.join('\n') + '\n');
    }, 600000);
});
