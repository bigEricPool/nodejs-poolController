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

// SWG Assist Model Bench, the models (AutoSwgBench.ts runs them). Pure functions only: no files, no clock, no globals, so they can be unit tested.
//
// The bench lets several FC projection models ("variants") project the FC of each new test from the reading before it, the same way, and scores the
// misses. It never changes the SWG %. Every variant shares one hourly form, summed over the gap between two readings:
//     loss(h) = a x FC(h)/CYA(h) x S(h) / 1000 + b / 24
// S is a sunlight term in W/m2 for the hour: the station's sun, the pool's sun (the station's sun times the sunlit share of the water, after the
// house's eave shadow and the enclosure screen, see poolSunFraction), or the clear-sky pool sun times the recent clearness (what a forecast can know).
// a and b are refitted at each check on the FC intervals of the last fitDays days (ridge least squares). The chlorine made in the gap (the cell, from
// its hourly output log through the 3-hour cycle count, plus any liquid chlorine) is the same for every variant, so only the loss is compared.
// A plain variant is the app's flat average: the consumption since the newest reading at least windowDays old, per day, times the gap.
//
// A miss is the test minus the projection; it equals the projected loss minus the actual loss.

import { ChlorinatorOutputHour } from './ChlorinatorLog';
import { cellUsageForHour, CycleContext } from './ChlorinatorUsage';

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
const DEG = Math.PI / 180;
const MG_PER_LB = 453592.37;
const L_PER_GAL = 3.785411784;

// ---------------------------------------------------------------- sun position

// The sun's declination (rad) and the equation of time (minutes) at a moment (NOAA's fractional-year series, as WeatherHistory.ts uses).
function sunAngles(t: number): { decl: number; eot: number } {
    const d = new Date(t);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / DAY_MS) + 1;
    const g = 2 * Math.PI / 365 * (doy - 1 + (d.getUTCHours() - 12) / 24);
    const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    return { decl: decl, eot: eot };
}

// The sun's altitude above the horizon and its azimuth (clockwise from true north), both in radians, at a moment and place.
export function sunPosition(t: number, lat: number, lon: number): { alt: number; az: number } {
    const { decl, eot } = sunAngles(t);
    const d = new Date(t);
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    const ha = ((minutes + eot + 4 * lon) / 4 - 180) * DEG;
    const phi = lat * DEG;
    const cz = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
    const alt = Math.asin(Math.max(-1, Math.min(1, cz)));
    // measured from south (positive to the west), then turned to be measured from north
    const azS = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi));
    let az = azS + Math.PI;
    if (az >= 2 * Math.PI) az -= 2 * Math.PI;
    return { alt: alt, az: az };
}

// Clear-sky global horizontal radiation (W/m2) at a moment, Haurwitz's formula (as WeatherHistory.clearSkyRadiation).
export function clearSkyRadiation(t: number, lat: number, lon: number): number {
    const s = Math.sin(sunPosition(t, lat, lon).alt);
    return s > 0 ? 1098 * s * Math.exp(-0.057 / s) : 0;
}

// ---------------------------------------------------------------- pool geometry

// The pool, the house edge that shades it and the screen enclosure over it. Distances in feet unless the name says inches.
//   wallFacingDeg   the direction the house's back wall faces (true bearing); the eave's shadow falls from the opposite direction
//   edgeHeightIn    the shading edge (the enclosure's splash panel under the back of the gutter) above the deck
//   deckToWaterIn   the drop from the deck to the water, added to the edge height
//   nearestIn       the pool's nearest point from the line straight below the shading edge (measured)
//   outline         the pool's outline, x along the wall (increasing toward wallFacing + 90), y away from the wall line; it is moved so its nearest
//                   point is nearestIn from the edge line
//   enclosure       the screen cage over the pool: x0 and width along the wall, depth from the edge line; a hip roof with its ridge along the wall
//   pitchDeg        the roof planes' pitch
//   meshOpen        the share of the sun the mesh lets through when the sun meets it straight on
//   frameShade      the share of the beam the cage frame's members shade
//   gridFt          the spacing of the points the sunlit share is counted on
export interface BenchGeometry {
    wallFacingDeg: number; edgeHeightIn: number; deckToWaterIn: number; nearestIn: number;
    outline: [number, number][];
    enclosure: { x0: number; width: number; depth: number };
    pitchDeg: number; meshOpen: number; frameShade: number; gridFt: number;
}

// The survey's kidney outline (feet), the user's measured 32 in, the 118.5 in splash panel, a 48 x 21 ft cage with an 18 x 14 mesh hip roof.
export const DEFAULT_GEOMETRY: BenchGeometry = {
    wallFacingDeg: 9.13, edgeHeightIn: 118.5, deckToWaterIn: 5, nearestIn: 32,
    outline: [[22.5, 19.9], [28.4, 20.5], [34.2, 19.9], [37.8, 20.4], [40.7, 19.9], [42.9, 18.1], [44.1, 15.4], [44.4, 12.4], [43.6, 9.1], [41.7, 6.1], [38.8, 4.5], [36.4, 4.5],
        [33.5, 5.2], [31.0, 4.9], [28.4, 5.7], [25.5, 7.0], [22.5, 7.9], [19.3, 8.2], [17.0, 9.4], [15.3, 11.7], [14.8, 14.4], [15.7, 17.2], [17.9, 19.2], [20.4, 19.9]],
    enclosure: { x0: 5.6, width: 48, depth: 21 },
    pitchDeg: 18, meshOpen: 0.68, frameShade: 0.06, gridFt: 1
};

