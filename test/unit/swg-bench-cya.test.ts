// SWG Assist Model Bench, step 2: the CYA path between tests (TFP's loss, physical rain dilution with storm runoff from the salt, stabilizer that
// dissolves over days, every test an anchor), the CYA test advice, the model-drift check and its guards, TFP's SWG FC table, and the temperature and rain
// wash-in variants (controller/AutoSwgBenchCya.ts, controller/AutoSwgBenchModel.ts). Synthetic pools only.
import { describe, expect, it } from 'vitest';
import { BenchHour, BenchVariant, cyaFor, DAY_MS, fitVariant, HOUR_MS, Interval } from '../../controller/AutoSwgBenchModel';
import {
    CyaAddition, cyaAdvice, cyaPath, CyaSettings, defaultRainK, Dilution, DriftCheck, modelDrift, normalizeCyaSettings, pathVsTests, polygonArea,
    tfpCyaLossPerMonth, tfpSwgFc
} from '../../controller/AutoSwgBenchCya';

const T0 = Date.UTC(2026, 5, 1);
const day = (d: number) => T0 + d * DAY_MS;
// hourly rows over `days` days; rain (inches) at the given days (one hour each); the sun from 10:00 to 16:00 UTC, 300 to 700 W/m2 by the day
// (days that differ, so the sun and the steady demand can be told apart)
function rows(days: number, rain: [number, number][] = [], extra?: (r: BenchHour) => void): BenchHour[] {
    const out: BenchHour[] = [];
    for (let t = T0 + HOUR_MS; t <= day(days); t += HOUR_MS) {
        const h = new Date(t - HOUR_MS).getUTCHours();
        const sun = 300 + 100 * ((Math.floor((t - HOUR_MS - T0) / DAY_MS) * 7) % 5);
        const r: BenchHour = { t: t, gen: 0, genFrom: 'none', frac: 1, clear: h >= 10 && h < 16 ? 800 : 0, sun: h >= 10 && h < 16 ? sun : 0, rain: 0 };
        out.push(r);
    }
    for (const [d, inch] of rain) { const r = out.find(x => x.t === Math.round(day(d) / HOUR_MS) * HOUR_MS); if (r) r.rain = inch; }
    if (extra) out.forEach(extra);
    return out;
}
// a set rain k and no CYA loss, so the dilution's shape can be checked on its own
const fixed = (k: number, extra: Partial<CyaSettings> = {}): CyaSettings => Object.assign(normalizeCyaSettings({}), { rainK: k, lossLow: 0, lossHigh: 0 }, extra);

describe('dilution', () => {
    it('takes a share k of the water out with each inch of rain', () => {
        const d = new Dilution(rows(10, [[3, 1], [6, 0.5]]));
        expect(d.rain(day(0), day(10))).toBeCloseTo(1.5, 6);
        expect(d.factor(day(0), day(10), 'rain', 0.02)).toBeCloseTo(Math.exp(-0.03), 9);
        expect(d.factor(day(0), day(10), 'none', 0.02)).toBe(1);
    });
    it('reads the salt, with the salt added taken off, and falls back to rain without it', () => {
        const r = rows(10, [[4, 1]], x => { x.salt = x.t < day(5) ? 3200 : 3100; });
        const d = new Dilution(r, [{ t: day(6), ppm: 100 }]);
        expect(d.factor(day(1), day(8), 'salt', 0.02)).toBeCloseTo((3100 - 100) / 3200, 6);
        expect(new Dilution(rows(10, [[4, 1]])).factor(day(1), day(8), 'salt', 0.02)).toBeCloseTo(Math.exp(-0.02), 9);
        // both: salt up to its last change (day 5), rain after it (none)
        expect(d.factor(day(1), day(8), 'both', 0.02)).toBeCloseTo(3100 / 3200, 6);
    });
    it('sizes the default k from the pool\'s area and gallons', () => {
        expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
        expect(defaultRainK(400, 15000)).toBeCloseTo(400 / 12 * 7.48052 / 15000, 6);
        expect(defaultRainK(0, 15000)).toBe(0.015);
    });
    it('counts a storm\'s inches up to twice when the salt after it fell more than k explains', () => {
        // 2 in on day 5; the salt 3200 before, 2900 on days 3-7 after: 9.4% of the water went, against 3.9% for k 0.02
        const salty = (x: BenchHour) => { x.salt = x.t < day(6) ? 3200 : 2900; };
        const d = new Dilution(rows(20, [[5, 2]], salty));
        const ev = d.setRunoff(0.02, day(15), 2);
        expect(ev.length).toBe(1);
        expect(ev[0].m).toBe(2);
        expect(ev[0].implied).toBeCloseTo(0.0938, 4);
        expect(d.rain(day(0), day(10))).toBeCloseTo(2, 6);
        expect(d.effectiveRain(day(0), day(10))).toBeCloseTo(4, 6);
        expect(d.factor(day(0), day(10), 'rain', 0.02)).toBeCloseTo(Math.exp(-0.08), 9);
        // not judged before day 3-7 after the storm is known, nor for a storm under 1.5 in, nor when the salt agrees with k
        const early = new Dilution(rows(20, [[5, 2]], salty));
        expect(early.setRunoff(0.02, day(10), 2)[0].m).toBe(1);
        const small = new Dilution(rows(20, [[5, 1]], salty));
        expect(small.setRunoff(0.02, day(15), 2)[0].implied).toBeUndefined();
        const agrees = new Dilution(rows(20, [[5, 2]], x => { x.salt = x.t < day(6) ? 3200 : 3080; }));
        expect(agrees.setRunoff(0.02, day(15), 2)[0].m).toBe(1);
    });
});

