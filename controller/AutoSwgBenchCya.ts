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
//   1. It starts at a CYA test. Every test is an anchor: the path always stands on the newest test, none is ever left out.
//   2. CYA is lost at TFP's rate, not a fitted one. TFP ("Free Chlorine and Cyanuric Acid Relationship", Pool School): "You may see a 5 to 10 PPM CYA
//      loss per month", more with hot water (85-90 F). The loss per month runs from lossLow at tLow (2.5 ppm at 75 F) up to lossHigh at tHigh (7.5 ppm,
//      the middle of TFP's 5-10, at 85 F), straight between, by the hour's water temperature (the water temperature history, else the last PoolMath
//      water temperature, else 80 F). Test pairs never feed back into the rate.
//   3. Dilution, from a source that is a setting:
//        rain   each inch of rain on the pool replaces a share k of the water, k from the pool's area and gallons (physical, not fitted). A storm of
//               1.5 in or more can bring in runoff: when the salt after it (days 3-7, net of salt added) fell more than one meter step (100 ppm) beyond
//               what k explains, that storm's inches count up to runoffMax (2) times. Nothing else changes k.
//        salt   the chlorinator's salt reading, with the salt added since taken off: the share of the water still there
//        both   salt anchors the level at each change of the reading, rain between those changes
//        none   no dilution
//   4. Stabilizer dissolves slowly: each logged addition enters straight over rampDays (5) days from its time.
//   5. Each new test is the level from its time on. The stretch since the test before is redrawn to land on it: when stabilizer was added in it, the
//      additions are scaled (the logged amount is corrected by the test); what is left is a correction growing from nothing at the earlier test to all of it
//      at the new one.
//   6. A test more than unexplainedPpm (20, twice the test's +-10) above the path with no stabilizer logged in the quietDays (14) before it, or that far
//      below it, is flagged 'unexplained'. The path still stands on it; the advice asks for a confirming test. The expectation comes only from the TFP
//      path above, so it can't reinforce itself.
// Past asOf the path goes on with the rain the rows hold (the weather that happened, as a nowcast uses it); additions after asOf are not known.

import { BenchHour, BenchVariant, CyaTest, DAY_MS, Fit, gapDays, HOUR_MS, Interval, consumption, sunFeature } from './AutoSwgBenchModel';

export interface CyaAddition { t: number; ppm: number; }
export interface WaterTemp { t: number; f: number; }      // a water temperature in F (PoolMath's tests)
export type CyaDilutionSource = 'none' | 'rain' | 'salt' | 'both';
export interface CyaSettings {
    source: CyaDilutionSource;
    rainK?: number;          // the share of the water one inch of rain replaces; not set: from the pool's area and gallons (defaultRainK)
    runoffMax: number;       // the most a storm's inches can count for when the salt shows runoff (2)
    lossLow: number;         // ppm a month lost at tLow and below (2.5)
    lossHigh: number;        // ppm a month lost at tHigh and above (7.5)
    tLow: number;            // F (75)
    tHigh: number;           // F (85)
    rampDays: number;        // days a stabilizer addition takes to enter (5, 3-7)
    unexplainedPpm: number;  // a test this far from the path is flagged (20)
    quietDays: number;       // with no stabilizer logged this many days before it (14)
}
export const DEFAULT_CYA_SETTINGS: CyaSettings = {
    source: 'rain', runoffMax: 2, lossLow: 2.5, lossHigh: 7.5, tLow: 75, tHigh: 85, rampDays: 5, unexplainedPpm: 20, quietDays: 14
};
export const RAIN_K_MIN = 0, RAIN_K_MAX = 0.05, RAIN_K_FALLBACK = 0.015;
export const DEFAULT_WATER_F = 80;
const GAL_PER_FT3 = 7.48052;
const RUNOFF_MIN_INCHES = 1.5, SALT_STEP_PPM = 100, EVENT_GAP_HOURS = 12;

