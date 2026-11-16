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
//   - one entry each time the pool % setting or the whole-hour run time changes while njsPC runs, once it has held for HOLD_MS; it is
//     timed at the change. A change undone within that time writes nothing. Changes from dashPanel, the API, another njsPC feature or a panel
//     all count: only the setting is watched. The spa %, the power, the flow and the actual output never write.
//   - a feeder: another module that keeps its own record of the SWG's changes (with the exact time, rate and hours it worked out) can hand
//     each one in (PoolMathSwgLogService.submitPoolMathSwgEntry) while it is registered (setPoolMathSwgFeeder). The setting is then not
//     watched: each handed-in change is written as given (its time, %, FC ppm a day; the hours rounded to whole hours for PoolMath) when its
//     % or whole hours differ from the last one logged, the last of several within HOLD_MS only. Without a feeder, the setting is watched.
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
    baseline?: { percent: number; at: number; hours?: number; ppm?: number };   // the last % and whole hours logged (or the starting point)
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
export interface SwgLogSettings { enabled: boolean; hours: number; hoursSource?: 'schedule' | 'set'; hoursNote?: string; }
type Client = Pick<PoolMathClient, 'request' | 'poolId' | 'ensureSession' | 'credentialsFileFound'> & { userId?: string; lastSignInAt?: number; lastSignInError?: string };

export interface SwgLogStatus {
    enabled: boolean; hoursPerDay: number; hoursSource?: 'schedule' | 'set'; hoursNote?: string;
    credentialsFile: 'found' | 'missing';
    lastSignIn?: { ok: boolean; at?: string };
    lastError?: string; lastErrorAt?: string;
    pending: number; baselinePercent?: number; feeder?: string;
    lastWritten?: { kind: SwgEntryKind; ts: string; percent: number; hours: number; ppm: number; at: string };
    note?: string;
}

export class SwgLogWriter {
    private data: SwgLogFile = { queue: [], sent: [] };
    private candidate?: { percent: number; hours: number; at: number };
    private fed?: { ts: number; percent: number; hours: number; ppm: number; receivedAt: number };
    private startedAt = 0;
    private wasEnabled = false;
    private sending = false;
    private lastSendAt = 0;
    private note?: string;

    constructor(private readonly deps: { client: Client; settings: () => SwgLogSettings; reading: () => SwgLogReading; file: string; now?: () => number; feeder?: () => string | undefined }) { }
    private feeder(): string | undefined { return this.deps.feeder ? this.deps.feeder() : undefined; }
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
    private setBaseline(percent: number, hours: number, at: number, why: string) {
        const b = this.data.baseline;
        this.data.baseline = { percent, at, hours: hours > 0 ? hours : undefined };
        if (!b || b.percent !== percent || (hours > 0 && b.hours !== hours))
            logger.info(`PoolMath SWG log: ${percent}%${hours > 0 ? `, ${hours} h` : ''} taken as the starting point (${why}); nothing written to PoolMath.`);
        this.save();
    }