describe('TFP', () => {
    it('loses CYA at 2.5 ppm a month at 75 F and below, 7.5 at 85 F and above, straight between', () => {
        expect(tfpCyaLossPerMonth(70)).toBe(2.5);
        expect(tfpCyaLossPerMonth(75)).toBe(2.5);
        expect(tfpCyaLossPerMonth(77.5)).toBeCloseTo(3.75, 9);
        expect(tfpCyaLossPerMonth(80)).toBeCloseTo(5, 9);
        expect(tfpCyaLossPerMonth(90)).toBe(7.5);
        expect(tfpCyaLossPerMonth(undefined)).toBeCloseTo(5, 9);
    });
    it('gives the SWG minimum, target and SLAM FC by CYA, between rows and held past the ends', () => {
        expect(tfpSwgFc(90)).toEqual({ cya: 90, min: 4, lo: 6, hi: 12, slam: 35 });
        expect(tfpSwgFc(85)).toEqual({ cya: 85, min: 4, lo: 6, hi: 11.5, slam: 33 });
        expect(tfpSwgFc(65).min).toBe(3);
        expect(tfpSwgFc(10)).toEqual({ cya: 10, min: 2, lo: 3, hi: 5, slam: 10 });
        expect(tfpSwgFc(120).slam).toBe(39);
    });
});

