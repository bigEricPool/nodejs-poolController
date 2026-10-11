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

// The condition of the computer njsPC runs on, for a dashboard: processor temperature, processor and memory use, free storage, Wi-Fi signal,
// uptime, the power and heat flags of a Raspberry Pi, and whether other services on the same computer answer. It reports only: nothing in
// njsPC acts on it.
//
// Everything is read from the operating system (the os module and, on Linux, small files under /proc and /sys), and a figure the
// computer does not have is left out, so this works, with fewer figures, on any computer. The recent samples and the hourly maxima are kept
// in memory and start again when njsPC restarts.
//
// A longer record is kept in data/systemStatus/YYYY-MM.jsonl (one file per month, UTC), one JSON object per line, appended to and never
// rewritten: a row every logMinutes with the averages and maxima of that period, and an event each time one of a Raspberry Pi's power or heat
// flags comes on or goes off, so the periods the processor was slowed can be listed. Files older than keepDays are removed.
//
// It also measures how late njsPC itself runs: a timer that should fire every second records how late it fired. A long delay means njsPC was
// not running its work for that time (for example while a synchronous write waited on slow storage), which matters to anything that relies on
// njsPC refreshing it regularly.
//
// The settings are the `systemStatus` section of config.json: enabled, sampleSeconds, historyMinutes, tempWarn (degrees C), logEnabled,
// logMinutes, keepDays and services, a list of other services to look for, each { "name": "...", "port": 8080 } (optionally with "host") or { "name": "...", "process": "name" }.

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { logger } from '../logger/Logger';

const LINUX = process.platform === 'linux';
const TEMP_FILE = '/sys/class/thermal/thermal_zone0/temp';
const THROTTLED_FILE = '/sys/devices/platform/soc/soc:firmware/get_throttled';
const SLOW_MS = 60 * 1000;                  // the flags, Wi-Fi, storage and services are read this often
const LAG_MS = 1000;                        // the timer that measures how late njsPC runs
const LAG_LOG_MS = 2000;                    // a delay this long is written to the log
const LAG_WARN_MS = 5000;                   // a delay this long in the last day is a warning
const STORAGE_WARN_PCT = 90;
const HOUR_MS = 60 * 60 * 1000;
const HOURS_KEPT = 24;
const PORT_TIMEOUT_MS = 2000;
const THROTTLED_EXEC_MS = 30 * 1000;        // the flags are read this often when that takes starting vcgencmd; from the firmware's file, at every sample
const DAY_MS = 24 * HOUR_MS;
const EVENTS_KEPT = 50;                     // flag events kept in memory for the report
const LOG_RAW_DAYS = 3;                     // a request for up to this many days returns the rows as logged ...
const LOG_HOURLY_DAYS = 60;                 // ... up to this many, one row an hour; beyond that, one a day
const FLAG_NAMES = ['underVoltage', 'frequencyCapped', 'throttled', 'softTempLimit'];

