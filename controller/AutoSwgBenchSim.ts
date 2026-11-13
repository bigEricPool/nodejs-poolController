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

// SWG Assist Model Bench, the closed-loop simulator. Only one controller runs on the pool, so what a projection model would do to the time FC spends in
// the range, and to how much it bounces, can only be seen in simulation. Pure functions only (no files, no clock, no globals), so it can be unit tested.
//
// The simulated pool (the plant) runs hour by hour:
//   generation  the SWG % through the 3-hour cycle count (ChlorinatorUsage.cycleConduction): the cell is powered over each day's run window, a cycle
//               starts at power-on, and current flows for the % of each cycle at its start.
//   burn        either 'k', the burn of the 2026-11-04 simulation (per ppm of FC and day, from the real FC tests, smoothed over a week, weighted by
//               daylight), or 'model', a bench model fitted to the real data on the real hourly inputs plus the real misses resampled, so the plant
//               varies as much as the pool does.
// FC tests are drawn at a rhythm (twice a week, weekly, or the real dates), with test error, rounded to 0.5 ppm.
// The controller is the REAL range control (SwgAssistBand.bandDecision) with the live settings, fed at each check (10:00 and 22:00) and each test by a
// projector: the live projection (a port of computeRecommendation's average and projected FC, checked against the app by the 2026-11-04 work), a
// plain average, or a bench model. The controller credits the SWG % linearly over the run window, as the app does.
// The outcome table is the user's criteria: hours in 7-10, below 7 and 6, above 10 and 10.5, lowest and highest FC, the daily swing, the day-to-day
// drift and the SWG % churn.

import { bandDecision, BandInput } from './SwgAssistBand';
import { cycleConduction, CycleSettings } from './ChlorinatorUsage';
import { BenchHour, BenchVariant, CyaTest, DAY_MS, firstRowAfter, Fit, fitVariant, HOUR_MS, Interval, plainRate, projectLoss, quantile, seededRandom, heldCya } from './AutoSwgBenchModel';

const NIGHT_RATIO = 0.5;
const MIN_FC_IN_WINDOW = 3;

export interface SimSwg { t: number; ppmPerDay: number; hrs: number; pct: number; }
export interface SimReading { t: number; fc: number; }

// ---------------------------------------------------------------- the local calendar

// Sunrise and sunset of a local date, in minutes after local midnight (the NOAA formula of the 2026-11-04 simulation).
export function sunMinutes(y: number, m: number, d: number, lat: number, lon: number): { sr: number; ss: number } {
    const n = Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
    const g = 2 * Math.PI / 365 * (n - 1);
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const la = lat * Math.PI / 180;
    const c = Math.cos(90.833 * Math.PI / 180) / (Math.cos(la) * Math.cos(decl)) - Math.tan(la) * Math.tan(decl);
    const ha = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
    const off = -new Date(y, m, d, 12).getTimezoneOffset();
    const mod = (x: number) => ((x % 1440) + 1440) % 1440;
    return { sr: mod(720 - 4 * (lon + ha) - eqtime + off), ss: mod(720 - 4 * (lon - ha) - eqtime + off) };
}

