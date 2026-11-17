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
import { chlorinatorPowerLog } from "./ChlorinatorPowerLog";
import { CELL_FAULT, ConductingInterval, conductingIntervals, pctAtFromHours, PowerEvent } from "./ChlorinatorUsage";
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
// The check points are what a solar check is expected to read at the solar pump speed, where the solar enhancements give a speed offset.
export function tempPointsOf(b: any): { water: HistoryPoint[]; solar: HistoryPoint[]; check: HistoryPoint[] } {
    const water: HistoryPoint[] = [], solar: HistoryPoint[] = [], check: HistoryPoint[] = [];
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
        if (b.p && num(b.p[i])) check.push({ t: t[i], v: b.p[i] });
    }
    return { water, solar, check };
}

export const tempHistorySource: HistorySource = {
    id: 'temps', name: 'Temperatures',
    kinds(): HistoryKind[] {
        const out: HistoryKind[] = [];
        const h = state.getTempHistory();
        const unit = tempUnit();
        for (const b of (h && h.bodies) || []) {
            out.push({ kind: `body${b.id}`, name: `${b.name} Water`, unit, group: 'temperature', style: 'line', view: 'Temperature' });
            if (num(b.hysteresis)) out.push({ kind: `body${b.id}:solar`, name: `${b.name} Solar Limits`, unit, group: 'temperature', style: 'band', view: 'Temperature' });
            if (Array.isArray(b.p) && b.p.some(num)) out.push({ kind: `body${b.id}:check`, name: `${b.name} Solar Check Reading`, unit, group: 'temperature', style: 'line', view: 'Temperature' });
        }
        return out;
    },
    series(kinds: string[], from: number, to: number) {
        const out: { [kind: string]: HistoryPoint[] } = {};
        const h = state.getTempHistory(tempRangeFor(from));
        for (const b of (h && h.bodies) || []) {
            const id = `body${b.id}`;
            if (kinds.indexOf(id) === -1 && kinds.indexOf(`${id}:solar`) === -1 && kinds.indexOf(`${id}:check`) === -1) continue;
            const p = tempPointsOf(b);
            if (kinds.indexOf(id) !== -1) out[id] = p.water;
            if (kinds.indexOf(`${id}:solar`) !== -1) out[`${id}:solar`] = p.solar;
            if (kinds.indexOf(`${id}:check`) !== -1) out[`${id}:check`] = p.check;
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
            // The cell's power (from the power log) and, for a cell counted by cycles, when current flowed: shown with the FC, as they are
            // what makes it.
            if (!chlorinatorPowerLog.lastEvent(c.id)) continue;
            out.push({ kind: `${c.id}:power`, name: `${name} Power`, unit: 'h', group: 'chlorinator', style: 'spans', view: 'FC',
                note: `${name} Power is measured: when the cell's power was on, from the chlorinator power log (an njsPC stall or stop counts as off).` });
            if (c.cycleHours > 0) out.push({ kind: `${c.id}:current`, name: `${name} Current (modelled)`, unit: 'h', group: 'chlorinator', style: 'spans', view: 'FC',
                note: `${name} Current is modelled, not measured: the cell does not report its current. It is worked out from the power and the % in force: ` +
                    `the cell runs in ${c.cycleHours} h cycles${c.cycleRestartsOnPower ? ', a new one at each power-on' : ''}, and each cycle makes current ` +
                    `${c.burstFirst ? 'first' : 'last'}, for the % set at its start, until the power goes off.` });
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
            if (isNaN(id)) continue;
            if (field === 'power' || field === 'current') { out[kind] = cellSpans(id, field, from, to, now); continue; }
            if (['out', 'set', 'salt'].indexOf(field) === -1) continue;
            if (!byId.has(id)) byId.set(id, chlorinatorLog.read(days, now, id, firstChlorinatorId()));
            out[kind] = chlorPointsOf(byId.get(id).filter(h => { const t = new Date(h.t).getTime(); return t >= from && t <= to; }), field as any, bucket);
        }
        return out;
    }
};

