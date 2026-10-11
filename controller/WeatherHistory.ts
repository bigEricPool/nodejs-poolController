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

// A local, hour by hour record of the weather at a nearby Weather Underground personal weather station (PWS): temperature, dew point, humidity,
// wind, pressure, rain, solar radiation and UV index. It is a log only: nothing in njsPC acts on it. It is there so that what the pool did
// (heat gained and lost, chlorine used, water diluted by rain) can be compared with what the weather was.
//
// The data comes from The Weather Company's PWS API (api.weather.com/v2/pws), which needs an API key. Weather Underground issues keys to members
// with a registered station (wunderground.com/member/api-keys); a key reads any station, so the station does not have to be yours. The settings
// are the `weather` section of config.json: enabled, stationId, apiKey, units ('e' English or 'm' metric), backfillDays and keepDays.
//
// Two requests are used:
//   * observations/hourly/7day, once an hour: the last seven days, which also fills a gap of up to a week after njsPC was not running;
//   * history/hourly?date=YYYYMMDD, one past day per request: older days back to backfillDays, a limited number each hour so the key's limits
//     (about 1500 requests a day and 30 a minute) are never approached. A day is asked for once, whether or not the station reported that day.
//
// Stored in data/weather/<stationId>_<units>/YYYY-MM.json, one file per month of the station's local time, so only the current month is rewritten
// and a change of station or units starts a separate record. status.json beside them lists the days already asked for.

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { logger } from '../logger/Logger';

const API_HOST = 'https://api.weather.com';
const DAY_MS = 86400000;
const BACKFILL_DAYS_PER_RUN = 40;           // past days requested in one hourly run ...
const BACKFILL_GAP_MS = 2500;               // ... this far apart
const RECENT_DAYS = 7;                      // what observations/hourly/7day covers
const SETTLED_MS = 2 * DAY_MS;              // a day this far in the past will get no more observations

export interface WeatherSettings { enabled: boolean; stationId: string; apiKey: string; units: 'e' | 'm'; backfillDays: number; keepDays: number; }
// One hour at the station. `lt` is the station's local time at the end of the hour ('YYYY-MM-DDTHH:MM:SS'), `t` the same instant in epoch ms.
// Temperatures, wind, pressure and rain are in the units the record was requested in. `precipTotal` is the day's rain so far (it starts again at
// the station's local midnight), `precipRate` the rate reported for the hour. `qc` is the station's quality control status: 1 passed, 0 failed,
// -1 not checked.
export interface WeatherHour {
    t: number; lt: string;
    temp?: number; tempHigh?: number; tempLow?: number; dewpt?: number; heatIndex?: number; windChill?: number;
    humidity?: number; humidityHigh?: number; humidityLow?: number;
    windSpeed?: number; windSpeedHigh?: number; windGust?: number; windDir?: number;
    pressureMax?: number; pressureMin?: number;
    precipRate?: number; precipTotal?: number;
    solarRad?: number; uv?: number;
    qc?: number;
}
export interface WeatherDay {
    date: string; hours: number;
    tempAvg?: number; tempHigh?: number; tempLow?: number; dewptAvg?: number; humidityAvg?: number;
    windSpeedAvg?: number; windGustHigh?: number;
    pressureMax?: number; pressureMin?: number;
    precipTotal?: number; precipRateHigh?: number;
    solarRadHigh?: number; uvHigh?: number;
    qcFailed: number;
}
export interface WeatherStatus {
    enabled: boolean; configured: boolean; stationId: string; units: string; backfillDays: number; keepDays: number;
    hours: number; oldest?: string; newest?: string;
    lastRunAt?: string; lastSuccessAt?: string; lastError?: string;
    backfillDaysLeft: number;
    // Rain is read as a running total for the day. This counts the days on which the total went down from one hour to the next, which should not happen.
    precipTotalDecreases: number;
}
// The station's latest report (observations/current). `lt` and `t` are as in WeatherHour.
export interface WeatherCurrent {
    t: number; lt: string;
    temp?: number; heatIndex?: number; windChill?: number; dewpt?: number; humidity?: number;
    windSpeed?: number; windGust?: number; windDir?: number; pressure?: number;
    precipRate?: number; precipTotal?: number;
    solarRad?: number; uv?: number;
}
// Today and yesterday (the station's local days) with the latest report, for a dashboard. Today's figures include the latest report.
export interface WeatherSummary {
    enabled: boolean; configured: boolean; stationId: string; units: string; stationUrl?: string; lastError?: string;
    current?: WeatherCurrent; today?: WeatherDay; yesterday?: WeatherDay;
    precip7Days?: number;       // rain over the last seven local days, today included
}
interface StatusFile { checked: string[]; lastRunAt?: string; lastSuccessAt?: string; lastError?: string; }
const CURRENT_CACHE_MS = 10 * 60 * 1000;    // the latest report is asked for at most this often, and only while something is showing it

