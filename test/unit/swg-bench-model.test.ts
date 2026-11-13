// SWG Assist Model Bench, the models (controller/AutoSwgBenchModel.ts): the sun's position against the user's suncalc screens, the pool's sunlit share,
// a synthetic pool whose burn coefficients must be recovered, no look-ahead, the scoring statistics, the hourly inputs, and the stabilizer reader.
import { describe, expect, it } from 'vitest';
import {
    BenchHour, BenchVariant, buildHourlyInputs, DAY_MS, DEFAULT_GEOMETRY, fitVariant, heldCya, HOUR_MS, Interval, meshTransmission, pairedDifference,
    poolSunFraction, projectLoss, quantile, ridgeSolve, scoreSummary, sunPosition
} from '../../controller/AutoSwgBenchModel';
import { stabilizerAdditionsOf, stabilizerPpm } from '../../controller/PoolMathArchive';

// A place near the pool, rounded (the bench reads the real one from the njsPC location).
const LAT = 28.5, LON = -81.5;
const deg = (r: number) => r * 180 / Math.PI;

describe('sun position', () => {
    // suncalc.org screens for the pool, 22nd of the month, near 13:00 local: altitude, with the sun due south (azimuth 186 to 191)
    const screens: [number, number][] = [[11, 37.3], [2, 62.2], [5, 84.9], [8, 61.1]];
    for (const [month, alt] of screens) {
        it(`matches the suncalc altitude ${alt} deg on ${month + 1}/22 with the sun near south`, () => {
            let best = Infinity;
            for (let m = 12 * 60 + 30; m <= 13 * 60 + 45; m++) {
                const p = sunPosition(new Date(2026, month, 22, Math.floor(m / 60), m % 60).getTime(), LAT, LON);
                const az = deg(p.az);
                if (az >= 180 && az <= 195) best = Math.min(best, Math.abs(deg(p.alt) - alt));
            }
            expect(best).toBeLessThan(0.4);
        });
    }
    it('puts the sun below the horizon at night and east in the morning', () => {
        expect(sunPosition(new Date(2026, 5, 22, 2, 0).getTime(), LAT, LON).alt).toBeLessThan(0);
        const am = sunPosition(new Date(2026, 5, 22, 9, 0).getTime(), LAT, LON);
        expect(deg(am.az)).toBeGreaterThan(60);
        expect(deg(am.az)).toBeLessThan(120);
    });
});

describe('pool sunlit share', () => {
    const at13 = (month: number) => poolSunFraction(new Date(2026, month, 22, 13, 0).getTime(), LAT, LON, DEFAULT_GEOMETRY);
    it('is almost all lit in June and mostly shaded in December at 13:00', () => {
        expect(at13(5).lit).toBeGreaterThan(0.99);
        expect(at13(11).lit).toBeLessThan(0.35);
        expect(at13(2).lit).toBeGreaterThan(at13(11).lit);
        expect(at13(8).lit).toBeGreaterThan(at13(11).lit);
    });
    it('passes less through the mesh when the sun is low, and nothing at night', () => {
        expect(at13(5).screen).toBeGreaterThan(at13(11).screen);
        expect(at13(5).screen).toBeLessThanOrEqual(0.68);
        expect(poolSunFraction(new Date(2026, 5, 22, 1, 0).getTime(), LAT, LON).total).toBe(0);
        expect(meshTransmission(90)).toBeCloseTo(0.68, 5);
        expect(meshTransmission(20)).toBeCloseTo(0.40, 5);
    });
    it('gives a clear-sky weighted share in December far below June', () => {
        const share = (month: number) => {
            let num = 0, den = 0;
            for (let m = 0; m < 24 * 60; m += 10) {
                const t = new Date(2026, month, 15, 0, m).getTime();
                const f = poolSunFraction(t, LAT, LON);
                const w = Math.max(0, Math.sin(f.alt));
                num += w * f.total; den += w;
            }
            return num / den;
        };
        const dec = share(11), jun = share(5);
        expect(dec).toBeLessThan(0.3);
        expect(jun).toBeGreaterThan(0.5);
    });
});