describe('the CYA path', () => {
    const r = rows(40, [[10, 1], [20, 1]]);
    const tests = [{ t: day(0), ppm: 70 }, { t: day(30), ppm: 60 }];
    it('goes forward from the last test with the rain, seeing no later test', () => {
        const p = cyaPath(tests, [], r, fixed(0.02), day(29));
        expect(p.at(day(5))).toBeCloseTo(70, 6);
        expect(p.at(day(25))).toBeCloseTo(70 * Math.exp(-0.04), 6);
        expect(p.notes.length).toBe(1);
    });
    it('loses CYA at TFP\'s rate by the water temperature', () => {
        const loss = (extra?: (x: BenchHour) => void, temps?: { t: number; f: number }[]) =>
            cyaPath([{ t: day(0), ppm: 70 }], [], rows(30, [], extra), fixed(0, { lossLow: 2.5, lossHigh: 7.5 }), day(30), { waterTemps: temps }).at(day(30));
        expect(loss()).toBeCloseTo(65, 6);                                  // no temperature: 80 F
        expect(loss(x => { x.temp = 90; })).toBeCloseTo(62.5, 6);
        expect(loss(x => { x.temp = 70; })).toBeCloseTo(67.5, 6);
        expect(loss(undefined, [{ t: day(0) - 1, f: 90 }])).toBeCloseTo(62.5, 6);   // PoolMath's water temperature when the rows have none
    });
    it('is redrawn to land on a new test, keeping the rain\'s shape', () => {
        const p = cyaPath(tests, [], r, fixed(0.02), day(31));
        expect(p.at(day(30) - 1000)).toBeCloseTo(60, 1);
        expect(p.at(day(31))).toBeCloseTo(60, 6);
        expect(p.notes[1]).toEqual({ t: day(30), ppm: 60, projected: 67.3, status: 'accepted', addition: false });
        // the rain still steps the path down by e^-k
        const step = p.at(day(10) + HOUR_MS) / p.at(day(10) - HOUR_MS);
        expect(Math.abs(step - Math.exp(-0.02))).toBeLessThan(0.002);
        for (let d = 1; d < 30; d++) expect(p.at(day(d))).toBeLessThanOrEqual(p.at(day(d - 1)) + 1e-9);
    });
    it('lets stabilizer in over five days, its size corrected by the next test', () => {
        // 20 ppm logged on day 5; the test on day 15 says 15 went in: scaled by 0.75, entering straight to day 10
        const p = cyaPath([{ t: day(0), ppm: 50 }, { t: day(15), ppm: 65 }], [{ t: day(5), ppm: 20 }], rows(20), fixed(0.02), day(16));
        expect(p.at(day(5) - HOUR_MS)).toBeCloseTo(50, 6);
        expect(p.at(day(5) + HOUR_MS)).toBeCloseTo(50 + 0.75 * 20 / 120, 6);
        expect(p.at(day(7.5))).toBeCloseTo(57.5, 6);
        expect(p.at(day(10) + HOUR_MS)).toBeCloseTo(65, 6);
        expect(p.at(day(14))).toBeCloseTo(65, 6);
        expect(p.notes[1].status).toBe('accepted');
        expect(p.notes[1].addition).toBe(true);
        // a three-day ramp
        const q = cyaPath([{ t: day(0), ppm: 50 }], [{ t: day(5), ppm: 20 }], rows(20), fixed(0.02, { rampDays: 3 }), day(16));
        expect(q.at(day(6.5))).toBeCloseTo(60, 6);
        expect(q.at(day(9))).toBeCloseTo(70, 6);
    });
    it('stands on every test, flagging a rise with nothing added as unexplained', () => {
        const p = cyaPath([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 85 }], [], rows(20), fixed(0.02), day(11));
        expect(p.notes[1].status).toBe('unexplained');
        expect(p.notes[1].reason).toBeDefined();
        expect(p.at(day(11))).toBeCloseTo(85, 6);
        expect(p.anchor).toEqual({ t: day(10), ppm: 85 });
        // within twice the test's error, or with stabilizer logged, it is just accepted
        expect(cyaPath([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 75 }], [], rows(20), fixed(0.02), day(11)).notes[1].status).toBe('accepted');
        expect(cyaPath([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 85 }], [{ t: day(2), ppm: 5 }], rows(20), fixed(0.02), day(11)).notes[1].status).toBe('accepted');
    });
    it('flags a fall far beyond the loss and dilution too, and still stands on it', () => {
        const p = cyaPath([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 35 }], [], rows(20), fixed(0.02), day(11));
        expect(p.notes[1].status).toBe('unexplained');
        expect(p.at(day(11))).toBeCloseTo(35, 6);
    });
    it('keeps the physical rain k, whatever the tests say', () => {
        const p = cyaPath([{ t: day(0), ppm: 70 }, { t: day(10), ppm: 50 }, { t: day(30), ppm: 40 }], [], r, normalizeCyaSettings({}), day(31), { defaultK: 0.015 });
        expect(p.rainK).toBe(0.015);
        expect(p.defaultK).toBe(0.015);
        expect(cyaPath(tests, [], r, normalizeCyaSettings({ rainK: 0.03 }), day(31), { defaultK: 0.015 }).rainK).toBe(0.03);
    });
    it('reports how the TFP path did at the tests', () => {
        const p = cyaPath(tests, [], r, fixed(0.02), day(31));
        const v = pathVsTests(p);
        expect(v.n).toBe(1);
        expect(v.meanMiss).toBeCloseTo(60 - 67.3, 6);
        expect(v.unexplained).toBe(0);
    });
});

