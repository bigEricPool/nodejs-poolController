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

// SWG Assist Model Bench, the water balance: pH between tests, CSI, and when acid is worth adding. Pure functions only (AutoSwgBench.ts runs them, on
// the same long hourly rows and CYA path as the CYA advice), so they can be unit tested. Advisory only: nothing here changes the SWG % or any setting.
//
// Inputs, all from PoolMath (nothing it logs about the water is left unused): the pH, TA, CH, salt, borate, CYA, CSI and water temperature tests, and
// the muriatic acid (chemical 14 is 31.45%, 16 is 14.5%; a strength PoolMath sends with the entry wins) and boric acid (chemical 10) additions. The
// hourly rows add the pump time, the cell's output and the water temperature history.
//
// Between tests:
//   TA        the last TA test, less each acid dose's alkalinity, times the dilution (rain, as the CYA path)
//   borates   the last test (plus boric acid added) times the dilution; CH the last test times the dilution; salt the reading, else the last test
//   CYA       the CYA path (AutoSwgBenchCya.ts)
//   pH        from the last pH test it rises toward the level it settles at, slowing as it gets near: dpH/dx = r (E - pH). E is the pH at which the water's
//             carbonate is in balance with the air's CO2 (from the carbonate alkalinity, physical), plus an offset c the tests move. Each acid dose drops
//             the pH as the carbonate, CYA and borate buffers say (closed system right after the dose). x is the variant's clock: days (ph-const),
//             pump-on hours (ph-pump), pump plus cell-output hours (ph-pump-swg: the cell's H2 bubbles and its NaOH raise pH too), or days by a water
//             temperature factor (ph-temp).
//   CSI       TFP's / PoolMath's formula (the same as ChemControllerState.calculateCSI in State.ts), on the projected pH and the paths above
//
// The fit (each check): r and c from the pH test pairs with no acid between them since acid logging began, the last recentDays (60) counting
// recentWeight (3) times, pulled toward the priors (c 0, r about 0.24 a day) as if they were priorPairs (5) pairs: as pairs pile up, the data takes over.
// A pH reading of 8.2 or more is the top of the test kit's scale: it counts as "8.2 or above". Baselines scored beside them: the pH holds at the last
// test, and the last 60 days' mean rise.

import { BenchHour, DAY_MS, HOUR_MS } from './AutoSwgBenchModel';

export interface ChemPoint { t: number; v: number; }
export interface AcidAddition { t: number; ml: number; percent: number; chemical?: number; flOz: number; }
export interface BorateAddition { t: number; grams: number; }
export interface ChemData {
    ph: ChemPoint[]; ta: ChemPoint[]; ch: ChemPoint[]; salt: ChemPoint[]; bor: ChemPoint[]; csi: ChemPoint[]; cya: ChemPoint[]; temp: ChemPoint[];   // temp in F
    acid: AcidAddition[]; boric: BorateAddition[];
}
// PoolMath's muriatic acid strengths by chemical id (the user's log, checked 2026-11-15: 14 is the 31.45% jug, 16 the 14.5%).
export const MURIATIC_BY_CHEMICAL: { [id: number]: number } = { 14: 31.45, 16: 14.5 };
export const BORIC_ACID_CHEMICAL = 10;
export const PH_TOP = 8.2;                      // the test kit's top: a reading here is "8.2 or above"
const ML_PER_FL_OZ = 29.5735, L_PER_GAL = 3.785411784;

// The water-balance tests and the acid and boric acid additions from PoolMath's archived entries (any shape with those fields), oldest first.
export function chemFromEntries(entries: any[]): ChemData {
    const d: ChemData = { ph: [], ta: [], ch: [], salt: [], bor: [], csi: [], cya: [], temp: [], acid: [], boric: [] };
    for (const e of entries || []) {
        const t = new Date(e && e.ts).getTime();
        if (!isFinite(t)) continue;
        if (e.type === 'testlog') {
            for (const k of ['ph', 'ta', 'ch', 'salt', 'bor', 'csi', 'cya'] as (keyof ChemData)[]) {
                const v = e[k];
                if (typeof v === 'number' && isFinite(v) && (k === 'csi' || v > 0)) (d[k] as ChemPoint[]).push({ t: t, v: v });
            }
            if (typeof e.waterTemp === 'number' && isFinite(e.waterTemp)) {
                const f = e.waterTempUnits === 1 ? e.waterTemp * 9 / 5 + 32 : e.waterTemp;
                if (f > 32 && f < 110) d.temp.push({ t: t, v: f });
            }
        }
        else if (e.type === 'chemlog' && typeof e.chemical === 'number') {
            if (typeof MURIATIC_BY_CHEMICAL[e.chemical] === 'number') {
                let ml = typeof e.normalizedAmount === 'number' && e.normalizedAmount > 0 ? e.normalizedAmount : undefined;
                if (typeof ml !== 'number' && typeof e.amount === 'number' && e.amount > 0 && (e.unit === 4 || typeof e.unit === 'undefined')) ml = e.amount * ML_PER_FL_OZ;
                if (!(ml > 0)) continue;
                const pct = typeof e.percent === 'number' && e.percent > 0 && e.percent <= 40 ? e.percent : MURIATIC_BY_CHEMICAL[e.chemical];
                d.acid.push({ t: t, ml: ml, percent: pct, chemical: e.chemical, flOz: Math.round(ml / ML_PER_FL_OZ * 10) / 10 });
            }
            else if (e.chemical === BORIC_ACID_CHEMICAL && typeof e.normalizedAmount === 'number' && e.normalizedAmount > 0) d.boric.push({ t: t, grams: e.normalizedAmount });
        }
    }
    for (const k of Object.keys(d)) (d as any)[k].sort((a: any, b: any) => a.t - b.t);
    return d;
}

