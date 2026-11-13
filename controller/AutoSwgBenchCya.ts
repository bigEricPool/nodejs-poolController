/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026.
Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// SWG Assist Model Bench, the CYA between tests and the CYA test advice. Pure functions only (AutoSwgBench.ts runs them), so they can be unit tested.
//
// The CYA path, hour by hour, from only what was known at a moment (asOf):
//   1. It starts at a CYA test.
//   2. Dilution since then, from a source that is a setting:
//        rain   the gauge's rain: each inch replaces a share k of the water (k from the pool's area and gallons, then re-estimated, see 4)
//        salt   the chlorinator's salt reading, with the salt added since taken off: the share of the water still there
//        both   salt anchors the level at each change of the reading, rain between those changes
//        none   no dilution
//   3. Stabilizer additions are steps at their logged times, of the size their amount gives.
//   4. Each new test is the level from its time on. The stretch since the test before is redrawn to land on it: when stabilizer was added in it, the
//      additions are scaled (the logged amount is corrected by the test); otherwise the dilution's shape is kept and scaled, the correction growing from
//      nothing at the earlier test to all of it at the new one. The rain k is re-estimated from every pair of tests with no addition between them,
//      pulled toward the default while there are few pairs and kept within RAIN_K_MIN..RAIN_K_MAX.
//   5. A test that rises more than jumpPpm above the path with no addition logged, or falls far more than dilution allows, is doubtful: the path
//      keeps going without it, the advice asks for a confirming test, and it is taken only once the next test agrees with it.
// Past asOf the path goes on with the rain the rows hold (the weather that happened, as a nowcast uses it); additions after asOf are not known.

import { BenchHour, BenchVariant, CyaTest, DAY_MS, Fit, gapDays, HOUR_MS, Interval, consumption, sunFeature } from './AutoSwgBenchModel';

export interface CyaAddition { t: number; ppm: number; }
export type CyaDilutionSource = 'none' | 'rain' | 'salt' | 'both';
export interface CyaSettings {
    source: CyaDilutionSource;
    rainK?: number;          // the share of the water one inch of rain replaces; not set: from the pool's area and gallons (defaultRainK)
    autoK: boolean;          // re-estimate k from the tests (4 above)
    jumpPpm: number;         // a rise this far above the path with nothing added is doubtful (10)
    priorPairs: number;      // how many one-inch test pairs the default k counts for when it is re-estimated (4)
}
export const DEFAULT_CYA_SETTINGS: CyaSettings = { source: 'rain', autoK: true, jumpPpm: 10, priorPairs: 4 };
export const RAIN_K_MIN = 0, RAIN_K_MAX = 0.05, RAIN_K_FALLBACK = 0.015;
const GAL_PER_FT3 = 7.48052;

export function normalizeCyaSettings(raw: any): CyaSettings {
    const s: CyaSettings = Object.assign({}, DEFAULT_CYA_SETTINGS);
    if (!raw || typeof raw !== 'object') return s;
    if (['none', 'rain', 'salt', 'both'].indexOf(raw.source) >= 0) s.source = raw.source;
    const k = Number(raw.rainK);
    if (raw.rainK !== undefined && raw.rainK !== null && raw.rainK !== '' && isFinite(k)) s.rainK = Math.max(RAIN_K_MIN, Math.min(RAIN_K_MAX, k));
    if (typeof raw.autoK === 'boolean') s.autoK = raw.autoK;
    const j = Number(raw.jumpPpm);
    if (isFinite(j) && j >= 3 && j <= 50) s.jumpPpm = j;
    const p = Number(raw.priorPairs);
    if (isFinite(p) && p >= 0 && p <= 50) s.priorPairs = p;
    return s;
}

