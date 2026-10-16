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
// The same record says which software was installed when: for njsPC's own folder and each folder listed in `repos`, the version in
// package.json, the fork (the owner and name of the repository the branch follows), the branch, the commit and its date and first line, and
// the number of files that differ from the commit and of files git does not track. A line is written when njsPC starts and whenever a folder's branch or commit changes. This is what is
// in the folder; a program that was not restarted after its folder changed still runs the older code, which is why njsPC's line also has the
// commit it started on. A folder that is built (it has a dist folder) is also checked against its build: when a source file (.ts) is newer
// than the newest file in dist, the source changed after the last build, as after a pull without a build. For njsPC a build newer than the
// time njsPC started means it was built but not restarted.
//
// It also measures how late njsPC itself runs: a timer that should fire every second records how late it fired. A long delay means njsPC was
// not running its work for that time (for example while a synchronous write waited on slow storage), which matters to anything that relies on
// njsPC refreshing it regularly.
//
// The settings are the `systemStatus` section of config.json: enabled, sampleSeconds, historyMinutes, tempWarn (degrees C), logEnabled,
// logMinutes, keepDays, repos, a list of other software folders to record, each { "name": "...", "path": "/folder" }, and services, a list of
// other services to look for, each { "name": "...", "port": 8080 } (optionally with "host") or { "name": "...", "process": "name" }.

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
const GIT_TIMEOUT_MS = 10 * 1000;
const SUBJECT_MAX = 120;
const BUILD_SCAN_MS = 15 * 60 * 1000;      // the source and build times are read again this often, or when the build or the commit changes
// Folders whose .ts files are not part of the program's build, or are too large to look through.
const SOURCE_SKIP = ['node_modules', 'dist', 'test', 'tests', 'data', 'logs', 'backups', 'replay'];
const pad2 = (n: number): string => (n < 10 ? '0' : '') + n;
const whenText = (t: number): string => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