export interface SystemServiceCheck { name: string; host?: string; port?: number; process?: string; }
export interface SystemStatusSettings {
    enabled: boolean; sampleSeconds: number; historyMinutes: number; tempWarn: number;
    logEnabled: boolean; logMinutes: number; keepDays: number;
    services: SystemServiceCheck[];
}
// A row of the log: the period starting at `t` (epoch ms) of `n` samples. temp, cpu and mem are averages, lag is the longest delay of njsPC in
// ms, and thr has a bit for each flag that was on at some time in the period (1 under-voltage, 2 frequency capped, 4 throttled, 8 soft
// temperature limit).
export interface SystemLogRow { t: number; n: number; temp?: number; tempMax?: number; cpu?: number; cpuMax?: number; mem?: number; lag: number; thr?: number; }
// A flag came on or went off at `t`. `brief` marks one that came on and went off again between two readings: only the computer's own record
// that it has happened since it started shows it, so its time is known only to within the two readings.
export interface SystemFlagEvent { t: number; e: string; on: boolean; brief?: boolean; temp?: number; }
// A period one flag was on. `end` is missing while it is still on, or when njsPC or the computer restarted before it went off.
export interface SystemFlagPeriod { e: string; start: number; end?: number; brief?: boolean; tempStart?: number; tempEnd?: number; }
export interface SystemLogReport { days: number; rowMinutes: number; rows: SystemLogRow[]; events: SystemFlagEvent[]; periods: SystemFlagPeriod[]; }
export interface SystemServiceState { name: string; isUp: boolean; port?: number; process?: string; since?: number; }
export interface SystemWarning { code: string; level: 'warn' | 'alert'; message: string; }
// The power and heat flags a Raspberry Pi keeps: `now` is happening at the moment, `sinceBoot` has happened since the computer started.
export interface SystemThrottleFlags { underVoltage: boolean; frequencyCapped: boolean; throttled: boolean; softTempLimit: boolean; }
export interface SystemInfo {
    model?: string; os: string; kernel: string; arch: string; cpuModel?: string; cpuCount: number; memTotal: number; node: string;
    storageDevice?: { name?: string; date?: string };
}
// One sample. temp is in degrees C, cpu and mem are percent in use, lag is the longest delay of njsPC since the previous sample, in ms.
interface Sample { t: number; temp?: number; cpu?: number; mem?: number; lag: number; }
interface HourMax { t: number; tempMax?: number; tempMaxAt?: number; cpuMax?: number; lagMax: number; lagMaxAt?: number; }
export interface SystemStatusReport {
    enabled: boolean; time: number;
    info?: SystemInfo;
    uptime?: number; appUptime?: number;            // seconds
    cpuTemp?: number; cpuUse?: number; load?: number[];
    memTotal?: number; memAvailable?: number; memUse?: number;
    storage?: { total: number; free: number; use: number };
    wifi?: { iface: string; signal?: number; quality?: number };
    throttled?: { raw: number; now: SystemThrottleFlags; sinceBoot: SystemThrottleFlags };
    services?: SystemServiceState[];
    day?: { hours: number; tempMax?: number; tempMaxAt?: number; lagMax: number; lagMaxAt?: number };
    warnings?: SystemWarning[];
    events?: SystemFlagEvent[];                     // the latest flag events since njsPC started
    log?: { enabled: boolean; minutes: number; keepDays: number };
    history?: { sampleSeconds: number; t: number[]; temp: number[]; cpu: number[]; mem: number[]; lag: number[] };
}

const round = (v: number, places: number): number => { const f = Math.pow(10, places); return Math.round(v * f) / f; };
const monoMs = (): number => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; };
async function readText(file: string): Promise<string | undefined> {
    try { return await fs.promises.readFile(file, 'utf8'); }
    catch (err) { return undefined; }
}

export function normalizeSystemStatusSettings(cfg: any): SystemStatusSettings {
    cfg = cfg || {};
    let sampleSeconds = parseInt(cfg.sampleSeconds, 10), historyMinutes = parseInt(cfg.historyMinutes, 10), tempWarn = parseFloat(cfg.tempWarn);
    if (isNaN(sampleSeconds) || sampleSeconds < 2) sampleSeconds = 10;
    if (sampleSeconds > 300) sampleSeconds = 300;
    if (isNaN(historyMinutes) || historyMinutes < 1) historyMinutes = 60;
    if (historyMinutes > 24 * 60) historyMinutes = 24 * 60;
    if (isNaN(tempWarn) || tempWarn <= 0) tempWarn = 70;
    let logMinutes = parseInt(cfg.logMinutes, 10), keepDays = parseInt(cfg.keepDays, 10);
    if (isNaN(logMinutes) || logMinutes < 1) logMinutes = 5;
    if (logMinutes > 60) logMinutes = 60;
    if (isNaN(keepDays) || keepDays < 1) keepDays = 400;
    const services: SystemServiceCheck[] = [];
    for (const s of Array.isArray(cfg.services) ? cfg.services : []) {
        if (!s || typeof s.name !== 'string' || s.name.trim() === '') continue;
        const port = parseInt(s.port, 10);
        const proc = typeof s.process === 'string' ? s.process.trim() : '';
        if (!isNaN(port) && port > 0 && port < 65536) services.push({ name: s.name.trim(), host: typeof s.host === 'string' && s.host.trim() !== '' ? s.host.trim() : '127.0.0.1', port: port });
        else if (proc !== '') services.push({ name: s.name.trim(), process: proc });
    }
    return { enabled: cfg.enabled !== false && cfg.enabled !== 'false', sampleSeconds: sampleSeconds, historyMinutes: historyMinutes, tempWarn: tempWarn,
        logEnabled: cfg.logEnabled !== false && cfg.logEnabled !== 'false', logMinutes: logMinutes, keepDays: keepDays, services: services
    };
}

