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

// The super chlorinate log: data/chlorinatorSuperChlorLog.jsonl, one line each time a chlorinator's super chlorinate goes on or off,
// checked every 15 seconds with the power log (ChlorinatorLogService.ts):
//   {"t":"2026-11-15T14:00:00.000Z","id":50,"on":true}
//   {"t":"2026-11-15T22:00:05.000Z","id":50,"on":false,"start":"2026-11-15T14:00:00.000Z","reason":"timer","hours":8,"poweredHours":7.95}
// An "off" line also has the run's start, why it ended and how long it lasted: `hours` from start to end, and `poweredHours` the part
// of that the cell had power, from the power log (the whole run when the power log has nothing for it). Reasons:
//   timer      super chlorinate ran its hours
//   bodyOff    the chlorinator's body went off (Nixie ends super chlorinate then)
//   comms      the chlorinator stopped answering (Nixie ends super chlorinate then)
//   turnedOff  turned off before its time
//   stopped    it ended while njsPC was not running; the end is the last time njsPC saw it running
// While a run is open the time it was last seen running is kept in data/chlorinatorSuperChlorSeen.json (written once a minute), so a run
// that ended while njsPC was stopped gets a sensible end. Other modules hear about each finished run (onSuperChlorRunEnded).

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { clockLooksSet } from './ChlorinatorLog';
import { ChlorinatorPowerEvent } from './ChlorinatorPowerLog';

export type SuperChlorEndReason = 'timer' | 'bodyOff' | 'comms' | 'turnedOff' | 'stopped';
export interface SuperChlorEvent {
    t: string; id: number; on: boolean;
    start?: string; reason?: SuperChlorEndReason; hours?: number; poweredHours?: number;
}
export interface SuperChlorRun { id: number; start: number; end: number; reason: SuperChlorEndReason; hours: number; poweredHours: number; atStartup: boolean; }

const SEEN_EVERY_MS = 60 * 1000;
const HOUR_MS = 3600000;

function isEvent(e: any): e is SuperChlorEvent {
    return !!e && typeof e.t === 'string' && typeof e.id === 'number' && typeof e.on === 'boolean' && !isNaN(new Date(e.t).getTime());
}
const round2 = (v: number) => Math.round(v * 100) / 100;

// The hours within [from, to] the cell had power by the power events (oldest first; the event before `from` sets the state it began in).
// Without any event at or before `to`, the whole span counts as powered.
export function poweredHoursBetween(events: ChlorinatorPowerEvent[], from: number, to: number): number {
    if (!(to > from)) return 0;
    let on: boolean | undefined;
    let at = from;
    let ms = 0;
    let known = false;
    for (const e of events) {
        const t = new Date(e.t).getTime();
        if (t > to) break;
        known = true;
        if (t <= from) { on = e.on; continue; }
        if (on) ms += t - at;
        at = t;
        on = e.on;
    }
    if (!known) return (to - from) / HOUR_MS;
    if (on) ms += to - at;
    return ms / HOUR_MS;
}

// Why a run ended, from what was seen at the last check while it ran and what is true now.
export function endReasonOf(o: { remainingSecAtLastCheck?: number; startedMs: number; superChlorHours?: number; now: number; bodyOn: boolean; commsLost: boolean }): SuperChlorEndReason {
    if (typeof o.remainingSecAtLastCheck === 'number' && o.remainingSecAtLastCheck <= 30) return 'timer';
    if (o.superChlorHours > 0 && o.now - o.startedMs >= o.superChlorHours * HOUR_MS - 120000) return 'timer';
    if (!o.bodyOn) return 'bodyOff';
    if (o.commsLost) return 'comms';
    return 'turnedOff';
}

export interface SuperChlorReading { id: number; on: boolean; remainingSec?: number; superChlorHours?: number; bodyOn: boolean; commsLost: boolean; }

export class ChlorinatorSuperChlorLog {
    private last = new Map<number, SuperChlorEvent>();
    private loaded = false;
    private lastRemaining = new Map<number, number>();
    private seenSavedAt = 0;
    private startupChecked = false;
    private listeners: ((run: SuperChlorRun) => void)[] = [];
    constructor(private readonly dir?: string) { }
    public file(): string { return path.join(this.dir || path.join(process.cwd(), 'data'), 'chlorinatorSuperChlorLog.jsonl'); }
    private seenFile(): string { return path.join(this.dir || path.join(process.cwd(), 'data'), 'chlorinatorSuperChlorSeen.json'); }
    public onRunEnded(fn: (run: SuperChlorRun) => void) { this.listeners.push(fn); }