// Fills in what a stored geometry lacks from the default.
export function normalizeGeometry(raw: any): BenchGeometry {
    const g: any = Object.assign({}, DEFAULT_GEOMETRY);
    if (raw && typeof raw === 'object') {
        for (const k of ['wallFacingDeg', 'edgeHeightIn', 'deckToWaterIn', 'nearestIn', 'pitchDeg', 'meshOpen', 'frameShade', 'gridFt']) {
            const v = Number(raw[k]);
            if (raw[k] !== null && typeof raw[k] !== 'undefined' && isFinite(v)) g[k] = v;
        }
        if (Array.isArray(raw.outline) && raw.outline.length >= 3 && raw.outline.every((p: any) => Array.isArray(p) && isFinite(Number(p[0])) && isFinite(Number(p[1]))))
            g.outline = raw.outline.map((p: any) => [Number(p[0]), Number(p[1])]);
        if (raw.enclosure && typeof raw.enclosure === 'object') {
            const e = raw.enclosure;
            g.enclosure = {
                x0: isFinite(Number(e.x0)) ? Number(e.x0) : DEFAULT_GEOMETRY.enclosure.x0,
                width: Number(e.width) > 0 ? Number(e.width) : DEFAULT_GEOMETRY.enclosure.width,
                depth: Number(e.depth) > 0 ? Number(e.depth) : DEFAULT_GEOMETRY.enclosure.depth
            };
        }
    }
    g.gridFt = Math.max(0.25, Math.min(5, g.gridFt));
    g.meshOpen = Math.max(0, Math.min(1, g.meshOpen));
    g.frameShade = Math.max(0, Math.min(0.9, g.frameShade));
    return g as BenchGeometry;
}

interface GridPoint { y: number; plane: number; }
interface Plane { tilt: number; facing: number; }
const gridCache = new Map<string, { points: GridPoint[]; planes: Plane[] }>();

function insidePolygon(x: number, y: number, p: [number, number][]): boolean {
    let c = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const [x1, y1] = p[i], [x2, y2] = p[j];
        if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c;
    }
    return c;
}

// The points the sunlit share is counted on, each with its distance from the edge line and the roof plane above it (the nearest eave of the hip
// roof: 0 the plane rising from the house, 1 the far plane, 2 the end at small x, 3 the end at large x).
function poolGrid(g: BenchGeometry): { points: GridPoint[]; planes: Plane[] } {
    const key = JSON.stringify(g);
    const hit = gridCache.get(key);
    if (hit) return hit;
    const xs = g.outline.map(p => p[0]), ys = g.outline.map(p => p[1]);
    const shift = Math.min(...ys) - g.nearestIn / 12;
    const points: GridPoint[] = [];
    const e = g.enclosure;
    for (let x = Math.min(...xs) + g.gridFt / 2; x < Math.max(...xs); x += g.gridFt) {
        for (let y = Math.min(...ys) + g.gridFt / 2; y < Math.max(...ys); y += g.gridFt) {
            if (!insidePolygon(x, y, g.outline)) continue;
            const yy = y - shift;
            const d = [yy, e.depth - yy, x - e.x0, e.x0 + e.width - x];
            let plane = 0;
            for (let k = 1; k < 4; k++) if (d[k] < d[plane]) plane = k;
            points.push({ y: yy, plane: plane });
        }
    }
    const w = g.wallFacingDeg * DEG, tilt = g.pitchDeg * DEG;
    // the plane rising from the house faces away from the pool, toward the house; the far plane faces the way the wall does; the ends face along the wall
    const planes: Plane[] = [{ tilt: tilt, facing: w + Math.PI }, { tilt: tilt, facing: w }, { tilt: tilt, facing: w - Math.PI / 2 }, { tilt: tilt, facing: w + Math.PI / 2 }];
    const out = { points: points, planes: planes };
    if (gridCache.size > 8) gridCache.clear();
    gridCache.set(key, out);
    return out;
}

// What an 18 x 14 mesh lets through by the sun's elevation above the mesh plane (degrees), at 0.68 open straight on: the wire's thickness
// closes it up as the sun gets lower (from the 2026-11-07 screen analysis). Scaled for another open share.
const MESH_TABLE: [number, number][] = [[0, 0], [20, 0.40], [37, 0.58], [62, 0.66], [85, 0.68], [90, 0.68]];
export function meshTransmission(elevationDeg: number, open: number = 0.68): number {
    const a = Math.max(0, Math.min(90, elevationDeg));
    for (let i = 1; i < MESH_TABLE.length; i++) {
        const [a1, v1] = MESH_TABLE[i - 1], [a2, v2] = MESH_TABLE[i];
        if (a <= a2) return (v1 + (v2 - v1) * (a - a1) / (a2 - a1)) * open / 0.68;
    }
    return open;
}

// The share of the sun that reaches the water at a moment: `lit` the share of the pool outside the eave's shadow, `screen` the mean mesh
// transmission over the lit points (each under its own roof plane) with the frame's shade, `total` the two together (0 at night).
// The eave's shadow reaches h / tan(altitude) x cos(sun azimuth - (wall facing + 180)) out from the edge line; a point closer than that is shaded.
export function poolSunFraction(t: number, lat: number, lon: number, g: BenchGeometry = DEFAULT_GEOMETRY): { lit: number; screen: number; total: number; alt: number; az: number } {
    const { alt, az } = sunPosition(t, lat, lon);
    if (alt <= 0.01) return { lit: 0, screen: 0, total: 0, alt: alt, az: az };
    const { points, planes } = poolGrid(g);
    if (!points.length) return { lit: 0, screen: 0, total: 0, alt: alt, az: az };
    const h = (g.edgeHeightIn + g.deckToWaterIn) / 12;
    const toward = Math.cos(az - (g.wallFacingDeg * DEG + Math.PI));
    const reach = toward > 0 ? h / Math.tan(alt) * toward : -Infinity;
    const trans = planes.map(p => {
        const cosI = Math.sin(alt) * Math.cos(p.tilt) + Math.cos(alt) * Math.sin(p.tilt) * Math.cos(az - p.facing);
        return meshTransmission(90 - Math.acos(Math.min(1, Math.abs(cosI))) / DEG, g.meshOpen) * (1 - g.frameShade);
    });
    let lit = 0, sum = 0;
    for (const p of points) {
        if (p.y < reach) continue;
        lit++; sum += trans[p.plane];
    }
    return { lit: lit / points.length, screen: lit ? sum / lit : 0, total: sum / points.length, alt: alt, az: az };
}