function localMinutes(t: number): number { const d = new Date(t); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
function localDayKey(t: number): string { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function localMidnight(t: number): number { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

// The daylight-weighted day equivalents (the app's dayEquivalents) for the sunrise and sunset of one date: daytime counts more than night, by the night
// burn ratio, and a whole day is one.
export class DayModel {
    public share: number;
    constructor(public sr: number, public ss: number, public swgStart: number) {
        const dayH = (ss - sr) / 60;
        this.share = dayH / (dayH + NIGHT_RATIO * (24 - dayH));
    }
    public split(a: number, b: number): { day: number; night: number } {
        const span = (b - a) / 60000;
        if (!(span > 0)) return { day: 0, night: 0 };
        const whole = Math.floor(span / 1440);
        const left = span - whole * 1440;
        let day = whole * this.share, night = whole * (1 - this.share);
        if (left > 0) {
            const s = localMinutes(a + whole * DAY_MS);
            const dayLen = this.ss - this.sr;
            let dm = 0;
            for (const k of [0, 1]) dm += Math.max(0, Math.min(s + left, this.ss + 1440 * k) - Math.max(s, this.sr + 1440 * k));
            day += dm * (this.share / dayLen);
            night += (left - dm) * ((1 - this.share) / (1440 - dayLen));
        }
        return { day: day, night: night };
    }
    public dayEq(a: number, b: number): number { const s = this.split(a, b); return s.day + s.night; }
    // the hours of a's to b's span inside the daily run windows (swgStart for hrs hours each local day)
    public windowHours(t1: number, t2: number, hrs: number): number {
        if (!(t2 > t1) || !(hrs > 0)) return 0;
        let tot = 0;
        const first = new Date(t1), last = new Date(t2);
        for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1); d.getTime() <= new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime(); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
            const st = d.getTime() + this.swgStart * 60000, en = st + hrs * HOUR_MS;
            const a = Math.max(st, t1), b = Math.min(en, t2);
            if (b > a) tot += (b - a) / HOUR_MS;
        }
        return tot;
    }
}

// The SWG entry in force at t (the last at or before it), by binary search over entries sorted by time.
function entryAt(sw: SimSwg[], t: number): SimSwg | undefined {
    let lo = 0, hi = sw.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sw[m].t <= t) lo = m + 1; else hi = m; }
    return lo > 0 ? sw[lo - 1] : undefined;
}
function breakpoints(sw: SimSwg[], t1: number, t2: number): number[] {
    const pts = [t1];
    let lo = 0, hi = sw.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sw[m].t <= t1) lo = m + 1; else hi = m; }
    for (let k = lo; k < sw.length && sw[k].t < t2; k++) if (sw[k].t > pts[pts.length - 1]) pts.push(sw[k].t);
    pts.push(t2);
    return pts;
}
// The credited chlorine between two moments: each entry's ppm a day, spread evenly in time until the next entry (the app's consumption credit).
export function genBetween(sw: SimSwg[], t1: number, t2: number): number {
    if (!(t2 > t1)) return 0;
    const pts = breakpoints(sw, t1, t2);
    let tot = 0;
    for (let k = 0; k + 1 < pts.length; k++) { const e = entryAt(sw, pts[k]); if (e) tot += e.ppmPerDay * (pts[k + 1] - pts[k]) / DAY_MS; }
    return tot;
}
// The credited chlorine since a reading: each entry's ppm a day over its run hours, inside the run windows (the app's projection credit).
export function genSince(m: DayModel, sw: SimSwg[], t1: number, t2: number): number {
    if (!sw.length || !(t2 > t1)) return 0;
    const pts = breakpoints(sw, t1, t2);
    let tot = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
        const e = entryAt(sw, pts[k]);
        if (!e || !(e.hrs > 0)) continue;
        tot += (e.ppmPerDay / e.hrs) * m.windowHours(pts[k], pts[k + 1], e.hrs);
    }
    return tot;
}

export interface ProjectionResult { projected: number; avg: number; elDays: number; lastT: number; lastV: number; }
// The live projection as of `asOf` (computeRecommendation's burn average and projected FC): the average consumption per day equivalent over the
// readings of the last windowDays days (at least the last three readings), with intervals that lost more than `tol` ppm of FC left out, and the
// last reading moved on by the credited chlorine since less that average, weighted by `weight`.
export function liveProjection(m: DayModel, fc: SimReading[], sw: SimSwg[], adds: { t: number; ppm: number }[], asOf: number, windowDays: number, weight: number, tol: number = 2): ProjectionResult | undefined {
    const fcl = fc.filter(e => e.t <= asOf);
    const swl = sw.filter(e => e.t <= asOf);
    const ad = adds.filter(e => e.t <= asOf);
    if (!fcl.length || !swl.length) return undefined;
    const added = (a: number, b: number) => ad.reduce((s, x) => s + (x.t > a && x.t <= b ? x.ppm : 0), 0);
    let wstart = asOf - windowDays * DAY_MS;
    const inw = fcl.filter(e => e.t >= wstart && e.t <= asOf);
    if (inw.length < MIN_FC_IN_WINDOW && fcl.length >= MIN_FC_IN_WINDOW) wstart = fcl[fcl.length - MIN_FC_IN_WINDOW].t;
    const firstSwg = swl[0].t;
    let wt = 0, cov = 0, unc = 0;
    const susp: { rate: number; o: number }[] = [];
    for (let k = 0; k + 1 < fcl.length; k++) {
        const t1 = fcl[k].t, t2 = fcl[k + 1].t;
        if (!(t2 > t1) || t2 <= wstart) continue;
        const a = Math.max(t1, wstart), b = Math.min(t2, asOf);
        const o = b > a ? m.dayEq(a, b) : 0;
        if (!(o > 0)) continue;
        if (t1 < firstSwg) { unc++; continue; }
        const consumed = genBetween(swl, t1, t2) + added(t1, t2) - (fcl[k + 1].fc - fcl[k].fc);
        const d = m.dayEq(t1, t2);
        const rate = d > 0 ? consumed / d : 0;
        if (tol > 0 && consumed < -tol) { susp.push({ rate: rate, o: o }); continue; }
        wt += rate * o; cov += o;
    }
    if (cov === 0 && susp.length) for (const s of susp) { wt += s.rate * s.o; cov += s.o; }
    if (cov === 0 && unc) return undefined;
    const avg = cov > 0 ? wt / cov : 0;
    const last = fcl[fcl.length - 1];
    const el = (asOf - last.t) / DAY_MS;
    const gen = genSince(m, swl, last.t, asOf);
    return { projected: last.fc + weight * (gen - avg * m.dayEq(last.t, asOf)) + added(last.t, asOf), avg: avg, elDays: el, lastT: last.t, lastV: last.fc };
}