// The area of a polygon (shoelace).
export function polygonArea(p: [number, number][]): number {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s) / 2;
}
// The share of the water one inch of rain on the pool replaces (the overflow and draining take the same volume back out).
export function defaultRainK(areaFt2: number, gallons: number): number {
    if (!(areaFt2 > 0 && gallons > 0)) return RAIN_K_FALLBACK;
    return Math.max(RAIN_K_MIN, Math.min(RAIN_K_MAX, areaFt2 / 12 * GAL_PER_FT3 / gallons));
}

// ---------------------------------------------------------------- dilution

// The rows' rain and salt, indexed for the dilution between any two moments.
export class Dilution {
    private ts: number[] = [];
    private cumRain: number[] = [];
    private salt: (number | undefined)[] = [];
    private saltSince: number[] = [];      // the time the salt reading last changed, at each row
    private adds: CyaAddition[];
    constructor(rows: BenchHour[], saltAdds: CyaAddition[] = []) {
        let c = 0, prev: number | undefined, since = -Infinity;
        for (const r of rows) {
            if (typeof r.rain === 'number' && r.rain > 0) c += r.rain;
            this.ts.push(r.t); this.cumRain.push(c); this.salt.push(r.salt);
            if (typeof r.salt === 'number' && r.salt !== prev) { since = r.t; prev = r.salt; }
            this.saltSince.push(since);
        }
        this.adds = saltAdds.slice().sort((a, b) => a.t - b.t);
    }
    private index(t: number): number {
        let lo = 0, hi = this.ts.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (this.ts[m] <= t) lo = m + 1; else hi = m; }
        return lo - 1;
    }
    // inches of rain in the hours that end in (t1, t2]
    public rain(t1: number, t2: number): number {
        const a = this.index(t1), b = this.index(t2);
        return Math.max(0, (b >= 0 ? this.cumRain[b] : 0) - (a >= 0 ? this.cumRain[a] : 0));
    }
    public saltAt(t: number): number | undefined { const i = this.index(t); return i >= 0 ? this.salt[i] : undefined; }
    private saltChangedAt(t: number): number { const i = this.index(t); return i >= 0 ? this.saltSince[i] : -Infinity; }
    private saltAdded(t1: number, t2: number): number { let s = 0; for (const a of this.adds) if (a.t > t1 && a.t <= t2) s += a.ppm; return s; }
    private saltFactor(t1: number, t2: number): number | undefined {
        const s1 = this.saltAt(t1), s2 = this.saltAt(t2);
        if (!(s1 > 0) || !(s2 > 0)) return undefined;
        return Math.max(0.5, Math.min(1.05, (s2 - this.saltAdded(t1, t2)) / s1));
    }
    // The share of the water at t1 still in the pool at t2.
    public factor(t1: number, t2: number, source: CyaDilutionSource, k: number): number {
        if (!(t2 > t1) || source === 'none') return 1;
        const rain = (a: number, b: number) => b > a ? Math.exp(-k * this.rain(a, b)) : 1;
        if (source === 'rain') return rain(t1, t2);
        if (source === 'salt') { const f = this.saltFactor(t1, t2); return typeof f === 'number' ? f : rain(t1, t2); }
        // both: the salt up to its last change before t2, rain after it
        const c = this.saltChangedAt(t2);
        if (!(c > t1)) return rain(t1, t2);
        const f = this.saltFactor(t1, c);
        return (typeof f === 'number' ? f : rain(t1, c)) * rain(c, t2);
    }
}

// ---------------------------------------------------------------- the path

export type CyaTestStatus = 'first' | 'accepted' | 'doubtful' | 'confirmed';
export interface CyaTestNote { t: number; ppm: number; projected?: number; status: CyaTestStatus; addition: boolean; reason?: string; }
export interface CyaPath {
    at: (t: number) => number;
    rainK: number;              // the k used (re-estimated when autoK)
    defaultK: number;
    pairs: number;              // the test pairs with rain the re-estimate used
    notes: CyaTestNote[];       // every known test, oldest first, with what the path expected there
    anchor?: CyaTest;           // the newest test the path stands on
    source: CyaDilutionSource;
}
interface Segment { t0: number; c0: number; t1: number; adds: CyaAddition[]; scale: number; ratio: number; }