// ---------------------------------------------------------------- the chemistry

// CSI, as TFP's and PoolMath's (and ChemControllerState.calculateCSI): CH and TA in ppm CaCO3, CYA and borates in ppm, salt in ppm, temperature in F.
export function csi(ph: number, ta: number, ch: number, cya: number, salt: number, bor: number, tempF: number): number | undefined {
    if (!(ph > 0 && ta > 0 && ch > 0)) return undefined;
    const extraSalt = Math.max(0, (salt || 0) - 1.168 * ch);
    const I = (1.5 * ch + ta) / 50045 + extraSalt / 58440;
    const carbAlk = ta - 0.38772 * (cya || 0) / (1 + Math.pow(10, 6.83 - ph)) - 4.63 * (bor || 0) / (1 + Math.pow(10, 9.11 - ph));
    if (!(carbAlk > 0)) return undefined;
    const tempK = ((isFinite(tempF) ? tempF : 80) - 32) * 5 / 9 + 273.15;
    const si = ph - 6.9395 + Math.log10(ch) + Math.log10(carbAlk) - 2.56 * Math.sqrt(I) / (1 + 1.65 * Math.sqrt(I)) - 1412.5 / tempK;
    return isFinite(si) ? Math.round(si * 1000) / 1000 : undefined;
}

// The buffers (mol/L of alkalinity) at a pH: carbonate (CT mol/L of total carbonate), CYA and borates (ppm), water.
const PK1 = 6.33, PK2 = 10.2, PK_CYA = 6.83, PK_BOR = 9.11;
function alpha(ph: number): { a1: number; a2: number } {
    const H = Math.pow(10, -ph), K1 = Math.pow(10, -PK1), K2 = Math.pow(10, -PK2);
    return { a1: 1 / (1 + H / K1 + K2 / H), a2: 1 / (1 + H / K2 + H * H / (K1 * K2)) };
}
function nonCarbonate(ph: number, cya: number, bor: number): number {
    const H = Math.pow(10, -ph);
    return (cya || 0) / 129.07e3 / (1 + Math.pow(10, PK_CYA - ph)) + (bor || 0) / 10.81e3 / (1 + Math.pow(10, PK_BOR - ph)) + 1e-14 / H - H;
}
function alkalinity(ph: number, CT: number, cya: number, bor: number): number { const a = alpha(ph); return CT * (a.a1 + 2 * a.a2) + nonCarbonate(ph, cya, bor); }

// mol/L of HCl that `ml` of muriatic acid at `percent` adds to `gallons` (the jug's density from its strength: 31.45% is about 1.16).
export function acidMolPerL(ml: number, percent: number, gallons: number): number {
    if (!(gallons > 0) || !(ml > 0) || !(percent > 0)) return 0;
    const density = 1 + 0.0051 * percent;
    return ml * density * percent / 100 / 36.46 / (gallons * L_PER_GAL);
}
// The TA (ppm CaCO3) a dose takes out.
export function acidTaDrop(ml: number, percent: number, gallons: number): number { return acidMolPerL(ml, percent, gallons) * 50045; }

// The pH right after `mol` mol/L of acid, the carbonate held (closed system), with the CYA and borate buffers.
export function phAfterAcid(ph: number, ta: number, cya: number, bor: number, mol: number): number {
    if (!(mol > 0)) return ph;
    const a = alpha(ph);
    const CT = (ta / 50045 - nonCarbonate(ph, cya, bor)) / (a.a1 + 2 * a.a2);
    const target = ta / 50045 - mol;
    let lo = 3, hi = ph;
    for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (alkalinity(m, CT, cya, bor) > target) hi = m; else lo = m; }
    return (lo + hi) / 2;
}
// The fl oz of acid at `percent` that bring `ph` down to `target` (0 when it is already there).
export function acidDoseFlOz(ph: number, target: number, ta: number, cya: number, bor: number, percent: number, gallons: number): number {
    if (!(ph > target) || !(gallons > 0)) return 0;
    let lo = 0, hi = 2000;
    for (let k = 0; k < 50; k++) {
        const m = (lo + hi) / 2;
        if (phAfterAcid(ph, ta, cya, bor, acidMolPerL(m * ML_PER_FL_OZ, percent, gallons)) > target) lo = m; else hi = m;
    }
    return Math.round((lo + hi) / 2);
}
// The strength (%) that makes a dose of `ml` move the pH from `before` to `after`, within 3-45% (a check on the logged strength).
export function bestStrength(before: number, after: number, ml: number, ta: number, cya: number, bor: number, gallons: number): number | undefined {
    if (!(before > after) || !(ml > 0) || !(gallons > 0)) return undefined;
    const ph = (p: number) => phAfterAcid(before, ta, cya, bor, acidMolPerL(ml, p, gallons));
    if (ph(3) <= after) return 3;
    if (ph(45) >= after) return 45;
    let lo = 3, hi = 45;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (ph(m) > after) lo = m; else hi = m; }
    return Math.round((lo + hi) / 2 * 10) / 10;
}