    public readAll(): SuperChlorEvent[] {
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return [];
            const out: SuperChlorEvent[] = [];
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { const e = JSON.parse(line); if (isEvent(e)) out.push(e); } catch (err) { /* a torn last line after a power loss */ }
            }
            return out;
        } catch (err) { logger.warn(`Super chlorinate log: could not read the log: ${err.message}`); return []; }
    }
    public lastEvent(id: number): SuperChlorEvent | undefined {
        if (!this.loaded) {
            this.loaded = true;
            for (const e of this.readAll()) this.last.set(e.id, e);
        }
        return this.last.get(id);
    }
    // The open run's start for a chlorinator, or undefined when none is open.
    public openSince(id: number): number | undefined {
        const e = this.lastEvent(id);
        return e && e.on ? new Date(e.t).getTime() : undefined;
    }
    private append(e: SuperChlorEvent): boolean {
        try {
            const f = this.file();
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.appendFileSync(f, JSON.stringify(e) + '\n', 'utf8');
            this.last.set(e.id, e);
            return true;
        } catch (err) { logger.warn(`Super chlorinate log: could not write the log: ${err.message}`); return false; }
    }
    private readSeen(): { [id: string]: string } {
        try { const j = JSON.parse(fs.readFileSync(this.seenFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; }
        catch (err) { return {}; }
    }
    private saveSeen(ids: number[], now: number) {
        try {
            const seen: { [id: string]: string } = {};
            for (const id of ids) seen[String(id)] = new Date(now).toISOString();
            const f = this.seenFile();
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f + '.tmp', JSON.stringify(seen), 'utf8');
            fs.renameSync(f + '.tmp', f);
            this.seenSavedAt = now;
        } catch (err) { logger.warn(`Super chlorinate log: could not save the time a run was last seen: ${err.message}`); }
    }

    private end(id: number, start: number, end: number, reason: SuperChlorEndReason, power: (id: number, from: number, to: number) => number, atStartup: boolean) {
        const hours = Math.max(0, (end - start) / HOUR_MS);
        let powered = hours;
        try { powered = Math.min(hours, Math.max(0, power(id, start, end))); } catch (err) { logger.warn(`Super chlorinate log: could not read the power log: ${err.message}`); }
        const e: SuperChlorEvent = { t: new Date(end).toISOString(), id, on: false, start: new Date(start).toISOString(), reason, hours: round2(hours), poweredHours: round2(powered) };
        if (!this.append(e)) return;
        logger.info(`Chlorinator ${id}: super chlorinate ended (${reason}) after ${hours.toFixed(2)} h, ${powered.toFixed(2)} h with power.`);
        const run: SuperChlorRun = { id, start, end, reason, hours, poweredHours: powered, atStartup };
        for (const fn of this.listeners) { try { fn(run); } catch (err) { logger.warn(`Super chlorinate log: a listener failed: ${err.message}`); } }
    }

    // One check of every chlorinator (every 15 seconds). `power` gives the powered hours of a span from the power log.
    public check(readings: SuperChlorReading[], power: (id: number, from: number, to: number) => number, now: number = Date.now()) {
        if (!clockLooksSet(now)) return;
        const firstCheck = !this.startupChecked;
        this.startupChecked = true;
        const seen = firstCheck ? this.readSeen() : {};
        const open: number[] = [];
        for (const r of readings) {
            const since = this.openSince(r.id);
            if (typeof since === 'number' && now < since) continue;   // the clock went back: wait until it passes the run's start
            if (r.on) {
                if (typeof since !== 'number') {
                    if (this.append({ t: new Date(now).toISOString(), id: r.id, on: true })) logger.info(`Chlorinator ${r.id}: super chlorinate on.`);
                }
                open.push(r.id);
                if (typeof r.remainingSec === 'number') this.lastRemaining.set(r.id, r.remainingSec);
            }
            else if (typeof since === 'number') {
                if (firstCheck) {
                    // it ended while njsPC was not running: the end is when it was last seen running (the start when that is unknown)
                    const s = Date.parse(seen[String(r.id)] || '');
                    const end = Number.isFinite(s) && s >= since && s <= now ? s : since;
                    this.end(r.id, since, end, 'stopped', power, true);
                }
                else {
                    const reason = endReasonOf({ remainingSecAtLastCheck: this.lastRemaining.get(r.id), startedMs: since, superChlorHours: r.superChlorHours, now, bodyOn: r.bodyOn, commsLost: r.commsLost });
                    this.end(r.id, since, now, reason, power, false);
                }
                this.lastRemaining.delete(r.id);
            }
        }
        if (open.length && (firstCheck || now - this.seenSavedAt >= SEEN_EVERY_MS)) this.saveSeen(open, now);
        else if (!open.length && this.seenSavedAt) { this.saveSeen([], now); this.seenSavedAt = 0; }
    }
    // At a stop: an open run's last-seen time is now.
    public markSeen(ids: number[], now: number = Date.now()) {
        const open = ids.filter(id => typeof this.openSince(id) === 'number');
        if (open.length && clockLooksSet(now)) this.saveSeen(open, now);
    }
}

export const chlorinatorSuperChlorLog = new ChlorinatorSuperChlorLog();
export function onSuperChlorRunEnded(fn: (run: SuperChlorRun) => void) { chlorinatorSuperChlorLog.onRunEnded(fn); }