const MIN_CYA = 10;
const MAX_ADD_SCALE = 3;

// The CYA path as known at asOf (see the top of the file). `defaultK` is the rain k when the settings do not set one.
export function cyaPath(tests: CyaTest[], additions: CyaAddition[], rows: BenchHour[], settings: CyaSettings, asOf: number, opts: { saltAdds?: CyaAddition[]; defaultK?: number } = {}): CyaPath {
    const known: CyaTest[] = [];
    for (const c of tests.filter(x => x.t <= asOf && x.ppm > 0).sort((a, b) => a.t - b.t)) {
        if (known.length && known[known.length - 1].t === c.t) known[known.length - 1] = c; else known.push(c);
    }
    const adds = additions.filter(a => a.t <= asOf && a.ppm > 0).sort((a, b) => a.t - b.t);
    const dil = new Dilution(rows, (opts.saltAdds || []).filter(a => a.t <= asOf));
    const k0 = typeof settings.rainK === 'number' ? settings.rainK : (typeof opts.defaultK === 'number' ? opts.defaultK : RAIN_K_FALLBACK);
    let walk = walkTests(known, adds, dil, settings, k0);
    let k = k0, pairs = 0;
    // re-estimated from the tests, pulled toward k0 (the settings' k when one is given, else the pool's)
    if (settings.autoK && (settings.source === 'rain' || settings.source === 'both')) {
        const e = estimateRainK(walk.notes, adds, dil, k0, settings.priorPairs);
        k = e.k; pairs = e.pairs;
        if (Math.abs(k - k0) > 1e-9) walk = walkTests(known, adds, dil, settings, k);
    }
    const segs = walk.segs, first = known[0];
    const valueIn = (s: Segment, t: number): number => {
        let v = s.c0 * dil.factor(s.t0, t, settings.source, k);
        for (const a of s.adds) if (a.t <= t) v += s.scale * a.ppm * dil.factor(a.t, t, settings.source, k);
        if (s.ratio !== 1 && isFinite(s.t1)) v *= Math.pow(s.ratio, Math.max(0, Math.min(1, (t - s.t0) / (s.t1 - s.t0))));
        return v;
    };
    const at = (t: number): number => {
        if (!first) return 70;
        if (t <= first.t || !segs.length) return Math.max(MIN_CYA, first.ppm);
        let lo = 0, hi = segs.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].t0 < t) lo = m + 1; else hi = m; }
        return Math.max(MIN_CYA, valueIn(segs[Math.max(0, lo - 1)], t));
    };
    return { at: at, rainK: k, defaultK: k0, pairs: pairs, notes: walk.notes, anchor: walk.anchor, source: settings.source };
}