// The mean of a function over an hour that ends at tEnd, from six samples at its 5-minute marks (5, 15, ... 55 minutes into the hour).
function hourMean(tEnd: number, f: (t: number) => number): number {
    let s = 0;
    for (let k = 0; k < 6; k++) s += f(tEnd - HOUR_MS + (5 + 10 * k) * 60000);
    return s / 6;
}

// ---------------------------------------------------------------- hourly inputs

export interface BenchWeatherHour { t: number; lt?: string; solarRad?: number; solarRadMean?: number; clearness?: number; clearnessMean?: number; precipTotal?: number; temp?: number; }
export interface BenchTempHour { t: number; v: number; }           // the start of the hour, the mean water temperature while the pump ran
export interface BenchPumpHour { t: number; seconds: number; }     // the start of the hour, the seconds the pump ran
export interface BenchSwgEntry { ts: number; ppmPerDay: number; hrs: number; pct: number; }

// What buildHourlyInputs reads. Every list is oldest first; any can be empty (the rows then say the input is missing).
export interface BenchSources {
    lat?: number; lon?: number;
    gallons: number;
    cellLbsPerDay: number;
    outputHours: ChlorinatorOutputHour[];      // the chlorinator's hourly output log
    cycle?: CycleContext;                     // the cycle count's context, when the cell is counted by its cycles
    swgEntries: BenchSwgEntry[];               // before the output log: the SWG history (credited ppm a day over `hrs` hours around midday)
    chlorine: { ts: number; ppm: number }[];   // liquid chlorine added
    weather: BenchWeatherHour[];
    waterTemp: BenchTempHour[];
    pump: BenchPumpHour[];
    salt: { t: number; ppm: number }[];
}

// One hour of inputs. `t` is the END of the hour (as the weather log keys its hours). Sunlight is W/m2, the hour's mean.
export interface BenchHour {
    t: number;
    gen: number;            // ppm of FC made in the hour (cell and liquid chlorine)
    genFrom: 'log' | 'swg' | 'none';
    sun?: number;           // the station's sun: the mean of its five-minute readings where there are any, else the hour's high
    sunHigh?: number;       // the hour's high
    frac: number;           // the share of the sun that reaches the water (see poolSunFraction)
    clear: number;          // clear-sky sun at the station
    clearness?: number;
    rain?: number;          // inches
    temp?: number;          // water temperature
    pumpSec?: number;
    salt?: number;
}

// Liquid chlorine: ppm that `ml` of a `percent` solution adds to `gallons`.
export function chlorinePpm(percent: number, ml: number, gallons: number): number {
    return gallons > 0 ? (percent / 100) * 1e6 * ml / (gallons * 3785.411784) : 0;
}

// ppm of FC that `pounds` of chlorine make in `gallons`.
export function poundsToPpm(pounds: number, gallons: number): number { return gallons > 0 ? pounds * MG_PER_LB / (gallons * L_PER_GAL) : 0; }

// The hours that end after `from` and at or before `to`, oldest first. The geometry decides the share of the sun on the water, the place the sun.
export function buildHourlyInputs(src: BenchSources, from: number, to: number, geometry: BenchGeometry = DEFAULT_GEOMETRY): BenchHour[] {
    const first = Math.floor(from / HOUR_MS) * HOUR_MS + HOUR_MS, last = Math.floor(to / HOUR_MS) * HOUR_MS;
    const rows: BenchHour[] = [];
    const index = new Map<number, BenchHour>();
    const hasPlace = typeof src.lat === 'number' && typeof src.lon === 'number' && isFinite(src.lat) && isFinite(src.lon);
    for (let t = first; t <= last; t += HOUR_MS) {
        const r: BenchHour = { t: t, gen: 0, genFrom: 'none', frac: 0, clear: 0 };
        if (hasPlace) {
            r.frac = hourMean(t, x => poolSunFraction(x, src.lat, src.lon, geometry).total);
            r.clear = hourMean(t, x => clearSkyRadiation(x, src.lat, src.lon));
        }
        rows.push(r); index.set(t, r);
    }
    // the cell: each logged hour (keyed by its start) through the cycle count; the hours before the log from the SWG entries
    let logStart = Infinity;
    for (const h of src.outputHours || []) {
        const start = new Date(h.t).getTime();
        if (!isFinite(start)) continue;
        logStart = Math.min(logStart, start);
        const r = index.get(start + HOUR_MS);
        if (!r) continue;
        const u = cellUsageForHour(h, src.cellLbsPerDay, src.cycle);
        r.gen += poundsToPpm(u.pounds, src.gallons);
        r.genFrom = 'log';
    }
    const entries = (src.swgEntries || []).filter(e => e && isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
    if (entries.length) {
        let k = 0;
        for (const r of rows) {
            if (r.t - HOUR_MS >= logStart) continue;
            // the entry in force at the middle of the hour, its ppm a day spread over its run hours, centred on 12:10 local time
            const mid = r.t - HOUR_MS / 2;
            while (k + 1 < entries.length && entries[k + 1].ts <= mid) k++;
            const e = entries[k];
            if (e.ts > mid || !(e.hrs > 0)) continue;
            const d = new Date(r.t - HOUR_MS);
            const startMin = d.getHours() * 60 + d.getMinutes();
            const lo = 12 * 60 + 10 - e.hrs * 30, hi = 12 * 60 + 10 + e.hrs * 30;
            const overlap = Math.max(0, Math.min(startMin + 60, hi) - Math.max(startMin, lo)) / 60;
            r.gen += e.ppmPerDay / e.hrs * overlap;
            r.genFrom = 'swg';
        }
    }
    for (const c of src.chlorine || []) {
        const r = index.get(Math.ceil(c.ts / HOUR_MS) * HOUR_MS);
        if (r) r.gen += c.ppm;
    }
    // weather: the hour's sun and clearness, and the rain from the day's running total (it starts again at the station's local midnight)
    let prevDay: string | undefined, prevTotal = 0;
    for (const w of (src.weather || []).slice().sort((a, b) => a.t - b.t)) {
        const r = index.get(Math.round(w.t / HOUR_MS) * HOUR_MS);
        const day = typeof w.lt === 'string' ? w.lt.slice(0, 10) : new Date(w.t - 1).toDateString();
        if (typeof w.precipTotal === 'number') {
            const rain = day === prevDay ? Math.max(0, w.precipTotal - prevTotal) : w.precipTotal;
            prevDay = day; prevTotal = w.precipTotal;
            if (r) r.rain = rain;
        }
        if (!r) continue;
        if (typeof w.solarRad === 'number') r.sunHigh = w.solarRad;
        const mean = typeof w.solarRadMean === 'number' ? w.solarRadMean : w.solarRad;
        if (typeof mean === 'number') r.sun = mean;
        const cl = typeof w.clearnessMean === 'number' ? w.clearnessMean : w.clearness;
        if (typeof cl === 'number') r.clearness = cl;
    }
    for (const x of src.waterTemp || []) { const r = index.get(Math.floor(x.t / HOUR_MS) * HOUR_MS + HOUR_MS); if (r && typeof x.v === 'number') r.temp = x.v; }
    for (const x of src.pump || []) { const r = index.get(Math.floor(x.t / HOUR_MS) * HOUR_MS + HOUR_MS); if (r) r.pumpSec = (r.pumpSec || 0) + x.seconds; }
    let si = 0;
    const salt = (src.salt || []).slice().sort((a, b) => a.t - b.t);
    for (const r of rows) {
        while (si + 1 < salt.length && salt[si + 1].t <= r.t) si++;
        if (salt.length && salt[si].t <= r.t) r.salt = salt[si].ppm;
    }
    return rows;
}

// How much of a span the hourly inputs cover: the share of hours with sun, generation from the log, water temperature and pump time.
export function inputCoverage(rows: BenchHour[], from: number, to: number): { hours: number; sun: number; genLog: number; genAny: number; temp: number; pump: number } {
    const sel = rows.filter(r => r.t > from && r.t <= to);
    const n = sel.length || 1;
    return {
        hours: sel.length,
        sun: sel.filter(r => typeof r.sun === 'number').length / n,
        genLog: sel.filter(r => r.genFrom === 'log').length / n,
        genAny: sel.filter(r => r.genFrom !== 'none').length / n,
        temp: sel.filter(r => typeof r.temp === 'number').length / n,
        pump: sel.filter(r => typeof r.pumpSec === 'number').length / n
    };
}

// ---------------------------------------------------------------- readings and intervals

export interface FcReading { t: number; fc: number; }
// Two consecutive FC readings and the chlorine made and added between them (ppm).
export interface Interval { t1: number; f1: number; t2: number; f2: number; gen: number; }
export function consumption(iv: Interval): number { return iv.gen - (iv.f2 - iv.f1); }
export function gapDays(iv: { t1: number; t2: number }): number { return (iv.t2 - iv.t1) / DAY_MS; }

// The index of the first row that ends after t (rows are oldest first).
export function firstRowAfter(rows: { t: number }[], t: number): number {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t <= t) lo = m + 1; else hi = m; }
    return lo;
}