// The pH the water settles at in balance with the air's CO2 (about 420 ppm, Henry's constant 10^-1.47 at 25 C): the pH at which the carbonate
// alkalinity the CO2 supports equals the TA less the CYA and borate alkalinity.
const H2CO3_AIR = Math.pow(10, -1.47) * 420e-6;
export function co2BalancePh(ta: number, cya: number, bor: number): number {
    if (!(ta > 0)) return 8.2;
    const K1 = Math.pow(10, -PK1), K2 = Math.pow(10, -PK2);
    let lo = 6, hi = 10;
    for (let k = 0; k < 50; k++) {
        const m = (lo + hi) / 2, H = Math.pow(10, -m);
        const carbFromAir = H2CO3_AIR * (K1 / H + 2 * K1 * K2 / (H * H));
        const carbLeft = ta / 50045 - nonCarbonate(m, cya, bor);
        if (carbFromAir > carbLeft) hi = m; else lo = m;
    }
    return (lo + hi) / 2;
}

// ---------------------------------------------------------------- the paths between tests

// What the pH model reads besides the tests: the gallons, the CYA path, the dilution between two moments, the hourly rows (pump time, cell output,
// water temperature) and what the cell makes at 100% (ppm an hour), to turn its output into hours.
export interface ChemContext {
    data: ChemData; gallons: number;
    cya: (t: number) => number;
    dilution: (t1: number, t2: number) => number;
    rows: BenchHour[];
    ppmPerHourAtFull: number;
}
function lastAt(list: ChemPoint[], t: number): ChemPoint | undefined {
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t <= t) lo = m + 1; else hi = m; }
    return lo > 0 ? list[lo - 1] : undefined;
}
export function taAt(ctx: ChemContext, t: number): number | undefined {
    const T = lastAt(ctx.data.ta, t);
    if (!T) return undefined;
    let v = T.v;
    for (const a of ctx.data.acid) if (a.t > T.t && a.t <= t) v -= acidTaDrop(a.ml, a.percent, ctx.gallons) / ctx.dilution(T.t, a.t);
    return Math.max(10, v * ctx.dilution(T.t, t));
}
export function borAt(ctx: ChemContext, t: number): number {
    const B = lastAt(ctx.data.bor, t);
    let v = B ? B.v : 0;
    const since = B ? B.t : -Infinity;
    for (const a of ctx.data.boric) if (a.t > since && a.t <= t && ctx.gallons > 0) v += a.grams * 0.1748 * 1000 / (ctx.gallons * L_PER_GAL) / ctx.dilution(since > -Infinity ? since : a.t, a.t);
    return Math.max(0, v * (B ? ctx.dilution(B.t, t) : 1));
}
export function chAt(ctx: ChemContext, t: number): number | undefined { const C = lastAt(ctx.data.ch, t); return C ? C.v * ctx.dilution(C.t, t) : undefined; }
function rowAt(rows: BenchHour[], t: number): number {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t <= t) lo = m + 1; else hi = m; }
    return lo - 1;
}
export function saltAt(ctx: ChemContext, t: number): number {
    const i = rowAt(ctx.rows, t);
    if (i >= 0 && typeof ctx.rows[i].salt === 'number' && ctx.rows[i].salt > 0 && t - ctx.rows[i].t < 2 * DAY_MS) return ctx.rows[i].salt;
    const S = lastAt(ctx.data.salt, t);
    return S ? S.v : 3200;
}
export function tempAt(ctx: ChemContext, t: number): number {
    const i = rowAt(ctx.rows, t);
    if (i >= 0 && t - ctx.rows[i].t < 2 * HOUR_MS) {
        for (let k = i; k >= 0 && k > i - 24; k--) if (typeof ctx.rows[k].temp === 'number') return ctx.rows[k].temp;
    }
    const W = lastAt(ctx.data.temp, t);
    return W ? W.v : 80;
}
// The CSI at t with the pH given and the paths above.
export function csiAt(ctx: ChemContext, t: number, ph: number): number | undefined {
    const ta = taAt(ctx, t), ch = chAt(ctx, t);
    if (typeof ta !== 'number' || typeof ch !== 'number') return undefined;
    return csi(ph, ta, ch, ctx.cya(t), saltAt(ctx, t), borAt(ctx, t), tempAt(ctx, t));
}
// The level the pH rises toward at t, before the fitted offset.
export function settleAt(ctx: ChemContext, t: number): number {
    const ta = taAt(ctx, t);
    return co2BalancePh(typeof ta === 'number' ? ta : 80, ctx.cya(t), borAt(ctx, t));
}

