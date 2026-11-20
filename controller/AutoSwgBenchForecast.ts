// SWG Assist Model Bench: the weather forecast as it was known at each check, so the bench's forecast scores can use the rain and clouds that were
// forecast (until 2026-11-20 a forecast knew only the recent clearness and expected no rain).
//
// Source: Open-Meteo (open-meteo.com, no key), hourly for 7 days: shortwave radiation (W/m2, the mean of the hour before), precipitation (inches,
// the hour before), air temperature (F), relative humidity (%) and wind (mph). The place is rounded to 0.1 degree (about 10 km, the model's grid) before
// it is sent. One forecast is saved at each bench check when the newest is more than FETCH_EVERY_MS old, kept KEEP_DAYS days in
// data/autoSwgBenchForecast.jsonl as { t: when fetched, src, hours: [[hour end ms, sun, rain, air, rh, wind], ...] }.

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { BenchForecast, BenchHour, ForecastHour } from './AutoSwgBenchModel';
import { evaporationInPerHour, hourFactor } from './AutoSwgBenchWater';

const HOUR_MS = 3600000, DAY_MS = 24 * HOUR_MS;
const FILE = 'autoSwgBenchForecast.jsonl';
const KEEP_DAYS = 120;
const FETCH_EVERY_MS = 6 * HOUR_MS;
// a forecast counts for a check made up to this long after it was fetched
export const FORECAST_MAX_AGE_MS = 13 * HOUR_MS;

export type ForecastRowHour = [number, number | null, number | null, number | null, number | null, number | null];
export interface ForecastSnapshot { t: number; src: string; hours: ForecastRowHour[]; }

function filePath(): string { return path.join(process.cwd(), 'data', FILE); }

// The Open-Meteo request for a place (rounded to 0.1 degree).
export function openMeteoUrl(lat: number, lon: number): string {
    const r = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
    return `https://api.open-meteo.com/v1/forecast?latitude=${r(lat)}&longitude=${r(lon)}` +
        '&hourly=shortwave_radiation,precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m' +
        '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timeformat=unixtime&timezone=GMT&forecast_days=7';
}

// Open-Meteo's answer as snapshot hours. Its hourly times are the start of each hour's instant values and the end of the summed ones; the sun and the
// rain are "the hour before", so the time is the hour's end, as the bench keys its rows.
export function parseOpenMeteo(body: any): ForecastRowHour[] {
    const h = body && body.hourly;
    if (!h || !Array.isArray(h.time)) return [];
    const num = (a: any[], i: number) => Array.isArray(a) && typeof a[i] === 'number' && isFinite(a[i]) ? a[i] : null;
    const out: ForecastRowHour[] = [];
    for (let i = 0; i < h.time.length; i++) {
        const t = Number(h.time[i]) * 1000;
        if (!isFinite(t)) continue;
        out.push([t, num(h.shortwave_radiation, i), num(h.precipitation, i), num(h.temperature_2m, i), num(h.relative_humidity_2m, i), num(h.wind_speed_10m, i)]);
    }
    return out;
}

function getJson(url: string, timeoutMs: number = 20000): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'njsPC-bench' } }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (err) { reject(err); } });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
        req.on('error', reject);
    });
}

export class BenchForecastLog {
    private cache: ForecastSnapshot[] | undefined;
    private lastError: string | undefined;
    private fetching = false;
    public read(): ForecastSnapshot[] {
        if (this.cache) return this.cache;
        const out: ForecastSnapshot[] = [];
        try {
            for (const line of fs.readFileSync(filePath(), 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { const s = JSON.parse(line); if (s && isFinite(s.t) && Array.isArray(s.hours)) out.push(s); } catch (err) { /* a cut line */ }
            }
        }
        catch (err) { /* none yet */ }
        this.cache = out.sort((a, b) => a.t - b.t);
        return this.cache;
    }
    public status(): { snapshots: number; newest?: string; error?: string } {
        const all = this.read();
        return { snapshots: all.length, newest: all.length ? new Date(all[all.length - 1].t).toISOString() : undefined, error: this.lastError };
    }
    // The newest snapshot fetched at or before `asOf` and no more than FORECAST_MAX_AGE_MS before it.
    public at(asOf: number): ForecastSnapshot | undefined {
        const all = this.read();
        for (let i = all.length - 1; i >= 0; i--) {
            if (all[i].t > asOf) continue;
            return asOf - all[i].t <= FORECAST_MAX_AGE_MS ? all[i] : undefined;
        }
        return undefined;
    }
    // Fetches and saves a forecast when the newest is older than FETCH_EVERY_MS. Never throws.
    public async refresh(lat: number | undefined, lon: number | undefined, now: number = Date.now()): Promise<void> {
        if (this.fetching || typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return;
        const all = this.read();
        if (all.length && now - all[all.length - 1].t < FETCH_EVERY_MS) return;
        this.fetching = true;
        try {
            const hours = parseOpenMeteo(await getJson(openMeteoUrl(lat, lon)));
            if (!hours.length) throw new Error('no hourly data');
            const snap: ForecastSnapshot = { t: now, src: 'open-meteo', hours: hours };
            const cut = now - KEEP_DAYS * DAY_MS;
            const keep = all.filter(s => s.t >= cut).concat([snap]);
            const file = filePath();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (keep.length === all.length + 1) fs.appendFileSync(file, JSON.stringify(snap) + '\n', 'utf8');
            else {
                fs.writeFileSync(`${file}.tmp`, keep.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');
                fs.renameSync(`${file}.tmp`, file);
            }
            this.cache = keep;
            this.lastError = undefined;
        }
        catch (err) { this.lastError = `${new Date(now).toISOString()} ${err && err.message}`; }
        finally { this.fetching = false; }
    }
}
export const benchForecastLog = new BenchForecastLog();

// A snapshot as the model's forecast: by hour end, the sun, the rain and the water balance factor (rain in, evaporation out at `depth` inches, the
// water held at `waterF`, else the air plus 2 F). `clearness` is the recent clearness, for hours past the snapshot.
export function forecastFor(snap: ForecastSnapshot | undefined, clearness: number | undefined, depth: number, waterF: number | undefined, evapScale: number = 1): BenchForecast | undefined {
    if (!snap) return typeof clearness === 'number' ? { clearness: clearness } : undefined;
    const hours = new Map<number, ForecastHour>();
    for (const [t, sun, rain, air, rh, wind] of snap.hours) {
        const h: ForecastHour = {};
        if (typeof sun === 'number') h.sun = Math.max(0, sun);
        if (typeof rain === 'number') h.rain = Math.max(0, rain);
        if (depth > 0) {
            const wt = typeof waterF === 'number' ? waterF : (typeof air === 'number' ? air + 2 : undefined);
            const e = evapScale > 0 && typeof wt === 'number' && typeof air === 'number' && typeof rh === 'number' ? evapScale * evaporationInPerHour(wt, air, rh, typeof wind === 'number' ? wind : 0) : 0;
            h.dil = hourFactor(depth, h.rain || 0, e);
        }
        hours.set(t, h);
    }
    return { clearness: clearness, hours: hours };
}

// The rows' own water temperature nearest before asOf (within 3 days).
export function waterTempBefore(rows: BenchHour[], asOf: number): number | undefined {
    for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.t > asOf) continue;
        if (asOf - r.t > 3 * DAY_MS) return undefined;
        if (typeof r.temp === 'number') return r.temp;
    }
    return undefined;
}