// The chlorine the rows say was made between two moments; the hours at either end count for the part of them inside.
export function generationBetween(rows: BenchHour[], t1: number, t2: number): number {
    let g = 0;
    for (let i = firstRowAfter(rows, t1); i < rows.length && rows[i].t - HOUR_MS < t2; i++) {
        const r = rows[i];
        const part = (Math.min(r.t, t2) - Math.max(r.t - HOUR_MS, t1)) / HOUR_MS;
        if (part > 0) g += r.gen * part;
    }
    return g;
}

// Consecutive readings as intervals, with the chlorine from the rows (or from `gen`, when it is given for each pair).
export function intervalsFrom(readings: FcReading[], rows: BenchHour[]): Interval[] {
    const out: Interval[] = [];
    for (let k = 0; k + 1 < readings.length; k++) {
        const a = readings[k], b = readings[k + 1];
        if (!(b.t > a.t)) continue;
        out.push({ t1: a.t, f1: a.fc, t2: b.t, f2: b.fc, gen: generationBetween(rows, a.t, b.t) });
    }
    return out;
}

// ---------------------------------------------------------------- CYA

export interface CyaTest { t: number; ppm: number; }
// The CYA of an hour as known at `asOf`, held at the last test (the full path with rain, salt and additions is AutoSwgBenchCya.ts):
// the newest test at or before the hour among those known at asOf, or the first known one for an hour before every test. Floored at 10.
export function heldCya(tests: CyaTest[], asOf: number): (t: number) => number {
    const known = tests.filter(c => c.t <= asOf && c.ppm > 0).sort((a, b) => a.t - b.t);
    return (t: number) => {
        if (!known.length) return 70;
        let v = known[0].ppm;
        for (const c of known) { if (c.t <= t) v = c.ppm; else break; }
        return Math.max(v, 10);
    };
}

// Where a variant's CYA comes from: the tests alone (held at the last one), or the tests and a path between them (AutoSwgBenchCya.ts) as known at a
// moment. A plain list of tests is the held CYA. A variant uses the path only when it asks for it (cya 'path') and one is given.
export interface CyaSource { tests: CyaTest[]; path?: (asOf: number) => (t: number) => number; }
export type CyaInput = CyaTest[] | CyaSource;
export function cyaFor(v: BenchVariant, src: CyaInput, asOf: number): (t: number) => number {
    if (Array.isArray(src)) return heldCya(src, asOf);
    if (v.cya === 'path' && src.path) return src.path(asOf);
    return heldCya(src.tests || [], asOf);
}

// ---------------------------------------------------------------- variants

