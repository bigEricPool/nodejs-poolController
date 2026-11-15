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

// Writes an SWG entry to the pool owner's PoolMath log when the chlorinator's pool % changes (PoolMathClient.ts does the talking). Off by
// default (the poolMath section's swgLogEnabled), and it needs the SWG run hours a day (swgLogHours, whole hours) and the encrypted
// credentials file. The rules:
//   - one entry each time the pool % setting changes to a new value while njsPC runs, once it has held for HOLD_MS; it is timed at the
//     change. A change undone within that time writes nothing. Changes from dashPanel, the API, another njsPC feature or a panel all count: only the setting
//     is watched. The spa %, the power, the flow, the actual output and the run hours setting never write.
//   - never at a start: the % then becomes the starting point, also when it differs from the last one logged (STARTUP_GRACE_MS after a
//     start, a change only moves the starting point). The same when the writing is turned on, or the hours are not set.
//   - super chlorinate (ChlorinatorSuperChlorLog.ts): when a run ends, two entries: 100% for the hours the cell had power during the run
//     (rounded to whole hours; nothing when that is 0) with the FC the run made, timed at its start, and the pool % in force again with the
//     run hours a day, timed at its end. A run that ended while njsPC was stopped is written after the start. % changes during a run
//     write nothing themselves: the second entry carries the % the cell goes back to.
//   - only with exactly one chlorinator (PoolMath's SWG entries are the pool's), and only with a set clock.
//   - FC ppm = lb/day x %/100 x hours/24 / (gallons x 8.345e-6), rounded to 0.1, from the cell's rating and the pool volume
//     (ChlorinatorLogService.poolGallons).
//   - the SWG change itself never waits for PoolMath: entries wait in a queue saved in data/poolMathSwgLog.json (which also keeps the
//     starting point, so nothing is written twice across restarts) and are sent in time order. A failure PoolMath answered, or one where the
//     request never left, is retried every RETRY_MS for up to MAX_AGE_MS. A request that may have reached PoolMath with no answer (a timeout,
//     a dropped connection) is not retried, as that could log it twice; the status says to check PoolMath. At most MAX_PER_DAY entries a day.
// The status (GET /state/poolMath/swgLog) shows whether the credentials file was found, the last sign-in and the last error; never the
// username, password or token.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { clockLooksSet } from './ChlorinatorLog';
import { PoolMathClient, PoolMathError, swgChemlog } from './PoolMathClient';
import { SuperChlorRun } from './ChlorinatorSuperChlorLog';

export const HOLD_MS = 2 * 60 * 1000;
export const STARTUP_GRACE_MS = 3 * 60 * 1000;
export const RETRY_MS = 15 * 60 * 1000;
export const MAX_AGE_MS = 24 * 3600 * 1000;
export const MAX_PER_DAY = 24;
export const MIN_SEND_GAP_MS = 5 * 1000;
const LB_PER_GALLON_PPM = 8.345e-6;   // lb of chlorine per gallon for 1 ppm

// FC ppm an SWG run makes, rounded to 0.1 (0 when the rating or volume is unknown).
export function swgPpm(lbsPerDay: number, percent: number, hours: number, gallons: number): number {
    if (!(lbsPerDay > 0) || !(gallons > 0) || !(percent >= 0) || !(hours >= 0)) return 0;
    return Math.round(lbsPerDay * (percent / 100) * (hours / 24) / (gallons * LB_PER_GALLON_PPM) * 10) / 10;
}

export type SwgEntryKind = 'change' | 'superChlorRun' | 'superChlorRestore';
export interface QueuedSwgEntry { kind: SwgEntryKind; ts: number; percent: number; hours: number; ppm: number; queuedAt: number; nextAt: number; tries: number; }
interface SwgLogFile {
    baseline?: { percent: number; at: number };   // the last % logged (or taken as the starting point)
    queue: QueuedSwgEntry[];
    sent: number[];                                // when entries were sent, for the daily limit (the last day only)
    lastWritten?: { kind: SwgEntryKind; ts: number; percent: number; hours: number; ppm: number; at: number; id?: string };
    lastError?: string; lastErrorAt?: number;
    lastSignInAt?: number; lastSignInFailedAt?: number;
}

export interface SwgLogReading {
    ok: boolean; reason?: string;
    percent?: number; superChlorOn?: boolean; lbsPerDay?: number; gallons?: number;
}
export interface SwgLogSettings { enabled: boolean; hours: number; }
type Client = Pick<PoolMathClient, 'request' | 'poolId' | 'ensureSession' | 'credentialsFileFound'> & { userId?: string; lastSignInAt?: number; lastSignInError?: string };

export interface SwgLogStatus {
    enabled: boolean; hoursPerDay: number;
    credentialsFile: 'found' | 'missing';
    lastSignIn?: { ok: boolean; at?: string };
    lastError?: string; lastErrorAt?: string;
    pending: number; baselinePercent?: number;
    lastWritten?: { kind: SwgEntryKind; ts: string; percent: number; hours: number; ppm: number; at: string };
    note?: string;
}

