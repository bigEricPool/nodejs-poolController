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

// When each chlorinator's RS-485 link changed: data/chlorinatorCommsLog.jsonl next to the power log, kept as long (CHLORINATOR_LOG_KEEP_MONTHS),
// with the same clock guards. It tells apart, after the fact, the two ways a cell logged as powered may not have been making chlorine:
//   port "down"                    the chlorinator's RS-485 port was closed or could not be opened (a USB adapter that reset or renumbered,
//                                  for example): the link was lost, the cell may still have had power.
//   port "ok", answering false     the port was open but the chlorinator stopped answering while its power relays were on: most likely no
//                                  power at the cell (a breaker, the wiring, a relay that did not close, the cell switched off).
// The power log is not changed by these; this log only records them.
//
// Each line: t  the time (ISO, UTC)    id  the chlorinator id    port  "ok" or "down"
//            answering  only while the power relays are on: false when the chlorinator has not answered for COMM_FRESH_SEC past the start-up
//                       grace after the relays came on, true at its first answer after that (a first line for a relays-on period is
//                       written only when it is silent)
// A line is written when the port or the answering changes; the port is followed at any time, the answering only while the relays are on.
// The first line for a chlorinator is the state when the log began. A port reopened by njsPC's inactivity timer (every inactivityRetry
// seconds on a quiet bus, all night when the cell is off) is closed for a moment only and is not a change: "down" needs the port closed at
// two checks in a row, or njsPC's "RS485 port disconnected" message up (the port could not be opened).

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { CHLORINATOR_LOG_KEEP_MONTHS, clockLooksSet, readEdgeLineOf } from './ChlorinatorLog';

const DAY_MS = 86400000;
const PRUNE_SLACK_MS = 31 * DAY_MS;

export type CommsPort = 'ok' | 'down';
export interface ChlorinatorCommsEvent { t: string; id: number; port: CommsPort; answering?: boolean; }

function isEvent(e: any): e is ChlorinatorCommsEvent {
    return !!e && typeof e.t === 'string' && typeof e.id === 'number' && (e.port === 'ok' || e.port === 'down') && !isNaN(new Date(e.t).getTime());
}

// What one check knows about a chlorinator.
export interface CommsReading {
    id: number;
    portOpen: boolean | undefined;     // the port's isOpen (undefined: no such port, or it is disabled: nothing is logged)
    portError: boolean;                // njsPC's "port disconnected" message is up
    relaysOn: boolean | undefined;     // all its power relays are on (undefined: not known)
    relaysOnSince?: number;            // when they all came on (ms)
    lastComm?: number;                 // the chlorinator's last answer (ms)
}
export interface CommsTiming { freshSec: number; graceSec: number; }

// Decides the lines from the readings of each check (pure, for the tests): the state of each chlorinator is kept between checks.
export class CommsTracker {
    private closedChecks = new Map<number, number>();
    private port = new Map<number, CommsPort>();
    private answering = new Map<number, boolean | undefined>();
    private okSince = new Map<number, number>();
    // `lastPort` is the port of each chlorinator's newest line in the log (so a start does not write the same state again).
    constructor(private readonly timing: CommsTiming, private readonly lastPort: (id: number) => CommsPort | undefined = () => undefined) { }
    public check(r: CommsReading, now: number): ChlorinatorCommsEvent | undefined {
        if (typeof r.portOpen !== 'boolean') return undefined;
        const closed = r.portOpen ? 0 : (this.closedChecks.get(r.id) || 0) + 1;
        this.closedChecks.set(r.id, closed);
        const port: CommsPort = r.portError || closed >= 2 ? 'down' : (r.portOpen ? 'ok' : (this.port.get(r.id) || this.lastPort(r.id) || 'ok'));
        const prevPort = this.port.has(r.id) ? this.port.get(r.id) : this.lastPort(r.id);
        if (port === 'ok' && (this.port.get(r.id) !== 'ok' || !this.okSince.has(r.id))) this.okSince.set(r.id, now);
        this.port.set(r.id, port);
        let answering: boolean | undefined;
        const prevAnswering = this.answering.get(r.id);
        if (r.relaysOn === true && typeof r.relaysOnSince === 'number' && port === 'ok') {
            // silent since the end of the start-up grace, the port's (re)opening or the last answer, whichever is latest
            const from = Math.max(r.relaysOnSince + this.timing.graceSec * 1000, this.okSince.get(r.id), typeof r.lastComm === 'number' ? r.lastComm : 0);
            if (now >= r.relaysOnSince + this.timing.graceSec * 1000) answering = now - from <= this.timing.freshSec * 1000;
            else answering = prevAnswering;
        }
        // relays off (or the port down): answering is not followed, and the next relays-on period starts fresh
        this.answering.set(r.id, r.relaysOn === true && port === 'ok' ? answering : undefined);
        const answeringChanged = typeof answering === 'boolean' && (typeof prevAnswering === 'boolean' ? prevAnswering !== answering : answering === false);
        if (port === prevPort && !answeringChanged) return undefined;
        const e: ChlorinatorCommsEvent = { t: new Date(now).toISOString(), id: r.id, port: port };
        if (typeof answering === 'boolean') e.answering = answering;
        return e;
    }
}