export type BenchSunTerm = 'none' | 'station' | 'pool' | 'poolHourHigh' | 'clearPool';
export interface BenchVariant {
    id: string;                 // stable name; an edit keeps the id and makes a new version
    version: number;
    label?: string;
    retired?: boolean;
    kind: 'live' | 'plain' | 'model';
    windowDays?: number;        // plain: the averaging window (days)
    fitDays?: number;           // model: the FC intervals of the last fitDays days are fitted (30)
    ridge?: number;             // model: ridge strength (0.5)
    minIntervals?: number;      // model: fewer intervals than this and the variant uses the 14-day plain average (5)
    minGapDays?: number;        // intervals shorter than this are not fitted or scored (0.3)
    sun?: BenchSunTerm;         // model: the sunlight term (pool)
    fcTerm?: 'fcCya' | 'fc';    // model: FC/CYA or FC alone (fcCya)
    fcPath?: 'held' | 'model';  // model: inside the gap FC is held at the start reading, or follows the model itself (model)
    cya?: 'held' | 'path';      // model: CYA held at the last test (held, also when not set) or the full path between tests (path)
    temp?: boolean;             // model: the sun term times exp(c x (T - 80 F)), T the water temperature, c fitted from TEMP_C_GRID
    rainWash?: boolean;         // model: plus b2 x the rain in inches (a wash-in demand), b2 fitted
}

export const DEFAULT_VARIANTS: BenchVariant[] = [
    { id: 'live', version: 1, kind: 'live', label: 'SWG Assist projection (live)' },
    { id: 'plain14', version: 1, kind: 'plain', windowDays: 14, label: '14-day average' },
    { id: 'plain7', version: 1, kind: 'plain', windowDays: 7, label: '7-day average' },
    // version 2 of the models: the CYA path between tests (version 1 held CYA at the last test; sun-cya-30-heldCYA keeps that one going)
    { id: 'sun-cya-30', version: 2, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, fcPath: 'model', cya: 'path', label: 'Pool sun x FC/CYA, 30-day fit' },
    { id: 'sun-cya-30-heldCYA', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, fcPath: 'model', cya: 'held', label: 'Pool sun x FC/CYA, CYA held at the last test' },
    { id: 'sun-cya-30-station', version: 2, kind: 'model', sun: 'station', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, fcPath: 'model', cya: 'path', label: 'Station sun x FC/CYA, 30-day fit' },
    { id: 'sun-cya-30-hourHigh', version: 2, kind: 'model', sun: 'poolHourHigh', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, fcPath: 'model', cya: 'path', label: 'Pool sun (hour highs) x FC/CYA, 30-day fit' },
    { id: 'sun-cya-30-temp', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, fcPath: 'model', cya: 'path', temp: true, label: 'Pool sun x FC/CYA x water temperature, 30-day fit' },
    { id: 'sun-cya-30-rainwash', version: 1, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 30, ridge: 0.5, fcPath: 'model', cya: 'path', rainWash: true, label: 'Pool sun x FC/CYA plus rain wash-in, 30-day fit' },
    { id: 'sun-cya-14', version: 2, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 14, ridge: 0.5, fcPath: 'model', cya: 'path', label: 'Pool sun x FC/CYA, 14-day fit' },
    { id: 'sun-cya-45', version: 2, kind: 'model', sun: 'pool', fcTerm: 'fcCya', fitDays: 45, ridge: 0.5, fcPath: 'model', cya: 'path', label: 'Pool sun x FC/CYA, 45-day fit' },
];

// The sunlight term of an hour (W/m2) for a variant; undefined when the hour lacks the input. `clearness` is the recent clearness a forecast uses.
export function sunTerm(r: BenchHour, term: BenchSunTerm, forecastClearness?: number): number | undefined {
    if (term === 'none') return 0;
    if (typeof forecastClearness === 'number') {
        // what a forecast can know: the clear sky times the recent clearness (on the water for the pool terms)
        const s = r.clear * forecastClearness;
        return term === 'station' ? s : s * r.frac;
    }
    switch (term) {
        case 'station': return r.sun;
        case 'pool': return typeof r.sun === 'number' ? r.sun * r.frac : undefined;
        case 'poolHourHigh': return typeof r.sunHigh === 'number' ? r.sunHigh * r.frac : undefined;
        case 'clearPool': return r.clear * r.frac * (typeof r.clearness === 'number' ? Math.min(1.2, r.clearness) : 1);
    }
    return undefined;
}

// The clearness of the last `days` days before asOf: the station's sun over the clear-sky sun, over the daylight hours that have both.
export function recentClearness(rows: BenchHour[], asOf: number, days: number = 7): number | undefined {
    let s = 0, c = 0;
    for (let i = firstRowAfter(rows, asOf - days * DAY_MS); i < rows.length && rows[i].t <= asOf; i++) {
        const r = rows[i];
        if (typeof r.sun !== 'number' || !(r.clear > 20)) continue;
        s += r.sun; c += r.clear;
    }
    return c > 0 ? s / c : undefined;
}

// c: the temperature factor's coefficient (per F) when the variant has one; b2: the rain wash-in (ppm per inch) when it has one.
export interface Fit { a: number; b: number; n: number; c?: number; b2?: number; fallback?: 'plain14'; plainRate?: number; }

// The water temperature the temperature factor is taken around (F), and the coefficients the fit tries (per F).
export const TEMP_REF_F = 80;
export const TEMP_C_GRID = [-0.02, 0, 0.02, 0.04, 0.06, 0.08, 0.1];
// The water temperature of row i: its own, or the newest one in the 72 hours before it; undefined when there is none.
export function rowTemp(rows: BenchHour[], i: number): number | undefined {
    for (let j = Math.min(i, rows.length - 1); j >= 0 && j > i - 72; j--) if (typeof rows[j].temp === 'number') return rows[j].temp;
    return undefined;
}
function tempFactor(rows: BenchHour[], i: number, c: number | undefined, heldTemp?: number): number {
    if (!c) return 1;
    const T = typeof heldTemp === 'number' ? heldTemp : rowTemp(rows, i);
    return typeof T === 'number' ? Math.exp(c * (T - TEMP_REF_F)) : 1;
}
// The rain (inches) of the hours that end in (t1, t2].
export function rainBetween(rows: BenchHour[], t1: number, t2: number): number {
    let s = 0;
    for (let i = firstRowAfter(rows, t1); i < rows.length && rows[i].t <= t2; i++) if (typeof rows[i].rain === 'number') s += rows[i].rain;
    return s;
}