    // A change handed in by the feeder: written (after HOLD_MS, the last of several only) when its % or whole hours differ from the last
    // logged. Returns false when it is not taken (the writing is off, or the values are not usable).
    public submit(e: { ts: number; percent: number; hours: number; ppm: number }): boolean {
        const now = this.now();
        if (!this.deps.settings().enabled) return false;
        if (!e || !clockLooksSet(e.ts) || e.ts > now + 60000 || !(e.percent >= 0 && e.percent <= 100) || !(e.hours > 0 && e.hours <= 24) || !(e.ppm >= 0) || !isFinite(e.ppm)) {
            logger.warn('PoolMath SWG log: a handed-in SWG change was not usable and was not taken.');
            return false;
        }
        this.fed = { ts: e.ts, percent: e.percent, hours: e.hours, ppm: e.ppm, receivedAt: now };
        return true;
    }
    private takeFed(now: number, r: SwgLogReading) {
        const f = this.fed;
        if (!f) return;
        if (r.superChlorOn) { this.fed = undefined; logger.info('PoolMath SWG log: a handed-in change during super chlorinate is not written; the entry at its end carries the %.'); return; }
        if (now - f.receivedAt < HOLD_MS) return;
        this.fed = undefined;
        const hours = Math.max(1, Math.round(f.hours));
        const b = this.data.baseline;
        if (b && b.percent === f.percent && b.hours === hours) { b.ppm = f.ppm; this.save(); return; }
        this.enqueue('change', f.ts, f.percent, hours, Math.round(f.ppm * 100) / 100, now);
        this.data.baseline = { percent: f.percent, at: f.ts, hours, ppm: f.ppm };
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
                    this.data.baseline = undefined; this.data.queue = []; this.candidate = undefined; this.fed = undefined;
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
            if (!r.ok) { this.note = r.reason; this.candidate = undefined; this.fed = undefined; await this.sendDue(now); return; }
            const feeder = this.feeder();
            this.note = feeder || set.hours > 0 ? undefined : 'Choose the SWG schedule or set the run hours a day; nothing is written until then.';
            const pct = r.percent;
            const hours = set.hours > 0 ? set.hours : 0;
            const b = this.data.baseline;
            if (justEnabled) { this.candidate = undefined; this.fed = undefined; this.setBaseline(pct, hours, now, 'the writing was turned on'); }
            else if (!b) { this.candidate = undefined; this.setBaseline(pct, hours, now, 'njsPC started'); }
            else if (feeder) { this.candidate = undefined; this.takeFed(now, r); }
            else if (now - this.startedAt < STARTUP_GRACE_MS) { this.candidate = undefined; this.setBaseline(pct, hours, now, 'njsPC started'); }
            else if (r.superChlorOn) this.candidate = undefined;
            else {
                // hours set for the first time (or a starting point from before the hours were kept) only become part of the starting point
                if (hours > 0 && !(b.hours > 0)) { b.hours = hours; this.save(); }
                const hoursChanged = hours > 0 && b.hours > 0 && b.hours !== hours;
                if (pct === b.percent && !hoursChanged) this.candidate = undefined;
                else {
                    if (!this.candidate || this.candidate.percent !== pct || this.candidate.hours !== hours) this.candidate = { percent: pct, hours, at: now };
                    if (now - this.candidate.at >= HOLD_MS) {
                        const c = this.candidate;
                        this.candidate = undefined;
                        if (c.hours > 0) this.enqueue('change', c.at, c.percent, c.hours, swgPpm(r.lbsPerDay, c.percent, c.hours, r.gallons), now);
                        this.data.baseline = { percent: c.percent, at: c.at, hours: c.hours > 0 ? c.hours : undefined };
                        this.save();
                    }
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
            if (!set.enabled) return;
            const r = this.deps.reading();
            if (!r.ok) return;
            // the entry at the end carries the last logged hours and rate when the % is the same (a feeder's exact figures), else the writer's own
            const b = this.data.baseline;
            const same = !!b && b.percent === r.percent && b.hours > 0;
            const backHours = same ? b.hours : set.hours;
            if (!(backHours > 0)) return;
            const backPpm = same && typeof b.ppm === 'number' ? Math.round(b.ppm * 100) / 100 : swgPpm(r.lbsPerDay, r.percent, backHours, r.gallons);
            const hours = Math.round(run.poweredHours);
            this.candidate = undefined; this.fed = undefined;
            if (hours <= 0) { logger.info('PoolMath SWG log: super chlorinate ran less than half an hour with power; nothing written to PoolMath.'); return; }
            this.enqueue('superChlorRun', run.start, 100, hours, swgPpm(r.lbsPerDay, 100, run.poweredHours, r.gallons), now);
            this.enqueue('superChlorRestore', run.end, r.percent, backHours, backPpm, now);
            this.data.baseline = { percent: r.percent, at: run.end, hours: backHours, ppm: same ? b.ppm : undefined };
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
            enabled: set.enabled, hoursPerDay: set.hours, hoursSource: set.hoursSource, hoursNote: set.hoursNote,
            credentialsFile: found ? 'found' : 'missing',
            lastSignIn,
            lastError: d.lastError, lastErrorAt: iso(d.lastErrorAt),
            pending: d.queue.length,
            baselinePercent: d.baseline ? d.baseline.percent : undefined,
            feeder: this.feeder(),
            lastWritten: d.lastWritten ? { kind: d.lastWritten.kind, ts: iso(d.lastWritten.ts), percent: d.lastWritten.percent, hours: d.lastWritten.hours, ppm: d.lastWritten.ppm, at: iso(d.lastWritten.at) } : undefined,
            note: set.enabled ? (found ? this.note : 'No PoolMath credentials file has been created on this controller.') : undefined
        };
    }
}
