/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022.
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
import { logger } from "../logger/Logger";

// One place a dashboard can read any history from (GET /state/history/kinds and GET /state/history). Each part of njsPC that keeps or works
// out something worth charting registers a source here: the kinds of data it has (water temperature, a PoolMath test, a chlorinator's output,
// a projection...) and a function that gives their points over a span of time. A source that cannot recompute its history keeps it itself;
// this registry stores nothing. A kind is named to the outside as `<source>:<kind>`, so two sources can use the same kind name.
//
// A point is { t, v?, lo?, hi?, text?, o? }: t the time (ms), v the value, lo and hi a band (the low and high of an hour or a day, or the
// levels a setting holds between), text a note or an addition written out, and o: 1 for a reading taken while the equipment was off (shown
// apart from the others). How a kind is best drawn is given by its style:
//   line     a value that is followed continuously (with a band where the points carry lo and hi)
//   band     a range in force at each time (lo to hi), stepped where it changed
//   steps    a setting that holds until the next point
//   dots     occasional readings (tests)
//   markers  events with text (additions, notes)
// `future` marks a kind with points ahead of now (a projection), so a chart can run past the present. `view` names the view a dashboard
// shows the kind in before the user has set up views of their own (kinds with the same view name share it).
export type HistoryStyle = 'line' | 'band' | 'steps' | 'dots' | 'markers';
export interface HistoryKind {
    kind: string; name: string; unit: string; group: string; style: HistoryStyle;
    future?: boolean; view?: string; count?: number; first?: string; last?: string; selected?: boolean;
}
export interface HistoryPoint { t: number; v?: number; lo?: number; hi?: number; text?: string; o?: number; }
export interface HistorySource {
    id: string;             // short and without ':' (for example 'temps', 'poolMath')
    name: string;           // shown to the user as the heading of the source's kinds
    kinds(): HistoryKind[];
    // The points of each kind between from and to (ms). For a band or steps kind, also the last point before `from`, so the range or setting in
    // force at the start of the span shows.
    series(kinds: string[], from: number, to: number): { [kind: string]: HistoryPoint[] };
}
export interface ListedHistoryKind extends HistoryKind { id: string; source: string; sourceName: string; }

export const MAX_HISTORY_KINDS = 100;
export const MAX_HISTORY_DAYS = 3660;

export class HistoryRegistry {
    private _sources = new Map<string, HistorySource>();
    // Adds a source, or replaces the one registered under the same id.
    public register(src: HistorySource) {
        if (!src || typeof src.id !== 'string' || !src.id || src.id.indexOf(':') !== -1) throw new Error(`History: a source id must be a name without ':' (${src && src.id}).`);
        this._sources.set(src.id, src);
    }
    public unregister(id: string) { this._sources.delete(id); }
    public sources(): HistorySource[] { return Array.from(this._sources.values()); }
    // Every kind of every source, in the order the sources were registered. A source that fails is left out (and logged).
    public kinds(): ListedHistoryKind[] {
        const out: ListedHistoryKind[] = [];
        for (const src of this._sources.values()) {
            let kinds: HistoryKind[] = [];
            try { kinds = src.kinds() || []; }
            catch (err) { logger.warn(`History: the ${src.id} kinds could not be read: ${err.message}`); continue; }
            for (const k of kinds) out.push({ ...k, id: `${src.id}:${k.kind}`, source: src.id, sourceName: src.name });
        }
        return out;
    }
    // The points of the given kinds (`<source>:<kind>` ids) between from and to (ms), oldest first, by id, with the last point before `from`
    // when the source gives one (the value in force at the start). Ids of sources not registered, and kinds a source has no points for, are
    // left out; a source that fails is left out (and logged).
    public series(ids: string[], from: number, to: number): { [id: string]: HistoryPoint[] } {
        const bySource = new Map<string, string[]>();
        for (const id of ids) {
            const i = typeof id === 'string' ? id.indexOf(':') : -1;
            if (i <= 0 || i === id.length - 1) continue;
            const src = id.substring(0, i);
            if (!this._sources.has(src)) continue;
            if (!bySource.has(src)) bySource.set(src, []);
            const list = bySource.get(src);
            const kind = id.substring(i + 1);
            if (list.indexOf(kind) === -1) list.push(kind);
        }
        const out: { [id: string]: HistoryPoint[] } = {};
        for (const [srcId, kinds] of bySource) {
            let s: { [kind: string]: HistoryPoint[] };
            try { s = this._sources.get(srcId).series(kinds, from, to) || {}; }
            catch (err) { logger.warn(`History: the ${srcId} series could not be read: ${err.message}`); continue; }
            for (const kind of kinds) {
                const pts = s[kind];
                if (!Array.isArray(pts) || pts.length === 0) continue;
                const ok = pts.filter(p => p && typeof p.t === 'number' && p.t <= to).sort((a, b) => a.t - b.t);
                let first = 0;
                while (first + 1 < ok.length && ok[first + 1].t < from) first++;
                const kept = ok.length && ok[first].t < from ? ok.slice(first) : ok.filter(p => p.t >= from);
                if (kept.length) out[`${srcId}:${kind}`] = kept;
            }
        }
        return out;
    }
}
export const historyRegistry = new HistoryRegistry();

