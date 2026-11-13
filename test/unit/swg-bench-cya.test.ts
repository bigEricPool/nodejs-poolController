// SWG Assist Model Bench, step 2: the CYA path between tests, its correction at each new test, the rain k, the CYA test advice, the model-drift check,
// and the temperature and rain wash-in variants (controller/AutoSwgBenchCya.ts, controller/AutoSwgBenchModel.ts). Synthetic pools only.
import { describe, expect, it } from 'vitest';
import { BenchHour, BenchVariant, cyaFor, DAY_MS, fitVariant, HOUR_MS, Interval } from '../../controller/AutoSwgBenchModel';
import {
    CyaAddition, cyaAdvice, cyaPath, CyaSettings, defaultRainK, Dilution, DriftCheck, estimateRainK, modelDrift, normalizeCyaSettings, polygonArea,
    RAIN_K_MAX
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
const fixed = (k: number, extra: Partial<CyaSettings> = {}): CyaSettings => Object.assign(normalizeCyaSettings({}), { rainK: k, autoK: false }, extra);

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
    it('corrects a stabilizer addition\'s size with the next test', () => {
        const p = cyaPath([{ t: day(0), ppm: 50 }, { t: day(15), ppm: 65 }], [{ t: day(5), ppm: 20 }], rows(20), fixed(0.02), day(16));
        expect(p.at(day(5) - HOUR_MS)).toBeCloseTo(50, 6);
        expect(p.at(day(5) + HOUR_MS)).toBeCloseTo(65, 6);
        expect(p.at(day(14))).toBeCloseTo(65, 6);
        expect(p.notes[1].status).toBe('accepted');
        expect(p.notes[1].addition).toBe(true);
    });
    it('holds a rise with nothing added as doubtful until the next test agrees', () => {
        const base = [{ t: day(0), ppm: 60 }, { t: day(10), ppm: 80 }];
        const p1 = cyaPath(base, [], rows(20), fixed(0.02), day(11));
        expect(p1.notes[1].status).toBe('doubtful');
        expect(p1.at(day(11))).toBeCloseTo(60, 6);
        const p2 = cyaPath(base.concat([{ t: day(14), ppm: 78 }]), [], rows(20), fixed(0.02), day(15));
        expect(p2.notes.map(n => n.status)).toEqual(['first', 'confirmed', 'accepted']);
        expect(p2.at(day(15))).toBeCloseTo(78, 6);
        const p3 = cyaPath(base.concat([{ t: day(14), ppm: 61 }]), [], rows(20), fixed(0.02), day(15));
        expect(p3.notes.map(n => n.status)).toEqual(['first', 'doubtful', 'accepted']);
        expect(p3.at(day(15))).toBeCloseTo(61, 6);
    });
    it('holds a fall far beyond the dilution as doubtful too', () => {
        const p = cyaPath([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 40 }], [], rows(20), fixed(0.02), day(11));
        expect(p.notes[1].status).toBe('doubtful');
        expect(p.notes[1].reason).toBeDefined();
    });
});

describe('the rain k from the tests', () => {
    const r = rows(40, [[5, 1], [25, 1]]);
    const dil = new Dilution(r);
    it('stays at the default with no usable pairs', () => {
        expect(estimateRainK([{ t: day(0), ppm: 70, status: 'first', addition: false }], [], dil, 0.015, 4)).toEqual({ k: 0.015, pairs: 0 });
    });
    it('is pulled toward the default while there are few pairs', () => {
        const notes = [{ t: day(0), ppm: 70, status: 'first' as const, addition: false }, { t: day(10), ppm: 70 * Math.exp(-0.04), status: 'accepted' as const, addition: false }];
        const e = estimateRainK(notes, [], dil, 0.015, 4);
        expect(e.pairs).toBe(1);
        expect(e.k).toBeCloseTo((0.04 + 4 * 0.015) / 5, 6);
    });
    it('stays within its bounds, and skips pairs with an addition or a doubtful test', () => {
        const big = [{ t: day(0), ppm: 70, status: 'first' as const, addition: false }, { t: day(10), ppm: 35, status: 'accepted' as const, addition: false }];
        expect(estimateRainK(big, [], dil, 0.015, 0).k).toBe(RAIN_K_MAX);
        expect(estimateRainK(big, [{ t: day(3), ppm: 10 }], dil, 0.015, 4)).toEqual({ k: 0.015, pairs: 0 });
        const doubt = [big[0], Object.assign({}, big[1], { status: 'doubtful' as const })];
        expect(estimateRainK(doubt, [], dil, 0.015, 4).pairs).toBe(0);
    });
    it('is used by the path when autoK is on', () => {
        const tests = [{ t: day(0), ppm: 70 }, { t: day(10), ppm: 66 }, { t: day(30), ppm: 62 }];
        const p = cyaPath(tests, [], r, Object.assign(normalizeCyaSettings({}), { autoK: true }), day(31), { defaultK: 0.015 });
        expect(p.pairs).toBe(2);
        expect(p.rainK).toBeGreaterThan(0.015);
        expect(p.rainK).toBeLessThanOrEqual(RAIN_K_MAX);
        expect(p.defaultK).toBe(0.015);
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
    it('6: an unexplained jump asks for a confirming test, and comes first', () => {
        const a = advice([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 80 }], day(40));
        expect(a.rule).toBe(6);
        expect(rules(a)).toEqual([6, 1]);
        expect(a.reason).toBeDefined();
        expect(rules(advice([{ t: day(0), ppm: 60 }, { t: day(10), ppm: 80 }, { t: day(12), ppm: 79 }], day(13)))).toEqual([]);
    });
});

describe('the model-drift check', () => {
    const v: BenchVariant = { id: 'm', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0, fcPath: 'held', cya: 'path' };
    const r = rows(30);
    // intervals of 2 days with FC held at 6 (so FC is the same at both ends), the loss from a true CYA, scaled by `wobble` so the fit has an error
    function intervals(trueCya: number, a: number, b: number): Interval[] {
        const out: Interval[] = [];
        for (let d = 14; d + 2 <= 28; d += 2) {
            let s = 0;
            for (const x of r) if (x.t > day(d) && x.t <= day(d + 2)) s += 6 / trueCya * x.sun / 1000;
            const wobble = 1 + 0.01 * Math.sin(d);
            out.push({ t1: day(d), f1: 6, t2: day(d + 2), f2: 6, gen: (a * s + b * 2) * wobble });
        }
        return out;
    }
    it('finds the CYA the burn implies, and is off when it is 20% or more from the path', () => {
        const a = 20, b = 0.4;
        const off = modelDrift(v, { a: a, b: b, n: 10 }, intervals(45, a, b), r, () => 70, day(28));
        expect(off.n).toBe(7);
        expect(Math.abs(off.implied - 45)).toBeLessThan(2);
        expect(off.off).toBe(true);
        const ok = modelDrift(v, { a: a, b: b, n: 10 }, intervals(70, a, b), r, () => 70, day(28));
        expect(Math.abs(ok.implied - 70)).toBeLessThan(2);
        expect(ok.off).toBe(false);
    });
    it('cannot judge with too few intervals or a fallback fit', () => {
        expect(modelDrift(v, { a: 20, b: 0.4, n: 10 }, intervals(45, 20, 0.4).slice(0, 3), r, () => 70, day(28)).off).toBeUndefined();
        expect(modelDrift(v, { a: 0, b: 0.4, n: 2, fallback: 'plain14' }, intervals(45, 20, 0.4), r, () => 70, day(28)).off).toBeUndefined();
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
