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

// The extra cell on-time from short power drops (njsPC restarts), for SWG Assist's burn calculation. A cell that makes its chlorine in cycles, with current
// first in each cycle, starts a new cycle at every power-on (see cycleConduction in ChlorinatorUsage.ts). A restart inside the run window therefore runs the
// current again from the start of a fresh cycle, which adds up to one on-period at the set % that the SWG % entries know nothing about.
//
// The power events come from data/chlorinatorPowerLog.jsonl (one line each time a chlorinator's power turns on or off: {t, id, on}; see ChlorinatorPowerLog.ts).
// The file is read here by path, like the super chlorinate log (AutoSwgSuperChlor.ts): SWG Assist works without the logging layer, and no file means no credit.
//
// The credit for a span is the on-time with the real power events less the on-time with each restart filled in (its off gap removed), at the full rate. Only
// a gap shorter than RESTART_MAX_GAP_MS counts as a restart; a longer one is an outage, and only one whose power-on falls in the run window is filled in.
// The two timelines are the same outside each restart's reach (from its power-off to the next real power-off), so only those stretches are counted.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { cycleConduction } from './ChlorinatorUsage';
import type { CycleSettings, PowerEvent } from './ChlorinatorUsage';

export const RESTART_MAX_GAP_MS = 5 * 60000;

export interface Restart { offMs: number; onMs: number; }

function timeOf(t: any): number {
    if (typeof t === 'number') return isFinite(t) ? t : NaN;
    if (typeof t === 'string') return new Date(t).getTime();
    return NaN;
}

// The power events of one chlorinator (a line without an id counts for any), oldest first. A torn last line is skipped.
export function parsePowerLog(text: string, id?: number): PowerEvent[] {
    const out: PowerEvent[] = [];
    for (const raw of (text || '').split('\n')) {
        if (!raw.trim()) continue;
        let l: any;
        try { l = JSON.parse(raw); } catch (err) { continue; }
        if (!l || typeof l !== 'object' || typeof l.on !== 'boolean') continue;
        const t = timeOf(l.t);
        if (isNaN(t)) continue;
        if (typeof id === 'number' && typeof l.id === 'number' && l.id !== id) continue;
        out.push({ t, on: l.on });
    }
    return out.sort((a, b) => a.t - b.t);
}

// The restarts: an off followed by an on less than `maxGapMs` later, with the on inside the run window (`inWindow`).
export function findRestarts(events: PowerEvent[], inWindow: (ms: number) => boolean, maxGapMs: number = RESTART_MAX_GAP_MS): Restart[] {
    const out: Restart[] = [];
    for (let i = 0; i + 1 < events.length; i++) {
        const a = events[i], b = events[i + 1];
        if (a.on || !b.on) continue;
        if (b.t - a.t >= maxGapMs || b.t < a.t) continue;
        if (!inWindow(b.t)) continue;
        out.push({ offMs: a.t, onMs: b.t });
    }
    return out;
}

// Where the restarts change the on-time: from each restart's power-off to the next power-off that is not itself part of a restart (Infinity while the power
// is still on). Restarts in a row share one stretch.
export function restartReach(events: PowerEvent[], restarts: Restart[]): { s: number; e: number }[] {
    if (!restarts.length) return [];
    const filledOff = new Set(restarts.map(r => r.offMs));
    const out: { s: number; e: number }[] = [];
    for (const r of restarts) {
        let e = Infinity;
        for (const ev of events) if (!ev.on && ev.t > r.onMs && !filledOff.has(ev.t)) { e = ev.t; break; }
        const last = out[out.length - 1];
        if (last && r.offMs <= last.e) last.e = Math.max(last.e, e);
        else out.push({ s: r.offMs, e });
    }
    return out;
}

// The events with the restarts' off gaps removed.
export function fillRestarts(events: PowerEvent[], restarts: Restart[]): PowerEvent[] {
    const offs = new Set(restarts.map(r => r.offMs)), ons = new Set(restarts.map(r => r.onMs));
    return events.filter(e => e.on ? !ons.has(e.t) : !offs.has(e.t));
}

// The extra hours at 100% the restarts made in [a, b] (ms): the on-time with the real events less the on-time with the restarts filled in. 0 when the cell is
// not counted by cycles or its cycles do not restart at power-on.
export function restartExtraHours(events: PowerEvent[], restarts: Restart[], a: number, b: number, cycle: CycleSettings, pctAt: (ms: number) => number,
    reach?: { s: number; e: number }[], filled?: PowerEvent[]): number {
    if (!cycle || !(cycle.cycleHours > 0) || !cycle.restartsOnPower || !(b > a) || !restarts.length) return 0;
    const spans = reach || restartReach(events, restarts);
    let total = 0;
    let filledEvents = filled;
    for (const sp of spans) {
        const lo = Math.max(a, sp.s), hi = Math.min(b, sp.e);
        if (!(hi > lo)) continue;
        if (!filledEvents) filledEvents = fillRestarts(events, restarts);
        total += cycleConduction(events, lo, hi, cycle, pctAt) - cycleConduction(filledEvents, lo, hi, cycle, pctAt);
    }
    return total;
}

export function powerLogFile(): string { return path.join(process.cwd(), 'data', 'chlorinatorPowerLog.jsonl'); }

// Kept between calls (Tune runs thousands of calculations): read again only when the file changes.
let cache: { key: string; events: PowerEvent[] } | undefined;
function mtimeOf(f: string): number { try { return fs.statSync(f).mtimeMs; } catch (err) { return 0; } }

// The chlorinator's power events, oldest first. `file` is for tests.
export function readPowerEvents(id?: number, file?: string): PowerEvent[] {
    const f = file || powerLogFile();
    const m = mtimeOf(f);
    if (!m) return [];
    const key = `${f}|${m}|${typeof id === 'number' ? id : ''}`;
    if (cache && cache.key === key) return cache.events;
    let events: PowerEvent[];
    try { events = parsePowerLog(fs.readFileSync(f, 'utf8'), id); }
    catch (err) { logger.warn(`SWG Assist: could not read the chlorinator power log: ${err.message}`); return []; }
    cache = { key, events };
    return events;
}
export function clearPowerEventsCache() { cache = undefined; }
