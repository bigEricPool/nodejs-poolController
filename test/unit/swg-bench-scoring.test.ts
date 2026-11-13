// SWG Assist Model Bench: the pairs it cannot score fairly (long gap, thin inputs, implausible projection), kept but left out of the headline figures,
// the gap bands' minimum count, and the flagged intervals left out of the model fits (controller/AutoSwgBenchModel.ts).
import { describe, expect, it } from 'vitest';
import {
    BenchHour, BenchVariant, DAY_MS, DEFAULT_SCORING, fitVariant, HOUR_MS, inputStarts, Interval, normalizeScoring, scoreFlags, scoreSummary, spanCoverage
} from '../../controller/AutoSwgBenchModel';

const T0 = Date.UTC(2026, 5, 1);
const day = (d: number) => T0 + d * DAY_MS;
// hourly rows with generation, pump time and sun on every hour (the sun 300-700 W/m2 by the day from 10:00 to 16:00 UTC); `edit` changes them
function rows(days: number, edit?: (r: BenchHour) => void): BenchHour[] {
    const out: BenchHour[] = [];
    for (let t = T0 + HOUR_MS; t <= day(days); t += HOUR_MS) {
        const h = new Date(t - HOUR_MS).getUTCHours();
        const sun = 300 + 100 * ((Math.floor((t - HOUR_MS - T0) / DAY_MS) * 7) % 5);
        const r: BenchHour = { t: t, gen: 0.05, genFrom: 'log', frac: 1, clear: h >= 10 && h < 16 ? 800 : 0, sun: h >= 10 && h < 16 ? sun : 0, pumpSec: 3600 };
        if (edit) edit(r);
        out.push(r);
    }
    return out;
}
const S = DEFAULT_SCORING;

describe('the flags', () => {
    it('flags a long gap, thin inputs and an implausible projection, and nothing else', () => {
        expect(scoreFlags({ days: 3, proj: 7, f1: 6, gen: 4, cov: 1 }, S)).toEqual([]);
        expect(scoreFlags({ days: 10.5, proj: 7, f1: 6, gen: 4, cov: 1 }, S)).toEqual(['longGap']);
        expect(scoreFlags({ days: 10, proj: 7, f1: 6, gen: 4, cov: 1 }, S)).toEqual([]);
        expect(scoreFlags({ days: 3, proj: 7, f1: 6, gen: 4, cov: 0.85 }, S)).toEqual(['thinInputs']);
        // above the start reading plus all the chlorine credited: a negative burn
        expect(scoreFlags({ days: 3, proj: 10.5, f1: 6, gen: 4, cov: 1 }, S)).toEqual(['implausible']);
        expect(scoreFlags({ days: 3, proj: -0.5, f1: 6, gen: 4, cov: 1 }, S)).toEqual(['implausible']);
        expect(scoreFlags({ days: 25.2, proj: 24.8, f1: 6, gen: 30, cov: 0.5 }, S)).toEqual(['longGap', 'thinInputs']);
        // an older row without coverage or generation is judged on what it has
        expect(scoreFlags({ days: 3, proj: 30, f1: 6 }, S)).toEqual([]);
    });
    it('keeps the settings within bounds', () => {
        expect(normalizeScoring({})).toEqual(S);
        expect(normalizeScoring({ maxGapDays: 0, minCoverage: 2, minGapN: 7.6 })).toEqual({ maxGapDays: 1, minCoverage: 1, minGapN: 8 });
        expect(normalizeScoring({ maxGapDays: '14', minCoverage: '' })).toEqual({ maxGapDays: 14, minCoverage: 0.9, minGapN: 8 });
    });
});

describe('input coverage', () => {
    it('counts the hours with every input whose log had begun', () => {
        const r = rows(10, x => { if (x.t <= day(4)) delete x.pumpSec; if (x.t > day(6) && x.t <= day(7)) x.genFrom = 'none'; });
        const st = inputStarts(r);
        expect(st.pump).toBe(day(4) + HOUR_MS);
        // before the pump log began nothing is missing
        expect(spanCoverage(r, day(0), day(4), st)).toBe(1);
        // a day with no generation in a 4-day gap
        expect(spanCoverage(r, day(5), day(9), st)).toBeCloseTo(0.75, 6);
        expect(spanCoverage(r, day(5), day(5), st)).toBe(0);
    });
    it('needs no sun in a dark hour, but does in a sunny one', () => {
        const dark = rows(4, x => { if (!(x.clear > 20)) delete x.sun; });
        expect(spanCoverage(dark, day(1), day(3), inputStarts(dark))).toBe(1);
        const hole = rows(4, x => { if (x.t > day(2) && x.clear > 20) delete x.sun; });
        expect(spanCoverage(hole, day(0), day(4), inputStarts(hole))).toBeCloseTo(1 - 12 / 96, 6);
    });
});

