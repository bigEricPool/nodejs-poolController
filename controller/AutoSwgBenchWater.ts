// SWG Assist Model Bench: the pool's water level and what it does to concentrations (pure, no njsPC state, except the local water log at the end).
//
// The pool is followed as a volume, in inches of depth over its surface (the mean depth is gallons / area):
//   rain          adds fresh water: every concentration (FC, CYA, salt, TA, CH, borates) falls by depth / (depth + inches)
//   evaporation   takes water only: every concentration rises by depth / (depth - inches)
//   water added   (the local water log, a hose or a fill) adds fresh water like rain
//   water removed (the local water log, pumped out) takes water at the pool's concentration: the level falls, no concentration changes
//   spill         above spillInches over the normal level (the deck), the extra goes over the edge mixed: the level is held, no concentration changes
// So only rain, evaporation and added water change a concentration; removing water and spilling change the level, which is what a trip needs to know.
// Water removed and not logged leaves the level reading high (and spill early), but the concentrations stay right.
//
// Evaporation: Smith, Lof and Jones (1994), measured on an outdoor pool, E = (0.089 + 0.0782 V)(Pw - Pa) / Y in kg/(m2 s), V the wind (m/s),
// Pw the vapour pressure at the water temperature, Pa the air's (kPa, from its temperature and humidity), Y = 2450 kJ/kg; times evapScale.

import * as fs from 'fs';
import * as path from 'path';

const HOUR_MS = 3600000, DAY_MS = 24 * HOUR_MS;
const GAL_PER_FT3 = 7.48052;

// The hour's inputs the balance reads (a BenchHour has them; `t` is the end of the hour).
export interface WaterHour { t: number; rain?: number; temp?: number; air?: number; rh?: number; wind?: number; }
export interface WaterEvent { id?: string; t: number; kind: 'add' | 'remove'; inches: number; note?: string; }
export interface WaterSettings {
    evapScale: number;          // times the evaporation formula (1; 0 turns evaporation off)
    spillInches?: number;       // inches above the normal level where water goes over the edge (not set: the geometry's deck-to-water)
}
export const DEFAULT_WATER_SETTINGS: WaterSettings = { evapScale: 1 };
export function normalizeWaterSettings(raw: any): WaterSettings {
    const s: WaterSettings = { evapScale: DEFAULT_WATER_SETTINGS.evapScale };
    if (raw && raw.evapScale !== undefined && raw.evapScale !== null && raw.evapScale !== '' && isFinite(Number(raw.evapScale))) s.evapScale = Math.max(0, Math.min(3, Number(raw.evapScale)));
    if (raw && raw.spillInches !== undefined && raw.spillInches !== null && raw.spillInches !== '' && isFinite(Number(raw.spillInches))) s.spillInches = Math.max(0, Math.min(36, Number(raw.spillInches)));
    return s;
}

// The pool's mean depth in inches from its gallons and surface area (ft2).
export function meanDepthInches(gallons: number, areaFt2: number): number {
    return gallons > 0 && areaFt2 > 0 ? gallons / GAL_PER_FT3 / areaFt2 * 12 : 0;
}

function satKpa(c: number): number { return 0.6108 * Math.exp(17.27 * c / (c + 237.3)); }
const f2c = (f: number) => (f - 32) * 5 / 9;
// Inches of water an hour evaporates (never negative). waterF the water temperature, airF and rh the air's, windMph the wind.
export function evaporationInPerHour(waterF: number, airF: number, rh: number, windMph: number = 0): number {
    if (![waterF, airF, rh].every(x => typeof x === 'number' && isFinite(x))) return 0;
    const pw = satKpa(f2c(waterF)), pa = Math.max(0, Math.min(100, rh)) / 100 * satKpa(f2c(airF));
    const v = Math.max(0, isFinite(windMph) ? windMph : 0) * 0.44704;
    const kgM2s = (0.089 + 0.0782 * v) * Math.max(0, pw - pa) / 2450;
    return kgM2s * 3600 / 25.4;      // 1 kg/m2 is 1 mm
}

export interface WaterBalance {
    depth: number;                 // the mean depth (inches) the shares are taken on
    t: number[];                   // each row's end
    level: Float64Array;           // inches above (+) or below (-) the level at the first row, at each row's end
    logConc: Float64Array;         // the log of the concentration factor from the first row's start to each row's end (cumulative)
    evap: Float64Array;            // inches evaporated in the row
    spilled: Float64Array;         // inches spilled in the row
    events: WaterEvent[];          // the water log entries applied
}