// The sun feature of a span: the sum over its hours of FC/CYA x S / 1000 (times the temperature factor with `c`), with FC from `fcAt`. Undefined when
// an hour in sunlight lacks the input. A forecast holds the water temperature at `heldTemp`.
export function sunFeature(v: BenchVariant, rows: BenchHour[], t1: number, t2: number, cya: (t: number) => number, fcAt: (t: number) => number, forecastClearness?: number, c?: number, heldTemp?: number): number | undefined {
    const term = v.sun || 'pool';
    let s = 0;
    for (let i = firstRowAfter(rows, t1); i < rows.length && rows[i].t <= t2; i++) {
        const r = rows[i];
        const sun = sunTerm(r, term, forecastClearness);
        if (typeof sun !== 'number') {
            if (r.clear > 20) return undefined;
            continue;
        }
        const f = Math.max(fcAt(r.t), 0.5);
        s += (v.fcTerm === 'fc' ? f : f / cya(r.t)) * sun / 1000 * tempFactor(rows, i, c, heldTemp);
    }
    return s;
}

// Ridge least squares without an intercept: minimizes |Xw - y|^2 + ridge |w|^2.
export function ridgeSolve(X: number[][], y: number[], ridge: number): number[] {
    const n = X.length ? X[0].length : 0;
    const A: number[][] = [], v: number[] = [];
    for (let a = 0; a < n; a++) {
        A.push([]);
        for (let b = 0; b < n; b++) { let s = a === b ? ridge : 0; for (const r of X) s += r[a] * r[b]; A[a].push(s); }
        let s = 0; for (let k = 0; k < X.length; k++) s += X[k][a] * y[k]; v.push(s);
    }
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        [A[c], A[p]] = [A[p], A[c]]; [v[c], v[p]] = [v[p], v[c]];
        for (let r = 0; r < n; r++) {
            if (r === c || !A[c][c]) continue;
            const m = A[r][c] / A[c][c];
            for (let k = 0; k < n; k++) A[r][k] -= m * A[c][k];
            v[r] -= m * v[c];
        }
    }
    return v.map((x, c) => A[c][c] ? x / A[c][c] : 0);
}

// The app's flat average as of `asOf`: the consumption since the newest reading at least `windowDays` old (or the oldest there is), per day.
// `intervals` are every consecutive pair of readings, oldest first; only those that end at or before asOf count.
export function plainRate(intervals: Interval[], asOf: number, windowDays: number): number | undefined {
    const known = intervals.filter(iv => iv.t2 <= asOf);
    if (!known.length) return undefined;
    const last = known[known.length - 1].t2;
    let j = known.length - 1;
    while (j > 0 && known[j].t1 > last - windowDays * DAY_MS) j--;
    const span = (last - known[j].t1) / DAY_MS;
    if (!(span > 0)) return undefined;
    let c = 0;
    for (let k = j; k < known.length; k++) c += consumption(known[k]);
    return c / span;
}

// Fits a model variant as of `asOf` on the intervals that lie within its last fitDays days (FC linear between the two readings of each).
// Fewer than minIntervals usable intervals: the fit falls back to the 14-day plain average. With the temperature factor every c of TEMP_C_GRID is
// fitted and the one with the smallest squared error is kept; with the rain wash-in the rain of each interval is a third column.
// `skip` leaves intervals out of the fit (the bench's flagged ones: a long gap or thin inputs); the plain fallback still sees every interval.
export function fitVariant(v: BenchVariant, intervals: Interval[], rows: BenchHour[], cyaTests: CyaInput, asOf: number, skip?: (iv: Interval) => boolean): Fit | undefined {
    const L = (v.fitDays || 30) * DAY_MS, minGap = (typeof v.minGapDays === 'number' ? v.minGapDays : 0.3) * DAY_MS;
    const cya = cyaFor(v, cyaTests, asOf);
    const usable = intervals.filter(iv => !(iv.t2 > asOf || iv.t1 < asOf - L || iv.t2 - iv.t1 <= minGap) && !(skip && skip(iv)));
    const ridge = typeof v.ridge === 'number' ? v.ridge : 0.5;
    let best: { w: number[]; c: number; n: number; sse: number } | undefined, nUsed = 0;
    for (const c of v.temp ? TEMP_C_GRID : [0]) {
        const X: number[][] = [], y: number[] = [];
        for (const iv of usable) {
            const s = sunFeature(v, rows, iv.t1, iv.t2, cya, t => iv.f1 + (iv.f2 - iv.f1) * (t - iv.t1) / (iv.t2 - iv.t1), undefined, c);
            if (typeof s !== 'number') continue;
            const x = [s, gapDays(iv)];
            if (v.rainWash) x.push(rainBetween(rows, iv.t1, iv.t2));
            X.push(x); y.push(consumption(iv));
        }
        nUsed = X.length;
        if (X.length < (v.minIntervals || 5)) { best = undefined; break; }
        const w = ridgeSolve(X, y, ridge);
        let sse = 0;
        for (let k = 0; k < X.length; k++) { let p = 0; for (let j = 0; j < w.length; j++) p += X[k][j] * w[j]; sse += (y[k] - p) * (y[k] - p); }
        if (!best || sse < best.sse - 1e-9) best = { w: w, c: c, n: X.length, sse: sse };
    }
    if (!best) {
        const r = plainRate(intervals, asOf, 14);
        return typeof r === 'number' ? { a: 0, b: r, n: nUsed, fallback: 'plain14', plainRate: r } : undefined;
    }
    const fit: Fit = { a: best.w[0], b: best.w[1], n: best.n };
    if (v.temp) fit.c = best.c;
    if (v.rainWash) fit.b2 = best.w[2];
    return fit;
}

