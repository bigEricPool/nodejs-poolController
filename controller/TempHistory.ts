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

// A rolling record of each body's water temperature for the last 24 hours, kept so the average, the high and the low can
// be shown on the dashboard (BodyTempState.avgTemp24h, maxTemp24h, minTemp24h). The 24 hours always end now: they move on
// with every sample, they are not a calendar day. State samples each body that is on once a minute (see start), because a feed
// from the relay manager sends a reading only when it changes, and the average has to count the time a temperature
// stayed the same. One sample is kept per body per minute, and the record is saved to
// data/tempHistory.json (next to poolConfig.json) at most every five minutes and when the process exits, so a restart
// does not start the average over. Readings in the file are in the units they were taken in, so the average is off
// for up to a day after the temperature units are changed.
//
// For the week, month and year views each completed hour is also summarized in one row per body (see TempHour), kept for a
// year in data/tempHistoryHourly.json. The rows are made from the minute readings, so the first ones cover the 24 hours
// already recorded when this was installed. That file is saved when a row is added (once an hour), without blocking, and
// when the process exits.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SAMPLE_MS = 60 * 1000;
const SAVE_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HOURS_KEPT_MS = 366 * 24 * HOUR_MS;

// t: when, v: the temperature shown, l: the live reading, kept only when it differs from v (the solar enhancements can show a reading
// taken at the solar pump speed for a while; the live one is kept beside it so a chart can show both), p: what a solar check would
// read at the solar pump speed, kept only where the solar enhancements give a speed offset (see State.sampleTemps), s: the body's
// setpoint, kept where a solar heater serves the body, so a chart can draw the levels solar works to as they were at each minute.
interface TempSample { t: number; v: number; l?: number; p?: number; s?: number; }
// One hour (or, for the year view, one day) of a body's readings: t, the start; n, how many minute readings; v, their mean; hi and lo,
// the highest and the lowest, read at ht and lt; p, the mean of the projected readings (pn of them), and s, the last setpoint kept.
export interface TempHour { t: number; n: number; v: number; hi: number; ht: number; lo: number; lt: number; p?: number; pn?: number; s?: number; }
// A longer view of a body's readings for a chart: the rows as lists, and the figures for the whole view.
export interface TempRange {
    t: number[]; v: number[]; hi: number[]; lo: number[]; p: number[]; s: number[];
    avg?: number; high?: number; highAt?: number; low?: number; lowAt?: number; hours?: number;
}