export class SwgLogWriter {
    private data: SwgLogFile = { queue: [], sent: [] };
    private candidate?: { percent: number; at: number };
    private startedAt = 0;
    private wasEnabled = false;
    private sending = false;
    private lastSendAt = 0;
    private note?: string;

    constructor(private readonly deps: { client: Client; settings: () => SwgLogSettings; reading: () => SwgLogReading; file: string; now?: () => number }) { }
    private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

    public start() {
        this.startedAt = this.now();
        try {
            const j = JSON.parse(fs.readFileSync(this.deps.file, 'utf8'));
            if (j && typeof j === 'object') this.data = { ...j, queue: Array.isArray(j.queue) ? j.queue : [], sent: Array.isArray(j.sent) ? j.sent : [] };
        } catch (err) {
            if (err && err.code !== 'ENOENT') logger.warn(`PoolMath SWG log: could not read ${this.deps.file}: ${err.message}`);
        }
        this.wasEnabled = this.deps.settings().enabled;
    }
    private save() {
        try {
            fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
            fs.writeFileSync(this.deps.file + '.tmp', JSON.stringify(this.data), 'utf8');
            fs.renameSync(this.deps.file + '.tmp', this.deps.file);
        } catch (err) { logger.warn(`PoolMath SWG log: could not save ${this.deps.file}: ${err.message}`); }
    }
    private setError(msg: string | undefined, now: number) {
        if (msg) { this.data.lastError = msg; this.data.lastErrorAt = now; logger.warn(`PoolMath SWG log: ${msg}`); }
        else { this.data.lastError = undefined; this.data.lastErrorAt = undefined; }
    }
    private setBaseline(percent: number, at: number, why: string) {
        const before = this.data.baseline ? this.data.baseline.percent : undefined;
        this.data.baseline = { percent, at };
        if (before !== percent) logger.info(`PoolMath SWG log: ${percent}% taken as the starting point (${why}); nothing written to PoolMath.`);
        this.save();
    }
    private enqueue(kind: SwgEntryKind, ts: number, percent: number, hours: number, ppm: number, now: number) {
        this.data.queue.push({ kind, ts, percent, hours, ppm, queuedAt: now, nextAt: now, tries: 0 });
        this.data.queue.sort((a, b) => a.ts - b.ts);
        logger.info(`PoolMath SWG log: queued SWG ${hours} h @ ${percent}%, ${ppm} ppm, at ${new Date(ts).toISOString()} (${kind}).`);
    }

    // One check (every 15 seconds): watches the pool %, then sends what is due. Never throws.
    public async tick(): Promise<void> {
        const now = this.now();
        try {
            const set = this.deps.settings();
            if (!set.enabled) {
                if (this.wasEnabled) {
                    this.wasEnabled = false;
                    this.data.baseline = undefined; this.data.queue = []; this.candidate = undefined;
                    this.save();
                    logger.info('PoolMath SWG log: turned off; nothing more is written to PoolMath.');
                }
                this.note = undefined;
                return;
            }
            const justEnabled = !this.wasEnabled;
            this.wasEnabled = true;
            if (!clockLooksSet(now)) { this.note = 'Waiting for the clock to be set.'; return; }
            const r = this.deps.reading();
            if (!r.ok) { this.note = r.reason; this.candidate = undefined; await this.sendDue(now); return; }
            this.note = set.hours > 0 ? undefined : 'Set the SWG run hours a day; nothing is written until then.';
            const pct = r.percent;
            if (justEnabled) { this.candidate = undefined; this.setBaseline(pct, now, 'the writing was turned on'); }
            else if (now - this.startedAt < STARTUP_GRACE_MS || !this.data.baseline) { this.candidate = undefined; this.setBaseline(pct, now, 'njsPC started'); }
            else if (r.superChlorOn) this.candidate = undefined;
            else if (pct === this.data.baseline.percent) this.candidate = undefined;
            else {
                if (!this.candidate || this.candidate.percent !== pct) this.candidate = { percent: pct, at: now };
                if (now - this.candidate.at >= HOLD_MS) {
                    const c = this.candidate;
                    this.candidate = undefined;
                    if (set.hours > 0) this.enqueue('change', c.at, c.percent, set.hours, swgPpm(r.lbsPerDay, c.percent, set.hours, r.gallons), now);
                    this.data.baseline = { percent: c.percent, at: c.at };
                    this.save();
                }
            }
            if (now - this.startedAt >= STARTUP_GRACE_MS) await this.sendDue(now);
        } catch (err) { logger.warn(`PoolMath SWG log: ${err.message}`); }
    }