export class ChlorinatorCommsLog {
    private last = new Map<number, ChlorinatorCommsEvent>();
    private loaded = false;
    private lastPrune = 0;
    // `file` defaults to data/chlorinatorCommsLog.jsonl in the working folder; tests pass their own.
    constructor(private readonly fileOverride?: string) { }
    public file(): string { return this.fileOverride || path.join(process.cwd(), 'data', 'chlorinatorCommsLog.jsonl'); }
    public lastEvent(id: number): ChlorinatorCommsEvent | undefined {
        if (!this.loaded) {
            this.loaded = true;
            for (const e of this.readAll()) {
                const p = this.last.get(e.id);
                if (!p || new Date(e.t).getTime() >= new Date(p.t).getTime()) this.last.set(e.id, e);
            }
        }
        return this.last.get(id);
    }
    // Appends a line; nothing while the time looks unset or before the chlorinator's newest line (the clock went back).
    public write(e: ChlorinatorCommsEvent): boolean {
        const t = new Date(e.t).getTime();
        if (!isEvent(e) || !clockLooksSet(t)) return false;
        const prev = this.lastEvent(e.id);
        if (prev && t < new Date(prev.t).getTime()) return false;
        try {
            const f = this.file();
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.appendFileSync(f, JSON.stringify(e) + '\n', 'utf8');
        } catch (err) { logger.warn(`Chlorinator comms log: could not write: ${err.message}`); return false; }
        this.last.set(e.id, e);
        if (t - this.lastPrune > DAY_MS) this.prune(t);
        return true;
    }
    public read(days: number = 1461, now: number = Date.now(), id?: number): ChlorinatorCommsEvent[] {
        const from = now - days * DAY_MS;
        return this.readAll().filter(e => (typeof id !== 'number' || e.id === id) && new Date(e.t).getTime() >= from);
    }
    private readAll(): ChlorinatorCommsEvent[] {
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return [];
            const out: ChlorinatorCommsEvent[] = [];
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { const e = JSON.parse(line); if (isEvent(e)) out.push(e); }
                catch (err) { /* a torn last line after a power loss is skipped */ }
            }
            return out;
        } catch (err) { logger.warn(`Chlorinator comms log: could not read: ${err.message}`); return []; }
    }
    // Drops the lines older than CHLORINATOR_LOG_KEEP_MONTHS, keeping each chlorinator's newest line before the cutoff (the state at it);
    // only the first line is read unless the oldest is more than a month past the cutoff.
    public prune(now: number = Date.now()) {
        this.lastPrune = now;
        try {
            if (!clockLooksSet(now)) return;
            const cutoff = new Date(now);
            cutoff.setMonth(cutoff.getMonth() - CHLORINATOR_LOG_KEEP_MONTHS);
            const oldest = readEdgeLineOf(this.file(), true);
            if (!oldest || new Date(oldest.t).getTime() >= cutoff.getTime() - PRUNE_SLACK_MS) return;
            const all = this.readAll();
            const keepBefore = new Map<number, ChlorinatorCommsEvent>();
            for (const e of all) if (new Date(e.t).getTime() < cutoff.getTime()) keepBefore.set(e.id, e);
            const kept = all.filter(e => new Date(e.t).getTime() >= cutoff.getTime() || keepBefore.get(e.id) === e);
            if (kept.length === all.length) return;
            const f = this.file();
            const tmp = f + '.tmp';
            fs.writeFileSync(tmp, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
            fs.renameSync(tmp, f);
        } catch (err) { logger.warn(`Chlorinator comms log: could not trim: ${err.message}`); }
    }
}

export const chlorinatorCommsLog = new ChlorinatorCommsLog();