// The loss a variant projects from a reading (t1, f1) to t2 with a fit. With fcPath 'model' FC inside the gap follows the projection itself (the
// generation from the rows less the projected loss, hour by hour); with 'held' it stays at f1. `forecastClearness` makes it a forecast.
// A forecast (forecastClearness given) holds the water temperature at the last one known at asOf and expects no rain.
export function projectLoss(v: BenchVariant, fit: Fit, rows: BenchHour[], cyaTests: CyaInput, asOf: number, t1: number, f1: number, t2: number, forecastClearness?: number): number | undefined {
    const days = (t2 - t1) / DAY_MS;
    if (fit.fallback === 'plain14') return fit.b * days;
    const cya = cyaFor(v, cyaTests, asOf);
    const forecast = typeof forecastClearness === 'number';
    const heldTemp = forecast && fit.c ? rowTemp(rows, firstRowAfter(rows, asOf) - 1) : undefined;
    const b2 = typeof fit.b2 === 'number' && !forecast ? fit.b2 : 0;
    if (v.fcPath === 'held') {
        const s = sunFeature(v, rows, t1, t2, cya, () => f1, forecastClearness, fit.c, heldTemp);
        return typeof s === 'number' ? fit.a * s + fit.b * days + b2 * rainBetween(rows, t1, t2) : undefined;
    }
    let fc = f1, loss = 0, t = t1;
    const term = v.sun || 'pool';
    for (let i = firstRowAfter(rows, t1); i < rows.length && rows[i].t - HOUR_MS < t2; i++) {
        const r = rows[i];
        const end = Math.min(r.t, t2);
        const part = (end - Math.max(r.t - HOUR_MS, t1)) / HOUR_MS;
        if (!(part > 0)) continue;
        // the sun counts for whole hours that end inside the gap, as in the fit
        let sunLoss = 0;
        if (r.t <= t2) {
            const sun = sunTerm(r, term, forecastClearness);
            if (typeof sun !== 'number') { if (r.clear > 20) return undefined; }
            else sunLoss = fit.a * (v.fcTerm === 'fc' ? Math.max(fc, 0.5) : Math.max(fc, 0.5) / cya(r.t)) * sun / 1000 * tempFactor(rows, i, fit.c, heldTemp);
            if (b2 && typeof r.rain === 'number') sunLoss += b2 * r.rain;
        }
        const step = sunLoss + fit.b * part / 24;
        loss += step;
        fc = Math.max(0, fc + r.gen * part - step);
        t = end;
    }
    // a gap that runs past the rows: the steady part only
    if (t < t2) loss += fit.b * (t2 - t) / DAY_MS;
    return loss;
}

// ---------------------------------------------------------------- replay (as the 2026-11-13 offline run did it)

export interface ReplayRow { t1: number; t2: number; days: number; f1: number; test: number; proj: number; actual: number; miss: number; fit?: Fit; }

// Scores a variant on every interval of `intervals` (consecutive readings) that starts in [from, to): it is fitted as of the start reading and projects
// the loss to the next one (nowcast, from the rows' weather). Plain variants use their window. Live variants are not replayed here.
export function replayVariant(v: BenchVariant, intervals: Interval[], rows: BenchHour[], cyaTests: CyaInput, from: number, to: number, firstFitFrom: number = -Infinity): ReplayRow[] {
    const out: ReplayRow[] = [];
    const minGap = (typeof v.minGapDays === 'number' ? v.minGapDays : 0.3) * DAY_MS;
    for (const iv of intervals) {
        if (iv.t1 < from || iv.t1 >= to || iv.t2 - iv.t1 <= minGap || iv.t1 <= firstFitFrom) continue;
        let proj: number | undefined, fit: Fit | undefined;
        if (v.kind === 'plain') {
            const r = plainRate(intervals, iv.t1, v.windowDays || 14);
            if (typeof r === 'number') proj = r * gapDays(iv);
        }
        else if (v.kind === 'model') {
            fit = fitVariant(v, intervals.filter(x => x.t1 >= firstFitFrom), rows, cyaTests, iv.t1);
            if (fit) proj = projectLoss(v, fit, rows, cyaTests, iv.t1, iv.t1, iv.f1, iv.t2);
        }
        if (typeof proj !== 'number') continue;
        const actual = consumption(iv);
        out.push({ t1: iv.t1, t2: iv.t2, days: gapDays(iv), f1: iv.f1, test: iv.f2, proj: iv.f1 + iv.gen - proj, actual: actual, miss: proj - actual, fit: fit });
    }
    return out;
}

// ---------------------------------------------------------------- statistics

