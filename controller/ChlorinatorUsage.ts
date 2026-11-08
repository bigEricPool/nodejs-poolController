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

// How much chlorine a cell has made, worked out from the hourly output log (ChlorinatorLog.ts) and the cell's rating in lb/day.
// An hour is credited with the mean output over the time its samples cover (one sample is ten minutes), so an hour at 50% for the full
// hour is 0.5 equivalent hours at 100%, and the pounds are those hours at the rating, taken over 24 hours. An hour in which the
// chlorinator went more than 15 minutes without reporting is not credited: a stale output looks like production when njsPC has lost
// the chlorinator. Nor is an hour in which the chlorinator reported a status that means the cell was not generating (NOT_GENERATING).
// The output in the log is what was commanded, not something the cell reports, and a cell makes its chlorine in bursts (it is on for
// the set % of each cycle), so `runHours` is the time the cell was enabled (output above 0), not the time it was energized.
// A chlorinator with a cycle length is counted by its cycles instead, from the time its power log begins (see cycleConduction): the
// hours current actually flowed, which differ from the mean output where the power goes off part way through a cycle.
// Pure functions only: no file or state access, so they can be unit tested.

import { ChlorinatorOutputHour, CHLORINATOR_STALE_SEC } from './ChlorinatorLog';

const SAMPLE_HOURS = 1 / 6;
// The status bits (see the chlorinatorStatus value map) under which the cell does not generate: low flow 1, very low salt 4, high
// current 8, low voltage 32, low water temperature 64 and communication lost 128. Low salt 2 and clean cell 16 are warnings; the cell
// still makes chlorine, if less.
export const NOT_GENERATING = 1 | 4 | 8 | 32 | 64 | 128;
// Pounds of water in a US gallon, for ppm x gallons -> pounds.
const LB_PER_GALLON = 8.34;

export interface CellUsage { hours: number; pounds: number; runHours: number; }

// A cell that makes its chlorine in cycles: current flows for the set % of each cycle, at the start of the cycle (burstFirst) or at
// its end, and a new cycle starts when the power comes on (restartsOnPower) or the cycles run on from the first power-on. cycleHours 0
// means the cell is not counted by cycles: each hour is credited with its mean output (cellUsageForHour without a cycle context).
export interface CycleSettings { cycleHours: number; restartsOnPower: boolean; burstFirst: boolean; }
// A change of the chlorinator's power (ChlorinatorPowerLog.ts), the time in ms.
export interface PowerEvent { t: number; on: boolean; }
// What the cycle count needs: the settings, the chlorinator's power events (oldest first), the time from which they are known (the
// first event; hours that start before it are counted by their mean output), and the % in force at a time (see pctAtFromHours).
export interface CycleContext { cycle: CycleSettings; events: PowerEvent[]; since: number; pctAt: (ms: number) => number; }

const HOUR_MS = 3600000;

// The % a cell was set to in a logged hour: its target output when it was producing, else 0.
export function hourPct(h: ChlorinatorOutputHour): number {
    if (!h || !(h.out > 0)) return 0;
    const p = h.tgt > 0 ? h.tgt : h.max;
    return Math.max(0, Math.min(100, Number(p) || 0));
}

// The % in force at a time, from the logged hours of one chlorinator (0 for an hour that has no line). Of two lines for the same hour
// (njsPC restarted within it), the one with more samples.
export function pctAtFromHours(hours: ChlorinatorOutputHour[]): (ms: number) => number {
    const byHour = new Map<number, ChlorinatorOutputHour>();
    for (const h of hours) {
        const t = new Date(h.t).getTime();
        if (!isFinite(t)) continue;
        const prev = byHour.get(t);
        if (!prev || h.n > prev.n) byHour.set(t, h);
    }
    return (ms: number) => { const h = byHour.get(Math.floor(ms / HOUR_MS) * HOUR_MS); return h ? hourPct(h) : 0; };
}

// The hours current flowed between `a` and `b` (ms), from the power events: each time the power is on is split into cycles from the
// power-on (or from the first power-on when the cycles do not restart), and each cycle conducts for the % in force at its start (or at
// the power-on, for a cycle that began while the power was off) times the cycle length, cut off where the power goes off.
export function cycleConduction(events: PowerEvent[], a: number, b: number, cycle: CycleSettings, pctAt: (ms: number) => number): number {
    const C = cycle.cycleHours * HOUR_MS;
    if (!(C > 0) || !(b > a) || !events || !events.length) return 0;
    const evs = events.filter(e => e && isFinite(e.t)).sort((x, y) => x.t - y.t);
    const firstOn = evs.find(e => e.on);
    let total = 0;
    for (let i = 0; i < evs.length; i++) {
        if (!evs[i].on) continue;
        const s = evs[i].t;
        const e = i + 1 < evs.length ? evs[i + 1].t : Infinity;
        const lo = Math.max(s, a), hi = Math.min(e, b);
        if (!(hi > lo)) continue;
        const anchor = cycle.restartsOnPower || !firstOn ? s : firstOn.t;
        for (let k = Math.floor((lo - anchor) / C); ; k++) {
            const cs = anchor + k * C;
            if (cs >= hi) break;
            const p = Math.max(0, Math.min(100, pctAt(Math.max(cs, s)) || 0)) / 100;
            const bs = cycle.burstFirst ? cs : cs + (1 - p) * C;
            const be = cycle.burstFirst ? cs + p * C : cs + C;
            total += Math.max(0, Math.min(be, hi) - Math.max(bs, lo));
        }
    }
    return total / HOUR_MS;
}

