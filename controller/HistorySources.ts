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
import { sys } from "./Equipment";
import { state } from "./State";
import { bucketPoints, HistoryKind, HistoryPoint, historyRegistry, HistorySource, HistoryStyle } from "./History";
import { chlorinatorLog } from "./ChlorinatorLog";
import { firstChlorinatorId } from "./ChlorinatorLogService";
import { historySeriesOf, readPoolMathArchive } from "./PoolMathArchive";
import { poolMathHistoryKinds } from "./PoolMathSync";

// The history sources njsPC has on its own (see History.ts): each body's water temperature (and the levels a solar heater works between),
// each chlorinator's output, and the PoolMath data chosen as Of Interest. Other features register theirs where they start.
const DAY_MS = 86400000;

function tempUnit(): string { return '°' + (sys.board.valueMaps.tempUnits.getName(state.temps.units) || 'F').toUpperCase(); }
// The temperature view that covers a span reaching back to `from`: the minute readings of the last day, hourly rows for a week, daily rows beyond.
export function tempRangeFor(from: number, now: number = Date.now()): string {
    const back = now - from;
    return back <= DAY_MS + 60000 ? 'day' : back <= 7 * DAY_MS + 60000 ? 'week' : back <= 30 * DAY_MS + 60000 ? 'month' : 'year';
}
const num = (v: any): boolean => typeof v === 'number' && isFinite(v);

// Turns one body of GET /state/temps/history into the water temperature points and, where the body shows solar levels, the solar band.
export function tempPointsOf(b: any): { water: HistoryPoint[]; solar: HistoryPoint[] } {
    const water: HistoryPoint[] = [], solar: HistoryPoint[] = [];
    const t: number[] = Array.isArray(b && b.t) ? b.t : [];
    const h = num(b.hysteresis) ? b.hysteresis : undefined;
    const daily = Array.isArray(b.hi);
    for (let i = 0; i < t.length; i++) {
        if (!num(t[i])) continue;
        const v = b.v && b.v[i];
        if (daily) {
            if (num(v)) water.push({ t: t[i], v: v, lo: num(b.lo[i]) ? b.lo[i] : v, hi: num(b.hi[i]) ? b.hi[i] : v });
            else if (b.ov && num(b.ov[i])) water.push({ t: t[i], v: b.ov[i], o: 1 });
        }
        else if (num(v)) water.push(b.o && b.o[i] ? { t: t[i], v: v, o: 1 } : { t: t[i], v: v });
        const s = b.s && b.s[i];
        if (typeof h !== 'undefined' && num(s)) solar.push({ t: t[i], lo: s - h, hi: s + h });
    }
    return { water, solar };
}

export const tempHistorySource: HistorySource = {
    id: 'temps', name: 'Temperatures',
    kinds(): HistoryKind[] {
        const out: HistoryKind[] = [];
        const h = state.getTempHistory();
        const unit = tempUnit();
        for (const b of (h && h.bodies) || []) {
            out.push({ kind: `body${b.id}`, name: `${b.name} Water`, unit, group: 'temperature', style: 'line' });
            if (num(b.hysteresis)) out.push({ kind: `body${b.id}:solar`, name: `${b.name} Solar Limits`, unit, group: 'temperature', style: 'band' });
        }
        return out;
    },
    series(kinds: string[], from: number, to: number) {
        const out: { [kind: string]: HistoryPoint[] } = {};
        const h = state.getTempHistory(tempRangeFor(from));
        for (const b of (h && h.bodies) || []) {
            const want = kinds.indexOf(`body${b.id}`) !== -1, wantSolar = kinds.indexOf(`body${b.id}:solar`) !== -1;
            if (!want && !wantSolar) continue;
            const p = tempPointsOf(b);
            if (want) out[`body${b.id}`] = p.water;
            if (wantSolar) out[`body${b.id}:solar`] = p.solar;
        }
        return out;
    }
};

// Each chlorinator's hourly output log: the mean output (with the hour's highest), the setpoint, and the salt reading. Spans longer than two
// weeks are shown a day at a time.
export function chlorPointsOf(hours: any[], field: 'out' | 'set' | 'salt', bucket: boolean): HistoryPoint[] {
    let pts: HistoryPoint[] = [];
    for (const hr of hours) {
        const t = new Date(hr.t).getTime();
        const v = hr[field];
        if (isNaN(t) || !num(v) || (field === 'salt' && v <= 0)) continue;
        pts.push(field === 'out' && num(hr.max) ? { t, v, lo: v, hi: hr.max } : { t, v });
    }
    if (bucket && field !== 'set') pts = bucketPoints(pts, DAY_MS);
    return pts;
}
const CHLOR_KINDS: [string, string, string, HistoryStyle][] = [['out', 'Output', '%', 'line'], ['set', 'Setpoint', '%', 'steps'], ['salt', 'Salt', 'ppm', 'line']];
export const chlorinatorHistorySource: HistorySource = {
    id: 'chlor', name: 'Chlorinator',
    kinds(): HistoryKind[] {
        const out: HistoryKind[] = [];
        for (const c of sys.chlorinators.toArray()) {
            const name = c.name || `Chlorinator ${c.id}`;
            for (const [k, n, unit, style] of CHLOR_KINDS) out.push({ kind: `${c.id}:${k}`, name: `${name} ${n}`, unit, group: 'chlorinator', style });
        }
        return out;
    },
    series(kinds: string[], from: number, to: number) {
        const out: { [kind: string]: HistoryPoint[] } = {};
        const now = Date.now();
        const days = Math.ceil((now - from) / DAY_MS) + 1;
        const bucket = to - from > 14 * DAY_MS;
        const byId = new Map<number, any[]>();
        for (const kind of kinds) {
            const [idText, field] = kind.split(':');
            const id = parseInt(idText, 10);
            if (isNaN(id) || ['out', 'set', 'salt'].indexOf(field) === -1) continue;
            if (!byId.has(id)) byId.set(id, chlorinatorLog.read(days, now, id, firstChlorinatorId()));
            out[kind] = chlorPointsOf(byId.get(id).filter(h => { const t = new Date(h.t).getTime(); return t >= from && t <= to; }), field as any, bucket);
        }
        return out;
    }
};

// PoolMath: the kinds chosen as Of Interest under PoolMath History. Tests and PoolMath's weather at each entry are drawn as dots; additions,
// notes and other logs as markers.
export function poolMathStyleOf(group: string, kind: string): HistoryStyle {
    if (kind === 'notes' || group === 'addition' || group === 'log') return 'markers';
    return 'dots';
}
export const poolMathHistorySource: HistorySource = {
    id: 'poolMath', name: 'PoolMath',
    kinds(): HistoryKind[] {
        return poolMathHistoryKinds().filter(k => k.selected)
            .map(k => ({ kind: k.kind, name: k.name, unit: k.unit, group: k.group, style: poolMathStyleOf(k.group, k.kind), count: k.count, first: k.first, last: k.last, selected: true }));
    },
    series(kinds: string[], from: number, to: number) {
        return historySeriesOf(readPoolMathArchive().entries, kinds, from, to);
    }
};

let registered = false;
export function registerBuiltInHistorySources() {
    if (registered) return;
    registered = true;
    historyRegistry.register(tempHistorySource);
    historyRegistry.register(chlorinatorHistorySource);
    historyRegistry.register(poolMathHistorySource);
}