function walkTests(known: CyaTest[], adds: CyaAddition[], dil: Dilution, s: CyaSettings, k: number): { segs: Segment[]; notes: CyaTestNote[]; anchor?: CyaTest } {
    const segs: Segment[] = [], notes: CyaTestNote[] = [];
    if (!known.length) return { segs, notes };
    const between = (a: number, b: number) => adds.filter(x => x.t > a && x.t <= b);
    const raw = (from: CyaTest, list: CyaAddition[], t: number, scale: number = 1) => {
        let v = from.ppm * dil.factor(from.t, t, s.source, k);
        for (const a of list) if (a.t <= t) v += scale * a.ppm * dil.factor(a.t, t, s.source, k);
        return v;
    };
    // closes the stretch from `a` to `b` so that it lands on b
    const close = (a: CyaTest, b: CyaTest) => {
        const list = between(a.t, b.t);
        const R = raw(a, list, b.t);
        let scale = 1, ratio = 1;
        const addEnd = list.reduce((x, y) => x + y.ppm * dil.factor(y.t, b.t, s.source, k), 0);
        if (list.length && addEnd > 0) {
            scale = Math.max(0, Math.min(MAX_ADD_SCALE, 1 + (b.ppm - R) / addEnd));
            const R2 = raw(a, list, b.t, scale);
            if (R2 > 0 && Math.abs(R2 - b.ppm) > 1e-6) ratio = b.ppm / R2;
        }
        else if (R > 0) ratio = b.ppm / R;
        segs.push({ t0: a.t, c0: a.ppm, t1: b.t, adds: list, scale: scale, ratio: ratio });
    };
    let anchor = known[0];
    notes.push({ t: anchor.t, ppm: anchor.ppm, status: 'first', addition: false });
    let pending: { test: CyaTest; note: CyaTestNote } | undefined;
    for (let j = 1; j < known.length; j++) {
        const T = known[j];
        if (pending) {
            const P = raw(pending.test, between(pending.test.t, T.t), T.t);
            if (Math.abs(T.ppm - P) <= s.jumpPpm) {
                close(anchor, pending.test);
                pending.note.status = 'confirmed';
                anchor = pending.test; pending = undefined;
                close(anchor, T);
                notes.push({ t: T.t, ppm: T.ppm, projected: round1(P), status: 'accepted', addition: between(anchor.t, T.t).length > 0 });
                anchor = T;
                continue;
            }
            pending = undefined;
        }
        const list = between(anchor.t, T.t);
        const R = raw(anchor, list, T.t);
        const diff = T.ppm - R;
        const hasAdd = list.length > 0;
        const rise = !hasAdd && diff > s.jumpPpm;
        const fall = diff < -Math.max(1.5 * s.jumpPpm, 0.2 * R);
        if (rise || fall) {
            const note: CyaTestNote = {
                t: T.t, ppm: T.ppm, projected: round1(R), status: 'doubtful', addition: hasAdd,
                reason: rise ? `${Math.round(diff)} ppm above the expected ${Math.round(R)} with no stabilizer logged` : `${Math.round(-diff)} ppm below the expected ${Math.round(R)}, more than dilution explains`
            };
            notes.push(note);
            pending = { test: T, note: note };
            continue;
        }
        close(anchor, T);
        notes.push({ t: T.t, ppm: T.ppm, projected: round1(R), status: 'accepted', addition: hasAdd });
        anchor = T;
    }
    // the open stretch after the newest test the path stands on
    segs.push({ t0: anchor.t, c0: anchor.ppm, t1: Infinity, adds: adds.filter(x => x.t > anchor.t), scale: 1, ratio: 1 });
    return { segs, notes, anchor };
}
function round1(x: number): number { return Math.round(x * 10) / 10; }

// The rain k from the pairs of consecutive tests the path stands on with no stabilizer added between them: ln(c1/c2) = k x inches of rain, solved by
// least squares pulled toward k0 as if it were `priorPairs` pairs of one inch each, and kept within the bounds.
export function estimateRainK(notes: CyaTestNote[], adds: CyaAddition[], dil: Dilution, k0: number, priorPairs: number): { k: number; pairs: number } {
    const used = notes.filter(n => n.status !== 'doubtful');
    let sxy = 0, sxx = 0, pairs = 0;
    for (let i = 0; i + 1 < used.length; i++) {
        const a = used[i], b = used[i + 1];
        if (adds.some(x => x.t > a.t && x.t <= b.t)) continue;
        const x = dil.rain(a.t, b.t);
        if (!(x > 0.05) || !(a.ppm > 0) || !(b.ppm > 0)) continue;
        sxy += x * Math.log(a.ppm / b.ppm); sxx += x * x; pairs++;
    }
    const k = (sxy + priorPairs * k0) / (sxx + priorPairs);
    return { k: isFinite(k) ? Math.max(RAIN_K_MIN, Math.min(RAIN_K_MAX, k)) : k0, pairs: pairs };
}