// The flags of `vcgencmd get_throttled`: bits 0 to 3 are happening now, bits 16 to 19 have happened since the computer started.
export function parseThrottled(raw: number): { raw: number; now: SystemThrottleFlags; sinceBoot: SystemThrottleFlags } {
    const flags = (shift: number): SystemThrottleFlags => ({
        underVoltage: (raw & (1 << shift)) !== 0,
        frequencyCapped: (raw & (2 << shift)) !== 0,
        throttled: (raw & (4 << shift)) !== 0,
        softTempLimit: (raw & (8 << shift)) !== 0
    });
    return { raw: raw, now: flags(0), sinceBoot: flags(16) };
}

// The first wireless interface of /proc/net/wireless: its name, the link quality and, when the driver reports it in dBm, the signal level.
export function parseWireless(txt: string): { iface: string; signal?: number; quality?: number } | undefined {
    for (const line of (txt || '').split('\n')) {
        const m = /^\s*([^:\s|]+):\s+\S+\s+(-?\d+)\.?\s+(-?\d+)\.?/.exec(line);
        if (!m) continue;
        const quality = parseInt(m[2], 10), level = parseInt(m[3], 10);
        return { iface: m[1], quality: isNaN(quality) ? undefined : quality, signal: !isNaN(level) && level < 0 ? level : undefined };
    }
    return undefined;
}

// The periods each flag was on, from its events in time order.
export function flagPeriods(events: SystemFlagEvent[]): SystemFlagPeriod[] {
    const periods: SystemFlagPeriod[] = [];
    const open: { [e: string]: SystemFlagPeriod } = {};
    for (const ev of events) {
        if (ev.brief) { periods.push({ e: ev.e, start: ev.t, end: ev.t, brief: true, tempStart: ev.temp }); continue; }
        if (ev.on) {
            // An "on" while one is open means njsPC or the computer restarted in between: the earlier one is left without an end.
            open[ev.e] = { e: ev.e, start: ev.t, tempStart: ev.temp };
            periods.push(open[ev.e]);
        }
        else if (typeof open[ev.e] !== 'undefined') {
            open[ev.e].end = ev.t;
            open[ev.e].tempEnd = ev.temp;
            delete open[ev.e];
        }
    }
    return periods;
}

// Rows combined into periods of `bucketMs`: averages weighted by the number of samples, and the maxima.
export function combineRows(rows: SystemLogRow[], bucketMs: number): SystemLogRow[] {
    const out: SystemLogRow[] = [];
    let cur: SystemLogRow | undefined, tempW = 0, cpuW = 0, memW = 0, tempS = 0, cpuS = 0, memS = 0;
    const close = () => {
        if (typeof cur === 'undefined') return;
        if (tempW > 0) cur.temp = round(tempS / tempW, 1);
        if (cpuW > 0) cur.cpu = round(cpuS / cpuW, 1);
        if (memW > 0) cur.mem = round(memS / memW, 1);
        out.push(cur);
    };
    for (const r of rows) {
        const start = r.t - (r.t % bucketMs);
        if (typeof cur === 'undefined' || cur.t !== start) {
            close();
            cur = { t: start, n: 0, lag: 0 };
            tempW = cpuW = memW = tempS = cpuS = memS = 0;
        }
        const n = r.n > 0 ? r.n : 1;
        cur.n += n;
        if (typeof r.temp === 'number') { tempS += r.temp * n; tempW += n; }
        if (typeof r.cpu === 'number') { cpuS += r.cpu * n; cpuW += n; }
        if (typeof r.mem === 'number') { memS += r.mem * n; memW += n; }
        if (typeof r.tempMax === 'number' && (typeof cur.tempMax === 'undefined' || r.tempMax > cur.tempMax)) cur.tempMax = r.tempMax;
        if (typeof r.cpuMax === 'number' && (typeof cur.cpuMax === 'undefined' || r.cpuMax > cur.cpuMax)) cur.cpuMax = r.cpuMax;
        if (r.lag > cur.lag) cur.lag = r.lag;
        if (typeof r.thr === 'number') cur.thr = (cur.thr || 0) | r.thr;
    }
    close();
    return out;
}