// Reads the query of GET /state/history: kinds (comma separated ids, required), and the span: days back from now (default 1), or from and
// to (ms or a date string; to defaults to now and may be in the future, for a projection). Answers an error message for a bad query.
export function parseHistoryQuery(q: any, now: number = Date.now()): { kinds: string[]; from: number; to: number } | { error: string } {
    q = q || {};
    const kinds = typeof q.kinds === 'string' ? Array.from(new Set<string>(q.kinds.split(',').map(k => k.trim()).filter(k => k))) : [];
    if (kinds.length === 0) return { error: 'kinds is required: a comma separated list of ids from /state/history/kinds.' };
    if (kinds.length > MAX_HISTORY_KINDS) return { error: `At most ${MAX_HISTORY_KINDS} kinds can be asked for at once.` };
    const time = (v: any): number => {
        if (typeof v !== 'string' || !v.trim()) return NaN;
        return /^\d+$/.test(v.trim()) ? parseInt(v, 10) : new Date(v).getTime();
    };
    let to = now, from: number;
    if (typeof q.to !== 'undefined') { to = time(q.to); if (!Number.isFinite(to)) return { error: 'to must be a time (ms or a date).' }; }
    if (typeof q.from !== 'undefined') {
        from = time(q.from);
        if (!Number.isFinite(from)) return { error: 'from must be a time (ms or a date).' };
    }
    else {
        let days = 1;
        if (typeof q.days !== 'undefined') {
            days = parseFloat(q.days);
            if (!Number.isFinite(days) || days <= 0) return { error: 'days must be a positive number.' };
        }
        from = to - Math.min(days, MAX_HISTORY_DAYS) * 86400000;
    }
    if (from >= to) return { error: 'from must be before to.' };
    if (to - from > MAX_HISTORY_DAYS * 86400000) from = to - MAX_HISTORY_DAYS * 86400000;
    return { kinds, from, to };
}

// The mean of the points of each bucket (bucketMs long, from the epoch in local time when local is set), with the lowest and highest
// value (or lo and hi) of the bucket as the band; points with text or o are kept as they are. For long spans of hourly data.
export function bucketPoints(points: HistoryPoint[], bucketMs: number, local: boolean = true): HistoryPoint[] {
    const out: HistoryPoint[] = [];
    let key: number, n = 0, sum = 0, lo = Infinity, hi = -Infinity;
    const flush = () => {
        if (n > 0) out.push({ t: key, v: Math.round(sum / n * 100) / 100, lo: lo, hi: hi });
        n = 0; sum = 0; lo = Infinity; hi = -Infinity;
    };
    for (const p of points) {
        if (typeof p.v !== 'number' || typeof p.text === 'string' || p.o) { out.push(p); continue; }
        const offset = local ? new Date(p.t).getTimezoneOffset() * 60000 : 0;
        const k = Math.floor((p.t - offset) / bucketMs) * bucketMs + offset;
        if (k !== key) { flush(); key = k; }
        n++; sum += p.v;
        lo = Math.min(lo, typeof p.lo === 'number' ? p.lo : p.v);
        hi = Math.max(hi, typeof p.hi === 'number' ? p.hi : p.v);
    }
    flush();
    return out.sort((a, b) => a.t - b.t);
}