// The path every `stepHours` hours over [from, to], for a chart.
export function pathSamples(p: CyaPath, from: number, to: number, stepHours: number = 6): [number, number][] {
    const out: [number, number][] = [];
    const step = Math.max(1, stepHours) * HOUR_MS;
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push([t, round1(p.at(t))]);
    return out;
}

// ---------------------------------------------------------------- model drift (advice rule 3)

export interface DriftCheck { t: number; off?: boolean; implied?: number; path?: number; n: number; }
// The burn fitted on the FC intervals of the last `days` days with CYA left free as a scale: the sun coefficient u of that fit against the main fit's a
// says what CYA the burn implies (CYA on the path x a / u). It is off when that is at least 20% from the path and u is more than two standard errors
// from a. Fewer than four intervals, or a sun coefficient that is not positive, cannot judge (off undefined).
export function modelDrift(v: BenchVariant, fit: Fit, intervals: Interval[], rows: BenchHour[], cya: (t: number) => number, asOf: number, days: number = 14): DriftCheck {
    const out: DriftCheck = { t: asOf, n: 0 };
    if (!fit || fit.fallback || !(fit.a > 0)) return out;
    const X: number[][] = [], y: number[] = [];
    for (const iv of intervals) {
        if (iv.t2 > asOf || iv.t1 < asOf - days * DAY_MS || iv.t2 - iv.t1 <= 0.3 * DAY_MS) continue;
        const s = sunFeature(v, rows, iv.t1, iv.t2, cya, t => iv.f1 + (iv.f2 - iv.f1) * (t - iv.t1) / (iv.t2 - iv.t1), undefined, fit.c);
        if (typeof s !== 'number') continue;
        X.push([s, gapDays(iv)]); y.push(consumption(iv));
    }
    out.n = X.length;
    if (X.length < 4) return out;
    let a11 = 0, a12 = 0, a22 = 0, v1 = 0, v2 = 0;
    for (let k = 0; k < X.length; k++) { a11 += X[k][0] * X[k][0]; a12 += X[k][0] * X[k][1]; a22 += X[k][1] * X[k][1]; v1 += X[k][0] * y[k]; v2 += X[k][1] * y[k]; }
    const det = a11 * a22 - a12 * a12;
    if (!(Math.abs(det) > 1e-12)) return out;
    const u = (a22 * v1 - a12 * v2) / det, b = (a11 * v2 - a12 * v1) / det;
    let sse = 0;
    for (let k = 0; k < X.length; k++) { const r = y[k] - u * X[k][0] - b * X[k][1]; sse += r * r; }
    const se = Math.sqrt(Math.max(0, sse / Math.max(1, X.length - 2)) * a22 / det);
    out.path = round1(cya(asOf));
    if (!(u > 0)) return out;
    out.implied = round1(out.path * fit.a / u);
    out.off = Math.abs(out.implied / out.path - 1) >= 0.2 && Math.abs(u - fit.a) > 2 * se;
    return out;
}

// ---------------------------------------------------------------- the advice

export const CYA_ADVICE = { ageDays: 28, dropPpm: 10, dropShare: 0.15, missPpm: 1, missSunShare: 0.4, addAfterDays: 3 };
export interface CyaAdviceRule { rule: number; reason: string; since: number; }
export interface CyaAdvice { due: boolean; rule?: number; reason?: string; since?: string; rules: { rule: number; reason: string; since: string }[]; }
export interface CyaMiss { t: number; miss: number; sunShare?: number; }
// The order a note is shown in when several rules hold: a doubtful test first, then a fresh addition, the model, the misses, the path, the age.
const PRIORITY = [6, 5, 3, 4, 2, 1];