export class SystemStatus {
    private getSettings: () => any;
    private sampleTimer: NodeJS.Timeout | undefined;
    private lagTimer: NodeJS.Timeout | undefined;
    private lagLast = 0;
    private lagMax = 0;
    private samples: Sample[] = [];
    private hours: HourMax[] = [];
    private cpuLast: { idle: number; total: number } | undefined;
    private slowAt = 0;
    private info: SystemInfo | undefined;
    private throttledRaw: number | undefined;
    private noVcgencmd = false;
    private wifi: { iface: string; signal?: number; quality?: number } | undefined;
    private storage: { total: number; free: number; use: number } | undefined;
    private services: SystemServiceState[] = [];
    private memAvailable: number | undefined;
    private enabled = false;
    private sampleSeconds = 10;
    private tempWarn = 70;
    private settings: SystemStatusSettings = normalizeSystemStatusSettings(undefined);
    private throttledAt = 0;
    private throttledViaExec = false;
    private events: SystemFlagEvent[] = [];
    // The period being gathered for the next row of the log.
    private acc: { start: number; n: number; tempS: number; tempN: number; tempMax?: number; cpuS: number; cpuN: number; cpuMax?: number; memS: number; memN: number; lag: number; thr?: number } | undefined;
    private writing: Promise<void> = Promise.resolve();
    private trimmedAt = 0;
    private logDir = path.join(process.cwd(), 'data', 'systemStatus');

    // Starts the sampling. `getSettings` returns the systemStatus section of config.json; it is read again at each sample, so a change of the
    // settings applies without a restart. The timers do not keep the process running.
    public start(getSettings: () => any) {
        this.getSettings = getSettings;
        if (typeof this.lagTimer === 'undefined') {
            this.lagLast = monoMs();
            this.lagTimer = setInterval(() => {
                const now = monoMs();
                const late = now - this.lagLast - LAG_MS;
                this.lagLast = now;
                if (late > this.lagMax) this.lagMax = late;
                if (late >= LAG_LOG_MS && this.enabled) logger.warn(`System: njsPC did not run for ${round(late / 1000, 1)} s.`);
            }, LAG_MS);
            this.lagTimer.unref();
        }
        this.arm(1000);
    }
    public stop() {
        if (typeof this.sampleTimer !== 'undefined') clearTimeout(this.sampleTimer);
        if (typeof this.lagTimer !== 'undefined') clearInterval(this.lagTimer);
        this.sampleTimer = this.lagTimer = undefined;
    }
    private arm(delayMs: number) {
        if (typeof this.sampleTimer !== 'undefined') clearTimeout(this.sampleTimer);
        this.sampleTimer = setTimeout(() => {
            this.sample()
                .catch(err => logger.error(`System: reading the system status failed: ${err.message}`))
                .finally(() => this.arm(this.enabled ? this.sampleSeconds * 1000 : SLOW_MS));
        }, delayMs);
        this.sampleTimer.unref();
    }