// A synthetic pool: daylight sun on a half-sine, CYA 50, burn = a x FC/CYA x sun/1000 + b per day, readings every 2.5 days from a known path.
function synthetic(a: number, b: number) {
    const start = Date.UTC(2026, 3, 1);
    const rows: BenchHour[] = [];
    for (let h = 1; h <= 90 * 24; h++) {
        const t = start + h * HOUR_MS;
        const hod = (h - 1) % 24;
        const sun = hod >= 6 && hod < 18 ? 900 * Math.sin(Math.PI * (hod - 6 + 0.5) / 12) * (0.6 + 0.4 * Math.abs(Math.sin(h / 37))) : 0;
        rows.push({ t: t, gen: hod >= 9 && hod < 16 ? 0.25 : 0, genFrom: 'log', sun: sun, frac: 1, clear: 0 });
    }
    const cya = [{ t: start - DAY_MS, ppm: 50 }];
    let fc = 8;
    const readings: { t: number; fc: number }[] = [{ t: start, fc: fc }];
    for (const r of rows) {
        fc = fc + r.gen - (a * fc / 50 * r.sun / 1000 + b / 24);
        if (((r.t - start) / HOUR_MS) % 60 === 0) readings.push({ t: r.t, fc: fc });
    }
    const intervals: Interval[] = [];
    for (let k = 0; k + 1 < readings.length; k++) {
        const g = rows.filter(r => r.t > readings[k].t && r.t <= readings[k + 1].t).reduce((s, r) => s + r.gen, 0);
        intervals.push({ t1: readings[k].t, f1: readings[k].fc, t2: readings[k + 1].t, f2: readings[k + 1].fc, gen: g });
    }
    return { rows, cya, readings, intervals, start };
}

describe('fit and projection', () => {
    const v: BenchVariant = { id: 's', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 60, ridge: 1e-6, fcPath: 'model' };
    it('recovers a known a and b from a synthetic pool', () => {
        const p = synthetic(1.6, 0.4);
        const fit = fitVariant(v, p.intervals, p.rows, p.cya, p.readings[p.readings.length - 1].t);
        expect(fit).toBeDefined();
        expect(fit.fallback).toBeUndefined();
        expect(fit.a).toBeGreaterThan(1.6 * 0.9);
        expect(fit.a).toBeLessThan(1.6 * 1.1);
        // the fit takes FC as linear between two readings while the real path curves with the daily cycle, so b comes back within about 0.1
        expect(Math.abs(fit.b - 0.4)).toBeLessThan(0.15);
    });
    it('projects the next reading closely when FC follows the model in the gap', () => {
        const p = synthetic(1.6, 0.4);
        const k = p.readings.length - 2;
        const fit = fitVariant(v, p.intervals, p.rows, p.cya, p.readings[k].t);
        const iv = p.intervals[k];
        const loss = projectLoss(v, fit, p.rows, p.cya, iv.t1, iv.t1, iv.f1, iv.t2);
        expect(Math.abs(iv.f1 + iv.gen - loss - iv.f2)).toBeLessThan(0.1);
    });
    it('falls back to the 14-day average with too few intervals', () => {
        const p = synthetic(1.6, 0.4);
        const fit = fitVariant(Object.assign({}, v, { minIntervals: 50 }), p.intervals, p.rows, p.cya, p.readings[p.readings.length - 1].t);
        expect(fit.fallback).toBe('plain14');
    });
    it('cannot see readings, tests or CYA after the moment it is fitted (no look-ahead)', () => {
        const p = synthetic(1.6, 0.4);
        const asOf = p.readings[15].t;
        const a = fitVariant(v, p.intervals, p.rows, p.cya, asOf);
        const later = p.intervals.map(iv => iv.t2 > asOf ? Object.assign({}, iv, { f2: iv.f2 + 3, gen: iv.gen * 2 }) : iv);
        const b = fitVariant(v, later, p.rows, p.cya.concat([{ t: asOf + DAY_MS, ppm: 90 }]), asOf);
        expect(b).toEqual(a);
        expect(heldCya(p.cya.concat([{ t: asOf + DAY_MS, ppm: 90 }]), asOf)(asOf + 5 * DAY_MS)).toBe(50);
        expect(heldCya([{ t: 0, ppm: 40 }, { t: 10, ppm: 70 }], 20)(5)).toBe(40);
        expect(heldCya([{ t: 0, ppm: 40 }, { t: 10, ppm: 70 }], 20)(15)).toBe(70);
    });
    it('solves ridge least squares', () => {
        const w = ridgeSolve([[1, 0], [0, 1], [1, 1]], [1, 2, 3], 0);
        expect(w[0]).toBeCloseTo(1, 6);
        expect(w[1]).toBeCloseTo(2, 6);
    });
});