// ---------------------------------------------------------------- the variants

export type PhClock = 'days' | 'pump' | 'pumpSwg' | 'temp';
export type PhKind = 'taper' | 'hold' | 'linear';
export interface PhVariant { id: string; label: string; kind: PhKind; clock?: PhClock; }
export const PH_VARIANTS: PhVariant[] = [
    { id: 'ph-const', label: 'Leveling off, by days', kind: 'taper', clock: 'days' },
    { id: 'ph-pump', label: 'Leveling off, by pump-on hours', kind: 'taper', clock: 'pump' },
    { id: 'ph-pump-swg', label: 'Leveling off, by pump and cell-output hours', kind: 'taper', clock: 'pumpSwg' },
    { id: 'ph-temp', label: 'Leveling off, by days and water temperature', kind: 'taper', clock: 'temp' },
    { id: 'ph-hold', label: 'Baseline: the pH holds at the last test', kind: 'hold' },
    { id: 'ph-linear60', label: 'Baseline: the last 60 days\' mean rise', kind: 'linear' }
];
const TEMP_FACTOR_PER_F = 0.03;

export interface ChemSettings {
    phRecommended: number; phNeeded: number; csiRecommended: number; csiNeeded: number; aheadDays: number;
    doseTargetHighTa: number; doseTargetLowTa: number; taSplit: number; doseStrength: number;
    recentDays: number; recentWeight: number; priorPairs: number; priorRate: number; main: string;
}
// The defaults, from TFP ("Water Balance for SWGs": let the pH rise to 8.0-8.2, then add acid back to the mid 7s, only to 7.8 at TA 60; "Calcium
// Saturation Index": target -0.6 to +0.6, ideal -0.3 to +0.3). Recommended at the top of the normal pH and the ideal CSI, needed at TFP's own point to
// add acid and the edge of its CSI target.
export const DEFAULT_CHEM_SETTINGS: ChemSettings = {
    phRecommended: 8.0, phNeeded: 8.2, csiRecommended: 0.3, csiNeeded: 0.6, aheadDays: 3,
    doseTargetHighTa: 7.6, doseTargetLowTa: 7.8, taSplit: 60, doseStrength: 31.45,
    recentDays: 60, recentWeight: 3, priorPairs: 5, priorRate: 0.24, main: 'ph-const'
};
export function normalizeChemSettings(raw: any): ChemSettings {
    const s: ChemSettings = Object.assign({}, DEFAULT_CHEM_SETTINGS);
    if (!raw || typeof raw !== 'object') return s;
    const num = (k: keyof ChemSettings, lo: number, hi: number) => {
        const x = Number(raw[k]);
        if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '' && isFinite(x)) (s as any)[k] = Math.max(lo, Math.min(hi, x));
    };
    num('phRecommended', 7.4, 8.4); num('phNeeded', 7.6, 8.6); num('csiRecommended', -0.5, 1); num('csiNeeded', -0.3, 1.5); num('aheadDays', 0, 7);
    num('doseTargetHighTa', 7.0, 8.0); num('doseTargetLowTa', 7.0, 8.0); num('taSplit', 20, 150); num('doseStrength', 5, 40);
    num('recentDays', 7, 365); num('recentWeight', 1, 10); num('priorPairs', 0, 50); num('priorRate', 0.01, 2);
    if (typeof raw.main === 'string' && PH_VARIANTS.some(v => v.id === raw.main && v.kind === 'taper')) s.main = raw.main;
    if (s.phNeeded < s.phRecommended) s.phNeeded = s.phRecommended;
    if (s.csiNeeded < s.csiRecommended) s.csiNeeded = s.csiRecommended;
    return s;
}

// The variant's clock over the hour that ends at row i, in days: a day of the clock is one day (days), 24 pump-on hours (pump), 24 pump plus cell
// hours (pumpSwg), or one day at 80 F (temp). An hour the rows lack pump time for counts at the rows' mean.
export class PhClockIndex {
    private cum: { [k: string]: Float64Array } = {};
    private rows: BenchHour[];
    constructor(rows: BenchHour[], ppmPerHourAtFull: number) {
        this.rows = rows;
        const n = rows.length;
        let pumpSum = 0, pumpN = 0;
        for (const r of rows) if (typeof r.pumpSec === 'number') { pumpSum += r.pumpSec / 3600; pumpN++; }
        const pumpMean = pumpN ? pumpSum / pumpN : 1;
        const cell = (r: BenchHour) => r.genFrom === 'log' && ppmPerHourAtFull > 0 ? Math.min(1, Math.max(0, r.gen / ppmPerHourAtFull)) : 0;
        for (const k of ['days', 'pump', 'pumpSwg', 'temp']) this.cum[k] = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) {
            const r = rows[i];
            const pump = typeof r.pumpSec === 'number' ? Math.min(1, r.pumpSec / 3600) : pumpMean;
            const temp = typeof r.temp === 'number' ? r.temp : 80;
            this.cum.days[i + 1] = this.cum.days[i] + 1 / 24;
            this.cum.pump[i + 1] = this.cum.pump[i] + pump / 24;
            this.cum.pumpSwg[i + 1] = this.cum.pumpSwg[i] + (pump + cell(r)) / 24;
            this.cum.temp[i + 1] = this.cum.temp[i] + Math.exp(TEMP_FACTOR_PER_F * (temp - 80)) / 24;
        }
    }
    private index(t: number): number { return rowAt(this.rows, t) + 1; }   // rows ending at or before t
    // the clock from t1 to t2 (past the rows: the rows' last day repeated)
    public between(clock: PhClock, t1: number, t2: number): number {
        if (!(t2 > t1)) return 0;
        const c = this.cum[clock], n = this.rows.length;
        if (!n) return (t2 - t1) / DAY_MS;
        const end = this.rows[n - 1].t;
        const inside = (a: number, b: number) => c[this.index(b)] - c[this.index(a)];
        let x = inside(t1, Math.min(t2, end));
        if (t2 > end) {
            const perDay = n >= 24 ? (c[n] - c[n - 24]) : (c[n] / Math.max(1, n)) * 24;
            x += perDay * (t2 - Math.max(t1, end)) / DAY_MS;
        }
        return Math.max(0, x);
    }
}