    private async sample() {
        const s = normalizeSystemStatusSettings(typeof this.getSettings === 'function' ? this.getSettings() : undefined);
        this.enabled = s.enabled;
        this.sampleSeconds = s.sampleSeconds;
        this.tempWarn = s.tempWarn;
        this.settings = s;
        if (!s.enabled) { this.samples = []; this.hours = []; this.lagMax = 0; this.cpuLast = undefined; this.acc = undefined; return; }
        const now = Date.now();
        const smp: Sample = { t: now, lag: Math.max(0, Math.round(this.lagMax)) };
        this.lagMax = 0;

        if (LINUX) {
            const txt = await readText(TEMP_FILE);
            const v = typeof txt === 'undefined' ? NaN : parseInt(txt.trim(), 10);
            if (!isNaN(v)) smp.temp = round(v / 1000, 1);
        }
        let idle = 0, total = 0;
        for (const c of os.cpus()) {
            idle += c.times.idle;
            total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
        }
        if (typeof this.cpuLast !== 'undefined' && total > this.cpuLast.total) smp.cpu = round(100 * (1 - (idle - this.cpuLast.idle) / (total - this.cpuLast.total)), 1);
        this.cpuLast = { idle: idle, total: total };

        const memTotal = os.totalmem();
        let avail = os.freemem();
        if (LINUX) {
            // MemAvailable counts memory the system can give back (file cache), which freemem does not.
            const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(await readText('/proc/meminfo') || '');
            if (m) avail = parseInt(m[1], 10) * 1024;
        }
        this.memAvailable = avail;
        if (memTotal > 0) smp.mem = round(100 * (1 - avail / memTotal), 1);

        this.samples.push(smp);
        const oldest = now - s.historyMinutes * 60 * 1000;
        while (this.samples.length > 0 && this.samples[0].t < oldest) this.samples.shift();

        const hourStart = now - (now % HOUR_MS);
        let h = this.hours.length > 0 ? this.hours[this.hours.length - 1] : undefined;
        if (typeof h === 'undefined' || h.t !== hourStart) {
            h = { t: hourStart, lagMax: 0 };
            this.hours.push(h);
            while (this.hours.length > HOURS_KEPT) this.hours.shift();
        }
        if (typeof smp.temp !== 'undefined' && (typeof h.tempMax === 'undefined' || smp.temp > h.tempMax)) { h.tempMax = smp.temp; h.tempMaxAt = now; }
        if (typeof smp.cpu !== 'undefined' && (typeof h.cpuMax === 'undefined' || smp.cpu > h.cpuMax)) h.cpuMax = smp.cpu;
        if (smp.lag > h.lagMax) { h.lagMax = smp.lag; h.lagMaxAt = now; }

        if (now - this.throttledAt >= (this.throttledViaExec ? THROTTLED_EXEC_MS : 0) || now < this.throttledAt) {
            this.throttledAt = now;
            this.noteThrottled(await this.readThrottled(), now, smp.temp, s);
        }
        this.gather(smp, s);
        if (now - this.slowAt >= SLOW_MS || now < this.slowAt) {
            this.slowAt = now;
            await this.sampleSlow(s);
        }
        if (s.logEnabled && (now - this.trimmedAt >= DAY_MS || now < this.trimmedAt)) {
            this.trimmedAt = now;
            this.trimLog(s.keepDays, now).catch(err => logger.warn(`System: removing old system status logs failed: ${err.message}`));
        }
    }

    // Compares the flags with the previous reading and records what came on or went off.
    private noteThrottled(raw: number | undefined, now: number, temp: number | undefined, s: SystemStatusSettings) {
        const prev = this.throttledRaw;
        this.throttledRaw = raw;
        if (typeof raw === 'undefined') return;
        for (let i = 0; i < FLAG_NAMES.length; i++) {
            const bit = 1 << i, since = 1 << (i + 16);
            const isOn = (raw & bit) !== 0, wasOn = typeof prev !== 'undefined' && (prev & bit) !== 0;
            if (isOn !== wasOn) this.addEvent({ t: now, e: FLAG_NAMES[i], on: isOn, temp: temp }, s);
            // On and off again between two readings: only the since-start flag shows it.
            else if (!isOn && typeof prev !== 'undefined' && (prev & since) === 0 && (raw & since) !== 0) this.addEvent({ t: now, e: FLAG_NAMES[i], on: false, brief: true, temp: temp }, s);
        }
        if (typeof this.acc !== 'undefined') this.acc.thr = (this.acc.thr || 0) | (raw & 0xF);
    }
    private addEvent(ev: SystemFlagEvent, s: SystemStatusSettings) {
        this.events.push(ev);
        while (this.events.length > EVENTS_KEPT) this.events.shift();
        logger.warn(`System: ${ev.e} ${ev.brief ? 'came on briefly' : ev.on ? 'came on' : 'went off'}${typeof ev.temp !== 'undefined' ? ` (processor at ${ev.temp} C)` : ''}.`);
        if (s.logEnabled) this.append(ev.t, ev);
    }