const num = (v: any): number | undefined => typeof v === 'number' && isFinite(v) ? v : undefined;
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise<void>(resolve => { const tmr = setTimeout(resolve, ms); tmr.unref(); });
const round = (v: number, places: number): number => { const f = Math.pow(10, places); return Math.round(v * f) / f; };

export function normalizeWeatherSettings(cfg: any): WeatherSettings {
    cfg = cfg || {};
    let backfillDays = parseInt(cfg.backfillDays, 10), keepDays = parseInt(cfg.keepDays, 10);
    if (isNaN(backfillDays) || backfillDays < 0) backfillDays = 400;
    if (isNaN(keepDays) || keepDays < 30) keepDays = 800;
    return {
        enabled: cfg.enabled === true || cfg.enabled === 'true',
        // A station id is letters and digits only, which also keeps it safe as a folder name.
        stationId: (typeof cfg.stationId === 'string' ? cfg.stationId : '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
        apiKey: (typeof cfg.apiKey === 'string' ? cfg.apiKey : '').trim(),
        units: cfg.units === 'm' ? 'm' : 'e',
        backfillDays: Math.min(backfillDays, keepDays),
        keepDays: keepDays
    };
}

// One observation of the hourly endpoints as a WeatherHour; undefined when it has no usable time.
export function parseObservation(o: any, units: 'e' | 'm'): WeatherHour | undefined {
    if (!o || typeof o !== 'object') return undefined;
    const t = typeof o.epoch === 'number' && isFinite(o.epoch) ? o.epoch * 1000 : new Date(o.obsTimeUtc).getTime();
    const lt = typeof o.obsTimeLocal === 'string' ? o.obsTimeLocal.trim().replace(' ', 'T').slice(0, 19) : '';
    if (isNaN(t) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(lt)) return undefined;
    const u = o[units === 'm' ? 'metric' : 'imperial'] || {};
    const h: WeatherHour = {
        t: t, lt: lt,
        temp: num(u.tempAvg), tempHigh: num(u.tempHigh), tempLow: num(u.tempLow), dewpt: num(u.dewptAvg), heatIndex: num(u.heatindexAvg), windChill: num(u.windchillAvg),
        humidity: num(o.humidityAvg), humidityHigh: num(o.humidityHigh), humidityLow: num(o.humidityLow),
        windSpeed: num(u.windspeedAvg), windSpeedHigh: num(u.windspeedHigh), windGust: num(u.windgustHigh), windDir: num(o.winddirAvg),
        pressureMax: num(u.pressureMax), pressureMin: num(u.pressureMin),
        precipRate: num(u.precipRate), precipTotal: num(u.precipTotal),
        solarRad: num(o.solarRadiationHigh), uv: num(o.uvHigh),
        qc: num(o.qcStatus)
    };
    for (const k of Object.keys(h)) if (typeof h[k] === 'undefined') delete h[k];
    return h;
}

// The observation of observations/current as a WeatherCurrent; undefined when it has no usable time.
export function parseCurrent(o: any, units: 'e' | 'm'): WeatherCurrent | undefined {
    if (!o || typeof o !== 'object') return undefined;
    const t = typeof o.epoch === 'number' && isFinite(o.epoch) ? o.epoch * 1000 : new Date(o.obsTimeUtc).getTime();
    const lt = typeof o.obsTimeLocal === 'string' ? o.obsTimeLocal.trim().replace(' ', 'T').slice(0, 19) : '';
    if (isNaN(t) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(lt)) return undefined;
    const u = o[units === 'm' ? 'metric' : 'imperial'] || {};
    const c: WeatherCurrent = {
        t: t, lt: lt,
        temp: num(u.temp), heatIndex: num(u.heatIndex), windChill: num(u.windChill), dewpt: num(u.dewpt), humidity: num(o.humidity),
        windSpeed: num(u.windSpeed), windGust: num(u.windGust), windDir: num(o.winddir), pressure: num(u.pressure),
        precipRate: num(u.precipRate), precipTotal: num(u.precipTotal),
        solarRad: num(o.solarRadiation), uv: num(o.uv)
    };
    for (const k of Object.keys(c)) if (typeof c[k] === 'undefined') delete c[k];
    return c;
}

// The days (station local time) summarized from their hours, oldest first.
export function summarizeDays(hours: WeatherHour[]): WeatherDay[] {
    const byDate = new Map<string, WeatherHour[]>();
    for (const h of hours) { const d = h.lt.slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(h); }
    const vals = (hs: WeatherHour[], k: keyof WeatherHour): number[] => hs.map(h => h[k] as number).filter(v => typeof v === 'number');
    const avg = (xs: number[], places: number) => xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, places) : undefined;
    const max = (xs: number[]) => xs.length ? Math.max(...xs) : undefined;
    const min = (xs: number[]) => xs.length ? Math.min(...xs) : undefined;
    const out: WeatherDay[] = [];
    for (const date of Array.from(byDate.keys()).sort()) {
        const hs = byDate.get(date);
        const day: WeatherDay = {
            date: date, hours: hs.length,
            tempAvg: avg(vals(hs, 'temp'), 1), tempHigh: max(vals(hs, 'tempHigh')), tempLow: min(vals(hs, 'tempLow')), dewptAvg: avg(vals(hs, 'dewpt'), 1), humidityAvg: avg(vals(hs, 'humidity'), 0),
            windSpeedAvg: avg(vals(hs, 'windSpeed'), 1), windGustHigh: max(vals(hs, 'windGust')),
            pressureMax: max(vals(hs, 'pressureMax')), pressureMin: min(vals(hs, 'pressureMin')),
            // The day's rain is the highest running total reported in it.
            precipTotal: max(vals(hs, 'precipTotal')), precipRateHigh: max(vals(hs, 'precipRate')),
            solarRadHigh: max(vals(hs, 'solarRad')), uvHigh: max(vals(hs, 'uv')),
            qcFailed: hs.filter(h => h.qc === 0).length
        };
        for (const k of Object.keys(day)) if (typeof day[k] === 'undefined') delete day[k];
        out.push(day);
    }
    return out;
}