// ---------------------------------------------------------------- test rhythms

function gauss(rnd: () => number): number {
    const u = Math.max(1e-12, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function localAt(y: number, m: number, d: number, hh: number): number {
    const h = Math.floor(hh), min = Math.round((hh - h) * 60) % 60;
    return new Date(y, m, d, h, min).getTime();
}
function weekStarts(start: number, end: number): Date[] {
    const d0 = new Date(start);
    const mon = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - ((d0.getDay() + 6) % 7));
    const out: Date[] = [];
    for (let w = mon; w.getTime() <= end; w = new Date(w.getFullYear(), w.getMonth(), w.getDate() + 7)) out.push(w);
    return out;
}
const randint = (rnd: () => number, a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const uniform = (rnd: () => number, a: number, b: number) => a + (b - a) * rnd();

// The user's habit, twice a week: one test on the weekend (Sat or Sun, 07:00-20:30), one midweek (Tue-Thu, morning 07:00-09:30 or evening
// 18:00-21:00), and in about a quarter of the weeks two spaced-out midweek tests (Mon/Tue and Thu/Fri).
export function twiceWeeklyTests(seed: number, start: number, end: number): number[] {
    const r = seededRandom(seed * 7 + 3);
    const mw = () => r() < 0.5 ? uniform(r, 7, 9.5) : uniform(r, 18, 21);
    const out: number[] = [];
    for (const w of weekStarts(start, end)) {
        const y = w.getFullYear(), m = w.getMonth(), d = w.getDate();
        out.push(localAt(y, m, d + 5 + randint(r, 0, 1), uniform(r, 7, 20.5)));
        if (r() < 0.25) { out.push(localAt(y, m, d + randint(r, 0, 1), mw())); out.push(localAt(y, m, d + randint(r, 3, 4), mw())); }
        else out.push(localAt(y, m, d + randint(r, 1, 3), mw()));
    }
    return out.filter(t => t > start && t <= end).sort((a, b) => a - b);
}
// One test a week, on the weekend (Sat or Sun, 07:00-20:30).
export function weeklyTests(seed: number, start: number, end: number): number[] {
    const r = seededRandom(seed * 11 + 5);
    const out: number[] = [];
    for (const w of weekStarts(start, end)) out.push(localAt(w.getFullYear(), w.getMonth(), w.getDate() + 5 + randint(r, 0, 1), uniform(r, 7, 20.5)));
    return out.filter(t => t > start && t <= end).sort((a, b) => a - b);
}

// ---------------------------------------------------------------- the plant

export interface SimData {
    start: number; end: number;            // the span simulated (ms)
    lat: number; lon: number;               // for sunrise and sunset
    fc: SimReading[];                       // the real FC tests, oldest first (the readings before `start` seed the controller)
    swg: SimSwg[];                          // the real SWG history (credited ppm a day), oldest first
    adds: { t: number; ppm: number }[];     // liquid chlorine
    rows?: BenchHour[];                     // the real hourly inputs, for a model plant and model projectors
    cya?: CyaTest[];
    ppmPerHourAtFull: number;               // what the cell adds per run hour at 100% (ppm)
}
export interface SimSettings {
    low: number; high: number;              // the FC range
    windowDays: number;                     // the live projection's burn window
    projectionWeight: number;
    trim: number; biasPerDay: number; guardPerDay: number; guardCap: number;
    peakCap: boolean; peakMarginPpm: number; integral: number; scaledBias: boolean;
    overshootPpmPerDay: number; overshootCapPpm: number;
    runWindow: 'sun' | 'sunOffset';         // the SWG relay schedule: sunrise to sunset, or 2 h after sunrise to 2 h before sunset
    cycle: CycleSettings;
    testNoise: number;                      // test error (ppm, one standard deviation) before rounding to 0.5
}
export const DEFAULT_SIM_SETTINGS: SimSettings = {
    low: 7, high: 10, windowDays: 14, projectionWeight: 0.65, trim: 0.2, biasPerDay: 0.05, guardPerDay: 0.3, guardCap: 2,
    peakCap: true, peakMarginPpm: 0.5, integral: 0.3, scaledBias: true, overshootPpmPerDay: 0.15, overshootCapPpm: 1,
    runWindow: 'sun', cycle: { cycleHours: 3, restartsOnPower: true, burstFirst: true }, testNoise: 0.3
};

// Everything about the simulated span that does not depend on the seed or the controller: hour by hour the run window's share, the day
// equivalents, the local hour, the day models, the run windows, and the 'k' burn of the 2026-11-04 simulation.
export interface SimCalendar {
    nh: number; start: number;
    frac: number[]; w: number[]; lhour: number[]; day: string[];
    models: Map<string, DayModel>; windows: Map<string, { on: number; off: number; hrs: number }>;
    kh: number[];
}

export function buildCalendar(data: SimData, s: SimSettings): SimCalendar {
    const nh = Math.floor((data.end - data.start) / HOUR_MS);
    const cal: SimCalendar = { nh: nh, start: data.start, frac: [], w: [], lhour: [], day: [], models: new Map(), windows: new Map(), kh: [] };
    const off = s.runWindow === 'sunOffset' ? 120 : 0;
    const modelFor = (t: number): DayModel => {
        const key = localDayKey(t);
        let m = cal.models.get(key);
        if (!m) {
            const d = new Date(t);
            const sun = sunMinutes(d.getFullYear(), d.getMonth(), d.getDate(), data.lat, data.lon);
            m = new DayModel(sun.sr, sun.ss, sun.sr + off);
            cal.models.set(key, m);
            const mid = localMidnight(t);
            cal.windows.set(key, { on: mid + (sun.sr + off) * 60000, off: mid + (sun.ss - off) * 60000, hrs: (sun.ss - sun.sr - 2 * off) / 60 });
        }
        return m;
    };
    for (let i = 0; i < nh; i++) {
        const t = data.start + i * HOUR_MS;
        const m = modelFor(t);
        const key = localDayKey(t);
        const win = cal.windows.get(key);
        cal.frac.push(Math.max(0, (Math.min(t + HOUR_MS, win.off) - Math.max(t, win.on)) / HOUR_MS));
        cal.w.push(m.dayEq(t, t + HOUR_MS));
        cal.lhour.push(new Date(t).getHours());
        cal.day.push(key);
    }
    // the 'k' burn: per ppm of FC and day equivalent, from each real interval of at least 0.3 days, averaged over the intervals overlapping
    // three days either side of each hour
    const real = data.fc.filter(e => e.t >= data.start - 20 * DAY_MS && e.t <= data.end + DAY_MS);
    const iv: { a: number; b: number; k: number }[] = [];
    for (let k = 0; k + 1 < real.length; k++) {
        const t1 = real[k].t, t2 = real[k + 1].t;
        if ((t2 - t1) / DAY_MS < 0.3) continue;
        const m = modelFor(t2);
        const cons = genBetween(data.swg, t1, t2) + data.adds.reduce((s2, x) => s2 + (x.t > t1 && x.t <= t2 ? x.ppm : 0), 0) - (real[k + 1].fc - real[k].fc);
        const de = m.dayEq(t1, t2);
        const fm = Math.max(1, (real[k].fc + real[k + 1].fc) / 2);
        iv.push({ a: t1, b: t2, k: Math.max(cons / de, 0.25) / fm });
    }
    const med = quantile(iv.map(x => x.k), 0.5);
    for (let i = 0; i < nh; i++) {
        const t = data.start + i * HOUR_MS + 30 * 60000;
        const lo = t - 3 * DAY_MS, hi = t + 3 * DAY_MS;
        let num = 0, den = 0;
        for (const x of iv) { const ov = Math.min(x.b, hi) - Math.max(x.a, lo); if (ov > 0) { num += x.k * ov; den += ov; } }
        cal.kh.push(den ? num / den : med);
    }
    return cal;
}

// A burn plant from a bench model fitted to every real interval in the span on the real hourly inputs, and the real misses of that fit (ppm per
// day), which a seed resamples in blocks as long as the real intervals.
export interface ModelPlant { variant: BenchVariant; fit: Fit; residuals: { rate: number; days: number }[]; }
export function fitModelPlant(data: SimData, variant: BenchVariant): ModelPlant | undefined {
    if (!data.rows || !data.rows.length) return undefined;
    const real = data.fc.filter(e => e.t >= data.start && e.t <= data.end);
    const intervals: Interval[] = [];
    for (let k = 0; k + 1 < real.length; k++) {
        const t1 = real[k].t, t2 = real[k + 1].t;
        intervals.push({ t1: t1, f1: real[k].fc, t2: t2, f2: real[k + 1].fc, gen: genBetween(data.swg, t1, t2) + data.adds.reduce((s, x) => s + (x.t > t1 && x.t <= t2 ? x.ppm : 0), 0) });
    }
    const all: BenchVariant = Object.assign({}, variant, { fitDays: (data.end - data.start) / DAY_MS + 30, minIntervals: 5 });
    const fit = fitVariant(all, intervals, data.rows, data.cya || [], data.end);
    if (!fit || fit.fallback) return undefined;
    const residuals: { rate: number; days: number }[] = [];
    for (const iv of intervals) {
        const days = (iv.t2 - iv.t1) / DAY_MS;
        if (days < 0.3) continue;
        const p = projectLoss(Object.assign({}, all, { fcPath: 'held' }), fit, data.rows, data.cya || [], data.end, iv.t1, (iv.f1 + iv.f2) / 2, iv.t2);
        if (typeof p !== 'number') continue;
        residuals.push({ rate: (iv.gen - (iv.f2 - iv.f1) - p) / days, days: days });
    }
    return residuals.length ? { variant: all, fit: fit, residuals: residuals } : undefined;
}

// ---------------------------------------------------------------- projectors (what feeds the controller)

export interface SimContext {
    t: number; cal: SimCalendar; data: SimData; s: SimSettings;
    model: DayModel;                    // the day model of the hour
    fcs: SimReading[]; sw: SimSwg[];    // the readings and SWG entries the controller has (simulated after the start)
}
export interface Projector { name: string; project(c: SimContext): ProjectionResult | undefined; }

function recentWindow(c: SimContext): { fw: SimReading[]; sww: SimSwg[] } {
    const cut = c.t - 60 * DAY_MS;
    let fw = c.fcs.filter(e => e.t >= cut);
    if (fw.length < 5) fw = c.fcs.slice(-5);
    const older = c.sw.filter(e => e.t < cut);
    const sww = (older.length ? [older[older.length - 1]] : []).concat(c.sw.filter(e => e.t >= cut));
    return { fw: fw, sww: sww };
}

// The live projection, with the live window and weight.
export function liveProjector(): Projector {
    return { name: 'live', project: c => { const r = recentWindow(c); return liveProjection(c.model, r.fw, r.sww, [], c.t, c.s.windowDays, c.s.projectionWeight); } };
}

// The simulated readings as intervals with the credited chlorine between them (what the app sees).
function simIntervals(fcs: SimReading[], sw: SimSwg[], from: number): Interval[] {
    const out: Interval[] = [];
    for (let k = 0; k + 1 < fcs.length; k++) {
        if (fcs[k + 1].t < from) continue;
        out.push({ t1: fcs[k].t, f1: fcs[k].fc, t2: fcs[k + 1].t, f2: fcs[k + 1].fc, gen: genBetween(sw, fcs[k].t, fcs[k + 1].t) });
    }
    return out;
}

// A plain average: the consumption per day since the newest reading at least windowDays old, at full weight.
export function plainProjector(windowDays: number): Projector {
    return {
        name: `plain${windowDays}`,
        project: c => {
            const last = c.fcs.filter(e => e.t <= c.t).slice(-1)[0];
            if (!last) return undefined;
            const rate = plainRate(simIntervals(c.fcs, c.sw, c.t - (windowDays + 30) * DAY_MS), c.t, windowDays);
            if (typeof rate !== 'number') return undefined;
            const days = (c.t - last.t) / DAY_MS;
            return { projected: last.fc + genSince(c.model, c.sw, last.t, c.t) - rate * days, avg: rate, elDays: days, lastT: last.t, lastV: last.fc };
        }
    };
}

// A bench model: fitted at each decision on the simulated readings and the real hourly inputs, it projects the loss since the last reading; the burn
// average the controller plans with is the model's loss over the last seven days at the projected FC, per day.
export function modelProjector(v: BenchVariant): Projector {
    const cache = new Map<number, Fit | undefined>();
    return {
        name: v.id,
        project: c => {
            const rows = c.data.rows || [], cya = c.data.cya || [];
            const last = c.fcs.filter(e => e.t <= c.t).slice(-1)[0];
            if (!last || !rows.length) return undefined;
            let fit = cache.get(last.t);
            if (!cache.has(last.t)) {
                fit = fitVariant(v, simIntervals(c.fcs, c.sw, c.t - ((v.fitDays || 30) + 2) * DAY_MS), rows, cya, last.t);
                cache.set(last.t, fit);
            }
            if (!fit) return undefined;
            const days = (c.t - last.t) / DAY_MS;
            const lossSince = days > 0 ? projectLoss(v, fit, rows, cya, last.t, last.t, last.fc, c.t) : 0;
            if (typeof lossSince !== 'number') return undefined;
            const projected = last.fc + genSince(c.model, c.sw, last.t, c.t) - lossSince;
            const week = projectLoss(Object.assign({}, v, { fcPath: 'held' }), fit, rows, cya, last.t, c.t - 7 * DAY_MS, Math.max(projected, 0.5), c.t);
            const avg = typeof week === 'number' ? Math.max(0, week / 7) : (fit.b || 0);
            return { projected: projected, avg: avg, elDays: days, lastT: last.t, lastV: last.fc };
        }
    };
}

// ---------------------------------------------------------------- one run

export interface SimRun { fc: number[]; pct: number[]; decisions: { t: number; pct: number; projected: number; kind: 'test' | 'check' }[]; tests: { t: number; measured: number; actual: number }[]; }

// The run window's hours from hour i until the SWG has run `runHours` (and the day equivalents over them): a boost's horizon.
function horizon(cal: SimCalendar, i: number, runHours: number): { eq: number; on: number } {
    let acc = 0, eq = 0;
    for (let j = i; j < cal.nh; j++) { acc += cal.frac[j]; eq += cal.w[j]; if (acc >= runHours) return { eq: eq, on: acc }; }
    return { eq: eq, on: Math.max(acc, 0.1) };
}
// From hour i to the end of the next (or current) run window: the SWG's hours and the day equivalents (where FC peaks).
function nextWindow(cal: SimCalendar, i: number): { on: number; eq: number } {
    let on = 0, eq = 0, started = false;
    for (let j = i; j < Math.min(cal.nh, i + 40); j++) {
        if (cal.frac[j] > 0) started = true;
        else if (started) break;
        on += cal.frac[j]; eq += cal.w[j];
    }
    return { on: on, eq: eq };
}

// The range control's inputs as the live check builds them (AutoSwgService: maintenance % from the average burn, a boost over one run period, the peak
// cap to the end of the run window, the integral from the last three readings, the scaled old-reading bias, the overshoot margin by the reading's age).
export function bandInputFor(cal: SimCalendar, s: SimSettings, ppmPerHourAtFull: number, i: number, r: ProjectionResult, hrs: number, coasting: boolean, recent: number[]): BandInput {
    const full = ppmPerHourAtFull * hrs;
    const hz = horizon(cal, Math.max(0, i), hrs);
    const pk = nextWindow(cal, Math.max(0, i));
    return {
        projectedFc: r.projected, avgPerDay: r.avg, elapsedDays: r.elDays, low: s.low, high: s.high,
        trim: s.trim, biasPerDay: s.biasPerDay, guardPerDay: s.guardPerDay, guardCap: s.guardCap,
        maintenancePct: full > 0 ? Math.max(0, Math.min(100, r.avg / full * 100)) : 0,
        marginPpm: s.overshootPpmPerDay > 0 ? Math.min(s.overshootCapPpm, s.overshootPpmPerDay * r.elDays) : 0,
        periodDayEq: hz.eq, periodRunHours: hz.on, boostPeriods: 1, ppmPerHourAtFull: ppmPerHourAtFull, coasting: coasting,
        peakCap: s.peakCap, peakMarginPpm: s.peakMarginPpm, peakRunHours: pk.on, peakDayEq: pk.eq,
        integral: s.integral, recentReadings: recent.slice(), scaledBias: s.scaledBias, lastReading: r.lastV
    };
}

export function simulate(data: SimData, cal: SimCalendar, s: SimSettings, projector: Projector, tests: number[], seed: number, plant: 'k' | ModelPlant = 'k'): SimRun {
    const rnd = seededRandom(seed);
    const noise = new Map<number, number>();
    for (const t of tests) noise.set(t, gauss(rnd) * s.testNoise);
    const prnd = seededRandom(seed * 13 + 1);
    // a model plant's residual consumption (ppm a day), in blocks as long as the real intervals
    let residual: number[] | undefined;
    if (plant !== 'k') {
        residual = [];
        while (residual.length < cal.nh) {
            const x = plant.residuals[Math.floor(prnd() * plant.residuals.length)];
            const hours = Math.max(1, Math.round(x.days * 24));
            for (let h = 0; h < hours; h++) residual.push(x.rate);
        }
    }
    let F = 0;
    const prior = data.fc.filter(e => e.t <= data.start);
    if (prior.length) F = prior[prior.length - 1].fc;
    const fcs: SimReading[] = prior.slice();
    const sw: SimSwg[] = data.swg.filter(e => e.t <= data.start);
    let pct = 24;
    const pctTimes: number[] = [data.start - 365 * DAY_MS], pctVals: number[] = [pct];
    const pctAt = (t: number) => { let lo = 0, hi = pctTimes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pctTimes[m] <= t) lo = m + 1; else hi = m; } return lo > 0 ? pctVals[lo - 1] : pct; };
    let coasting = false;
    const recent: number[] = prior.slice(-3).map(e => e.fc);
    const run: SimRun = { fc: [], pct: [], decisions: [], tests: [] };
    let ti = 0;
    const cyaAt = plant !== 'k' ? heldCya(data.cya || [], data.end) : undefined;
    const rows = data.rows || [];
    for (let i = 0; i < cal.nh; i++) {
        const t = data.start + i * HOUR_MS;
        const key = cal.day[i];
        const win = cal.windows.get(key);
        const model = cal.models.get(key);
        const events: { kind: 'test' | 'check'; t: number }[] = [];
        while (ti < tests.length && tests[ti] < t + HOUR_MS) { events.push({ kind: 'test', t: tests[ti] }); ti++; }
        if (cal.lhour[i] === 10 || cal.lhour[i] === 22) events.push({ kind: 'check', t: t });
        for (const ev of events) {
            if (ev.kind === 'test') {
                const meas = Math.round(Math.max(0, F + (noise.get(ev.t) || 0)) * 2) / 2;
                fcs.push({ t: ev.t, fc: meas });
                run.tests.push({ t: ev.t, measured: meas, actual: F });
                recent.push(meas); while (recent.length > 3) recent.shift();
            }
            const r = projector.project({ t: ev.t, cal: cal, data: data, s: s, model: new DayModel(model.sr, model.ss, model.swgStart), fcs: fcs, sw: sw });
            if (!r) continue;
            const hrs = win.hrs;
            const full = data.ppmPerHourAtFull * hrs;
            const d = bandDecision(bandInputFor(cal, s, data.ppmPerHourAtFull, i, r, hrs, coasting, recent));
            coasting = d.coasting;
            const next = Math.round(d.pct);
            sw.push({ t: ev.t, ppmPerDay: next / 100 * full, hrs: hrs, pct: next });
            run.decisions.push({ t: ev.t, pct: next, projected: r.projected, kind: ev.kind });
            if (next !== pct) { pctTimes.push(ev.t); pctVals.push(next); }
            pct = next;
        }
        // the plant: the cell by its cycles over the day's run window, less the burn
        let on: number;
        if (win && win.off > win.on) on = cycleConduction([{ t: win.on, on: true }, { t: win.off, on: false }], t, t + HOUR_MS, s.cycle, pctAt);
        else on = 0;
        const gen = data.ppmPerHourAtFull * on;
        let cons: number;
        if (plant === 'k') cons = cal.kh[i] * F * cal.w[i];
        else {
            const end = t + HOUR_MS;
            const j = firstRowAfter(rows, t);
            const row = j < rows.length && rows[j].t === end ? rows[j] : undefined;
            const sun = row ? (plant.variant.sun === 'station' ? row.sun : (typeof row.sun === 'number' ? row.sun * row.frac : undefined)) : undefined;
            const f = Math.max(F, 0.5);
            cons = (typeof sun === 'number' ? plant.fit.a * (plant.variant.fcTerm === 'fc' ? f : f / cyaAt(end)) * sun / 1000 : 0) + (plant.fit.b + residual[i]) / 24;
        }
        F = Math.max(0, F + gen - cons);
        run.fc.push(F); run.pct.push(pct);
    }
    return run;
}