// A small seeded random generator (mulberry32), so bootstraps and simulations repeat exactly.
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The p quantile with linear interpolation between the sorted values.
export function quantile(xs: number[], p: number): number {
    if (!xs.length) return NaN;
    const s = xs.slice().sort((a, b) => a - b);
    const k = (s.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
    return s[f] + (s[c] - s[f]) * (k - f);
}

// ---------------------------------------------------------------- pairs the bench cannot score fairly
//
// The same rule for the live projection and every challenger, live and replay. A flagged pair stays in the scores file and on the page (its `flags`), but
// is left out of the headline figures and the paired difference against live, and counted apart:
//   longGap      the gap is longer than maxGapDays
//   thinInputs   under minCoverage of its hours have every input (generation, pump time, sun) whose log had begun by then
//   implausible  the projection is below zero, or above the start reading plus the chlorine credited over the gap (a negative burn)
// Long-gap and thin-input intervals are also left out of the model fits (judged on the inputs, never on the miss). A gap band's half-width and MAE are
// shown only from minGapN pairs on; below that only its count.
export interface ScoringSettings { maxGapDays: number; minCoverage: number; minGapN: number; }
export const DEFAULT_SCORING: ScoringSettings = { maxGapDays: 10, minCoverage: 0.9, minGapN: 8 };
export function normalizeScoring(raw: any): ScoringSettings {
    const s: ScoringSettings = Object.assign({}, DEFAULT_SCORING);
    if (!raw || typeof raw !== 'object') return s;
    const num = (k: keyof ScoringSettings, lo: number, hi: number) => { const x = Number(raw[k]); if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '' && isFinite(x)) s[k] = Math.max(lo, Math.min(hi, x)); };
    num('maxGapDays', 1, 60); num('minCoverage', 0, 1); num('minGapN', 1, 100);
    s.minGapN = Math.round(s.minGapN);
    return s;
}
export type ScoreFlag = 'longGap' | 'thinInputs' | 'implausible';
// When each input's log begins in the rows: the first hour with generation, pump time and sun. An hour before an input's log began does not count
// against the coverage (a pair is thin when its logs have holes, not because a log is newer than the pair).
export interface InputStarts { gen?: number; pump?: number; sun?: number; }
export function inputStarts(rows: BenchHour[]): InputStarts {
    const s: InputStarts = {};
    for (const r of rows) {
        if (s.gen === undefined && r.genFrom !== 'none') s.gen = r.t;
        if (s.pump === undefined && typeof r.pumpSec === 'number') s.pump = r.t;
        if (s.sun === undefined && typeof r.sun === 'number') s.sun = r.t;
        if (s.gen !== undefined && s.pump !== undefined && s.sun !== undefined) break;
    }
    return s;
}
// The share of the hours that end in (t1, t2] with every input whose log had begun (a dark hour needs no sun). No hours: 0.
export function spanCoverage(rows: BenchHour[], t1: number, t2: number, starts: InputStarts): number {
    let n = 0, ok = 0;
    for (let i = firstRowAfter(rows, t1); i < rows.length && rows[i].t <= t2; i++) {
        const r = rows[i];
        n++;
        const gen = starts.gen === undefined || r.t < starts.gen || r.genFrom !== 'none';
        const pump = starts.pump === undefined || r.t < starts.pump || typeof r.pumpSec === 'number';
        const sun = starts.sun === undefined || r.t < starts.sun || typeof r.sun === 'number' || !(r.clear > 20);
        if (gen && pump && sun) ok++;
    }
    return n ? ok / n : 0;
}
// The flags of a scored pair: `gen` is the chlorine credited over the gap, `cov` its input coverage (either may be missing on older rows).
export function scoreFlags(r: { days: number; proj: number; f1: number; gen?: number; cov?: number }, s: ScoringSettings): ScoreFlag[] {
    const f: ScoreFlag[] = [];
    if (r.days > s.maxGapDays) f.push('longGap');
    if (typeof r.cov === 'number' && r.cov < s.minCoverage) f.push('thinInputs');
    if (r.proj < 0 || (typeof r.gen === 'number' && r.proj > r.f1 + r.gen + 1e-6)) f.push('implausible');
    return f;
}

export interface GapStats { label: string; n: number; flagged?: number; halfWidth90?: number; mae?: number; note?: string; }
export interface ScoreStats {
    n: number; mae?: number; bias?: number; halfWidth90?: number; p5?: number; p95?: number;
    byGap: GapStats[];
    nAll?: number;                                                              // with the flagged pairs
    excluded?: { longGap: number; thinInputs: number; implausible: number };   // a pair with two flags counts in both
}
export const GAP_BANDS: [string, number, number][] = [['under 2 d', 0, 2], ['2-4 d', 2, 4], ['4-7 d', 4, 7], ['7 d or more', 7, Infinity]];

// The summary of a set of misses (test minus projection): n, mean absolute miss, bias, the 90% half-width of |miss| (the "next test will read X to Y"
// band), the 5% and 95% points, and the same by gap length. With `flagsOf` the flagged pairs are left out and counted apart; a gap band shows its
// half-width and MAE only from `minGapN` pairs on.
export function scoreSummary<T extends { miss: number; days: number }>(all: T[], opts: { flagsOf?: (r: T) => ScoreFlag[]; minGapN?: number } = {}): ScoreStats {
    const flags = all.map(r => opts.flagsOf ? opts.flagsOf(r) : []);
    const rows = all.filter((r, k) => !flags[k].length);
    const m = rows.map(r => r.miss);
    const out: ScoreStats = { n: rows.length, byGap: [] };
    if (opts.flagsOf) {
        out.nAll = all.length;
        out.excluded = { longGap: 0, thinInputs: 0, implausible: 0 };
        for (const f of flags) for (const x of f) out.excluded[x]++;
    }
    if (rows.length) {
        out.mae = m.reduce((s, x) => s + Math.abs(x), 0) / m.length;
        out.bias = m.reduce((s, x) => s + x, 0) / m.length;
        out.halfWidth90 = quantile(m.map(Math.abs), 0.9);
        out.p5 = quantile(m, 0.05); out.p95 = quantile(m, 0.95);
    }
    const minN = Math.max(1, opts.minGapN || 1);
    for (const [label, lo, hi] of GAP_BANDS) {
        const sel = rows.filter(r => r.days >= lo && r.days < hi);
        const g: GapStats = { label: label, n: sel.length };
        if (opts.flagsOf) g.flagged = all.filter((r, k) => flags[k].length && r.days >= lo && r.days < hi).length;
        if (sel.length >= minN) {
            g.halfWidth90 = quantile(sel.map(r => Math.abs(r.miss)), 0.9);
            g.mae = sel.reduce((s, r) => s + Math.abs(r.miss), 0) / sel.length;
        }
        else if (sel.length) g.note = `only ${sel.length} pair${sel.length === 1 ? '' : 's'}; the band needs ${minN}`;
        out.byGap.push(g);
    }
    return out;
}

// The paired difference in absolute miss of a variant against a reference on the same tests (negative: the variant misses less), its standard error,
// and the bootstrap share of resamples in which the variant is better (fixed seed).
export function pairedDifference(variant: number[], reference: number[], resamples: number = 2000, seed: number = 3): { n: number; meanDiff?: number; se?: number; pBetter?: number } {
    const n = Math.min(variant.length, reference.length);
    if (n < 2) return { n: n };
    const d: number[] = [];
    for (let k = 0; k < n; k++) d.push(Math.abs(variant[k]) - Math.abs(reference[k]));
    const mean = d.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1));
    const rnd = seededRandom(seed);
    let better = 0;
    for (let b = 0; b < resamples; b++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += d[Math.floor(rnd() * n)];
        if (s < 0) better++;
    }
    return { n: n, meanDiff: mean, se: sd / Math.sqrt(n), pBetter: better / resamples };
}