export function normalizeCyaSettings(raw: any): CyaSettings {
    const s: CyaSettings = Object.assign({}, DEFAULT_CYA_SETTINGS);
    if (!raw || typeof raw !== 'object') return s;
    if (['none', 'rain', 'salt', 'both'].indexOf(raw.source) >= 0) s.source = raw.source;
    const k = Number(raw.rainK);
    if (raw.rainK !== undefined && raw.rainK !== null && raw.rainK !== '' && isFinite(k)) s.rainK = Math.max(RAIN_K_MIN, Math.min(RAIN_K_MAX, k));
    const num = (key: keyof CyaSettings, lo: number, hi: number) => {
        const x = Number(raw[key]);
        if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '' && isFinite(x)) (s as any)[key] = Math.max(lo, Math.min(hi, x));
    };
    num('runoffMax', 1, 3); num('lossLow', 0, 20); num('lossHigh', 0, 30); num('tLow', 40, 100); num('tHigh', 40, 110);
    num('rampDays', 3, 7); num('unexplainedPpm', 5, 60); num('quietDays', 0, 60);
    if (s.tHigh <= s.tLow) s.tHigh = s.tLow + 1;
    return s;
}

// TFP's CYA loss in ppm a month at a water temperature (F), see 2 at the top.
export function tfpCyaLossPerMonth(tempF: number | undefined, s: CyaSettings = DEFAULT_CYA_SETTINGS): number {
    const t = typeof tempF === 'number' && isFinite(tempF) ? tempF : DEFAULT_WATER_F;
    if (t <= s.tLow) return s.lossLow;
    if (t >= s.tHigh) return s.lossHigh;
    return s.lossLow + (s.lossHigh - s.lossLow) * (t - s.tLow) / (s.tHigh - s.tLow);
}