// The balance over `rows` (oldest first). `rainMult(i)` scales a row's rain (a storm's runoff, see Dilution.setRunoff). `waterTempAt` is the water
// temperature for a row that has none (PoolMath's tests); without either the air temperature plus 2 F is used.
export function waterBalance(rows: WaterHour[], depth: number, s: WaterSettings, events: WaterEvent[] = [], opts: { rainMult?: (i: number) => number; waterTempAt?: (t: number) => number | undefined; spillInches?: number; startLevel?: number } = {}): WaterBalance {
    const n = rows.length;
    const out: WaterBalance = { depth: depth, t: rows.map(r => r.t), level: new Float64Array(n), logConc: new Float64Array(n), evap: new Float64Array(n), spilled: new Float64Array(n), events: [] };
    if (!(depth > 0)) return out;
    const spill = typeof s.spillInches === 'number' ? s.spillInches : (typeof opts.spillInches === 'number' ? opts.spillInches : Infinity);
    const evs = events.filter(e => e && isFinite(e.t) && e.inches > 0).sort((a, b) => a.t - b.t);
    let ei = 0, level = opts.startLevel || 0, lc = 0, lastWater: number | undefined;
    while (ei < evs.length && n && evs[ei].t <= rows[0].t - HOUR_MS) ei++;
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        const vol = () => Math.max(depth * 0.5, depth + level);
        // evaporation over the hour
        let wt = typeof r.temp === 'number' && isFinite(r.temp) ? r.temp : (opts.waterTempAt ? opts.waterTempAt(r.t) : undefined);
        if (typeof wt === 'number') lastWater = wt; else if (typeof lastWater === 'number' && i > 0 && r.t - rows[i - 1].t <= 3 * DAY_MS) wt = lastWater;
        if (typeof wt !== 'number' && typeof r.air === 'number') wt = r.air + 2;
        const e = s.evapScale > 0 && typeof wt === 'number' && typeof r.air === 'number' && typeof r.rh === 'number' ? s.evapScale * evaporationInPerHour(wt, r.air, r.rh, r.wind) : 0;
        const rain = typeof r.rain === 'number' && r.rain > 0 ? r.rain * (opts.rainMult ? opts.rainMult(i) : 1) : 0;
        const v0 = vol();
        const v1 = Math.max(depth * 0.5, v0 + rain - e);
        lc += Math.log(v0 / v1);
        level += rain - e;
        out.evap[i] = e;
        // the water log in this hour
        while (ei < evs.length && evs[ei].t <= r.t) {
            const x = evs[ei++];
            if (x.kind === 'add') { const a = vol(); lc += Math.log(a / (a + x.inches)); level += x.inches; }
            else level -= x.inches;
            out.events.push(x);
        }
        if (level > spill) { out.spilled[i] = level - spill; level = spill; }
        out.level[i] = level; out.logConc[i] = lc;
    }
    return out;
}

// The concentration factor of the balance between two moments (1 outside its rows).
export function balanceFactor(b: WaterBalance, t1: number, t2: number): number {
    if (!(t2 > t1) || !b.t.length) return 1;
    const idx = (t: number) => { let lo = 0, hi = b.t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (b.t[m] <= t) lo = m + 1; else hi = m; } return lo - 1; };
    const a = idx(t1), c = idx(t2);
    const la = a >= 0 ? b.logConc[a] : 0, lb = c >= 0 ? b.logConc[c] : 0;
    return Math.exp(lb - la);
}

// The factor of one hour (the row ending at t) from a forecast: rain in, evaporation out, at `depth` inches (no water log, no spill: those do not
// change a concentration).
export function hourFactor(depth: number, rain: number, evap: number): number {
    if (!(depth > 0)) return 1;
    return depth / Math.max(depth * 0.5, depth + Math.max(0, rain) - Math.max(0, evap));
}

// ---------------------------------------------------------------- the local water log (until PoolMath can log water changes)

const LOG_FILE = 'waterLog.json';
function logPath(): string { return path.join(process.cwd(), 'data', LOG_FILE); }
export function normalizeWaterEvent(raw: any): WaterEvent | undefined {
    if (!raw) return undefined;
    const t = typeof raw.t === 'number' ? raw.t : new Date(raw.t).getTime();
    const inches = Number(raw.inches);
    const kind = raw.kind === 'add' || raw.kind === 'remove' ? raw.kind : undefined;
    if (!kind || !isFinite(t) || !(inches > 0) || inches > 60) return undefined;
    const e: WaterEvent = { t: t, kind: kind, inches: Math.round(inches * 100) / 100 };
    if (typeof raw.note === 'string' && raw.note.trim()) e.note = raw.note.trim().slice(0, 200);
    e.id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : `w${t.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    return e;
}
export class WaterLog {
    private cache: WaterEvent[] | undefined;
    public list(): WaterEvent[] {
        if (this.cache) return this.cache.slice();
        let out: WaterEvent[] = [];
        try { const raw = JSON.parse(fs.readFileSync(logPath(), 'utf8')); if (Array.isArray(raw)) out = raw.map(normalizeWaterEvent).filter(e => !!e); }
        catch (err) { /* none yet */ }
        this.cache = out.sort((a, b) => a.t - b.t);
        return this.cache.slice();
    }
    private write(list: WaterEvent[]) {
        const file = logPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2), 'utf8');
        fs.renameSync(`${file}.tmp`, file);
        this.cache = list.slice().sort((a, b) => a.t - b.t);
    }
    // Adds an entry ({ t, kind 'add' | 'remove', inches, note }); returns it, or undefined when it is not valid.
    public add(raw: any): WaterEvent | undefined {
        const e = normalizeWaterEvent(Object.assign({}, raw, { id: undefined }));
        if (!e) return undefined;
        this.write(this.list().concat([e]));
        return e;
    }
    public remove(id: string): boolean {
        const list = this.list();
        const next = list.filter(e => e.id !== id);
        if (next.length === list.length) return false;
        this.write(next);
        return true;
    }
}
export const waterLog = new WaterLog();
