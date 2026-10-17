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

// The projected FC points behind the FC line of the Water panel, kept in data/autoSwgProjection.jsonl next to poolConfig.json, one JSON line per point,
// for 18 months (the length of the PoolMath archive). A point is the FC the calculation expected at a moment it mattered:
//   after    the projected FC a calculation gave when its result was applied (a check, a refresh, a refresh and apply). `run` is that apply's id (its time
//            in ms), `tf` and `td` the target FC and deadline (ms) it aimed at, so the planned path can be drawn out to the deadline.
//   before   the FC the PREVIOUS run expected at the time of the next apply, from only what it knew (the FC readings up to its time), so the step between
//            `before` and `after` at the same time is what the refresh changed. `run` is the previous run's id.
//   reading  the FC the previous run expected at the time of an FC test, so the test and the projection can be compared. `run` is the run that was current.
// Points of one run, joined in time order, are that run's line: its `after`, then any `reading` points, then the `before` of the apply that replaced it.
// The points are worked out from the history of applies (data/autoSwgHistory.json), the PoolMath archive and the PoolMath page the last calculation read,
// so nothing here contacts PoolMath. The work is done in the background after a calculation or an apply, a little at a time (updateProjectionPoints), and
// changes no calculation.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { cachedPageHtml, computeRecommendation } from './AutoSwgService';
import { readAutoSwgHistory, toLocalSwgEntries } from './AutoSwgHistory';
import { archivedChlorineAdditions, archivedCyaReadings, archivedFcReadings, archivedSwgEvents, archivedWaterTemps } from './AutoSwgPoolMathArchive';

const KEEP_MONTHS = 18;
const PRUNE_EVERY_MS = 24 * 3600000;
const LOOKBACK_DAYS = 45;              // how far back the points that need a calculation are filled in
const HTML_MAX_AGE_MS = 24 * 3600000;  // the cached PoolMath page is used for the calculations while it is no older than this
const PAUSE_MS = 40;                   // between two calculations, so the rest of njsPC (the serial ports above all) is never kept waiting
const MAX_TASKS = 250;

export type ProjectionKind = 'after' | 'before' | 'reading';
export interface ProjectionPoint { t: number; fc: number; kind: ProjectionKind; run: number; tf?: number; td?: number; }
const KIND_ORDER = { before: 0, reading: 1, after: 2 };

function keyOf(kind: string, t: number, run: number): string { return kind === 'after' ? `after|${run}` : `${kind}|${t}`; }

class ProjectionLog {
    private points: ProjectionPoint[] | undefined;
    private keys: Set<string> | undefined;
    private lastPrune = 0;
    private file(): string { return path.join(process.cwd(), 'data', 'autoSwgProjection.jsonl'); }
    private load() {
        if (this.points) return;
        const points: ProjectionPoint[] = [];
        try {
            const text = fs.readFileSync(this.file(), 'utf8');
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const p = JSON.parse(line);
                    if (p && typeof p.t === 'number' && typeof p.fc === 'number' && typeof p.run === 'number' && typeof KIND_ORDER[p.kind] === 'number') points.push(p);
                }
                catch (err) { /* a line cut short by a power loss */ }
            }
        }
        catch (err) {
            if (err && err.code !== 'ENOENT') logger.warn(`AutoSwg: could not read ${this.file()}: ${err.message}`);
        }
        this.points = points;
        this.keys = new Set(points.map(p => keyOf(p.kind, p.t, p.run)));
    }
    public has(kind: ProjectionKind, t: number, run: number): boolean {
        this.load();
        return this.keys.has(keyOf(kind, t, run));
    }
    // Appends the points that are not there yet, in one write.
    public add(list: ProjectionPoint[]) {
        this.load();
        const fresh = list.filter(p => !this.keys.has(keyOf(p.kind, p.t, p.run)));
        if (fresh.length === 0) return;
        const file = this.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, fresh.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
        for (const p of fresh) { this.points.push(p); this.keys.add(keyOf(p.kind, p.t, p.run)); }
        this.prune();
    }
    // Once a day, drops what is older than KEEP_MONTHS (the file is rewritten through a temporary file only when something is dropped).
    private prune() {
        const now = Date.now();
        if (now - this.lastPrune < PRUNE_EVERY_MS) return;
        this.lastPrune = now;
        const cutoff = new Date(now);
        cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);
        const kept = this.points.filter(p => p.t >= cutoff.getTime());
        if (kept.length === this.points.length) return;
        const file = this.file();
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, kept.map(p => JSON.stringify(p)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
        fs.renameSync(tmp, file);
        this.points = kept;
        this.keys = new Set(kept.map(p => keyOf(p.kind, p.t, p.run)));
    }
    // The points of the last `days` days, oldest first; at one time a `before` comes first, then a `reading`, then an `after`.
    public read(days: number): ProjectionPoint[] {
        this.load();
        const from = Date.now() - days * 86400000;
        return this.points.filter(p => p.t >= from).sort((a, b) => (a.t - b.t) || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
    }
}
export const projectionLog = new ProjectionLog();