export interface PhPair { t1: number; p1: number; t2: number; p2: number; days: number; w: number; settle: number; }
// The pH test pairs a fit uses, as known at asOf: consecutive tests 0.5-10 days apart with no acid logged between them, the first after acid logging
// began (the first logged acid; before it, acid that went in unlogged shows as falls), and no fall of 0.3 or more (unlogged acid). Weighted
// recentWeight within recentDays of asOf.
export function phPairs(ctx: ChemContext, asOf: number, s: ChemSettings = DEFAULT_CHEM_SETTINGS): PhPair[] {
    const ph = ctx.data.ph.filter(p => p.t <= asOf);
    const acid = ctx.data.acid.filter(a => a.t <= asOf);
    if (!acid.length) return [];
    const start = acid[0].t - DAY_MS;
    const out: PhPair[] = [];
    let ai = 0;
    for (let k = 1; k < ph.length; k++) {
        const a = ph[k - 1], b = ph[k];
        const days = (b.t - a.t) / DAY_MS;
        if (a.t < start || days < 0.5 || days > 10 || a.v - b.v >= 0.3) continue;
        while (ai < acid.length && acid[ai].t <= a.t) ai++;
        if (ai < acid.length && acid[ai].t <= b.t) continue;
        out.push({ t1: a.t, p1: a.v, t2: b.t, p2: b.v, days: days, w: b.t >= asOf - s.recentDays * DAY_MS ? s.recentWeight : 1, settle: settleAt(ctx, (a.t + b.t) / 2) });
    }
    return out;
}

export interface PhFit { id: string; kind: PhKind; r?: number; c?: number; rate?: number; n: number; nRecent: number; rmse?: number; prior?: boolean; }
const taper = (p1: number, E: number, r: number, x: number) => E - (E - p1) * Math.exp(-r * x);
// The error of a projection against a test, with a reading at the kit's top as "8.2 or above".
export function phError(test: number, proj: number): number { return test >= PH_TOP && proj >= test ? 0 : test - proj; }