describe('the CYA test advice', () => {
    const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
    const advice = (tests: { t: number; ppm: number }[], now: number, o: { adds?: CyaAddition[]; drift?: DriftCheck[]; misses?: { t: number; miss: number; sunShare?: number }[]; rain?: [number, number][]; k?: number } = {}) =>
        cyaAdvice(now, cyaPath(tests, o.adds || [], rows(70, o.rain || []), fixed(o.k || 0.02), now), o.adds || [], o.drift || [], o.misses || [], fmt);
    const rules = (a: ReturnType<typeof cyaAdvice>) => a.rules.map(r => r.rule);
    it('1: age', () => {
        expect(rules(advice([{ t: day(0), ppm: 70 }], day(27)))).toEqual([]);
        expect(advice([{ t: day(0), ppm: 70 }], day(29)).rule).toBe(1);
        expect(rules(advice([{ t: day(0), ppm: 70 }, { t: day(29), ppm: 70 }], day(29.5)))).toEqual([]);
    });
    it('2: projected drift', () => {
        const rain: [number, number][] = [[5, 2], [8, 2], [11, 2]];
        const a = advice([{ t: day(0), ppm: 70 }], day(15), { rain: rain, k: 0.03 });
        expect(a.rule).toBe(2);
        expect(a.since).toBe(new Date(day(11)).toISOString());
        expect(rules(advice([{ t: day(0), ppm: 70 }, { t: day(14), ppm: 60 }], day(15), { rain: rain, k: 0.03 }))).toEqual([]);
    });
    it('3: model drift at two checks in a row', () => {
        const off = (d: number, o: boolean): DriftCheck => ({ t: day(d), off: o, implied: 45, path: 70, n: 6 });
        const tests = [{ t: day(0), ppm: 70 }];
        expect(rules(advice(tests, day(10), { drift: [off(8, false), off(9, true)] }))).toEqual([]);
        expect(advice(tests, day(10), { drift: [off(8, true), off(9, true)] }).rule).toBe(3);
        expect(rules(advice(tests.concat([{ t: day(9.5), ppm: 70 }]), day(10), { drift: [off(8, true), off(9, true)] }))).toEqual([]);
        // a check that could not judge breaks the run
        const unjudged: DriftCheck = { t: day(8.5), n: 3, why: '3 intervals, 6 needed' };
        expect(rules(advice(tests, day(10), { drift: [off(8, true), unjudged, off(9, true)] }))).toEqual([]);
    });
    it('4: three misses the same way on sunny stretches', () => {
        const m = (d: number, miss: number, s: number = 0.6) => ({ t: day(d), miss: miss, sunShare: s });
        const tests = [{ t: day(0), ppm: 70 }];
        expect(advice(tests, day(10), { misses: [m(3, 1.5), m(5, 1.2), m(8, 2)] }).rule).toBe(4);
        expect(rules(advice(tests, day(10), { misses: [m(3, 1.5), m(5, -1.2), m(8, 2)] }))).toEqual([]);
        expect(rules(advice(tests, day(10), { misses: [m(3, 1.5), m(5, 1.2), m(8, 2, 0.2)] }))).toEqual([]);
        expect(rules(advice(tests, day(10), { misses: [m(3, 1.5), m(5, 1.2), m(8, 0.5)] }))).toEqual([]);
    });
    it('5: three days after stabilizer is added, until a test', () => {
        const adds = [{ t: day(1), ppm: 15 }];
        const tests = [{ t: day(0), ppm: 50 }];
        expect(rules(advice(tests, day(3), { adds: adds }))).toEqual([]);
        expect(advice(tests, day(4.5), { adds: adds }).rule).toBe(5);
        expect(rules(advice(tests.concat([{ t: day(5), ppm: 64 }]), day(5.5), { adds: adds }))).toEqual([]);
    });
    it('6: an unexplained test asks for a confirming test, and comes first', () => {
        const a = advice([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 85 }], day(40));
        expect(a.rule).toBe(6);
        expect(rules(a)).toEqual([6, 1]);
        expect(a.reason).toBeDefined();
        expect(rules(advice([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 85 }, { t: day(12), ppm: 84 }], day(13)))).toEqual([]);
    });
});

describe('the model-drift check', () => {
    const v: BenchVariant = { id: 'm', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0, fcPath: 'held', cya: 'path' };
    // the sun by two-day block, varied enough (CV about 0.43 across the intervals) for the check to judge
    const blocks = [300, 800, 450, 700, 250, 600, 900];
    const varied = rows(30, [], x => { const h = new Date(x.t - HOUR_MS).getUTCHours(); const d = Math.floor((x.t - HOUR_MS - T0) / DAY_MS); x.sun = h >= 10 && h < 16 ? blocks[Math.floor(d / 2) % 7] : 0; });
    // intervals of 2 days with FC held at 6 (so FC is the same at both ends), the loss from a true CYA, scaled by `wobble` so the fit has an error
    function intervals(r: BenchHour[], trueCya: number, a: number, b: number): Interval[] {
        const out: Interval[] = [];
        for (let d = 14; d + 2 <= 28; d += 2) {
            let s = 0;
            for (const x of r) if (x.t > day(d) && x.t <= day(d + 2)) s += 6 / trueCya * x.sun / 1000;
            const wobble = 1 + 0.01 * Math.sin(d);
            out.push({ t1: day(d), f1: 6, t2: day(d + 2), f2: 6, gen: (a * s + b * 2) * wobble });
        }
        return out;
    }
    const a = 20, b = 0.4;
    it('finds the CYA the burn implies, and is off when it is 20% or more from the path', () => {
        const off = modelDrift(v, { a: a, b: b, n: 10 }, intervals(varied, 45, a, b), varied, () => 70, day(28));
        expect(off.n).toBe(7);
        expect(off.cv).toBeGreaterThan(0.25);
        expect(Math.abs(off.implied - 45)).toBeLessThan(2);
        expect(off.off).toBe(true);
        const ok = modelDrift(v, { a: a, b: b, n: 10 }, intervals(varied, 70, a, b), varied, () => 70, day(28));
        expect(Math.abs(ok.implied - 70)).toBeLessThan(2);
        expect(ok.off).toBe(false);
    });
    it('cannot judge with too few intervals or a fallback fit', () => {
        const x = modelDrift(v, { a: a, b: b, n: 10 }, intervals(varied, 45, a, b).slice(0, 5), varied, () => 70, day(28));
        expect(x.off).toBeUndefined();
        expect(x.why).toContain('6 needed');
        expect(modelDrift(v, { a: 0, b: b, n: 2, fallback: 'plain14' }, intervals(varied, 45, a, b), varied, () => 70, day(28)).off).toBeUndefined();
    });
    it('cannot judge when the sun varied too little or the implied CYA is not a CYA', () => {
        const flat = rows(30);      // two-day sun means from 400 to 600: CV about 0.16
        const x = modelDrift(v, { a: a, b: b, n: 10 }, intervals(flat, 45, a, b), flat, () => 70, day(28));
        expect(x.off).toBeUndefined();
        expect(x.why).toContain('varied too little');
        const y = modelDrift(v, { a: a, b: b, n: 10 }, intervals(varied, 10, a, b), varied, () => 70, day(28));
        expect(y.off).toBeUndefined();
        expect(y.why).toContain('outside');
    });
});