// TFP's "Salt Water Chlorine" FC/CYA chart (Pool School): the minimum, target range and SLAM FC by CYA, straight between rows, held beyond the ends.
// For an SWG pool this is the table to judge FC by (not the 7.5%-of-CYA liquid-chlorine rule).
export const TFP_SWG_FC: { cya: number; min: number; lo: number; hi: number; slam: number }[] = [
    { cya: 20, min: 2, lo: 3, hi: 5, slam: 10 }, { cya: 30, min: 2, lo: 3, hi: 6, slam: 12 }, { cya: 40, min: 2, lo: 3, hi: 7, slam: 16 },
    { cya: 50, min: 2, lo: 3, hi: 8, slam: 20 }, { cya: 60, min: 3, lo: 4, hi: 9, slam: 24 }, { cya: 70, min: 3, lo: 5, hi: 10, slam: 28 },
    { cya: 80, min: 4, lo: 6, hi: 11, slam: 31 }, { cya: 90, min: 4, lo: 6, hi: 12, slam: 35 }, { cya: 100, min: 5, lo: 7, hi: 13, slam: 39 }
];
export function tfpSwgFc(cya: number): { cya: number; min: number; lo: number; hi: number; slam: number } {
    const T = TFP_SWG_FC;
    const c = isFinite(cya) ? cya : 70;
    if (c <= T[0].cya) return Object.assign({}, T[0], { cya: c });
    if (c >= T[T.length - 1].cya) return Object.assign({}, T[T.length - 1], { cya: c });
    let i = 0;
    while (i + 1 < T.length && T[i + 1].cya < c) i++;
    const a = T[i], b = T[i + 1], w = (c - a.cya) / (b.cya - a.cya);
    const mix = (x: number, y: number) => Math.round((x + (y - x) * w) * 10) / 10;
    return { cya: c, min: mix(a.min, b.min), lo: mix(a.lo, b.lo), hi: mix(a.hi, b.hi), slam: mix(a.slam, b.slam) };
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

// A storm and what the salt said about it: `m` is how many times its inches count (1 unless the salt showed runoff).
export interface RainEvent { t1: number; t2: number; inches: number; m: number; saltBefore?: number; saltAfter?: number; added?: number; implied?: number; expected?: number; }

// The rows' rain and salt, indexed for the dilution between any two moments.
export class Dilution {
    private ts: number[] = [];
    private cumRain: number[] = [];
    private cumEff: number[] = [];          // the rain with each storm's runoff multiplier (see setRunoff)
    private salt: (number | undefined)[] = [];
    private saltSince: number[] = [];      // the time the salt reading last changed, at each row
    private adds: CyaAddition[];
    private rows: BenchHour[];
    constructor(rows: BenchHour[], saltAdds: CyaAddition[] = []) {
        let c = 0, prev: number | undefined, since = -Infinity;
        this.rows = rows;
        for (const r of rows) {
            if (typeof r.rain === 'number' && r.rain > 0) c += r.rain;
            this.ts.push(r.t); this.cumRain.push(c); this.salt.push(r.salt);
            if (typeof r.salt === 'number' && r.salt !== prev) { since = r.t; prev = r.salt; }
            this.saltSince.push(since);
        }
        this.cumEff = this.cumRain.slice();
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
    // the same with each storm's runoff multiplier
    public effectiveRain(t1: number, t2: number): number {
        const a = this.index(t1), b = this.index(t2);
        return Math.max(0, (b >= 0 ? this.cumEff[b] : 0) - (a >= 0 ? this.cumEff[a] : 0));
    }
    public saltAt(t: number): number | undefined { const i = this.index(t); return i >= 0 ? this.salt[i] : undefined; }
    private saltChangedAt(t: number): number { const i = this.index(t); return i >= 0 ? this.saltSince[i] : -Infinity; }
    public saltAdded(t1: number, t2: number): number { let s = 0; for (const a of this.adds) if (a.t > t1 && a.t <= t2) s += a.ppm; return s; }
    private saltFactor(t1: number, t2: number): number | undefined {
        const s1 = this.saltAt(t1), s2 = this.saltAt(t2);
        if (!(s1 > 0) || !(s2 > 0)) return undefined;
        return Math.max(0.5, Math.min(1.05, (s2 - this.saltAdded(t1, t2)) / s1));
    }
    // The median salt reading of the hours that end in (t1, t2].
    public saltMedian(t1: number, t2: number): number | undefined {
        const a = this.index(t1) + 1, b = this.index(t2);
        const v: number[] = [];
        for (let i = Math.max(0, a); i <= b; i++) if (typeof this.salt[i] === 'number' && this.salt[i] > 0) v.push(this.salt[i]);
        if (!v.length) return undefined;
        v.sort((x, y) => x - y);
        return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    }
    // The storms (rain hours less than EVENT_GAP_HOURS apart) and, for those of RUNOFF_MIN_INCHES or more whose days 3-7 after are known by asOf, the
    // runoff the salt shows (see 3 at the top). The multipliers then apply to effectiveRain and factor.
    public setRunoff(k: number, asOf: number, runoffMax: number): RainEvent[] {
        const events: RainEvent[] = [];
        let cur: RainEvent | undefined;
        for (const r of this.rows) {
            if (!(typeof r.rain === 'number' && r.rain > 0)) continue;
            if (cur && r.t - cur.t2 <= EVENT_GAP_HOURS * HOUR_MS) { cur.t2 = r.t; cur.inches += r.rain; }
            else { cur = { t1: r.t - HOUR_MS, t2: r.t, inches: r.rain, m: 1 }; events.push(cur); }
        }
        for (const e of events) {
            if (e.inches < RUNOFF_MIN_INCHES || e.t2 + 7 * DAY_MS > asOf || !(k > 0)) continue;
            const before = this.saltMedian(e.t1 - 3 * DAY_MS, e.t1), after = this.saltMedian(e.t2 + 3 * DAY_MS, e.t2 + 7 * DAY_MS);
            if (!(before > 0) || !(after > 0)) continue;
            const added = this.saltAdded(e.t1 - 3 * DAY_MS, e.t2 + 7 * DAY_MS);
            const implied = 1 - (after - added) / before, expected = 1 - Math.exp(-k * e.inches);
            e.saltBefore = before; e.saltAfter = after; e.added = Math.round(added); e.implied = Math.round(implied * 10000) / 10000; e.expected = Math.round(expected * 10000) / 10000;
            if ((implied - expected) * before > SALT_STEP_PPM && expected > 0) e.m = Math.max(1, Math.min(runoffMax, implied / expected));
        }
        // the effective rain: each storm's hours times its m
        let c = 0, ei = 0;
        for (let i = 0; i < this.rows.length; i++) {
            const r = this.rows[i];
            if (typeof r.rain === 'number' && r.rain > 0) {
                while (ei < events.length && events[ei].t2 < r.t) ei++;
                const m = ei < events.length && events[ei].t1 < r.t && r.t <= events[ei].t2 ? events[ei].m : 1;
                c += r.rain * m;
            }
            this.cumEff[i] = c;
        }
        return events;
    }
    // The share of the water at t1 still in the pool at t2.
    public factor(t1: number, t2: number, source: CyaDilutionSource, k: number): number {
        if (!(t2 > t1) || source === 'none') return 1;
        const rain = (a: number, b: number) => b > a ? Math.exp(-k * this.effectiveRain(a, b)) : 1;
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

export type CyaTestStatus = 'first' | 'accepted' | 'unexplained';
export interface CyaTestNote { t: number; ppm: number; projected?: number; status: CyaTestStatus; addition: boolean; reason?: string; }
export interface CyaPath {
    at: (t: number) => number;
    rainK: number;              // the k used (the settings' or the pool's)
    defaultK: number;           // the pool's, from its area and gallons
    notes: CyaTestNote[];       // every known test, oldest first, with what the TFP path expected there
    anchor?: CyaTest;           // the newest test the path stands on
    source: CyaDilutionSource;
    runoff: RainEvent[];        // the storms whose salt showed runoff (m > 1)
    storms: RainEvent[];        // every storm of RUNOFF_MIN_INCHES or more the salt could judge
    lossNow: number;            // ppm a month at the newest water temperature
}

const MIN_CYA = 10;
const MAX_ADD_SCALE = 3;

// The CYA path as known at asOf (see the top of the file). `defaultK` is the rain k when the settings do not set one; `waterTemps` are PoolMath's water
// temperatures, for hours the rows have none.
export function cyaPath(tests: CyaTest[], additions: CyaAddition[], rows: BenchHour[], settings: CyaSettings, asOf: number,
    opts: { saltAdds?: CyaAddition[]; defaultK?: number; waterTemps?: WaterTemp[] } = {}): CyaPath {
    const s = settings;
    const known: CyaTest[] = [];
    for (const c of tests.filter(x => x.t <= asOf && x.ppm > 0).sort((a, b) => a.t - b.t)) {
        if (known.length && known[known.length - 1].t === c.t) known[known.length - 1] = c; else known.push(c);
    }
    const adds = additions.filter(a => a.t <= asOf && a.ppm > 0).sort((a, b) => a.t - b.t);
    const dil = new Dilution(rows, (opts.saltAdds || []).filter(a => a.t <= asOf));
    const kGeo = typeof opts.defaultK === 'number' ? opts.defaultK : RAIN_K_FALLBACK;
    const k = typeof s.rainK === 'number' ? s.rainK : kGeo;
    const events = s.source === 'rain' || s.source === 'both' ? dil.setRunoff(k, asOf, s.runoffMax) : [];
    // per row: the hour's dilution factor, its loss in ppm, and the stabilizer entering in it (index of the addition, ppm)
    const n = rows.length;
    const fac = new Float64Array(n), loss = new Float64Array(n);
    const temps = (opts.waterTemps || []).filter(w => isFinite(w.f)).sort((a, b) => a.t - b.t);
    let wi = -1, lastTemp: number | undefined;
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        fac[i] = dil.factor(r.t - HOUR_MS, r.t, s.source, k);
        while (wi + 1 < temps.length && temps[wi + 1].t <= r.t) wi++;
        const t = typeof r.temp === 'number' && isFinite(r.temp) ? r.temp : (wi >= 0 ? temps[wi].f : undefined);
        if (typeof t === 'number') lastTemp = t;
        loss[i] = tfpCyaLossPerMonth(t, s) / (30 * 24);
    }
    const rampMs = s.rampDays * DAY_MS;
    // the ppm of addition `a` entering in the hour that ends at t
    const enter = (a: CyaAddition, t: number) => {
        const lo = Math.max(t - HOUR_MS, a.t), hi = Math.min(t, a.t + rampMs);
        return hi > lo ? a.ppm * (hi - lo) / rampMs : 0;
    };
    const rowIndex = (t: number): number => {       // the last row at or before t
        let lo = 0, hi = n;
        while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t <= t) lo = m + 1; else hi = m; }
        return lo - 1;
    };
    const vals = new Float64Array(n).fill(NaN);
    const notes: CyaTestNote[] = [];
    // One stretch from test a to the time b (Infinity: the open stretch). Additions logged in it are scaled to land on bPpm; earlier ones still entering
    // count as logged. Returns what the TFP path expected at b before the correction.
    const stretch = (a: CyaTest, bT: number, bPpm?: number): number => {
        const i0 = rowIndex(a.t) + 1, i1 = isFinite(bT) ? rowIndex(bT) : n - 1;
        const mine = adds.filter(x => x.t > a.t && x.t <= bT);
        const carry = adds.filter(x => x.t <= a.t && x.t + rampMs > a.t);
        const base = new Float64Array(Math.max(0, i1 - i0 + 1)), add = new Float64Array(base.length);
        let b0 = a.ppm, a0 = 0;
        for (let i = i0; i <= i1; i++) {
            const t = rows[i].t;
            b0 = b0 * fac[i] - loss[i];
            a0 = a0 * fac[i];
            for (const x of carry) b0 += enter(x, t);
            for (const x of mine) a0 += enter(x, t);
            base[i - i0] = b0; add[i - i0] = a0;
        }
        const R0 = base.length ? base[base.length - 1] + add[add.length - 1] : a.ppm;
        let scale = 1, ratio = 1;
        if (typeof bPpm === 'number' && base.length) {
            const A = add[add.length - 1], B = base[base.length - 1];
            if (mine.length && A > 0) scale = Math.max(0, Math.min(MAX_ADD_SCALE, 1 + (bPpm - R0) / A));
            const R2 = B + scale * A;
            if (R2 > 0 && Math.abs(R2 - bPpm) > 1e-9) ratio = bPpm / R2;
        }
        for (let i = i0; i <= i1; i++) {
            const j = i - i0;
            let v = base[j] + scale * add[j];
            if (ratio !== 1) v *= Math.pow(ratio, Math.max(0, Math.min(1, (rows[i].t - a.t) / (bT - a.t))));
            vals[i] = v;
        }
        return R0;
    };
    for (let j = 0; j < known.length; j++) {
        const T = known[j];
        if (j === 0) { notes.push({ t: T.t, ppm: T.ppm, status: 'first', addition: false }); continue; }
        const a = known[j - 1];
        const R0 = stretch(a, T.t, T.ppm);
        const inStretch = adds.some(x => x.t > a.t && x.t <= T.t);
        const recent = inStretch || adds.some(x => x.t > T.t - s.quietDays * DAY_MS && x.t <= T.t);
        const diff = T.ppm - R0;
        const note: CyaTestNote = { t: T.t, ppm: T.ppm, projected: round1(R0), status: 'accepted', addition: inStretch };
        if (!recent && diff > s.unexplainedPpm) {
            note.status = 'unexplained';
            note.reason = `${Math.round(diff)} ppm above the ${Math.round(R0)} the TFP path expected, with no stabilizer logged in the ${s.quietDays} days before`;
        }
        else if (diff < -s.unexplainedPpm) {
            note.status = 'unexplained';
            note.reason = `${Math.round(-diff)} ppm below the ${Math.round(R0)} the TFP path expected, more than the CYA loss and dilution explain`;
        }
        notes.push(note);
    }
    const last = known[known.length - 1];
    if (last) stretch(last, Infinity);
    const first = known[0];
    const lossAfter = tfpCyaLossPerMonth(lastTemp, s) / (30 * 24);
    const at = (t: number): number => {
        if (!first) return 70;
        if (t <= first.t) return Math.max(MIN_CYA, first.ppm);
        if (!n) {   // no rows: held at the newest test, less the loss at 80 F
            let c = first;
            for (const x of known) { if (x.t <= t) c = x; else break; }
            return Math.max(MIN_CYA, c.ppm - tfpCyaLossPerMonth(undefined, s) * (t - c.t) / (30 * DAY_MS));
        }
        const i = rowIndex(t);
        if (i < 0 || !isFinite(vals[i])) {
            // before the first row after the test it stands on: the test itself
            let c = first;
            for (const x of known) { if (x.t <= t) c = x; else break; }
            return Math.max(MIN_CYA, c.ppm);
        }
        if (i === n - 1 && t > rows[n - 1].t) return Math.max(MIN_CYA, vals[i] - lossAfter * (t - rows[n - 1].t) / HOUR_MS);
        return Math.max(MIN_CYA, vals[i]);
    };
    const judged = events.filter(e => typeof e.implied === 'number');
    return {
        at: at, rainK: k, defaultK: kGeo, notes: notes, anchor: last, source: s.source,
        runoff: judged.filter(e => e.m > 1), storms: judged, lossNow: Math.round(tfpCyaLossPerMonth(lastTemp, s) * 100) / 100
    };
}
function round1(x: number): number { return Math.round(x * 10) / 10; }

// The path every `stepHours` hours over [from, to], for a chart.
export function pathSamples(p: CyaPath, from: number, to: number, stepHours: number = 6): [number, number][] {
    const out: [number, number][] = [];
    const step = Math.max(1, stepHours) * HOUR_MS;
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push([t, round1(p.at(t))]);
    return out;
}

// How the TFP path did at the tests (a check only, it never changes the path): each test after the first against what the path expected there.
export function pathVsTests(p: CyaPath, from: number = -Infinity): { n: number; meanMiss?: number; meanAbsMiss?: number; unexplained: number } {
    const used = p.notes.filter(x => x.t >= from && typeof x.projected === 'number' && !x.addition);
    if (!used.length) return { n: 0, unexplained: 0 };
    const miss = used.map(x => x.ppm - x.projected);
    return {
        n: used.length, meanMiss: round1(miss.reduce((a, b) => a + b, 0) / miss.length), meanAbsMiss: round1(miss.reduce((a, b) => a + Math.abs(b), 0) / miss.length),
        unexplained: p.notes.filter(x => x.t >= from && x.status === 'unexplained').length
    };
}

// ---------------------------------------------------------------- model drift (advice rule 3)

// The rule's guards: enough intervals, sun that varied enough between them to tell the sun from the steady demand, a sun coefficient known well enough,
// and an implied CYA that is a CYA at all. Otherwise the check does not judge (off undefined, `why` says which guard).
export const DRIFT_GUARDS = { minIntervals: 6, minSunCv: 0.25, maxSeShare: 0.3, impliedMin: 20, impliedMax: 150, offShare: 0.2 };
export interface DriftCheck { t: number; off?: boolean; implied?: number; path?: number; n: number; cv?: number; seShare?: number; why?: string; }
// The burn fitted on the FC intervals of the last `days` days with CYA left free as a scale: the sun coefficient u of that fit against the main fit's a
// says what CYA the burn implies (CYA on the path x a / u). It is off when that is at least 20% from the path and u is more than two standard errors
// from a, once the guards above hold.
export function modelDrift(v: BenchVariant, fit: Fit, intervals: Interval[], rows: BenchHour[], cya: (t: number) => number, asOf: number, days: number = 14): DriftCheck {
    const G = DRIFT_GUARDS;
    const out: DriftCheck = { t: asOf, n: 0 };
    if (!fit || fit.fallback || !(fit.a > 0)) { out.why = 'no model fit'; return out; }
    const X: number[][] = [], y: number[] = [];
    for (const iv of intervals) {
        if (iv.t2 > asOf || iv.t1 < asOf - days * DAY_MS || iv.t2 - iv.t1 <= 0.3 * DAY_MS) continue;
        const s = sunFeature(v, rows, iv.t1, iv.t2, cya, t => iv.f1 + (iv.f2 - iv.f1) * (t - iv.t1) / (iv.t2 - iv.t1), undefined, fit.c);
        if (typeof s !== 'number') continue;
        X.push([s, gapDays(iv)]); y.push(consumption(iv));
    }
    out.n = X.length;
    if (X.length < G.minIntervals) { out.why = `${X.length} intervals, ${G.minIntervals} needed`; return out; }
    // the sun term per day of each interval: its coefficient of variation
    const perDay = X.map(x => x[1] > 0 ? x[0] / x[1] : 0);
    const mean = perDay.reduce((a, b) => a + b, 0) / perDay.length;
    const sd = Math.sqrt(perDay.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, perDay.length - 1));
    out.cv = mean > 0 ? Math.round(sd / mean * 1000) / 1000 : 0;
    let a11 = 0, a12 = 0, a22 = 0, v1 = 0, v2 = 0;
    for (let k = 0; k < X.length; k++) { a11 += X[k][0] * X[k][0]; a12 += X[k][0] * X[k][1]; a22 += X[k][1] * X[k][1]; v1 += X[k][0] * y[k]; v2 += X[k][1] * y[k]; }
    const det = a11 * a22 - a12 * a12;
    if (!(Math.abs(det) > 1e-12)) { out.why = 'the sun and the days cannot be told apart'; return out; }
    const u = (a22 * v1 - a12 * v2) / det;
    let sse = 0;
    for (let k = 0; k < X.length; k++) { const r = y[k] - u * X[k][0] - ((a11 * v2 - a12 * v1) / det) * X[k][1]; sse += r * r; }
    const se = Math.sqrt(Math.max(0, sse / Math.max(1, X.length - 2)) * a22 / det);
    out.path = round1(cya(asOf));
    if (!(u > 0)) { out.why = 'the sun coefficient is not positive'; return out; }
    out.implied = round1(out.path * fit.a / u);
    out.seShare = Math.round(se / u * 1000) / 1000;
    if (out.cv < G.minSunCv) { out.why = `the sun varied too little (CV ${out.cv}, ${G.minSunCv} needed)`; return out; }
    if (out.seShare > G.maxSeShare) { out.why = `the sun coefficient is too uncertain (SE ${Math.round(out.seShare * 100)}% of it)`; return out; }
    if (out.implied < G.impliedMin || out.implied > G.impliedMax) { out.why = `the implied CYA ${out.implied} is outside ${G.impliedMin}-${G.impliedMax}`; return out; }
    out.off = Math.abs(out.implied / out.path - 1) >= G.offShare && Math.abs(u - fit.a) > 2 * se;
    return out;
}

