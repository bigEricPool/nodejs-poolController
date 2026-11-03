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

export function cellUsageForHour(h: ChlorinatorOutputHour, lbsPerDay: number): CellUsage {
    if (!h || !(h.n > 0) || !(h.out > 0) || (typeof h.age === 'number' && h.age > CHLORINATOR_STALE_SEC)) return { hours: 0, pounds: 0, runHours: 0 };
    if (Array.isArray(h.st) && h.st.some(s => (s & NOT_GENERATING) !== 0)) return { hours: 0, pounds: 0, runHours: 0 };
    const covered = Math.min(1, h.n * SAMPLE_HOURS);
    const hours = (h.out / 100) * covered;
    return { hours: hours, pounds: lbsPerDay > 0 ? hours * lbsPerDay / 24 : 0, runHours: covered * Math.min(1, h.on / h.n) };
}

// The usage of the hours that start at or after `fromMs`, and the start of the first of them.
export function cellUsageSince(hours: ChlorinatorOutputHour[], fromMs: number, lbsPerDay: number): CellUsage & { firstHour?: string } {
    const total: CellUsage & { firstHour?: string } = { hours: 0, pounds: 0, runHours: 0 };
    for (const h of hours) {
        const t = new Date(h.t).getTime();
        if (!isFinite(t) || t < fromMs) continue;
        if (!total.firstHour || h.t < total.firstHour) total.firstHour = h.t;
        const u = cellUsageForHour(h, lbsPerDay);
        total.hours += u.hours; total.pounds += u.pounds; total.runHours += u.runHours;
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
// came from the entries.
export function cellUsageFromInstall(hours: ChlorinatorOutputHour[], entries: SwgEntry[], installedMs: number, nowMs: number, gallons: number, lbsPerDay: number): CellUsage & { estimatedPounds: number; firstHour?: string } {
    const starts = hours.map(h => new Date(h.t).getTime()).filter(t => isFinite(t) && t >= installedMs).sort((a, b) => a - b);
    const logStart = starts.length ? starts[0] : nowMs;
    const early = cellUsageFromSwgEntries(entries, installedMs, logStart, gallons, lbsPerDay);
    const logged = cellUsageSince(hours, logStart, lbsPerDay);
    return {
        hours: early.hours + logged.hours,
        pounds: early.pounds + logged.pounds,
        runHours: early.runHours + logged.runHours,
        estimatedPounds: early.pounds,
        firstHour: logged.firstHour,
    };
}
