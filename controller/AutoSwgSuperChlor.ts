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

// The super chlorinate runs, for SWG Assist's burn calculation. A run makes no SWG % entry (the setpoint doesn't change; the chlorinator runs at 100% for it),
// so without this the chlorine it made is missing from the burn and the projection.
//
// The runs come from data/chlorinatorSuperChlorLog.jsonl, written by the chlorinator logging (one line per on and per off: {t, id, on}; an off line also
// carries the end reason and the powered hours). The file is read here by path: SWG Assist does not import the logging layer, and works without it (no file
// means no runs). Each on is paired with the next off; an on with no off is a run in progress. Spa runs are ignored, like the spa %.
//
// The powered hours: the off line's, when it has them; otherwise (and for a run in progress) the hours the hourly output log shows the cell at 100% inside the
// run (data/chlorinatorOutputLog.jsonl, see ChlorinatorLog.ts), counted from the share of samples that were producing.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';

const HOUR_MS = 3600000;

export interface SuperChlorRun {
    startMs: number;
    endMs?: number;            // undefined while the run is in progress
    poweredHours?: number;     // hours at 100% inside the run (from the off line, else counted from the output log)
    reason?: string;           // why it ended, when the off line says
    id?: number;
}

function timeOf(t: any): number {
    if (typeof t === 'number') return isFinite(t) ? t : NaN;
    if (typeof t === 'string') return new Date(t).getTime();
    return NaN;
}
function boolOf(v: any): boolean | undefined {
    if (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') return true;
    if (v === false || v === 0 || v === '0' || v === 'false' || v === 'off') return false;
    return undefined;
}
function numOf(...vals: any[]): number | undefined {
    for (const v of vals) if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
    return undefined;
}
function isSpa(body: any): boolean {
    if (typeof body === 'string') return body.toLowerCase() === 'spa';
    return body === 1;   // the body value map: 0 pool, 1 spa, 32 shared
}

// Pairs each on with the next off. A second on before an off keeps the first (the run was already on); an off with no on before it is dropped.
// With `id`, only that chlorinator's lines (a line without an id counts for any).
export function parseSuperChlorLog(text: string, id?: number): SuperChlorRun[] {
    const lines: { t: number; on: boolean; l: any }[] = [];
    for (const raw of (text || '').split('\n')) {
        if (!raw.trim()) continue;
        let l: any;
        try { l = JSON.parse(raw); } catch (err) { continue; }   // a torn last line after a power loss
        if (!l || typeof l !== 'object') continue;
        const t = timeOf(l.t);
        const on = boolOf(l.on);
        if (isNaN(t) || typeof on === 'undefined') continue;
        if (typeof id === 'number' && typeof l.id === 'number' && l.id !== id) continue;
        if (isSpa(l.body)) continue;
        lines.push({ t, on, l });
    }
    lines.sort((a, b) => a.t - b.t);
    const runs: SuperChlorRun[] = [];
    let open: SuperChlorRun | undefined;
    for (const x of lines) {
        if (x.on) { if (!open) open = { startMs: x.t, id: typeof x.l.id === 'number' ? x.l.id : undefined }; continue; }
        if (!open) continue;
        open.endMs = Math.max(open.startMs, x.t);
        const ph = numOf(x.l.poweredHours, x.l.poweredH, x.l.powered, x.l.hours, x.l.hrs);
        if (typeof ph === 'number') open.poweredHours = Math.min(ph, (open.endMs - open.startMs) / HOUR_MS);
        const reason = x.l.reason || x.l.endReason || x.l.end;
        if (typeof reason === 'string') open.reason = reason;
        runs.push(open);
        open = undefined;
    }
    if (open) runs.push(open);
    return runs;
}

// The hours at 100% inside [fromMs, toMs] from the hourly output log lines: each hour at 100% (target or highest output) counts for the share of its samples
// that were producing, but no more than the part of the hour inside the span.
export function poweredHoursFromOutput(hours: { t: string; id?: number; n: number; on: number; max: number; tgt: number }[], fromMs: number, toMs: number, id?: number): number {
    let total = 0;
    for (const h of hours) {
        if (!h || typeof h.t !== 'string' || !(h.n > 0)) continue;
        if (typeof id === 'number' && typeof h.id === 'number' && h.id !== id) continue;
        const s = new Date(h.t).getTime();
        if (isNaN(s)) continue;
        const overlap = Math.max(0, Math.min(s + HOUR_MS, toMs) - Math.max(s, fromMs)) / HOUR_MS;
        if (overlap <= 0) continue;
        if (!(h.tgt >= 100 || h.max >= 100)) continue;
        total += Math.min(overlap, Math.max(0, Math.min(1, h.on / h.n)));
    }
    return total;
}

function readOutputHours(file: string): any[] {
    try {
        if (!fs.existsSync(file)) return [];
        const out: any[] = [];
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { const h = JSON.parse(line); if (h && typeof h.t === 'string' && typeof h.n === 'number') out.push(h); } catch (err) { }
        }
        return out;
    } catch (err) { logger.warn(`SWG Assist: could not read the chlorinator output log for super chlorinate hours: ${err.message}`); return []; }
}

export function superChlorLogFile(): string { return path.join(process.cwd(), 'data', 'chlorinatorSuperChlorLog.jsonl'); }
export function outputLogFile(): string { return path.join(process.cwd(), 'data', 'chlorinatorOutputLog.jsonl'); }

// Kept between calls (Tune runs thousands of calculations): the runs are read again only when the run log changes, or, when a run needs its hours counted from
// the output log, when that changes (it gets a line an hour).
let cache: { key: string; runs: SuperChlorRun[] } | undefined;
function mtimeOf(f: string): number { try { return fs.statSync(f).mtimeMs; } catch (err) { return 0; } }

// The pool's super chlorinate runs, oldest first. `files` is for tests.
export function readSuperChlorRuns(nowMs: number = Date.now(), files?: { runs: string; output: string }): SuperChlorRun[] {
    const runFile = files ? files.runs : superChlorLogFile();
    const outFile = files ? files.output : outputLogFile();
    const runM = mtimeOf(runFile);
    if (!runM) return [];
    const base = `${runFile}|${runM}`;
    if (cache && (cache.key === base || cache.key === `${base}|${outFile}|${mtimeOf(outFile)}`)) return cache.runs;
    let runs: SuperChlorRun[];
    try { runs = parseSuperChlorLog(fs.readFileSync(runFile, 'utf8')); }
    catch (err) { logger.warn(`SWG Assist: could not read the super chlorinate log: ${err.message}`); return []; }
    let key = base;
    if (runs.some(r => typeof r.poweredHours !== 'number')) {
        key = `${base}|${outFile}|${mtimeOf(outFile)}`;
        const hours = readOutputHours(outFile);
        for (const r of runs) {
            if (typeof r.poweredHours === 'number') continue;
            const end = typeof r.endMs === 'number' ? r.endMs : nowMs;
            r.poweredHours = poweredHoursFromOutput(hours, r.startMs, end, r.id);
        }
    }
    cache = { key, runs };
    return runs;
}
export function clearSuperChlorCache() { cache = undefined; }