describe('the summary', () => {
    const pairs = [
        { miss: 1, days: 3 }, { miss: -1, days: 3 }, { miss: 0.5, days: 3 }, { miss: 2, days: 1 },
        { miss: -18, days: 25.2, proj: 24.8, f1: 6, gen: 30 }, { miss: 4, days: 3, proj: -1, f1: 6, gen: 1 }
    ].map(r => Object.assign({ proj: 6, f1: 6, gen: 2, cov: 1 }, r));
    it('leaves the flagged pairs out of the headline figures and counts them apart', () => {
        const s = scoreSummary(pairs, { flagsOf: r => scoreFlags(r, S), minGapN: 1 });
        expect(s.n).toBe(4);
        expect(s.nAll).toBe(6);
        expect(s.excluded).toEqual({ longGap: 1, thinInputs: 0, implausible: 1 });
        expect(s.mae).toBeCloseTo((1 + 1 + 0.5 + 2) / 4, 9);
        expect(s.byGap.find(g => g.label === '7 d or more')).toEqual({ label: '7 d or more', n: 0, flagged: 1 });
    });
    it('shows a gap band\'s width only from minGapN pairs on', () => {
        const s = scoreSummary(pairs, { flagsOf: r => scoreFlags(r, S), minGapN: 3 });
        const g24 = s.byGap.find(g => g.label === '2-4 d');
        expect(g24.n).toBe(3);
        expect(g24.halfWidth90).toBeDefined();
        const g2 = s.byGap.find(g => g.label === 'under 2 d');
        expect(g2.halfWidth90).toBeUndefined();
        expect(g2.mae).toBeUndefined();
        expect(g2.note).toBe('only 1 pair; the band needs 3');
    });
    it('is unchanged without flags', () => {
        const s = scoreSummary(pairs);
        expect(s.n).toBe(6);
        expect(s.nAll).toBeUndefined();
        expect(s.byGap.map(g => g.n)).toEqual([1, 4, 0, 1]);
    });
});

describe('the fits leave the flagged intervals out', () => {
    const v: BenchVariant = { id: 'm', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 60, ridge: 0, fcPath: 'held', minIntervals: 5 };
    const r = rows(50);
    const cya = [{ t: day(0), ppm: 60 }];
    // 2-day intervals with FC held at 6: loss = 25 x FC/CYA x S/1000 + 0.4 per day; one 10.5-day interval whose credited chlorine is far too high
    const ivs: Interval[] = [];
    for (let d = 0; d + 2 <= 36; d += 2) {
        let s = 0;
        for (const x of r) if (x.t > day(d) && x.t <= day(d + 2)) s += 6 / 60 * x.sun / 1000;
        ivs.push({ t1: day(d), f1: 6, t2: day(d + 2), f2: 6, gen: 25 * s + 0.8 });
    }
    let s2 = 0;
    for (const x of r) if (x.t > day(36) && x.t <= day(46.5)) s2 += 6 / 60 * x.sun / 1000;
    ivs.push({ t1: day(36), f1: 6, t2: day(46.5), f2: 6, gen: 25 * s2 + 0.4 * 10.5 + 18 });
    const skip = (iv: Interval) => (iv.t2 - iv.t1) / DAY_MS > S.maxGapDays;
    it('recovers the burn without the long interval, and is pulled off it with it', () => {
        const clean = fitVariant(v, ivs, r, cya, day(47), skip);
        expect(clean.a).toBeCloseTo(25, 3);
        expect(clean.b).toBeCloseTo(0.4, 3);
        expect(clean.n).toBe(18);
        const dirty = fitVariant(v, ivs, r, cya, day(47));
        expect(dirty.n).toBe(19);
        expect(Math.abs(dirty.b - 0.4) + Math.abs(dirty.a - 25) / 25).toBeGreaterThan(0.1);
    });
    it('keeps every interval for the plain fallback', () => {
        const few = fitVariant(Object.assign({}, v, { minIntervals: 50 }), ivs, r, cya, day(47), skip);
        expect(few.fallback).toBe('plain14');
        // the 14-day average still spans the long interval (with its extra 18 ppm)
        expect(few.plainRate).toBeGreaterThan(fitVariant(Object.assign({}, v, { minIntervals: 50 }), ivs.slice(0, -1), r, cya, day(36)).plainRate);
    });
});