// ---------------------------------------------------------------- the outcome table

export interface SimOutcome {
    in710: number; below7: number; below6: number; above10: number; above105: number;
    low: number; high: number; swing: number; drift: number;
    changesPerWeek: number; changeSize: number; meanChangePerCheck: number; typicalPct: number;
}
// The user's criteria for one run, over hours [a, b): the share of hours (%) in 7-10, below 7 and 6, above 10 and 10.5, the lowest and highest FC,
// the daily swing (mean over 24-hour blocks of the highest less the lowest FC), the day-to-day drift (mean absolute change of the block means),
// and the SWG % churn (changes a week, their mean size, the mean change per decision, the median %).
export function outcome(run: SimRun, s: SimSettings, a: number = 0, b?: number): SimOutcome {
    const F = run.fc.slice(a, typeof b === 'number' ? b : run.fc.length);
    const n = F.length || 1;
    const pctIn = (f: (x: number) => boolean) => 100 * F.filter(f).length / n;
    const blocks: number[][] = [];
    for (let k = 0; k + 24 < F.length; k += 24) blocks.push(F.slice(k, k + 24));
    const means = blocks.map(x => x.reduce((p, q) => p + q, 0) / x.length);
    let drift = 0;
    for (let k = 1; k < means.length; k++) drift += Math.abs(means[k] - means[k - 1]);
    const ds = run.decisions.map(x => x.pct);
    let changes = 0, size = 0, step = 0;
    for (let k = 1; k < ds.length; k++) { const c = Math.abs(ds[k] - ds[k - 1]); step += c; if (c > 0) { changes++; size += c; } }
    return {
        in710: pctIn(x => x >= s.low && x <= s.high), below7: pctIn(x => x < s.low), below6: pctIn(x => x < s.low - 1),
        above10: pctIn(x => x > s.high), above105: pctIn(x => x > s.high + 0.5),
        low: Math.min(...F), high: Math.max(...F),
        swing: blocks.length ? blocks.reduce((p, x) => p + Math.max(...x) - Math.min(...x), 0) / blocks.length : Math.max(...F) - Math.min(...F),
        drift: means.length > 1 ? drift / (means.length - 1) : 0,
        changesPerWeek: changes / (n / 168), changeSize: changes ? size / changes : 0, meanChangePerCheck: ds.length > 1 ? step / (ds.length - 1) : 0,
        typicalPct: ds.length ? quantile(ds, 0.5) : 0
    };
}

export type SimRhythm = 'twiceWeekly' | 'weekly' | 'real';
export function testsFor(rhythm: SimRhythm, seed: number, data: SimData): number[] {
    if (rhythm === 'weekly') return weeklyTests(seed, data.start, data.end);
    if (rhythm === 'real') return data.fc.filter(e => e.t > data.start && e.t <= data.end).map(e => e.t);
    return twiceWeeklyTests(seed, data.start, data.end);
}

// The median of each criterion over the seeds, with the 10% and 90% points across them (the spread).
export interface SimSummary { seeds: number; median: SimOutcome; p10: SimOutcome; p90: SimOutcome; }
export function summarizeOutcomes(list: SimOutcome[]): SimSummary {
    const keys = Object.keys(list[0]) as (keyof SimOutcome)[];
    const pick = (p: number) => { const o: any = {}; for (const k of keys) o[k] = quantile(list.map(x => x[k]), p); return o as SimOutcome; };
    return { seeds: list.length, median: pick(0.5), p10: pick(0.1), p90: pick(0.9) };
}