const round2 = (v: number): number => Math.round(v * 100) / 100;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const idOf = (r: any): number => new Date(r.appliedAt).getTime();
const failed = new Set<string>();   // calculations that could not be made (too little history before that moment): not tried again until njsPC restarts
let busy = false;
let again = false;   // a call came in while a run was going: it goes once more when that one is done, so a new apply is not left until the next calculation

// The applies that carry a calculation: an applied recommendation with the parameters it used, the FC it projected and the reading it was based on.
// (The steps to the maintenance % carry none of that.)
function runRecords(records: any[]): any[] {
    return records.filter(r => r && r.source === 'auto' && typeof r.appliedAt === 'string' && !isNaN(idOf(r)) && r.inputs && r.outputs
        && typeof r.outputs.projectedCurrentFc === 'number' && r.outputs.mostRecentFc && typeof r.outputs.mostRecentFc.ts === 'string')
        .sort((a, b) => idOf(a) - idOf(b));
}

// Brings the points up to date: the `after` of every apply (no calculation), then, for the last LOOKBACK_DAYS days, the `before` of every apply and a `reading`
// for every FC test that has none yet. It is safe to call as often as you like (a call during a run makes the run go once more when it is done; it does nothing when the page has not been read), and it
// never throws. `cfg` is the share code and pool name of the AutoSwg settings (this module does not read the equipment configuration itself).
export async function updateProjectionPoints(cfg: { shareCode: string; poolName?: string }): Promise<void> {
    if (busy) { again = true; return; }
    busy = true;
    try {
        const history = readAutoSwgHistory();
        const runs = runRecords(history);
        projectionLog.add(runs.map(r => {
            const id = idOf(r);
            const point: ProjectionPoint = { t: id, fc: round2(r.outputs.projectedCurrentFc), kind: 'after', run: id };
            if (typeof r.targetFc === 'number') point.tf = r.targetFc;
            const td = r.targetDate ? new Date(r.targetDate).getTime() : NaN;
            if (isFinite(td)) point.td = td;
            return point;
        }));
        const html = cachedPageHtml(HTML_MAX_AGE_MS);
        if (!html || !cfg.shareCode) return;
        const from = Date.now() - LOOKBACK_DAYS * 86400000;
        const base = { shareCode: cfg.shareCode, poolName: cfg.poolName || undefined, inFlight: undefined as any };
        const tasks: { kind: ProjectionKind; t: number; run: number; params: any }[] = [];
        // What the previous run expected at the time of each apply, from only the readings it had.
        for (let i = 1; i < runs.length; i++) {
            const prev = runs[i - 1], next = runs[i];
            const t = idOf(next), run = idOf(prev);
            if (t < from || projectionLog.has('before', t, run) || failed.has(keyOf('before', t, run))) continue;
            const readingAt = new Date(prev.outputs.mostRecentFc.ts);
            if (isNaN(readingAt.getTime())) continue;
            tasks.push({ kind: 'before', t: t, run: run, params: Object.assign({}, next.inputs, base, { asOf: new Date(t), dataAsOf: readingAt }) });
        }
        // What the run in force expected at the time of each FC test (from the readings before it).
        for (const reading of archivedFcReadings()) {
            const t = reading.ts.getTime();
            if (t < from) continue;
            let current: any;
            for (const r of runs) { if (idOf(r) <= t) current = r; else break; }
            if (!current) continue;
            const run = idOf(current);
            if (projectionLog.has('reading', t, run) || failed.has(keyOf('reading', t, run))) continue;
            tasks.push({ kind: 'reading', t: t, run: run, params: Object.assign({}, current.inputs, base, { asOf: new Date(t - 60000) }) });
        }
        if (tasks.length === 0) return;
        const local = toLocalSwgEntries(history);
        const archive = { fc: archivedFcReadings(), swg: archivedSwgEvents(), cya: archivedCyaReadings(), chlorine: archivedChlorineAdditions(), temp: archivedWaterTemps() };
        let made = 0;
        for (const task of tasks.slice(0, MAX_TASKS)) {
            try {
                const result = await computeRecommendation(task.params, html, local, undefined, archive);
                projectionLog.add([{ t: task.t, fc: round2(result.projectedCurrentFc), kind: task.kind, run: task.run }]);
                made++;
            }
            catch (err) { failed.add(keyOf(task.kind, task.t, task.run)); }
            await pause(PAUSE_MS);
        }
        if (made > 0) logger.verbose(`AutoSwg: ${made} projected FC point${made === 1 ? '' : 's'} added for the Water panel.`);
    }
    catch (err) {
        logger.warn(`AutoSwg: could not update the projected FC points: ${err && err.message}`);
    }
    finally {
        busy = false;
        if (again) { again = false; void updateProjectionPoints(cfg); }
    }
}