// ---------------------------------------------------------------- the advice

export const CYA_ADVICE = { ageDays: 28, dropPpm: 10, dropShare: 0.15, missPpm: 1, missSunShare: 0.4, addAfterDays: 3 };
export interface CyaAdviceRule { rule: number; reason: string; since: number; }
export interface CyaAdvice { due: boolean; rule?: number; reason?: string; since?: string; rules: { rule: number; reason: string; since: string }[]; }
export interface CyaMiss { t: number; miss: number; sunShare?: number; }
// The order a note is shown in when several rules hold: an unexplained test first, then a fresh addition, the model, the misses, the path, the age.
const PRIORITY = [6, 5, 3, 4, 2, 1];

// Whether a CYA test is worth doing now, and why (advisory only). Every rule is judged after the newest CYA test, so a newer test clears it:
//   1 age: the newest test is ageDays old
//   2 projected drift: the path has fallen dropPpm or dropShare below the test it stands on
//   3 model drift: the model drift was off at the last two checks (see DRIFT_GUARDS for when it judges at all)
//   4 misses: the last three FC projections missed the same way by more than missPpm on days the sun was missSunShare of the burn
//   5 stabilizer added: addAfterDays after a logged addition (once it has dissolved), until a test
//   6 unexplained test: the newest test is far from the TFP path (see cyaPath); a confirming test would help. The path stands on the test.
export function cyaAdvice(now: number, path: CyaPath, additions: CyaAddition[], drift: DriftCheck[], misses: CyaMiss[], fmt: (t: number) => string = t => new Date(t).toISOString()): CyaAdvice {
    const found: CyaAdviceRule[] = [];
    const notes = path.notes.filter(n => n.t <= now);
    const newest = notes[notes.length - 1];
    const after = newest ? newest.t : -Infinity;
    if (!newest) found.push({ rule: 1, reason: 'No CYA test is logged.', since: now });
    else {
        if (newest.status === 'unexplained') found.push({ rule: 6, reason: `The CYA test of ${fmt(newest.t)} (${newest.ppm}) is ${newest.reason}; a confirming test would help. The path uses the test.`, since: newest.t });
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
            found.push({ rule: 2, reason: `The CYA path has fallen from ${base.ppm} to about ${Math.round(nowVal)} since the test of ${fmt(base.t)} (TFP's CYA loss and rain dilution).`, since: since });
        }
        if (now - newest.t >= CYA_ADVICE.ageDays * DAY_MS) found.push({ rule: 1, reason: `The last CYA test was ${Math.floor((now - newest.t) / DAY_MS)} days ago (${fmt(newest.t)}).`, since: newest.t + CYA_ADVICE.ageDays * DAY_MS });
    }
    found.sort((a, b) => PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule));
    const rules = found.map(f => ({ rule: f.rule, reason: f.reason, since: new Date(f.since).toISOString() }));
    if (!rules.length) return { due: false, rules: [] };
    return { due: true, rule: rules[0].rule, reason: rules[0].reason, since: rules[0].since, rules: rules };
}