describe('scoring statistics', () => {
    const rows = [-2, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 4].map((m, k) => ({ miss: m, days: [1, 3, 5, 8][k % 4] }));
    it('gives n, mean absolute miss, bias and the 90% half-width', () => {
        const s = scoreSummary(rows);
        expect(s.n).toBe(10);
        expect(s.mae).toBeCloseTo(1.55, 6);
        expect(s.bias).toBeCloseTo(0.85, 6);
        expect(s.halfWidth90).toBeCloseTo(quantile(rows.map(r => Math.abs(r.miss)), 0.9), 9);
        expect(s.halfWidth90).toBeCloseTo(3.1, 6);
        expect(s.byGap.map(g => g.n)).toEqual([3, 3, 2, 2]);
    });
    it('interpolates quantiles like the offline run', () => {
        expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 9);
        expect(quantile([5], 0.9)).toBe(5);
    });
    it('pairs a variant against a reference repeatably', () => {
        const a = rows.map(r => r.miss * 0.5), b = rows.map(r => r.miss);
        const p1 = pairedDifference(a, b), p2 = pairedDifference(a, b);
        expect(p1.meanDiff).toBeCloseTo(-0.775, 6);
        expect(p1.pBetter).toBeGreaterThan(0.95);
        expect(p2).toEqual(p1);
    });
});

describe('hourly inputs', () => {
    it('credits the cell from the output log, adds liquid chlorine, and splits the rain by local day', () => {
        const t0 = new Date(2026, 9, 10, 9, 0).getTime();
        const rows = buildHourlyInputs({
            gallons: 12000, cellLbsPerDay: 1.47,
            outputHours: [{ t: new Date(t0).toISOString(), n: 6, on: 6, out: 50, max: 50, set: 50, tgt: 50, salt: 3200 }],
            swgEntries: [], chlorine: [{ ts: t0 + 30 * 60000, ppm: 1.2 }],
            weather: [{ t: t0 + HOUR_MS, lt: '2026-10-10T10:00:00', precipTotal: 0.1, solarRad: 600 }, { t: t0 + 2 * HOUR_MS, lt: '2026-10-10T11:00:00', precipTotal: 0.35, solarRad: 700, solarRadMean: 500 }],
            waterTemp: [], pump: [], salt: []
        }, t0, t0 + 3 * HOUR_MS);
        // 50% for the hour of a 1.47 lb/day cell in 12,000 gallons: 0.5 x 1.47/24 lb = 0.306 ppm
        expect(rows[0].gen).toBeCloseTo(0.5 * 1.47 / 24 * 453592.37 / (12000 * 3.785411784) + 1.2, 4);
        expect(rows[0].genFrom).toBe('log');
        expect(rows[1].rain).toBeCloseTo(0.25, 9);
        expect(rows[1].sun).toBe(500);
        expect(rows[1].sunHigh).toBe(700);
        expect(rows[0].sun).toBe(600);
    });
});

describe('stabilizer additions', () => {
    it('reads PoolMath chemical 24 in grams as ppm of CYA for the pool', () => {
        const list = stabilizerAdditionsOf([
            { id: 'a', type: 'chemlog', ts: '2026-02-21T13:59:38Z', chemical: 24, unit: 7, amount: 32, normalizedAmount: 907.18474 },
            { id: 'b', type: 'chemlog', ts: '2026-02-21T14:00:00Z', chemical: 26, unit: 6, amount: 40, normalizedAmount: 18143.7 },
            { id: 'c', type: 'testlog', ts: '2026-03-04T18:28:37Z', cya: 70 },
        ], 12000);
        expect(list.length).toBe(1);
        expect(list[0].grams).toBeCloseTo(907.18, 2);
        expect(list[0].ppm).toBeCloseTo(19.97, 1);
        expect(stabilizerPpm(907.18474, 0)).toBe(0);
    });
});