function httpGetJson(url: string): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
        try {
            const req = https.request(url, { method: 'GET', headers: { 'Accept': 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'nodejs-poolController' }, timeout: 30000 }, res => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', d => { body += d; });
                res.on('end', () => {
                    let data: any;
                    try { data = body.length ? JSON.parse(body) : undefined; } catch (err) { data = undefined; }
                    resolve({ status: res.statusCode || 0, data: data });
                });
            });
            req.on('timeout', () => req.destroy(new Error('the weather request timed out')));
            req.on('error', reject);
            req.end();
        } catch (err) { reject(err); }
    });
}

export class WeatherHistory {
    private months = new Map<string, Map<string, WeatherHour>>();    // 'YYYY-MM' -> hour key ('YYYY-MM-DDTHH') -> the hour
    private dirtyMonths = new Set<string>();
    private status: StatusFile = { checked: [] };
    private loadedFor: string = '';
    private running: boolean = false;
    // The request is a seam so the history can be exercised without the network.
    constructor(private get: (url: string) => Promise<{ status: number; data: any }> = httpGetJson, private baseDir?: string) { }

    private dir(s: WeatherSettings): string { return path.join(this.baseDir || path.join(process.cwd(), 'data', 'weather'), `${s.stationId}_${s.units}`); }
    private load(s: WeatherSettings) {
        const dir = this.dir(s);
        if (this.loadedFor === dir) return;
        this.loadedFor = dir;
        this.months.clear();
        this.dirtyMonths.clear();
        this.status = { checked: [] };
        try {
            if (!fs.existsSync(dir)) return;
            for (const f of fs.readdirSync(dir)) {
                const m = /^(\d{4}-\d{2})\.json$/.exec(f);
                if (!m) continue;
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                    const map = new Map<string, WeatherHour>();
                    if (Array.isArray(data)) for (const h of data) if (h && typeof h.t === 'number' && typeof h.lt === 'string') map.set(h.lt.slice(0, 13), h);
                    this.months.set(m[1], map);
                } catch (err) { logger.warn(`Weather: could not read ${f}: ${err.message}`); }
            }
            const sf = path.join(dir, 'status.json');
            if (fs.existsSync(sf)) {
                const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
                this.status = { checked: Array.isArray(st.checked) ? st.checked.filter(d => typeof d === 'string') : [], lastRunAt: st.lastRunAt, lastSuccessAt: st.lastSuccessAt, lastError: st.lastError };
            }
        } catch (err) { logger.warn(`Weather: could not read the weather history: ${err.message}`); }
    }
    private writeFile(file: string, data: any) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
        fs.renameSync(tmp, file);
    }
    private save(s: WeatherSettings) {
        const dir = this.dir(s);
        try {
            for (const month of this.dirtyMonths) {
                const map = this.months.get(month);
                const file = path.join(dir, `${month}.json`);
                if (!map || map.size === 0) { if (fs.existsSync(file)) fs.unlinkSync(file); this.months.delete(month); }
                else this.writeFile(file, Array.from(map.values()).sort((a, b) => a.t - b.t));
            }
            this.dirtyMonths.clear();
            this.writeFile(path.join(dir, 'status.json'), this.status);
        } catch (err) { logger.warn(`Weather: could not save the weather history: ${err.message}`); }
    }
    // Adds the observations, the newer copy of an hour replacing the older (the hour in progress is reported again when it is complete).
    private merge(observations: any[], units: 'e' | 'm'): number {
        let n = 0;
        for (const o of Array.isArray(observations) ? observations : []) {
            const h = parseObservation(o, units);
            if (!h) continue;
            const month = h.lt.slice(0, 7), key = h.lt.slice(0, 13);
            if (!this.months.has(month)) this.months.set(month, new Map());
            const map = this.months.get(month), had = map.get(key);
            if (had && JSON.stringify(had) === JSON.stringify(h)) continue;
            map.set(key, h);
            this.dirtyMonths.add(month);
            n++;
        }
        return n;
    }
    private prune(s: WeatherSettings, now: number) {
        const cutoff = now - s.keepDays * DAY_MS, cutoffMonth = ymd(cutoff).slice(0, 7);
        for (const [month, map] of this.months) {
            if (month > cutoffMonth) continue;
            for (const [key, h] of map) if (h.t < cutoff) { map.delete(key); this.dirtyMonths.add(month); }
        }
        const oldest = ymd(cutoff - DAY_MS);
        this.status.checked = this.status.checked.filter(d => d >= oldest);
    }
    // The past days (UTC dates, newest first) not yet asked for, from the edge of what the seven day request covers back to backfillDays.
    private daysToBackfill(s: WeatherSettings, now: number): string[] {
        const checked = new Set(this.status.checked), out: string[] = [];
        for (let i = RECENT_DAYS - 1; i <= s.backfillDays; i++) { const d = ymd(now - i * DAY_MS); if (!checked.has(d)) out.push(d); }
        return out;
    }
    private url(s: WeatherSettings, resource: string, extra: string = ''): string {
        return `${API_HOST}/v2/pws/${resource}?stationId=${encodeURIComponent(s.stationId)}&format=json&units=${s.units}&numericPrecision=decimal${extra}&apiKey=${encodeURIComponent(s.apiKey)}`;
    }
    // The observations of one request; an empty list when the station reported nothing for it. The key is never put in a message.
    private async fetch(s: WeatherSettings, resource: string, extra: string = ''): Promise<any[]> {
        const r = await this.get(this.url(s, resource, extra));
        if (r.status === 204) return [];
        if (r.status === 401 || r.status === 403) throw new Error(`the API key was not accepted (HTTP ${r.status})`);
        if (r.status === 429) throw new Error('the API key has reached its request limit (HTTP 429)');
        if (r.status === 404) throw new Error(`station ${s.stationId} was not found (HTTP 404)`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status} from the weather service`);
        return r.data && Array.isArray(r.data.observations) ? r.data.observations : [];
    }
    // One run: the last seven days, then some of the older days still to be asked for. Returns the hours added or changed.
    public async sync(cfg: any, now: number = Date.now(), gapMs: number = BACKFILL_GAP_MS): Promise<number> {
        const s = normalizeWeatherSettings(cfg);
        if (!s.enabled || !s.stationId || !s.apiKey || this.running) return 0;
        this.running = true;
        let changed = 0;
        try {
            this.load(s);
            this.status.lastRunAt = new Date(now).toISOString();
            try {
                changed += this.merge(await this.fetch(s, 'observations/hourly/7day'), s.units);
                // The days the seven day request fully covered and that are over need not be asked for again.
                const checked = new Set(this.status.checked);
                for (let i = 2; i < RECENT_DAYS - 1; i++) checked.add(ymd(now - i * DAY_MS));
                this.status.checked = Array.from(checked).sort();
                const todo = this.daysToBackfill(s, now).slice(0, BACKFILL_DAYS_PER_RUN);
                for (const d of todo) {
                    if (gapMs > 0) await sleep(gapMs);
                    let obs: any[];
                    // A day the station has nothing for comes back as 204 or, for a day before it existed, 404; either way it is not asked for again.
                    try { obs = await this.fetch(s, 'history/hourly', `&date=${d.replace(/-/g, '')}`); }
                    catch (err) { if (/HTTP 404/.test(err.message)) obs = []; else throw err; }
                    changed += this.merge(obs, s.units);
                    if (now - new Date(`${d}T00:00:00Z`).getTime() >= SETTLED_MS) this.status.checked.push(d);
                }
                this.status.checked.sort();
                if (this.status.lastError) logger.info(`Weather: station ${s.stationId} is being read again.`);
                this.status.lastSuccessAt = new Date(now).toISOString();
                this.status.lastError = undefined;
            }
            catch (err) {
                if (this.status.lastError !== err.message) logger.warn(`Weather: could not read station ${s.stationId}: ${err.message}`);
                this.status.lastError = err.message;
            }
            this.prune(s, now);
            this.save(s);
        }
        finally { this.running = false; }
        return changed;
    }
    // The hours from `from` to `to` (epoch ms), oldest first.
    public hours(cfg: any, from: number, to: number = Date.now()): WeatherHour[] {
        const s = normalizeWeatherSettings(cfg);
        if (!s.stationId) return [];
        this.load(s);
        // A month file is named for the station's local time, which is within a day of UTC.
        const first = ymd(from - DAY_MS).slice(0, 7), last = ymd(to + DAY_MS).slice(0, 7), out: WeatherHour[] = [];
        for (const [month, map] of this.months) {
            if (month < first || month > last) continue;
            for (const h of map.values()) if (h.t >= from && h.t <= to) out.push(h);
        }
        return out.sort((a, b) => a.t - b.t);
    }
    public daily(cfg: any, from: number, to: number = Date.now()): WeatherDay[] {
        // Whole local days: every hour of a day that has any hour in the range.
        const inRange = this.hours(cfg, from, to);
        if (!inRange.length) return [];
        const firstDate = inRange[0].lt.slice(0, 10), lastDate = inRange[inRange.length - 1].lt.slice(0, 10);
        return summarizeDays(this.hours(cfg, from - DAY_MS, to + DAY_MS).filter(h => h.lt.slice(0, 10) >= firstDate && h.lt.slice(0, 10) <= lastDate));
    }
    private currentObs: { key: string; at: number; value?: WeatherCurrent } | undefined;
    // The station's latest report, asked for at most every ten minutes. Undefined when the station has reported nothing in the last hour or the
    // request failed (the reason is not kept: the hourly run reports a key or a station that does not work).
    public async current(cfg: any, now: number = Date.now()): Promise<WeatherCurrent | undefined> {
        const s = normalizeWeatherSettings(cfg);
        if (!s.enabled || !s.stationId || !s.apiKey) return undefined;
        const key = `${s.stationId}_${s.units}`;
        if (this.currentObs && this.currentObs.key === key && now - this.currentObs.at < CURRENT_CACHE_MS) return this.currentObs.value;
        const had = this.currentObs && this.currentObs.key === key ? this.currentObs.value : undefined;
        // Recorded before the request so that requests arriving together make one call.
        this.currentObs = { key: key, at: now, value: had };
        try {
            const obs = await this.fetch(s, 'observations/current');
            this.currentObs = { key: key, at: now, value: obs.length ? parseCurrent(obs[0], s.units) : undefined };
        }
        catch (err) { logger.verbose(`Weather: could not read the latest report of station ${s.stationId}: ${err.message}`); }
        return this.currentObs.value;
    }
    public async summary(cfg: any, now: number = Date.now()): Promise<WeatherSummary> {
        const s = normalizeWeatherSettings(cfg);
        const out: WeatherSummary = { enabled: s.enabled, configured: !!(s.stationId && s.apiKey), stationId: s.stationId, units: s.units };
        if (!s.stationId) return out;
        out.stationUrl = `https://www.wunderground.com/dashboard/pws/${s.stationId}`;
        this.load(s);
        out.lastError = this.status.lastError;
        let cur = await this.current(cfg, now);
        const hours = this.hours(cfg, now - 9 * DAY_MS, now + DAY_MS);
        // The station's local date now, from the difference between its local and UTC times in the newest thing it reported.
        const newest: { t: number; lt: string } | undefined = cur || hours[hours.length - 1];
        if (!newest) return out;
        const offset = Math.round((new Date(`${newest.lt}Z`).getTime() - newest.t) / 900000) * 900000;
        const today = ymd(now + offset), yesterday = ymd(now + offset - DAY_MS), weekAgo = ymd(now + offset - 6 * DAY_MS);
        // A latest report from an earlier day says nothing about today.
        if (cur && cur.lt.slice(0, 10) !== today) cur = undefined;
        out.current = cur;
        const days = summarizeDays(hours);
        out.today = days.find(d => d.date === today);
        out.yesterday = days.find(d => d.date === yesterday);
        if (cur) {
            const t: WeatherDay = out.today || { date: today, hours: 0, qcFailed: 0 };
            const hi = (a: number | undefined, b: number | undefined) => typeof b !== 'number' ? a : typeof a !== 'number' ? b : Math.max(a, b);
            const lo = (a: number | undefined, b: number | undefined) => typeof b !== 'number' ? a : typeof a !== 'number' ? b : Math.min(a, b);
            t.tempHigh = hi(t.tempHigh, cur.temp); t.tempLow = lo(t.tempLow, cur.temp);
            t.precipTotal = hi(t.precipTotal, cur.precipTotal); t.precipRateHigh = hi(t.precipRateHigh, cur.precipRate);
            t.uvHigh = hi(t.uvHigh, cur.uv); t.solarRadHigh = hi(t.solarRadHigh, cur.solarRad); t.windGustHigh = hi(t.windGustHigh, cur.windGust);
            for (const k of Object.keys(t)) if (typeof t[k] === 'undefined') delete t[k];
            out.today = t;
        }
        const week = days.filter(d => d.date >= weekAgo && d.date <= today && d.date !== today).concat(out.today ? [out.today] : []).filter(d => typeof d.precipTotal === 'number');
        if (week.length) out.precip7Days = round(week.reduce((a, d) => a + d.precipTotal, 0), 2);
        return out;
    }
    public getStatus(cfg: any, now: number = Date.now()): WeatherStatus {
        const s = normalizeWeatherSettings(cfg);
        if (s.stationId) this.load(s);
        let count = 0, oldest: WeatherHour | undefined, newest: WeatherHour | undefined, decreases = 0;
        if (s.stationId) for (const map of this.months.values()) {
            const hs = Array.from(map.values()).sort((a, b) => a.t - b.t);
            const down = new Set<string>();
            for (let i = 0; i < hs.length; i++) {
                const h = hs[i], p = hs[i - 1];
                count++;
                if (!oldest || h.t < oldest.t) oldest = h;
                if (!newest || h.t > newest.t) newest = h;
                if (p && p.lt.slice(0, 10) === h.lt.slice(0, 10) && typeof p.precipTotal === 'number' && typeof h.precipTotal === 'number' && h.precipTotal < p.precipTotal - 0.005) down.add(h.lt.slice(0, 10));
            }
            decreases += down.size;
        }
        return {
            enabled: s.enabled, configured: !!(s.stationId && s.apiKey), stationId: s.stationId, units: s.units, backfillDays: s.backfillDays, keepDays: s.keepDays,
            hours: count, oldest: oldest ? oldest.lt : undefined, newest: newest ? newest.lt : undefined,
            lastRunAt: this.status.lastRunAt, lastSuccessAt: this.status.lastSuccessAt, lastError: this.status.lastError,
            backfillDaysLeft: s.stationId && s.apiKey ? this.daysToBackfill(s, now).length : 0,
            precipTotalDecreases: decreases
        };
    }
}
export const weatherHistory = new WeatherHistory();