export interface SystemServiceCheck { name: string; host?: string; port?: number; process?: string; }
export interface SystemStatusSettings {
    enabled: boolean; sampleSeconds: number; historyMinutes: number; tempWarn: number;
    logEnabled: boolean; logMinutes: number; keepDays: number;
    services: SystemServiceCheck[]; repos: SystemRepo[];
}
export interface SystemRepo { name: string; path: string; }
// What is installed in one folder. `fork` is owner/name of the repository the branch follows, `date` and `subject` are the commit's, `modified`
// is the number of tracked files that differ from the commit (so the code is not exactly that commit) and `untracked` the number of files
// in the folder that git does not track, such as backups. `runningCommit` (njsPC only) is the commit njsPC started on. Lines logged by the
// first version have `changed` instead, the two counted together. `builtAt` is the time of the newest file in the folder's dist and `sourceAt`
// that of the newest source file (epoch ms); `buildStale` is true when the source is newer than the build, and `builtAfterStart` (njsPC only)
// when njsPC was built after it started.
export interface SystemSoftware {
    name: string; version?: string; fork?: string; branch?: string; commit?: string; date?: string; subject?: string;
    modified?: number; untracked?: number; changed?: number;
    runningCommit?: string;
    builtAt?: number; sourceAt?: number; buildStale?: boolean; builtAfterStart?: boolean;
}
// A line of the log for one folder: `v` is its name and `start` marks the line written when njsPC started.
export interface SystemSoftwareRecord extends SystemSoftware { t: number; v: string; start?: boolean; }
// A row of the log: the period starting at `t` (epoch ms) of `n` samples. temp, cpu and mem are averages, lag is the longest delay of njsPC in
// ms, and thr has a bit for each flag that was on at some time in the period (1 under-voltage, 2 frequency capped, 4 throttled, 8 soft
// temperature limit).
export interface SystemLogRow { t: number; n: number; temp?: number; tempMax?: number; cpu?: number; cpuMax?: number; mem?: number; lag: number; thr?: number; }
// A flag came on or went off at `t`. `brief` marks one that came on and went off again between two readings: only the computer's own record
// that it has happened since it started shows it, so its time is known only to within the two readings.
export interface SystemFlagEvent { t: number; e: string; on: boolean; brief?: boolean; temp?: number; }
// A period one flag was on. `end` is missing while it is still on, or when njsPC or the computer restarted before it went off.
export interface SystemFlagPeriod { e: string; start: number; end?: number; brief?: boolean; tempStart?: number; tempEnd?: number; }
export interface SystemLogReport { days: number; rowMinutes: number; rows: SystemLogRow[]; events: SystemFlagEvent[]; periods: SystemFlagPeriod[]; software: SystemSoftwareRecord[]; }
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
    software?: SystemSoftware[];
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
    const repos: SystemRepo[] = [];
    for (const r of Array.isArray(cfg.repos) ? cfg.repos : []) {
        if (!r || typeof r.name !== 'string' || r.name.trim() === '' || typeof r.path !== 'string' || r.path.trim() === '') continue;
        repos.push({ name: r.name.trim(), path: r.path.trim() });
    }
    return { enabled: cfg.enabled !== false && cfg.enabled !== 'false', sampleSeconds: sampleSeconds, historyMinutes: historyMinutes, tempWarn: tempWarn,
        logEnabled: cfg.logEnabled !== false && cfg.logEnabled !== 'false', logMinutes: logMinutes, keepDays: keepDays, services: services, repos: repos
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

// owner/name from a git remote's address ("https://host/owner/name.git", "git@host:owner/name.git"). Anything before the host, such as a
// user name or an access token, is never part of the result.
export function forkOfUrl(url: string): string | undefined {
    const m = /[:\/]([^\/:@]+)\/([^\/:@]+?)(?:\.git)?\/?$/.exec((url || '').trim());
    return m ? `${m[1]}/${m[2]}` : undefined;
}
// The remotes' addresses and the remote each branch follows, from a git config file.
export function parseGitConfig(txt: string): { remotes: { [name: string]: string }; branches: { [name: string]: string } } {
    const cfg = { remotes: {} as { [name: string]: string }, branches: {} as { [name: string]: string } };
    let kind = '', name = '';
    for (const line of (txt || '').split('\n')) {
        const sec = /^\s*\[\s*(\w+)(?:\s+"(.*)")?\s*\]\s*$/.exec(line);
        if (sec) { kind = sec[1].toLowerCase(); name = sec[2] || ''; continue; }
        const kv = /^\s*(\w+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!kv || name === '') continue;
        if (kind === 'remote' && kv[1].toLowerCase() === 'url') cfg.remotes[name] = kv[2];
        else if (kind === 'branch' && kv[1].toLowerCase() === 'remote') cfg.branches[name] = kv[2];
    }
    return cfg;
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
    private software: SystemSoftware[] = [];
    private softwareKeys: { [name: string]: string } = {};
    private startCommit: string | undefined;
    private startCommitRead = false;
    private processStart = Date.now() - process.uptime() * 1000;
    private builds: { [dir: string]: { probe?: number; commitKey: string; scannedAt: number; builtAt?: number; sourceAt?: number } } = {};

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
        const rows: SystemLogRow[] = [], events: SystemFlagEvent[] = [], software: SystemSoftwareRecord[] = [];
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
                    if (typeof o.v === 'string') software.push(o);
                    else if (typeof o.e === 'string') events.push(o);
                    else rows.push(o);
                }
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            if (++mo > 11) { mo = 0; y++; }
        }
        rows.sort((a, b) => a.t - b.t);
        events.sort((a, b) => a.t - b.t);
        software.sort((a, b) => a.t - b.t);
        let rowMinutes = s.logMinutes, out = rows;
        if (days > LOG_HOURLY_DAYS) { rowMinutes = 24 * 60; out = combineRows(rows, DAY_MS); }
        else if (days > LOG_RAW_DAYS) { rowMinutes = 60; out = combineRows(rows, HOUR_MS); }
        return { days: days, rowMinutes: rowMinutes, rows: out, events: events, periods: flagPeriods(events), software: software };
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
        await this.checkSoftware(s, now);
    }

    // The folder's git data: where it is, the branch and the commit. Read from git's own files, so nothing is started to look.
    private async readRepoHead(dir: string): Promise<{ gitDir: string; branch?: string; commit?: string } | undefined> {
        let gitDir = path.join(dir, '.git');
        // In a linked worktree .git is a file that names the folder.
        const dot = await readText(gitDir);
        if (typeof dot !== 'undefined') {
            const m = /^gitdir:\s*(.+)$/m.exec(dot);
            if (m) gitDir = path.resolve(dir, m[1].trim());
        }
        const head = await readText(path.join(gitDir, 'HEAD'));
        if (typeof head === 'undefined') return undefined;
        let common = gitDir;
        const cd = await readText(path.join(gitDir, 'commondir'));
        if (typeof cd !== 'undefined') common = path.resolve(gitDir, cd.trim());
        const m = /^ref:\s*(\S+)/.exec(head.trim());
        if (!m) return { gitDir: common, commit: head.trim() };
        const ref = m[1];
        let commit = await readText(path.join(common, ref));
        if (typeof commit === 'undefined') {
            for (const line of (await readText(path.join(common, 'packed-refs')) || '').split('\n')) {
                const parts = line.trim().split(' ');
                if (parts.length === 2 && parts[1] === ref) { commit = parts[0]; break; }
            }
        }
        return { gitDir: common, branch: ref.replace(/^refs\/heads\//, ''), commit: typeof commit === 'undefined' ? undefined : commit.trim() };
    }
    private runGit(dir: string, args: string[]): Promise<string | undefined> {
        return new Promise<string | undefined>(resolve => {
            execFile('git', ['-C', dir].concat(args), { timeout: GIT_TIMEOUT_MS }, (err, stdout) => resolve(err ? undefined : String(stdout)));
        });
    }
    // Looks at njsPC's folder and each listed folder; when a branch or commit is not the one last recorded, reads the details and records them.
    private async checkSoftware(s: SystemStatusSettings, now: number) {
        const repos: SystemRepo[] = [{ name: 'njsPC', path: process.cwd() }].concat(s.repos.filter(r => r.name !== 'njsPC'));
        const list: SystemSoftware[] = [];
        for (const r of repos) {
            const head = await this.readRepoHead(r.path);
            if (r.name === 'njsPC' && !this.startCommitRead) { this.startCommitRead = true; this.startCommit = typeof head !== 'undefined' ? head.commit : undefined; }
            const commitKey = typeof head === 'undefined' ? 'none' : `${head.branch || ''}|${head.commit || ''}`;
            const build = await this.checkBuild(r.path, commitKey, now);
            const buildStale = typeof build.builtAt === 'number' && typeof build.sourceAt === 'number' && build.sourceAt > build.builtAt + 1000;
            const builtAfterStart = r.name === 'njsPC' && typeof build.builtAt === 'number' && build.builtAt > this.processStart + 5000;
            const key = `${commitKey}|${buildStale ? 'stale' : ''}|${builtAfterStart ? 'rebuilt' : ''}`;
            const prev = this.software.find(x => x.name === r.name);
            if (typeof prev !== 'undefined' && this.softwareKeys[r.name] === key) {
                prev.builtAt = build.builtAt;
                prev.sourceAt = build.sourceAt;
                list.push(prev);
                continue;
            }
            const isStart = typeof this.softwareKeys[r.name] === 'undefined';
            this.softwareKeys[r.name] = key;
            const sw: SystemSoftware = { name: r.name };
            try { sw.version = JSON.parse(await readText(path.join(r.path, 'package.json')) || '{}').version; } catch (err) { }
            if (typeof head !== 'undefined') {
                sw.branch = head.branch;
                sw.commit = head.commit;
                const cfg = parseGitConfig(await readText(path.join(head.gitDir, 'config')) || '');
                const names = Object.keys(cfg.remotes);
                const remote = typeof head.branch !== 'undefined' && typeof cfg.branches[head.branch] !== 'undefined' ? cfg.branches[head.branch] : names.indexOf('origin') !== -1 ? 'origin' : names[0];
                if (typeof remote !== 'undefined' && typeof cfg.remotes[remote] !== 'undefined') sw.fork = forkOfUrl(cfg.remotes[remote]);
                // The commit's date and first line, and the counts of files, need git itself; without it they are left out.
                const log = await this.runGit(r.path, ['log', '-1', '--format=%cI%x1f%s']);
                if (typeof log !== 'undefined') {
                    const parts = log.trim().split('\x1f');
                    sw.date = parts[0] || undefined;
                    if (parts.length > 1) sw.subject = parts[1].length > SUBJECT_MAX ? parts[1].substring(0, SUBJECT_MAX) : parts[1];
                }
                const status = await this.runGit(r.path, ['status', '--porcelain']);
                if (typeof status !== 'undefined') {
                    const lines = status.split('\n').filter(x => x.trim() !== '');
                    sw.untracked = lines.filter(x => x.startsWith('??')).length;
                    sw.modified = lines.length - sw.untracked;
                }
            }
            if (r.name === 'njsPC') sw.runningCommit = this.startCommit;
            sw.builtAt = build.builtAt;
            sw.sourceAt = build.sourceAt;
            if (typeof build.builtAt === 'number') sw.buildStale = buildStale;
            if (r.name === 'njsPC' && typeof build.builtAt === 'number') sw.builtAfterStart = builtAfterStart;
            list.push(sw);
            if (s.logEnabled) {
                const rec: SystemSoftwareRecord = Object.assign({ t: now, v: r.name }, sw);
                if (isStart) rec.start = true;
                this.append(now, rec);
            }
            if (!isStart) logger.info(`System: ${r.name} is now at ${sw.branch || ''} ${typeof sw.commit !== 'undefined' ? sw.commit.substring(0, 8) : ''}${buildStale ? ', not built since its source changed' : ''}${builtAfterStart ? ', built after njsPC started' : ''}.`);
        }
        this.software = list;
    }

    // The newest build and source times of a folder. The folder is looked through again when its build or commit changed or after
    // BUILD_SCAN_MS; otherwise the times found last are used.
    private async checkBuild(dir: string, commitKey: string, now: number): Promise<{ builtAt?: number; sourceAt?: number }> {
        let probe: number | undefined;
        try { probe = Math.round((await fs.promises.stat(path.join(dir, 'dist', 'app.js'))).mtimeMs); } catch (err) { probe = undefined; }
        let c = this.builds[dir];
        if (typeof c === 'undefined' || c.probe !== probe || c.commitKey !== commitKey || now - c.scannedAt >= BUILD_SCAN_MS || now < c.scannedAt) {
            c = { probe: probe, commitKey: commitKey, scannedAt: now };
            if (typeof probe !== 'undefined') {
                c.builtAt = await this.newestFile(path.join(dir, 'dist'), n => n.endsWith('.js'), ['node_modules']);
                c.sourceAt = await this.newestFile(dir, n => n.endsWith('.ts') && !n.endsWith('.d.ts'), SOURCE_SKIP);
            }
            this.builds[dir] = c;
        }
        return c;
    }
    // The time of the newest file in a folder and the folders under it whose name passes `test`, leaving out the folders named in `skip`
    // and anything whose name starts with a dot.
    private async newestFile(dir: string, test: (name: string) => boolean, skip: string[]): Promise<number | undefined> {
        let newest: number | undefined;
        const walk = async (d: string, depth: number) => {
            if (depth > 10) return;
            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(d, { withFileTypes: true }); }
            catch (err) { return; }
            for (const e of entries) {
                if (e.name.startsWith('.')) continue;
                const full = path.join(d, e.name);
                if (e.isDirectory()) { if (skip.indexOf(e.name) === -1) await walk(full, depth + 1); }
                else if (e.isFile() && test(e.name)) {
                    try {
                        const t = Math.round((await fs.promises.stat(full)).mtimeMs);
                        if (typeof newest === 'undefined' || t > newest) newest = t;
                    } catch (err) { }
                }
            }
        };
        await walk(dir, 0);
        return newest;
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
                    // Not a Raspberry Pi, or njsPC may not ask the firmware: do not try again. Any other failure (a slow start, for one) is tried again.
                    const code = (err as any).code;
                    if (code === 'ENOENT' || code === 'EACCES') this.noVcgencmd = true;
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
        for (const sw of rep.software || []) {
            if (sw.buildStale) w.push({ code: 'notBuilt', level: 'warn', message: `${sw.name}: the source changed after the last build (built ${whenText(sw.builtAt)}, source ${whenText(sw.sourceAt)}). Build it in its folder (npm run build), then restart it.` });
            if (sw.builtAfterStart) w.push({ code: 'builtNotRestarted', level: 'warn', message: `njsPC was built at ${whenText(sw.builtAt)}, after it started: restart it to run the new build.` });
            if (typeof sw.runningCommit !== 'undefined' && typeof sw.commit !== 'undefined' && sw.runningCommit !== sw.commit) w.push({ code: 'notRestarted', level: 'warn', message: `${sw.name} is running ${sw.runningCommit.substring(0, 8)} but its folder is at ${sw.commit.substring(0, 8)}: it has not been restarted since the folder changed.` });
        }
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
        rep.software = this.software;
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