describe('the temperature and rain wash-in variants', () => {
    const base: BenchVariant = { id: 'm', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 40, ridge: 0, fcPath: 'held', minIntervals: 5 };
    // 2-day intervals with the loss a x FC/CYA x S/1000 x exp(c (T - 80)) + b x days + b2 x rain
    function pool(c: number, b2: number, temp: (d: number) => number, rainAt: [number, number][]) {
        const r = rows(40, rainAt, x => { x.temp = temp(Math.floor((x.t - T0 - 1) / (2 * DAY_MS)) * 2); });
        const ivs: Interval[] = [];
        for (let d = 0; d + 2 <= 40; d += 2) {
            let s = 0, rain = 0;
            for (const x of r) if (x.t > day(d) && x.t <= day(d + 2)) { s += 6 / 60 * x.sun / 1000 * Math.exp(c * (x.temp - 80)); rain += x.rain || 0; }
            ivs.push({ t1: day(d), f1: 6, t2: day(d + 2), f2: 6, gen: 25 * s + 0.4 * 2 + b2 * rain });
        }
        return { r, ivs };
    }
    const cya = [{ t: day(0), ppm: 60 }];
    it('fits the temperature coefficient', () => {
        const p = pool(0.06, 0, d => (d / 2) % 2 ? 90 : 72, []);
        const f = fitVariant(Object.assign({}, base, { temp: true }), p.ivs, p.r, cya, day(40));
        expect(f.c).toBe(0.06);
        expect(f.a).toBeCloseTo(25, 1);
        // without temperatures every c fits the same: the first one is kept and a, b are those of the plain fit
        const flat = pool(0, 0, () => 80, []);
        const plain = fitVariant(base, flat.ivs, flat.r, cya, day(40));
        const t = fitVariant(Object.assign({}, base, { temp: true }), flat.ivs, flat.r, cya, day(40));
        expect(t.a).toBeCloseTo(plain.a, 6);
        expect(t.b).toBeCloseTo(plain.b, 6);
    });
    it('fits the rain wash-in', () => {
        const p = pool(0, 0.5, () => 80, [[3, 1], [9, 0.4], [17, 2], [25, 0.8], [33, 1.5]]);
        const f = fitVariant(Object.assign({}, base, { rainWash: true }), p.ivs, p.r, cya, day(40));
        expect(f.b2).toBeCloseTo(0.5, 2);
        expect(f.a).toBeCloseTo(25, 1);
        expect(fitVariant(base, p.ivs, p.r, cya, day(40)).b2).toBeUndefined();
    });
    it('uses the CYA path only for a variant that asks for it', () => {
        const src = { tests: [{ t: day(0), ppm: 60 }], path: () => () => 42 };
        expect(cyaFor(Object.assign({}, base, { cya: 'path' as const }), src, day(5))(day(5))).toBe(42);
        expect(cyaFor(base, src, day(5))(day(5))).toBe(60);
        expect(cyaFor(Object.assign({}, base, { cya: 'path' as const }), src.tests, day(5))(day(5))).toBe(60);
    });
});