    // A super chlorinate run ended: 100% for its powered hours at its start, then the pool % in force at its end.
    public superChlorEnded(run: SuperChlorRun) {
        try {
            const now = this.now();
            const set = this.deps.settings();
            if (!set.enabled || !(set.hours > 0)) return;
            const r = this.deps.reading();
            if (!r.ok) return;
            const hours = Math.round(run.poweredHours);
            this.candidate = undefined;
            if (hours <= 0) { logger.info('PoolMath SWG log: super chlorinate ran less than half an hour with power; nothing written to PoolMath.'); return; }
            this.enqueue('superChlorRun', run.start, 100, hours, swgPpm(r.lbsPerDay, 100, run.poweredHours, r.gallons), now);
            this.enqueue('superChlorRestore', run.end, r.percent, set.hours, swgPpm(r.lbsPerDay, r.percent, set.hours, r.gallons), now);
            this.data.baseline = { percent: r.percent, at: run.end };
            this.save();
        } catch (err) { logger.warn(`PoolMath SWG log: ${err.message}`); }
    }

    private async sendDue(now: number) {
        if (this.sending || !this.data.queue.length) return;
        this.sending = true;
        try {
            while (this.data.queue.length) {
                const e = this.data.queue[0];
                if (now - e.queuedAt > MAX_AGE_MS) {
                    this.data.queue.shift();
                    this.setError(`An entry (SWG ${e.hours} h @ ${e.percent}% at ${new Date(e.ts).toISOString()}) could not be written for ${MAX_AGE_MS / 3600000} h and was dropped.`, now);
                    this.save();
                    continue;
                }
                if (e.nextAt > now) break;
                this.data.sent = this.data.sent.filter(t => now - t < 24 * 3600 * 1000);
                if (this.data.sent.length >= MAX_PER_DAY) {
                    if (this.data.lastError !== 'The daily limit of PoolMath entries was reached; the rest wait.') this.setError('The daily limit of PoolMath entries was reached; the rest wait.', now);
                    this.save();
                    break;
                }
                if (now - this.lastSendAt < MIN_SEND_GAP_MS) break;
                this.lastSendAt = now;
                e.tries++;
                try {
                    const poolId = await this.deps.client.poolId();
                    const s = await this.deps.client.ensureSession();
                    const res = await this.deps.client.request('POST', 'chemlogs', swgChemlog({ poolId, userId: s.userId, ts: e.ts, percent: e.percent, hours: e.hours, ppm: e.ppm }));
                    this.data.queue.shift();
                    this.data.sent.push(now);
                    const id = res && res.log && typeof res.log.id === 'string' ? res.log.id : undefined;
                    this.data.lastWritten = { kind: e.kind, ts: e.ts, percent: e.percent, hours: e.hours, ppm: e.ppm, at: now, id };
                    this.setError(undefined, now);
                    logger.info(`PoolMath SWG log: wrote SWG ${e.hours} h @ ${e.percent}%, ${e.ppm} ppm, at ${new Date(e.ts).toISOString()}${id ? '' : ' (PoolMath sent no log id back)'}.`);
                }
                catch (err) {
                    if (err instanceof PoolMathError && err.maybeSent) {
                        this.data.queue.shift();
                        this.setError(`${err.message}. The entry SWG ${e.hours} h @ ${e.percent}% at ${new Date(e.ts).toISOString()} may or may not have been logged: check PoolMath. It is not sent again, so it cannot be logged twice.`, now);
                    }
                    else {
                        e.nextAt = now + RETRY_MS;
                        this.setError(`${err.message} (trying again in ${RETRY_MS / 60000} min).`, now);
                    }
                    break;
                }
                finally {
                    const c = this.deps.client;
                    if (c.lastSignInAt) this.data.lastSignInAt = c.lastSignInAt;
                    if (c.lastSignInError) this.data.lastSignInFailedAt = now;
                    else if (c.lastSignInAt) this.data.lastSignInFailedAt = undefined;
                    this.save();
                }
            }
        }
        finally { this.sending = false; }
    }

    public status(): SwgLogStatus {
        const set = this.deps.settings();
        const d = this.data;
        const iso = (ms?: number) => ms > 0 ? new Date(ms).toISOString() : undefined;
        let lastSignIn: SwgLogStatus['lastSignIn'];
        if (d.lastSignInFailedAt && (!d.lastSignInAt || d.lastSignInFailedAt >= d.lastSignInAt)) lastSignIn = { ok: false, at: iso(d.lastSignInFailedAt) };
        else if (d.lastSignInAt) lastSignIn = { ok: true, at: iso(d.lastSignInAt) };
        let found = false;
        try { found = this.deps.client.credentialsFileFound(); } catch (err) { /* not found */ }
        return {
            enabled: set.enabled, hoursPerDay: set.hours,
            credentialsFile: found ? 'found' : 'missing',
            lastSignIn,
            lastError: d.lastError, lastErrorAt: iso(d.lastErrorAt),
            pending: d.queue.length,
            baselinePercent: d.baseline ? d.baseline.percent : undefined,
            lastWritten: d.lastWritten ? { kind: d.lastWritten.kind, ts: iso(d.lastWritten.ts), percent: d.lastWritten.percent, hours: d.lastWritten.hours, ppm: d.lastWritten.ppm, at: iso(d.lastWritten.at) } : undefined,
            note: set.enabled ? (found ? this.note : 'No PoolMath credentials file has been created on this controller.') : undefined
        };
    }
}
