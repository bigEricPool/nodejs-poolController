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

// When each chlorinator had power: one line each time its power turns on or off, in data/chlorinatorPowerLog.jsonl next to
// poolConfig.json, kept as long as the output log (CHLORINATOR_LOG_KEEP_MONTHS). A cell that makes its chlorine in cycles starts a new
// cycle when its power comes on, so these times place the cycles (see cycleConduction in ChlorinatorUsage.ts). Only changes are written,
// a few lines a day; the first line for a chlorinator is the state it was in when the log began, not necessarily a change.
//
// Each line: t  the time (ISO, UTC)    id  the chlorinator id    on  true when the power came on, false when it went off
//
// What "has power" means is up to ChlorinatorLogService.ts (by default the chlorinator's body is on). The same clock guards as the
// output log apply: nothing is written while the time looks unset, nor before the newest event (the clock went back).

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { CHLORINATOR_LOG_KEEP_MONTHS, clockLooksSet, readEdgeLineOf } from './ChlorinatorLog';

const DAY_MS = 86400000;
const PRUNE_EVERY_MS = DAY_MS;
// As for the output log, the file is rewritten only when its oldest line is this far past the cutoff.
const PRUNE_SLACK_MS = 31 * DAY_MS;

export interface ChlorinatorPowerEvent { t: string; id: number; on: boolean; }

function isEvent(e: any): e is ChlorinatorPowerEvent {
    return !!e && typeof e.t === 'string' && typeof e.id === 'number' && typeof e.on === 'boolean' && !isNaN(new Date(e.t).getTime());
}

export class ChlorinatorPowerLog {
    private last = new Map<number, ChlorinatorPowerEvent>();
    private loaded = false;
    private lastPrune = 0;
    // `file` defaults to data/chlorinatorPowerLog.jsonl in the working folder; tests pass their own.
    constructor(private readonly fileOverride?: string) { }
    public file(): string { return this.fileOverride || path.join(process.cwd(), 'data', 'chlorinatorPowerLog.jsonl'); }
    // The newest event of a chlorinator (read from the file once, then kept).
    public lastEvent(id: number): ChlorinatorPowerEvent | undefined {
        if (!this.loaded) {
            this.loaded = true;
            for (const e of this.readAll()) {
                const p = this.last.get(e.id);
                if (!p || new Date(e.t).getTime() >= new Date(p.t).getTime()) this.last.set(e.id, e);
            }
        }
        return this.last.get(id);
    }
    // Writes the chlorinator's power state when it differs from the last one written (or none was). Returns the event written.
    public record(id: number, on: boolean, now: number = Date.now()): ChlorinatorPowerEvent | undefined {
        if (typeof id !== 'number' || typeof on !== 'boolean' || !clockLooksSet(now)) return undefined;
        const prev = this.lastEvent(id);
        if (prev && prev.on === on) return undefined;
        // the clock went back: wait until it has passed the newest event, so the lines stay in time order
        if (prev && now < new Date(prev.t).getTime()) return undefined;
        const e: ChlorinatorPowerEvent = { t: new Date(now).toISOString(), id: id, on: on };
        try {
            const f = this.file();
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.appendFileSync(f, JSON.stringify(e) + '\n', 'utf8');
        } catch (err) { logger.warn(`Chlorinator power log: could not write the power log: ${err.message}`); return undefined; }
        this.last.set(id, e);
        if (now - this.lastPrune > PRUNE_EVERY_MS) this.prune(now);
        return e;
    }
    // The events from the last `days` days, oldest first, with the event before them for each chlorinator (the state the span began in).
    // With `id`, only that chlorinator's.
    public read(days: number = 1461, now: number = Date.now(), id?: number): ChlorinatorPowerEvent[] {
        const from = now - days * DAY_MS;
        const all = this.readAll().filter(e => typeof id !== 'number' || e.id === id);
        const before = new Map<number, ChlorinatorPowerEvent>();
        const out: ChlorinatorPowerEvent[] = [];
        for (const e of all) {
            if (new Date(e.t).getTime() < from) before.set(e.id, e);
            else out.push(e);
        }
        return Array.from(before.values()).concat(out).sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
    }
    private readAll(): ChlorinatorPowerEvent[] {
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return [];
            const out: ChlorinatorPowerEvent[] = [];
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { const e = JSON.parse(line); if (isEvent(e)) out.push(e); }
                catch (err) { /* a torn last line after a power loss is skipped */ }
            }
            return out;
        } catch (err) { logger.warn(`Chlorinator power log: could not read the power log: ${err.message}`); return []; }
    }
    // Drops the events older than CHLORINATOR_LOG_KEEP_MONTHS, keeping each chlorinator's newest event before the cutoff (the state at
    // the cutoff). Only the first line is read unless the oldest is more than a month past the cutoff. Does nothing while the time looks
    // wrong.
    public prune(now: number = Date.now()) {
        this.lastPrune = now;
        try {
            if (!clockLooksSet(now)) return;
            for (const e of Array.from(this.last.values())) if (now < new Date(e.t).getTime()) return;
            const cutoff = new Date(now);
            cutoff.setMonth(cutoff.getMonth() - CHLORINATOR_LOG_KEEP_MONTHS);
            const oldest = readEdgeLineOf(this.file(), true);
            if (!oldest || new Date(oldest.t).getTime() >= cutoff.getTime() - PRUNE_SLACK_MS) return;
            const all = this.readAll();
            const keepBefore = new Map<number, ChlorinatorPowerEvent>();
            for (const e of all) if (new Date(e.t).getTime() < cutoff.getTime()) keepBefore.set(e.id, e);
            const kept = all.filter(e => new Date(e.t).getTime() >= cutoff.getTime() || keepBefore.get(e.id) === e);
            if (kept.length === all.length) return;
            const f = this.file();
            const tmp = f + '.tmp';
            fs.writeFileSync(tmp, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
            fs.renameSync(tmp, f);
        } catch (err) { logger.warn(`Chlorinator power log: could not trim the power log: ${err.message}`); }
    }
}

export const chlorinatorPowerLog = new ChlorinatorPowerLog();