// Fits a variant on the pairs (see the top). Taper: a coarse grid then a fine one over c and log r, the ridge pulling toward c 0 and the prior rate
// as if it were priorPairs pairs with an error of 0.1. Linear: the weighted mean rise per day. Hold: nothing to fit.
export function fitPh(v: PhVariant, pairs: PhPair[], clocks: PhClockIndex, s: ChemSettings = DEFAULT_CHEM_SETTINGS): PhFit {
    const nRecent = pairs.filter(p => p.w > 1).length;
    if (v.kind === 'hold') return { id: v.id, kind: v.kind, n: pairs.length, nRecent: nRecent };
    if (v.kind === 'linear') {
        const recent = pairs.filter(p => p.w > 1 && p.p2 < PH_TOP);
        const use = recent.length >= 3 ? recent : pairs.filter(p => p.p2 < PH_TOP);
        const W = use.reduce((a, p) => a + p.days, 0);
        const rate = W > 0 ? use.reduce((a, p) => a + (p.p2 - p.p1), 0) / W : 0.07;
        return { id: v.id, kind: v.kind, rate: Math.round(rate * 10000) / 10000, n: use.length, nRecent: nRecent };
    }
    const clock = v.clock || 'days';
    const X = pairs.map(p => clocks.between(clock, p.t1, p.t2));
    // the prior rate on this clock: the days' prior scaled by how much clock a day of these pairs ran
    const dSum = pairs.reduce((a, p) => a + p.days, 0), xSum = X.reduce((a, b) => a + b, 0);
    const r0 = s.priorRate * (dSum > 0 && xSum > 0 ? dSum / xSum : 1);
    if (pairs.length < 3) return { id: v.id, kind: v.kind, r: round4(r0), c: 0, n: pairs.length, nRecent: nRecent, prior: true };
    const wSum = pairs.reduce((a, p) => a + p.w, 0);
    const lambda = s.priorPairs * (wSum / pairs.length) * 0.01;
    const SC = 0.3, SLR = 0.5;
    const cost = (r: number, c: number) => {
        let e2 = 0;
        for (let k = 0; k < pairs.length; k++) { const p = pairs[k]; const e = phError(p.p2, taper(p.p1, p.settle + c, r, X[k])); e2 += p.w * e * e; }
        const lr = Math.log(r / r0);
        return e2 + lambda * ((c / SC) * (c / SC) + (lr / SLR) * (lr / SLR));
    };
    let best = { r: r0, c: 0, f: cost(r0, 0) };
    for (let c = -0.6; c <= 0.6 + 1e-9; c += 0.05)
        for (let lr = -2; lr <= 2 + 1e-9; lr += 0.2) { const r = r0 * Math.exp(lr), f = cost(r, c); if (f < best.f) best = { r: r, c: c, f: f }; }
    const c0 = best.c, lr0 = Math.log(best.r / r0);
    for (let c = c0 - 0.05; c <= c0 + 0.05 + 1e-9; c += 0.01)
        for (let lr = lr0 - 0.2; lr <= lr0 + 0.2 + 1e-9; lr += 0.02) { const r = r0 * Math.exp(lr), f = cost(r, c); if (f < best.f) best = { r: r, c: c, f: f }; }
    let e2 = 0;
    for (let k = 0; k < pairs.length; k++) { const p = pairs[k]; const e = phError(p.p2, taper(p.p1, p.settle + best.c, best.r, X[k])); e2 += e * e; }
    return { id: v.id, kind: v.kind, r: round4(best.r), c: Math.round(best.c * 1000) / 1000, n: pairs.length, nRecent: nRecent, rmse: Math.round(Math.sqrt(e2 / pairs.length) * 1000) / 1000 };
}
function round4(x: number): number { return Math.round(x * 10000) / 10000; }

// The pH from a start (t0, p0) hour by hour to each of `times`, with the fit: the taper toward the settling level plus c (worked out again each day
// and after each dose), each logged acid dose after t0 and up to `acidUpTo` dropping it. Returns the pH at each time.
export function projectPh(ctx: ChemContext, v: PhVariant, fit: PhFit, clocks: PhClockIndex, t0: number, p0: number, times: number[], acidUpTo: number = Infinity): number[] {
    const out: number[] = [];
    const sorted = times.map((t, k) => ({ t: t, k: k })).sort((a, b) => a.t - b.t);
    const doses = ctx.data.acid.filter(a => a.t > t0 && a.t <= acidUpTo).sort((a, b) => a.t - b.t);
    let p = p0, t = t0, di = 0, E = settleAt(ctx, t0) + (fit.c || 0), Et = t0;
    const advance = (to: number) => {
        // to the next dose or day boundary, whichever is first
        while (t < to) {
            const next = Math.min(to, t + DAY_MS, di < doses.length && doses[di].t <= to ? doses[di].t : Infinity);
            if (v.kind === 'linear') p += (fit.rate || 0) * (next - t) / DAY_MS;
            else if (v.kind === 'taper') p = taper(p, E, fit.r || 0, clocks.between(v.clock || 'days', t, next));
            t = next;
            while (di < doses.length && doses[di].t <= t) {
                const d = doses[di++];
                const ta = taAt(ctx, d.t - 1);
                p = phAfterAcid(p, typeof ta === 'number' ? ta : 80, ctx.cya(d.t), borAt(ctx, d.t), acidMolPerL(d.ml, d.percent, ctx.gallons));
                E = settleAt(ctx, d.t + 1) + (fit.c || 0); Et = t;
            }
            if (t - Et >= DAY_MS) { E = settleAt(ctx, t) + (fit.c || 0); Et = t; }
        }
    };
    for (const x of sorted) { advance(x.t); out[x.k] = Math.round(p * 1000) / 1000; }
    return out;
}

// ---------------------------------------------------------------- the advice