    // Adds the sample to the period being gathered, and writes the period to the log when the sample starts the next one.
    private gather(smp: Sample, s: SystemStatusSettings) {
        const logMs = s.logMinutes * 60 * 1000;
        const start = smp.t - (smp.t % logMs);
        if (typeof this.acc !== 'undefined' && this.acc.start !== start) {
            const a = this.acc;
            const row: SystemLogRow = { t: a.start, n: a.n, lag: a.lag };
            if (a.tempN > 0) { row.temp = round(a.tempS / a.tempN, 1); row.tempMax = a.tempMax; }
            if (a.cpuN > 0) { row.cpu = round(a.cpuS / a.cpuN, 1); row.cpuMax = a.cpuMax; }
            if (a.memN > 0) row.mem = round(a.memS / a.memN, 1);
            if (typeof a.thr !== 'undefined') row.thr = a.thr;
            if (s.logEnabled) this.append(a.start, row);
            this.acc = undefined;
        }
        if (typeof this.acc === 'undefined') {
            this.acc = { start: start, n: 0, tempS: 0, tempN: 0, cpuS: 0, cpuN: 0, memS: 0, memN: 0, lag: 0 };
            // A flag that is on carries into the new period.
            if (typeof this.throttledRaw !== 'undefined') this.acc.thr = this.throttledRaw & 0xF;
        }
        const a = this.acc;
        a.n++;
        if (typeof smp.temp !== 'undefined') { a.tempS += smp.temp; a.tempN++; if (typeof a.tempMax === 'undefined' || smp.temp > a.tempMax) a.tempMax = smp.temp; }
        if (typeof smp.cpu !== 'undefined') { a.cpuS += smp.cpu; a.cpuN++; if (typeof a.cpuMax === 'undefined' || smp.cpu > a.cpuMax) a.cpuMax = smp.cpu; }
        if (typeof smp.mem !== 'undefined') { a.memS += smp.mem; a.memN++; }
        if (smp.lag > a.lag) a.lag = smp.lag;
    }

