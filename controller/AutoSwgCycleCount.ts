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

// SWG Assist's count of what the cell really made, from the chlorinator's power events, for the hours the power log covers. A cell that makes its
// chlorine in cycles (current for the set % of each cycle, first in the cycle when burstFirst, a new cycle at every power-on when restartsOnPower) does
// not make "% x run window": a restart in the window runs a fresh on-period, a power-off part way through an on-period cuts it, and the cell makes
// chlorine whenever it has power, in the window or not. The count is cycleConduction (ChlorinatorUsage.ts, the same as the cell usage and the Model
// Bench), the hours of current at the full rate (the rated ppm per 24 h at 100%, over 24). Hours before the log begins are left to the run window.
//
// The power events come from data/chlorinatorPowerLog.jsonl (one line each time a chlorinator's power turns on or off: {t, id, on}; see
// ChlorinatorPowerLog.ts). The file is read here by path, like the super chlorinate log (AutoSwgSuperChlor.ts): SWG Assist works without the logging
// layer, and no file means no count. What the log cannot show is not counted: a power drop njsPC never saw leaves no lines, so the cycles are placed as
// if the power had stayed on. A relay whose latch on the REM expired while njsPC was stalled is seen when the logging writes stall lines (an off/on pair
// with cause "stall"); those count like any other off/on, which is right: the power did drop and the cell starts a new cycle.
//
// Hours in which the cell said it was not making chlorine count nothing, as in the cell usage and the Model Bench: a clock hour whose line(s) in the hourly
// output log (data/chlorinatorOutputLog.jsonl, see ChlorinatorLog.ts) carry a CELL_FAULT status (ChlorinatorUsage.ts: low flow, very low salt, high current,
// low voltage, low water temperature) has its conduction taken out. Communication lost (128) is not one: it is normal overnight while the cell has no power,
// and the power log already says when it had. Clean cell (16) still generates. No cycle restart is modelled after a fault; the hour is just dropped. No
// output log means no fault hours: the count is the power log alone.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { CELL_FAULT, cycleConduction } from './ChlorinatorUsage';
import type { CycleSettings, PowerEvent } from './ChlorinatorUsage';

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

const HOUR_MS = 3600000;

// The starts (ms) of the clock hours in which a chlorinator (a line without an id counts for any) reported a CELL_FAULT status, from the output log's text,
// oldest first. Of several lines for one hour (njsPC restarted within it), any with a fault drops the hour. A torn line is skipped.
export function parseFaultHours(text: string, id?: number): number[] {
    const hours = new Set<number>();
    for (const raw of (text || '').split('\n')) {
        if (!raw.trim()) continue;
        let l: any;
        try { l = JSON.parse(raw); } catch (err) { continue; }
        if (!l || typeof l !== 'object' || typeof l.t !== 'string' || !Array.isArray(l.st)) continue;
        if (typeof id === 'number' && typeof l.id === 'number' && l.id !== id) continue;
        if (!l.st.some((s: any) => typeof s === 'number' && (s & CELL_FAULT) !== 0)) continue;
        const t = new Date(l.t).getTime();
        if (isFinite(t)) hours.add(Math.floor(t / HOUR_MS) * HOUR_MS);
    }
    return Array.from(hours).sort((a, b) => a - b);
}

// The ppm the cell made in [a, b] (ms): the hours current flowed (cycleConduction, the % at each cycle's start from pctAt) at the full rate, less the
// conduction inside the fault hours (hour starts, see parseFaultHours) that overlap [a, b].
export function cycleGenerationPpm(events: PowerEvent[], a: number, b: number, cycle: CycleSettings, pctAt: (ms: number) => number, ratedPpmPer24h: number, faultHours?: number[]): number {
    if (!(ratedPpmPer24h > 0) || !cycle || !(cycle.cycleHours > 0) || !(b > a)) return 0;
    let hours = cycleConduction(events, a, b, cycle, pctAt);
    if (faultHours && faultHours.length && hours > 0) {
        for (const h of faultHours) {
            if (h + HOUR_MS <= a) continue;
            if (h >= b) break;
            hours -= cycleConduction(events, Math.max(a, h), Math.min(b, h + HOUR_MS), cycle, pctAt);
        }
        hours = Math.max(0, hours);
    }
    return hours * ratedPpmPer24h / 24;
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

export function outputLogFile(): string { return path.join(process.cwd(), 'data', 'chlorinatorOutputLog.jsonl'); }

// The same for the fault hours of the output log (it gets a line an hour, so it is read again about once an hour). No file means none. `file` is for tests.
let faultCache: { key: string; hours: number[] } | undefined;
export function readFaultHours(id?: number, file?: string): number[] {
    const f = file || outputLogFile();
    const m = mtimeOf(f);
    if (!m) return [];
    const key = `${f}|${m}|${typeof id === 'number' ? id : ''}`;
    if (faultCache && faultCache.key === key) return faultCache.hours;
    let hours: number[];
    try { hours = parseFaultHours(fs.readFileSync(f, 'utf8'), id); }
    catch (err) { logger.warn(`SWG Assist: could not read the chlorinator output log for fault hours: ${err.message}`); return []; }
    faultCache = { key, hours };
    return hours;
}
export function clearFaultHoursCache() { faultCache = undefined; }