export interface AcidAdvice {
    level: 'none' | 'recommended' | 'needed'; reason?: string; at?: string;
    ph?: number; csi?: number; phAhead?: number; csiAhead?: number; lastTest?: { t: string; ph: number }; stale?: boolean;
    doseFlOz?: number; doseTo?: number; doseStrength?: number; taDrop?: number; variant: string;
    // the dose if it went in now, from the pH projected now (doseFlOz is for when the level is reached); the pH the dose is sized from
    doseNowFlOz?: number; doseFromPh?: number;
    // the whole advice in words, without the level: when, how much then, and how much now
    text?: string;
}
// Acid recommended when the projected pH reaches phRecommended or the CSI csiRecommended within aheadDays, needed at phNeeded or csiNeeded (advisory
// only). The dose brings the projected pH now to doseTargetHighTa (TA above taSplit) or doseTargetLowTa, in fl oz at doseStrength.
export function acidAdvice(ctx: ChemContext, v: PhVariant, fit: PhFit, clocks: PhClockIndex, now: number, s: ChemSettings = DEFAULT_CHEM_SETTINGS, fmt: (t: number) => string = t => new Date(t).toISOString()): AcidAdvice {
    const last = lastAt(ctx.data.ph, now);
    if (!last) return { level: 'none', reason: 'No pH test is logged.', variant: v.id };
    const times: number[] = [];
    for (let t = now; t <= now + s.aheadDays * DAY_MS + 1; t += 3 * HOUR_MS) times.push(t);
    const ph = projectPh(ctx, v, fit, clocks, last.t, last.v, times, now);
    const csis = times.map((t, k) => csiAt(ctx, t, ph[k]));
    const round2 = (x: number) => typeof x === 'number' ? Math.round(x * 100) / 100 : undefined;
    const out: AcidAdvice = {
        level: 'none', ph: round2(ph[0]), csi: round2(csis[0]), phAhead: round2(Math.max(...ph)),
        csiAhead: round2(Math.max(...csis.filter(x => typeof x === 'number'))), lastTest: { t: new Date(last.t).toISOString(), ph: last.v },
        stale: now - last.t > 10 * DAY_MS, variant: v.id
    };
    if (!isFinite(out.csiAhead)) out.csiAhead = undefined;
    const first = (f: (k: number) => boolean) => { for (let k = 0; k < times.length; k++) if (f(k)) return k; return -1; };
    const needed = first(k => ph[k] >= s.phNeeded || (typeof csis[k] === 'number' && csis[k] >= s.csiNeeded));
    const recommended = first(k => ph[k] >= s.phRecommended || (typeof csis[k] === 'number' && csis[k] >= s.csiRecommended));
    const k = needed >= 0 ? needed : recommended;
    if (k < 0) {
        out.reason = `The pH is projected to stay below ${s.phRecommended} and the CSI below ${s.csiRecommended} for the next ${s.aheadDays} days.`;
        return out;
    }
    out.level = needed >= 0 ? 'needed' : 'recommended';
    out.at = new Date(times[k]).toISOString();
    const byPh = ph[k] >= (out.level === 'needed' ? s.phNeeded : s.phRecommended);
    const signed = (x: number) => (x > 0 ? '+' : '') + x.toFixed(2);
    const what = byPh
        ? `pH ${k === 0 ? `projected at ${ph[0].toFixed(2)} now` : `projected to reach ${(out.level === 'needed' ? s.phNeeded : s.phRecommended).toFixed(1)} around ${fmt(times[k])}`}`
        : `CSI ${k === 0 ? `projected at ${signed(csis[0])} now` : `projected to reach ${signed(out.level === 'needed' ? s.csiNeeded : s.csiRecommended)} around ${fmt(times[k])}`}`;
    out.reason = `The ${what} (${byPh ? (out.level === 'needed' ? s.phNeeded : s.phRecommended).toFixed(1) : signed(out.level === 'needed' ? s.csiNeeded : s.csiRecommended)} or more).`;
    const ta = taAt(ctx, now);
    const taV = typeof ta === 'number' ? ta : 80;
    const cya = ctx.cya(now), bor = borAt(ctx, now);
    out.doseTo = taV > s.taSplit ? s.doseTargetHighTa : s.doseTargetLowTa;
    out.doseStrength = s.doseStrength;
    // sized for when the level is reached (the pH projected then), and for now
    out.doseFromPh = Math.round(Math.max(ph[0], ph[k]) * 100) / 100;
    out.doseFlOz = acidDoseFlOz(out.doseFromPh, out.doseTo, taV, cya, bor, s.doseStrength, ctx.gallons);
    out.doseNowFlOz = acidDoseFlOz(ph[0], out.doseTo, taV, cya, bor, s.doseStrength, ctx.gallons);
    out.taDrop = Math.round(acidTaDrop(out.doseFlOz * ML_PER_FL_OZ, s.doseStrength, ctx.gallons) * 10) / 10;
    const acid = `${s.doseStrength}% muriatic acid`, to = out.doseTo.toFixed(1);
    if (k === 0) out.text = `${what}; add about ${out.doseFlOz} fl oz of ${acid} to bring it to ${to}.`;
    else out.text = `${what}; then add about ${out.doseFlOz} fl oz of ${acid} to bring it to ${to}`
        + (out.doseNowFlOz > 0 ? ` (about ${out.doseNowFlOz} fl oz if added today).` : ` (none needed today: pH is projected at ${ph[0].toFixed(2)}).`);
    if (out.stale) {
        const old = ` The last pH test is ${Math.floor((now - last.t) / DAY_MS)} days old; a test would firm this up.`;
        out.reason += old; out.text += old;
    }
    return out;
}

// ---------------------------------------------------------------- checks