// One logged hour's usage. With a cycle context and an hour that starts after the power events begin, the hours are the time current
// flowed in the hour (cycleConduction), scaled by the part of the hour the line covers (a line from a restart within the hour covers
// part of it); otherwise the mean output over the time the samples cover. `cycle` says which was used.
export function cellUsageForHour(h: ChlorinatorOutputHour, lbsPerDay: number, ctx?: CycleContext): CellUsage & { cycle?: boolean } {
    if (!h || !(h.n > 0) || !(h.out > 0) || (typeof h.age === 'number' && h.age > CHLORINATOR_STALE_SEC)) return { hours: 0, pounds: 0, runHours: 0 };
    if (Array.isArray(h.st) && h.st.some(s => (s & NOT_GENERATING) !== 0)) return { hours: 0, pounds: 0, runHours: 0 };
    const covered = Math.min(1, h.n * SAMPLE_HOURS);
    let hours = (h.out / 100) * covered;
    let byCycle = false;
    const start = new Date(h.t).getTime();
    if (ctx && ctx.cycle && ctx.cycle.cycleHours > 0 && isFinite(start) && start >= ctx.since) {
        hours = cycleConduction(ctx.events, start, start + HOUR_MS, ctx.cycle, ctx.pctAt) * covered;
        byCycle = true;
    }
    const u: CellUsage & { cycle?: boolean } = { hours: hours, pounds: lbsPerDay > 0 ? hours * lbsPerDay / 24 : 0, runHours: covered * Math.min(1, h.on / h.n) };
    if (byCycle) u.cycle = true;
    return u;
}

// The usage of the hours that start at or after `fromMs`, the start of the first of them, and how many of them were counted by cycles.
export function cellUsageSince(hours: ChlorinatorOutputHour[], fromMs: number, lbsPerDay: number, ctx?: CycleContext): CellUsage & { firstHour?: string; cycleHourCount: number } {
    const total: CellUsage & { firstHour?: string; cycleHourCount: number } = { hours: 0, pounds: 0, runHours: 0, cycleHourCount: 0 };
    for (const h of hours) {
        const t = new Date(h.t).getTime();
        if (!isFinite(t) || t < fromMs) continue;
        if (!total.firstHour || h.t < total.firstHour) total.firstHour = h.t;
        const u = cellUsageForHour(h, lbsPerDay, ctx);
        total.hours += u.hours; total.pounds += u.pounds; total.runHours += u.runHours;
        if (u.cycle) total.cycleHourCount++;
    }
    return total;
}

// An SWG entry from a pool log (for example PoolMath's): from `ts` until the next entry, the cell ran `hrs` a day at `pct` and was
// credited with `ppmPerDay` of FC.
export interface SwgEntry { ts: number; ppmPerDay: number; hrs: number; pct: number; }

// The time before the output log began, estimated from SWG entries: each entry holds until the next one and makes its credited ppm a
// day, which is the chlorine in pounds for the pool volume. The equivalent hours are those pounds at the rating (or, without a rating,
// the % times the hours). Counting starts at the first entry at or after `fromMs`, because the entry in force at the install date was
// set for the cell that came out, and stops at `toMs`.
export function cellUsageFromSwgEntries(entries: SwgEntry[], fromMs: number, toMs: number, gallons: number, lbsPerDay: number): CellUsage {
    const total: CellUsage = { hours: 0, pounds: 0, runHours: 0 };
    const all = entries.filter(e => e && isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (e.ts < fromMs || e.ts >= toMs) continue;
        // the stretch ends at the next entry whatever its time, or at toMs
        const next = all.slice(i + 1).find(x => x.ts > e.ts);
        const end = Math.min(toMs, next ? next.ts : toMs);
        const days = (end - e.ts) / 86400000;
        if (!(days > 0) || !(e.ppmPerDay > 0)) continue;
        const pounds = e.ppmPerDay * gallons * LB_PER_GALLON / 1e6 * days;
        total.pounds += pounds;
        total.hours += lbsPerDay > 0 ? pounds * 24 / lbsPerDay : (e.pct / 100) * e.hrs * days;
        total.runHours += e.hrs * days;
    }
    return total;
}

// Drops the entries of `others` within an hour of one in `own` (the same event logged twice); `own` wins.
export function mergeSwgEntries(own: SwgEntry[], others: SwgEntry[]): SwgEntry[] {
    const kept = others.filter(o => !own.some(e => Math.abs(e.ts - o.ts) < 3600000));
    return own.concat(kept).sort((a, b) => a.ts - b.ts);
}

// The whole count from the install date: the SWG entries up to the first logged hour, then the log. `estimatedPounds` is the part that
// came from the entries; `cycleHourCount` is how many logged hours were counted by cycles (see cellUsageForHour).
export function cellUsageFromInstall(hours: ChlorinatorOutputHour[], entries: SwgEntry[], installedMs: number, nowMs: number, gallons: number, lbsPerDay: number, ctx?: CycleContext): CellUsage & { estimatedPounds: number; firstHour?: string; cycleHourCount: number } {
    const starts = hours.map(h => new Date(h.t).getTime()).filter(t => isFinite(t) && t >= installedMs).sort((a, b) => a - b);
    const logStart = starts.length ? starts[0] : nowMs;
    const early = cellUsageFromSwgEntries(entries, installedMs, logStart, gallons, lbsPerDay);
    const logged = cellUsageSince(hours, logStart, lbsPerDay, ctx);
    return {
        hours: early.hours + logged.hours,
        pounds: early.pounds + logged.pounds,
        runHours: early.runHours + logged.runHours,
        estimatedPounds: early.pounds,
        firstHour: logged.firstHour,
        cycleHourCount: logged.cycleHourCount,
    };
}