// Whether a CYA test is worth doing now, and why (advisory only). Every rule is judged after the newest CYA test, so a newer test clears it:
//   1 age: the newest test is ageDays old
//   2 projected drift: the path has fallen dropPpm or dropShare below the test it stands on
//   3 model drift: the model drift was off at the last two checks
//   4 misses: the last three FC projections missed the same way by more than missPpm on days the sun was missSunShare of the burn
//   5 stabilizer added: addAfterDays after a logged addition (once it has dissolved), until a test
//   6 unexplained jump: the newest test is doubtful (see cyaPath); a confirming test is asked for
export function cyaAdvice(now: number, path: CyaPath, additions: CyaAddition[], drift: DriftCheck[], misses: CyaMiss[], fmt: (t: number) => string = t => new Date(t).toISOString()): CyaAdvice {
    const found: CyaAdviceRule[] = [];
    const notes = path.notes.filter(n => n.t <= now);
    const newest = notes[notes.length - 1];
    const after = newest ? newest.t : -Infinity;
    if (!newest) found.push({ rule: 1, reason: 'No CYA test is logged.', since: now });
    else {
        if (newest.status === 'doubtful') found.push({ rule: 6, reason: `The CYA test of ${fmt(newest.t)} (${newest.ppm}) is ${newest.reason}; a second test would confirm it. Until then the bench keeps the CYA path without it.`, since: newest.t });
        const add = additions.filter(a => a.t > after && a.t <= now).sort((a, b) => a.t - b.t)[0];
        if (add && now >= add.t + CYA_ADVICE.addAfterDays * DAY_MS)
            found.push({ rule: 5, reason: `Stabilizer was added ${fmt(add.t)} (about ${Math.round(add.ppm)} ppm); a test now shows what it really added.`, since: add.t + CYA_ADVICE.addAfterDays * DAY_MS });
        const d = drift.filter(x => x.t > after).sort((a, b) => a.t - b.t);
        if (d.length >= 2 && d[d.length - 1].off === true && d[d.length - 2].off === true) {
            const x = d[d.length - 1];
            found.push({ rule: 3, reason: `The FC tests of the last two weeks fit a CYA of about ${Math.round(x.implied)}, against ${Math.round(x.path)} on the path, at the last two checks.`, since: d[d.length - 2].t });
        }
        const m = misses.filter(x => x.t > after).sort((a, b) => a.t - b.t).slice(-3);
        if (m.length === 3 && m.every(x => Math.abs(x.miss) > CYA_ADVICE.missPpm && (x.sunShare || 0) >= CYA_ADVICE.missSunShare)
            && (m.every(x => x.miss > 0) || m.every(x => x.miss < 0)))
            found.push({ rule: 4, reason: `The last three FC projections all came out ${m[0].miss > 0 ? 'below' : 'above'} the test by more than ${CYA_ADVICE.missPpm} ppm on sunny stretches; CYA may have moved.`, since: m[0].t });
        const base = path.anchor || newest;
        const nowVal = path.at(now);
        const limit = CYA_ADVICE.dropPpm;
        if (base.ppm - nowVal >= limit || (base.ppm - nowVal) / base.ppm >= CYA_ADVICE.dropShare) {
            let since = now;
            for (let t = base.t + DAY_MS; t <= now; t += DAY_MS) { const v = path.at(t); if (base.ppm - v >= limit || (base.ppm - v) / base.ppm >= CYA_ADVICE.dropShare) { since = t; break; } }
            found.push({ rule: 2, reason: `The CYA path has fallen from ${base.ppm} to about ${Math.round(nowVal)} since the test of ${fmt(base.t)} (rain dilution).`, since: since });
        }
        if (now - newest.t >= CYA_ADVICE.ageDays * DAY_MS) found.push({ rule: 1, reason: `The last CYA test was ${Math.floor((now - newest.t) / DAY_MS)} days ago (${fmt(newest.t)}).`, since: newest.t + CYA_ADVICE.ageDays * DAY_MS });
    }
    found.sort((a, b) => PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule));
    const rules = found.map(f => ({ rule: f.rule, reason: f.reason, since: new Date(f.since).toISOString() }));
    if (!rules.length) return { due: false, rules: [] };
    return { due: true, rule: rules[0].rule, reason: rules[0].reason, since: rules[0].since, rules: rules };
}