    private logFile(t: number): string { return path.join(this.logDir, `${new Date(t).toISOString().slice(0, 7)}.jsonl`); }
    // Appends one line to the month's file. The writes are made one after another, and a failed one does not stop the next.
    private append(t: number, obj: any) {
        const line = JSON.stringify(obj) + '\n';
        this.writing = this.writing.then(async () => {
            try {
                await fs.promises.mkdir(this.logDir, { recursive: true });
                await fs.promises.appendFile(this.logFile(t), line, 'utf8');
            } catch (err) { logger.warn(`System: writing the system status log failed: ${err.message}`); }
        });
    }
    // Removes the months that ended more than keepDays ago.
    private async trimLog(keepDays: number, now: number) {
        let files: string[];
        try { files = await fs.promises.readdir(this.logDir); }
        catch (err) { return; }
        for (const f of files) {
            const m = /^(\d{4})-(\d{2})\.jsonl$/.exec(f);
            if (!m) continue;
            const monthEnd = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10), 1);
            if (monthEnd < now - keepDays * DAY_MS) await fs.promises.unlink(path.join(this.logDir, f));
        }
    }

    // The log of the last `days` days: the rows (as logged for a few days, hourly or daily for longer), the flag events and the periods each
    // flag was on. The files are read one month at a time so a long request does not hold njsPC up.
    public async readLog(days: number): Promise<SystemLogReport> {
        const s = this.settings;
        if (isNaN(days) || days <= 0) days = 1;
        if (days > s.keepDays) days = s.keepDays;
        const now = Date.now(), from = now - days * DAY_MS;
        await this.writing;
        const rows: SystemLogRow[] = [], events: SystemFlagEvent[] = [];
        const d = new Date(from);
        let y = d.getUTCFullYear(), mo = d.getUTCMonth();
        while (Date.UTC(y, mo, 1) <= now) {
            const txt = await readText(this.logFile(Date.UTC(y, mo, 1)));
            if (typeof txt !== 'undefined') {
                for (const line of txt.split('\n')) {
                    if (line === '') continue;
                    let o: any;
                    try { o = JSON.parse(line); } catch (err) { continue; }     // a line cut short by a power loss
                    if (!o || typeof o.t !== 'number' || o.t < from) continue;
                    if (typeof o.e === 'string') events.push(o);
                    else rows.push(o);
                }
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            if (++mo > 11) { mo = 0; y++; }
        }
        rows.sort((a, b) => a.t - b.t);
        events.sort((a, b) => a.t - b.t);
        let rowMinutes = s.logMinutes, out = rows;
        if (days > LOG_HOURLY_DAYS) { rowMinutes = 24 * 60; out = combineRows(rows, DAY_MS); }
        else if (days > LOG_RAW_DAYS) { rowMinutes = 60; out = combineRows(rows, HOUR_MS); }
        return { days: days, rowMinutes: rowMinutes, rows: out, events: events, periods: flagPeriods(events) };
    }

    // What changes slowly, or costs more to read.
    private async sampleSlow(s: SystemStatusSettings) {
        if (typeof this.info === 'undefined') this.info = await this.readInfo();
        this.wifi = LINUX ? parseWireless(await readText('/proc/net/wireless') || '') : undefined;
        try {
            const st = await fs.promises.statfs(process.cwd());
            const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
            this.storage = total > 0 ? { total: total, free: free, use: round(100 * (1 - free / total), 1) } : undefined;
        } catch (err) { this.storage = undefined; }

        const names = s.services.some(x => typeof x.process !== 'undefined') ? await this.processNames() : undefined;
        const now = Date.now();
        const next: SystemServiceState[] = [];
        for (const svc of s.services) {
            let isUp = false;
            if (typeof svc.port !== 'undefined') isUp = await this.checkPort(svc.host, svc.port);
            else if (typeof names !== 'undefined') isUp = names.has(svc.process);
            const prev = this.services.find(x => x.name === svc.name);
            next.push({ name: svc.name, isUp: isUp, port: svc.port, process: svc.process, since: typeof prev !== 'undefined' && prev.isUp === isUp ? prev.since : now });
        }
        this.services = next;
    }

    private async readInfo(): Promise<SystemInfo> {
        const cpus = os.cpus();
        const info: SystemInfo = {
            os: `${os.type()} ${os.release()}`, kernel: os.release(), arch: os.arch(),
            cpuModel: cpus.length > 0 && cpus[0].model ? cpus[0].model.trim() : undefined, cpuCount: cpus.length,
            memTotal: os.totalmem(), node: process.version
        };
        if (LINUX) {
            const model = await readText('/proc/device-tree/model');
            if (typeof model !== 'undefined') info.model = model.replace(/\0/g, '').trim();
            const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(await readText('/etc/os-release') || '');
            if (m && m[1].trim() !== '') info.os = m[1].trim();
            // The card or drive the system is on, when it is an SD or eMMC card.
            const name = await readText('/sys/block/mmcblk0/device/name'), date = await readText('/sys/block/mmcblk0/device/date');
            if (typeof name !== 'undefined' || typeof date !== 'undefined') info.storageDevice = { name: name ? name.trim() : undefined, date: date ? date.trim() : undefined };
        }
        return info;
    }

    // A Raspberry Pi's flags: from the firmware's file when the kernel has it, otherwise from vcgencmd. Undefined on any other computer.
    private async readThrottled(): Promise<number | undefined> {
        if (!LINUX) return undefined;
        const txt = await readText(THROTTLED_FILE);
        if (typeof txt !== 'undefined') {
            const v = parseInt(txt.trim(), 16);
            if (!isNaN(v)) return v;
        }
        if (this.noVcgencmd) return undefined;
        this.throttledViaExec = true;
        return new Promise<number | undefined>(resolve => {
            execFile('vcgencmd', ['get_throttled'], { timeout: 5000 }, (err, stdout) => {
                if (err) {
                    // Not a Raspberry Pi, or njsPC may not ask the firmware: do not try again.
                    this.noVcgencmd = true;
                    return resolve(undefined);
                }
                const m = /throttled=(0x[0-9a-fA-F]+)/.exec(String(stdout));
                resolve(m ? parseInt(m[1], 16) : undefined);
            });
        });
    }

    private checkPort(host: string, port: number): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            let done = false;
            const sock = net.connect({ host: host, port: port });
            const finish = (isUp: boolean) => {
                if (done) return;
                done = true;
                sock.destroy();
                resolve(isUp);
            };
            sock.setTimeout(PORT_TIMEOUT_MS);
            sock.once('connect', () => finish(true));
            sock.once('timeout', () => finish(false));
            sock.once('error', () => finish(false));
        });
    }

    // The names of the running processes (Linux only).
    private async processNames(): Promise<Set<string>> {
        const names = new Set<string>();
        if (!LINUX) return names;
        try {
            for (const pid of await fs.promises.readdir('/proc')) {
                if (!/^\d+$/.test(pid)) continue;
                const comm = await readText(`/proc/${pid}/comm`);
                if (typeof comm !== 'undefined') names.add(comm.trim());
            }
        } catch (err) { }
        return names;
    }

    private warnings(rep: SystemStatusReport): SystemWarning[] {
        const w: SystemWarning[] = [];
        const t = rep.throttled;
        if (typeof t !== 'undefined') {
            if (t.now.underVoltage) w.push({ code: 'underVoltageNow', level: 'alert', message: 'The supply voltage is too low right now. Check the power supply and its cable.' });
            else if (t.sinceBoot.underVoltage) w.push({ code: 'underVoltage', level: 'warn', message: 'The supply voltage was too low at some time since the computer started. Check the power supply and its cable.' });
            if (t.now.throttled || t.now.frequencyCapped) w.push({ code: 'throttledNow', level: 'alert', message: 'The processor is being slowed down right now.' });
            else if (t.sinceBoot.throttled || t.sinceBoot.frequencyCapped) w.push({ code: 'throttled', level: 'warn', message: 'The processor was slowed down at some time since the computer started.' });
            if (t.now.softTempLimit) w.push({ code: 'softTempLimitNow', level: 'alert', message: 'The processor is at its soft temperature limit and is being slowed to cool it.' });
            else if (t.sinceBoot.softTempLimit) w.push({ code: 'softTempLimit', level: 'warn', message: 'The processor reached its soft temperature limit at some time since the computer started.' });
        }
        if (typeof rep.cpuTemp !== 'undefined' && rep.cpuTemp >= this.tempWarn) w.push({ code: 'tempHigh', level: 'alert', message: `The processor is at ${rep.cpuTemp} C.` });
        if (typeof rep.storage !== 'undefined' && rep.storage.use >= STORAGE_WARN_PCT) w.push({ code: 'storageFull', level: 'warn', message: `Storage is ${Math.round(rep.storage.use)}% full.` });
        if (typeof rep.day !== 'undefined' && rep.day.lagMax >= LAG_WARN_MS) w.push({ code: 'stalled', level: 'warn', message: `njsPC did not run for ${round(rep.day.lagMax / 1000, 1)} s at one point in the last ${rep.day.hours} h.` });
        for (const svc of rep.services || []) if (!svc.isUp) w.push({ code: 'serviceDown', level: 'alert', message: `${svc.name} is not answering.` });
        return w;
    }

    // The latest figures, the maxima of the last day and, unless `history` is false, the recent samples for charts.
    public get(history: boolean = true): SystemStatusReport {
        const rep: SystemStatusReport = { enabled: this.enabled, time: Date.now() };
        if (!this.enabled) return rep;
        const last = this.samples.length > 0 ? this.samples[this.samples.length - 1] : undefined;
        rep.info = this.info;
        rep.uptime = Math.round(os.uptime());
        rep.appUptime = Math.round(process.uptime());
        // The load averages are always 0 on Windows.
        if (process.platform !== 'win32') rep.load = os.loadavg().map(v => round(v, 2));
        if (typeof last !== 'undefined') { rep.cpuTemp = last.temp; rep.cpuUse = last.cpu; rep.memUse = last.mem; }
        rep.memTotal = os.totalmem();
        rep.memAvailable = this.memAvailable;
        rep.storage = this.storage;
        rep.wifi = this.wifi;
        if (typeof this.throttledRaw !== 'undefined') rep.throttled = parseThrottled(this.throttledRaw);
        rep.services = this.services;
        if (this.hours.length > 0) {
            const day: SystemStatusReport['day'] = { hours: this.hours.length, lagMax: 0 };
            for (const h of this.hours) {
                if (typeof h.tempMax !== 'undefined' && (typeof day.tempMax === 'undefined' || h.tempMax > day.tempMax)) { day.tempMax = h.tempMax; day.tempMaxAt = h.tempMaxAt; }
                if (h.lagMax > day.lagMax) { day.lagMax = h.lagMax; day.lagMaxAt = h.lagMaxAt; }
            }
            rep.day = day;
        }
        rep.warnings = this.warnings(rep);
        rep.events = this.events;
        rep.log = { enabled: this.settings.logEnabled, minutes: this.settings.logMinutes, keepDays: this.settings.keepDays };
        if (history) {
            // A sample without a figure is null in its column, so the columns stay the same length.
            rep.history = {
                sampleSeconds: this.sampleSeconds,
                t: this.samples.map(x => x.t),
                temp: this.samples.map(x => typeof x.temp === 'undefined' ? null : x.temp),
                cpu: this.samples.map(x => typeof x.cpu === 'undefined' ? null : x.cpu),
                mem: this.samples.map(x => typeof x.mem === 'undefined' ? null : x.mem),
                lag: this.samples.map(x => x.lag)
            };
        }
        return rep;
    }
}
export const systemStatus = new SystemStatus();