// When the cell had power and when current flowed. The power is measured: the chlorinator power log's on and off lines (a stall or an
// outage line counts as an off, and the next on as a restart). The current is not: the AquaRite does not report it, so the times come
// from the cycle count (conductingIntervals: each cycle conducts first, for the % in force at its start, cut off where the power goes
// off), less the hours the output log shows a fault the cell reported (as the cell usage counts them). Up to SPAN_DAYS each time is a
// span; beyond that a point for each day with the hours on, so a month or a year is not thousands of bars.
const SPAN_DAYS = 8;
const HOUR_MS = 3600000;
function localDayStart(t: number): number { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function cellSpans(id: number, field: 'power' | 'current', from: number, to: number, now: number): HistoryPoint[] {
    const chlor = sys.chlorinators.find(c => c.id === id);
    if (!chlor) return [];
    if (field === 'current' && !(chlor.cycleHours > 0)) return [];
    const daily = to - from > SPAN_DAYS * DAY_MS;
    // whole days for the daily hours; for the current, back to the start of a cycle that may run into the span
    const a = daily ? localDayStart(from) : from;
    const lead = field === 'current' ? chlor.cycleHours * HOUR_MS : 0;
    // cycles that do not restart at a power-on run on from the first power-on in the log
    const restarts = chlor.cycleRestartsOnPower;
    const back = Math.ceil((now - a + lead) / DAY_MS) + 1;
    const events = chlorinatorPowerLog.read(field === 'current' && !restarts ? 1461 : back, now, id)
        .map(e => ({ t: new Date(e.t).getTime(), on: e.on, cause: (e as any).cause as string }));
    const end = Math.min(to, now);
    let spans: HistoryPoint[];
    if (field === 'power') spans = powerSpansOf(events, a, end);
    else {
        const hours = chlorinatorLog.read(back, now, id, firstChlorinatorId());
        const ivs = conductingIntervals(events, a, end, { cycleHours: chlor.cycleHours, restartsOnPower: restarts, burstFirst: chlor.burstFirst }, pctAtFromHours(hours));
        spans = currentSpansOf(ivs, faultHoursOf(hours));
    }
    return daily ? dailyHoursOf(spans, a, end) : spans;
}

// The times the power was on between a and b (ms), each from its on line to the next off (or b while it is still on), cut to [a, b]. A
// span that ended with a stall or an outage line says so.
export function powerSpansOf(events: (PowerEvent & { cause?: string })[], a: number, b: number): HistoryPoint[] {
    const evs = events.filter(e => e && isFinite(e.t)).sort((x, y) => x.t - y.t);
    const out: HistoryPoint[] = [];
    for (let i = 0; i < evs.length; i++) {
        if (!evs[i].on || (i > 0 && evs[i - 1].on)) continue;
        let j = i + 1;
        while (j < evs.length && evs[j].on) j++;
        const next = j < evs.length ? evs[j] : undefined;
        const s = Math.max(a, evs[i].t), e = Math.min(b, next ? next.t : b);
        if (!(e > s)) continue;
        const p: HistoryPoint = { t: s, e: e };
        if (!next) p.text = 'on now';
        else if (next.cause === 'stall') p.text = 'off: njsPC stalled';
        else if (next.cause === 'outage') p.text = 'off: njsPC stopped';
        out.push(p);
    }
    return out;
}
// The clock hours (start, ms) in which an output-log line shows a fault the cell reported (CELL_FAULT): the cell made nothing then.
export function faultHoursOf(hours: { t: string; st?: number[] }[]): Set<number> {
    const out = new Set<number>();
    for (const h of hours || []) if (Array.isArray(h.st) && h.st.some(s => (s & CELL_FAULT) !== 0)) out.add(new Date(h.t).getTime());
    return out;
}
// The conducting intervals as spans, v the % of the cycle each belongs to, less the fault hours.
export function currentSpansOf(ivs: ConductingInterval[], faultHours: Set<number>): HistoryPoint[] {
    const out: HistoryPoint[] = [];
    for (const iv of ivs) {
        let s = iv.start, joined = false;
        while (s < iv.end) {
            const h = Math.floor(s / HOUR_MS) * HOUR_MS, e = Math.min(iv.end, h + HOUR_MS);
            if (faultHours.has(h)) joined = false;
            else if (joined) out[out.length - 1].e = e;
            else { out.push({ t: s, e: e, v: iv.pct }); joined = true; }
            s = e;
        }
    }
    return out;
}
// The hours on of each local day from a (a day's start) to b, from the spans; a day with none is 0, so a chart shows the days off too.
export function dailyHoursOf(spans: HistoryPoint[], a: number, b: number): HistoryPoint[] {
    const out: HistoryPoint[] = [];
    for (let d = localDayStart(a); d < b;) {
        const dt = new Date(d), next = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1).getTime();
        const lo = Math.max(d, a), hi = Math.min(next, b);
        let ms = 0;
        for (const p of spans) ms += Math.max(0, Math.min(p.e, hi) - Math.max(p.t, lo));
        out.push({ t: d, v: Math.round(ms / HOUR_MS * 100) / 100 });
        d = next;
    }
    return out;
}

// PoolMath: the kinds chosen as Of Interest under PoolMath History. Tests and PoolMath's weather at each entry are drawn as dots; additions,
// notes and other logs as markers. The FC tests start in an FC view.
export function poolMathStyleOf(group: string, kind: string): HistoryStyle {
    if (kind === 'notes' || group === 'addition' || group === 'log') return 'markers';
    return 'dots';
}
export const poolMathHistorySource: HistorySource = {
    id: 'poolMath', name: 'PoolMath',
    kinds(): HistoryKind[] {
        return poolMathHistoryKinds().filter(k => k.selected)
            .map(k => ({ kind: k.kind, name: k.name, unit: k.unit, group: k.group, style: poolMathStyleOf(k.group, k.kind), view: k.kind === 'fc' ? 'FC' : undefined,
                count: k.count, first: k.first, last: k.last, selected: true }));
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