class TempHistory {
    private samples: { [bodyId: number]: TempSample[] } = {};
    private hourly: { [bodyId: number]: TempHour[] } = {};
    private hourlyDirty: boolean = false;
    private hourlySaving: boolean = false;
    private loaded: boolean = false;
    private dirty: boolean = false;
    private lastSave: number = 0;
    constructor() {
        process.on('exit', () => {
            try { this.save(Date.now()); } catch (err) { /* nothing more can be done at exit */ }
            try { if (this.hourlyDirty) fs.writeFileSync(this.hourlyFile(), JSON.stringify(this.hourly), 'utf8'); } catch (err) { /* as above */ }
        });
    }
    private file(): string { return path.join(process.cwd(), 'data', 'tempHistory.json'); }
    private hourlyFile(): string { return path.join(process.cwd(), 'data', 'tempHistoryHourly.json'); }
    // Reads the saved record once. Every reader calls it, not only record(): after a restart while the body is off nothing is
    // recorded, and the saved readings must still be shown.
    private load() {
        this.loaded = true;
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return;
            const data = JSON.parse(fs.readFileSync(f, 'utf8'));
            const cutoff = Date.now() - WINDOW_MS;
            for (const id of Object.keys(data || {})) {
                const arr: any[] = Array.isArray(data[id]) ? data[id] : [];
                this.samples[parseInt(id, 10)] = arr.filter(s => s && typeof s.t === 'number' && typeof s.v === 'number' && isFinite(s.v) && s.t >= cutoff);
            }
        } catch (err) { logger.warn(`Could not read the temperature history: ${err.message}`); }
        try {
            const f = this.hourlyFile();
            if (fs.existsSync(f)) {
                const data = JSON.parse(fs.readFileSync(f, 'utf8'));
                const cutoff = Date.now() - HOURS_KEPT_MS;
                for (const id of Object.keys(data || {})) {
                    const arr: any[] = Array.isArray(data[id]) ? data[id] : [];
                    this.hourly[parseInt(id, 10)] = arr.filter(r => r && typeof r.t === 'number' && typeof r.v === 'number' && isFinite(r.v) && r.t >= cutoff);
                }
            }
        } catch (err) { logger.warn(`Could not read the hourly temperature history: ${err.message}`); }
        // The hours the minute readings cover that have no row yet (all of them the first time).
        for (const id of Object.keys(this.samples)) this.rollUp(parseInt(id, 10), Date.now());
    }
    // Summarizes readings by period: one row for each period start that `key` gives, oldest first.
    private group(rows: { t: number, n: number, v: number, hi: number, ht: number, lo: number, lt: number, p?: number, pn?: number, s?: number }[], key: (t: number) => number): TempHour[] {
        const out: TempHour[] = [];
        let cur: TempHour, vs = 0, ps = 0;
        const close = () => {
            if (typeof cur === 'undefined') return;
            cur.v = Math.round((vs / cur.n) * 100) / 100;
            if (cur.pn > 0) cur.p = Math.round((ps / cur.pn) * 100) / 100; else { delete cur.p; delete cur.pn; }
            out.push(cur);
        };
        for (const r of rows) {
            const k = key(r.t);
            if (typeof cur === 'undefined' || cur.t !== k) {
                close();
                cur = { t: k, n: 0, v: 0, hi: r.hi, ht: r.ht, lo: r.lo, lt: r.lt, pn: 0 };
                vs = 0; ps = 0;
            }
            cur.n += r.n; vs += r.v * r.n;
            if (r.hi >= cur.hi) { cur.hi = r.hi; cur.ht = r.ht; }
            if (r.lo <= cur.lo) { cur.lo = r.lo; cur.lt = r.lt; }
            if (typeof r.p === 'number') { const pn = typeof r.pn === 'number' ? r.pn : r.n; cur.pn += pn; ps += r.p * pn; }
            if (typeof r.s === 'number') cur.s = r.s;
        }
        close();
        return out;
    }
    // Minute readings as rows of one reading each, for group().
    private asRows(samples: TempSample[]) {
        return samples.map(s => ({ t: s.t, n: 1, v: s.v, hi: s.v, ht: s.t, lo: s.v, lt: s.t, p: s.p, pn: typeof s.p === 'number' ? 1 : 0, s: s.s }));
    }
    // The minute readings after the last hourly row as hourly rows, up to (not including) the hour starting at `before`.
    private pendingHours(bodyId: number, before: number): TempHour[] {
        const rows = this.hourly[bodyId] || [];
        const from = rows.length > 0 ? rows[rows.length - 1].t + HOUR_MS : -Infinity;
        const arr = (this.samples[bodyId] || []).filter(s => s.t >= from && s.t < before);
        return this.group(this.asRows(arr), t => Math.floor(t / HOUR_MS) * HOUR_MS);
    }
    // Adds a row for each completed hour that has none yet, drops rows older than a year, and saves the rows when any were added.
    private rollUp(bodyId: number, now: number) {
        const made = this.pendingHours(bodyId, Math.floor(now / HOUR_MS) * HOUR_MS);
        const rows = this.hourly[bodyId] || (this.hourly[bodyId] = []);
        const cutoff = now - HOURS_KEPT_MS;
        let changed = made.length > 0;
        for (const r of made) rows.push(r);
        while (rows.length > 0 && rows[0].t < cutoff) { rows.shift(); changed = true; }
        if (changed) { this.hourlyDirty = true; this.saveHourly(); }
    }
    // Writes the hourly rows without blocking (the file can be large); a write that fails is tried again with the next row.
    private saveHourly() {
        if (!this.hourlyDirty || this.hourlySaving) return;
        this.hourlySaving = true;
        this.hourlyDirty = false;
        const f = this.hourlyFile();
        const tmp = f + '.tmp';
        fs.promises.writeFile(tmp, JSON.stringify(this.hourly), 'utf8')
            .then(() => fs.promises.rename(tmp, f))
            .then(() => { this.hourlySaving = false; },
                (err) => { this.hourlySaving = false; this.hourlyDirty = true; logger.warn(`Could not save the hourly temperature history: ${err.message}`); });
    }
    private save(now: number) {
        if (!this.dirty) return;
        try {
            const f = this.file();
            const tmp = f + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.samples), 'utf8');
            fs.renameSync(tmp, f);
            this.dirty = false;
            this.lastSave = now;
        } catch (err) { logger.warn(`Could not save the temperature history: ${err.message}`); this.lastSave = now; }
    }
    private timer: NodeJS.Timeout;
    // Calls the sampler shortly after start-up and then once a minute, without keeping the process alive.
    public start(sampler: () => void) {
        if (typeof this.timer !== 'undefined') return;
        const first = setTimeout(sampler, 10 * 1000);
        first.unref();
        this.timer = setInterval(sampler, SAMPLE_MS);
        this.timer.unref();
    }
    // Adds a reading for a body (at most one a minute is kept) and drops anything older than 24 hours. `live` is the sensor's own
    // reading when the temperature shown is a different one, `projected` the reading expected at the solar pump speed and `setPoint`
    // the body's setpoint at the time.
    public record(bodyId: number, temp: number, live?: number, projected?: number, setPoint?: number, now: number = Date.now()) {
        if (!this.loaded) this.load();
        const arr = this.samples[bodyId] || (this.samples[bodyId] = []);
        const last = arr[arr.length - 1];
        if (typeof last === 'undefined') logger.info(`Temperature history: first reading for body ${bodyId} since the last 24 hours of data; saving to ${this.file()}`);
        if (typeof last === 'undefined' || now - last.t >= SAMPLE_MS - 5000) {
            const s: TempSample = { t: now, v: temp };
            if (typeof live === 'number' && isFinite(live) && Math.abs(live - temp) >= 0.05) s.l = live;
            if (typeof projected === 'number' && isFinite(projected)) s.p = Math.round(projected * 100) / 100;
            if (typeof setPoint === 'number' && isFinite(setPoint) && setPoint > 0) s.s = setPoint;
            arr.push(s);
            const cutoff = now - WINDOW_MS;
            while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
            this.dirty = true;
            this.rollUp(bodyId, now);
        }
        if (this.dirty && now - this.lastSave >= SAVE_MS) this.save(now);
    }
    // The mean of the readings in the last 24 hours, to a tenth of a degree, or undefined when there are none.
    public average(bodyId: number, now: number = Date.now()): number | undefined {
        if (!this.loaded) this.load();
        const arr = this.samples[bodyId];
        if (typeof arr === 'undefined') return undefined;
        const cutoff = now - WINDOW_MS;
        let sum = 0, count = 0;
        for (let i = 0; i < arr.length; i++) if (arr[i].t >= cutoff) { sum += arr[i].v; count++; }
        return count > 0 ? Math.round((sum / count) * 10) / 10 : undefined;
    }
    // The readings of the last 24 hours, oldest first, as five lists (time, shown, live, projected and setpoint, the last three null
    // where not kept), for a chart.
    public series(bodyId: number, now: number = Date.now()): { t: number[], v: number[], l: number[], p: number[], s: number[] } {
        if (!this.loaded) this.load();
        const out = { t: [], v: [], l: [], p: [], s: [] };
        const arr = this.samples[bodyId];
        if (typeof arr === 'undefined') return out;
        const cutoff = now - WINDOW_MS;
        for (let i = 0; i < arr.length; i++) {
            const s = arr[i];
            if (s.t < cutoff) continue;
            out.t.push(s.t); out.v.push(s.v); out.l.push(typeof s.l === 'number' ? s.l : null); out.p.push(typeof s.p === 'number' ? s.p : null);
            out.s.push(typeof s.s === 'number' ? s.s : null);
        }
        return out;
    }
    // The highest and the lowest reading in the last 24 hours, with the time of each (the latest one when a value repeats),
    // or undefined when there are none.
    public extremes(bodyId: number, now: number = Date.now()): { high: TempSample, low: TempSample } | undefined {
        if (!this.loaded) this.load();
        const arr = this.samples[bodyId];
        if (typeof arr === 'undefined') return undefined;
        const cutoff = now - WINDOW_MS;
        let high: TempSample, low: TempSample;
        for (let i = 0; i < arr.length; i++) {
            const s = arr[i];
            if (s.t < cutoff) continue;
            if (typeof high === 'undefined' || s.v >= high.v) high = s;
            if (typeof low === 'undefined' || s.v <= low.v) low = s;
        }
        return typeof high === 'undefined' ? undefined : { high: high, low: low };
    }
    // The last `days` days of a body's readings, one row an hour (or one a day with `daily`), oldest first, with the mean, the high and the
    // low over them all and how many hours they cover. The hour under way is included from its minute readings.
    public range(bodyId: number, days: number, daily: boolean, now: number = Date.now()): TempRange {
        if (!this.loaded) this.load();
        const out: TempRange = { t: [], v: [], hi: [], lo: [], p: [], s: [] };
        const from = now - days * 24 * HOUR_MS;
        let rows = (this.hourly[bodyId] || []).filter(r => r.t + HOUR_MS > from).concat(this.pendingHours(bodyId, Infinity));
        if (rows.length === 0) return out;
        if (daily) rows = this.group(rows, t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); });
        const all = this.group(rows, t => 0)[0];
        for (const r of rows) {
            out.t.push(r.t); out.v.push(r.v); out.hi.push(r.hi); out.lo.push(r.lo);
            out.p.push(typeof r.p === 'number' ? r.p : null); out.s.push(typeof r.s === 'number' ? r.s : null);
        }
        out.avg = Math.round(all.v * 10) / 10;
        out.high = all.hi; out.highAt = all.ht; out.low = all.lo; out.lowAt = all.lt;
        out.hours = Math.round(Math.min(days * 24, (now - Math.max(from, rows[0].t)) / HOUR_MS) * 10) / 10;
        return out;
    }
    // How many hours of readings the average covers (up to 24), to a tenth, so a short record is not mistaken for a full day.
    public hours(bodyId: number, now: number = Date.now()): number | undefined {
        if (!this.loaded) this.load();
        const arr = this.samples[bodyId];
        if (typeof arr === 'undefined' || arr.length === 0) return undefined;
        const first = arr.find(s => s.t >= now - WINDOW_MS);
        if (typeof first === 'undefined') return undefined;
        return Math.round(Math.min(24, (now - first.t) / 3600000) * 10) / 10;
    }
}
export const tempHistory = new TempHistory();