// Each logged acid dose with a pH test before it (within 1.5 days) and after it (within 2 days): the pH the chemistry predicts after it, the test, and
// the strength that would explain the drop (the logged strength is the one to doubt when that differs a lot).
export function acidChecks(ctx: ChemContext, from: number = -Infinity): { t: number; flOz: number; percent: number; before: number; after: number; predicted: number; error: number; bestStrength?: number }[] {
    const out: any[] = [];
    for (const a of ctx.data.acid) {
        if (a.t < from) continue;
        const before = ctx.data.ph.filter(p => p.t <= a.t && p.t >= a.t - 1.5 * DAY_MS).pop();
        const after = ctx.data.ph.find(p => p.t > a.t && p.t <= a.t + 2 * DAY_MS);
        if (!before || !after) continue;
        const ta = taAt(ctx, a.t - 1);
        const taV = typeof ta === 'number' ? ta : 80, cya = ctx.cya(a.t), bor = borAt(ctx, a.t);
        const pred = phAfterAcid(before.v, taV, cya, bor, acidMolPerL(a.ml, a.percent, ctx.gallons));
        out.push({
            t: a.t, flOz: a.flOz, percent: a.percent, before: before.v, after: after.v, predicted: Math.round(pred * 100) / 100,
            error: Math.round((after.v - pred) * 100) / 100, bestStrength: bestStrength(before.v, after.v, a.ml, taV, cya, bor, ctx.gallons)
        });
    }
    return out;
}
// The borate tests against the dilution between them (borates don't degrade, so they are a second tracer for the dilution the CYA path uses).
export function borateChecks(ctx: ChemContext): { t1: number; t2: number; b1: number; b2: number; expected: number }[] {
    const out: any[] = [];
    const b = ctx.data.bor;
    for (let k = 1; k < b.length; k++) {
        if (ctx.data.boric.some(x => x.t > b[k - 1].t && x.t <= b[k].t)) continue;
        out.push({ t1: b[k - 1].t, t2: b[k].t, b1: b[k - 1].v, b2: b[k].v, expected: Math.round(b[k - 1].v * ctx.dilution(b[k - 1].t, b[k].t) * 10) / 10 });
    }
    return out;
}

// ---------------------------------------------------------------- scores

export type ChemFlag = 'acid' | 'longGap' | 'top';
export interface ChemScoreRow {
    t: number; kind: 'score'; id: string; what: 'ph' | 'csi'; t1: number; start: number; test: number; proj: number; miss: number; days: number;
    fitAt?: number; replay?: boolean; flags?: ChemFlag[];
}
// The score of a pH test from the test before it, with the fit frozen at fitAt: the pH, and the CSI against PoolMath's CSI at the test.
export function scorePhTest(ctx: ChemContext, v: PhVariant, fit: PhFit, clocks: PhClockIndex, k: number, fitAt: number, replay: boolean, maxGapDays: number = 10): ChemScoreRow[] {
    const ph = ctx.data.ph;
    const a = ph[k - 1], b = ph[k];
    if (!a || !b || b.t - a.t < 0.3 * DAY_MS) return [];
    const proj = projectPh(ctx, v, fit, clocks, a.t, a.v, [b.t], b.t)[0];
    const days = Math.round((b.t - a.t) / DAY_MS * 100) / 100;
    const flags: ChemFlag[] = [];
    if (ctx.data.acid.some(x => x.t > a.t && x.t <= b.t)) flags.push('acid');
    if (days > maxGapDays) flags.push('longGap');
    if (b.v >= PH_TOP) flags.push('top');
    const base = { t: b.t, kind: 'score' as const, id: v.id, t1: a.t, days: days, fitAt: fitAt };
    const rows: ChemScoreRow[] = [Object.assign({}, base, { what: 'ph' as const, start: a.v, test: b.v, proj: proj, miss: Math.round(phError(b.v, proj) * 1000) / 1000 })];
    const pm = ctx.data.csi.find(x => x.t === b.t);
    const cs = csiAt(ctx, b.t, proj);
    if (pm && typeof cs === 'number') rows.push(Object.assign({}, base, { what: 'csi' as const, start: a.v, test: pm.v, proj: cs, miss: Math.round((pm.v - cs) * 1000) / 1000 }));
    for (const r of rows) { if (flags.length) r.flags = flags.slice(); if (replay) r.replay = true; }
    return rows;
}
export interface ChemSummary { n: number; mae?: number; bias?: number; p90?: number; acid?: { n: number; mae?: number }; }
// The headline of a set of score rows: mean absolute miss, mean miss and the 90% point of the absolute miss, over the rows with no flag but 'acid'
// and 'top' (a long gap is left out); the rows with a dose in the interval are also summarized apart.
export function chemSummary(rows: ChemScoreRow[]): ChemSummary {
    const use = rows.filter(r => !(r.flags || []).includes('longGap'));
    const pick = (x: ChemScoreRow[]) => {
        if (!x.length) return { n: 0 };
        const abs = x.map(r => Math.abs(r.miss)).sort((p, q) => p - q);
        return {
            n: x.length, mae: Math.round(abs.reduce((p, q) => p + q, 0) / x.length * 1000) / 1000,
            bias: Math.round(x.reduce((p, r) => p + r.miss, 0) / x.length * 1000) / 1000,
            p90: abs[Math.min(abs.length - 1, Math.floor(0.9 * abs.length))]
        };
    };
    const out: ChemSummary = pick(use);
    const acid = use.filter(r => (r.flags || []).includes('acid'));
    const a = pick(acid);
    out.acid = { n: a.n, mae: (a as any).mae };
    return out;
}
