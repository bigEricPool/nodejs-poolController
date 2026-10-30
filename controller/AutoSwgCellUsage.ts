// How much chlorine the cell has made, worked out from the hourly output log (AutoSwgOutputLog.ts) and the cell's rating. An hour is credited with the mean
// output over the time the samples cover (one sample is ten minutes), so an hour at 50% for the full hour is 0.5 equivalent hours at 100%, and the pounds are
// those hours at the rating in lb/day, taken over 24 hours. An hour in which the chlorinator went more than 15 minutes without reporting is not credited: a
// stale output looks like production when njsPC has lost the chlorinator (the log keeps that age for exactly this).
// The run time is the part of the time covered in which the cell was producing at all (any output above 0), whatever the output was.
import { AutoSwgOutputHour } from './AutoSwgOutputLog';

const SAMPLE_HOURS = 1 / 6;
const STALE_SEC = 15 * 60;

export interface CellUsage { hours: number; pounds: number; runHours: number; }

export function cellUsageForHour(h: AutoSwgOutputHour, lbsPerDay: number): CellUsage {
    if (!h || !(h.n > 0) || !(h.out > 0) || (typeof h.age === 'number' && h.age > STALE_SEC)) return { hours: 0, pounds: 0, runHours: 0 };
    const covered = Math.min(1, h.n * SAMPLE_HOURS);
    const hours = (h.out / 100) * covered;
    return { hours: hours, pounds: lbsPerDay > 0 ? hours * lbsPerDay / 24 : 0, runHours: covered * Math.min(1, h.on / h.n) };
}

// The part of the time before the output log began, estimated from the SWG entries (PoolMath's, and the ones this app wrote after them): each entry holds until the
// next one, and makes its credited ppm a day, which is the chlorine in pounds for the pool volume (so an entry whose % was not what ran, but whose credit fits the FC
// readings, counts at its credit). The equivalent hours are those pounds at the rating. Counting starts at the first entry at or after `fromMs`, because the entry in
// force at the install date was set for the cell that came out, and stops at `toMs`.
export interface SwgEventLike { ts: number; ppmPerDay: number; hrs: number; pct: number; }
export function cellUsageFromSwgEvents(events: SwgEventLike[], fromMs: number, toMs: number, gallons: number, lbsPerDay: number): CellUsage {
    const total: CellUsage = { hours: 0, pounds: 0, runHours: 0 };
    const list = events.filter(e => isFinite(e.ts) && e.ts >= fromMs && e.ts < toMs).sort((a, b) => a.ts - b.ts);
    // the entries before the first one in range do not count, but the one that ends this stretch is the next entry whatever its time
    const all = events.filter(e => isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
    for (const e of list) {
        const next = all.find(x => x.ts > e.ts);
        const end = Math.min(toMs, next ? next.ts : toMs);
        const days = (end - e.ts) / 86400000;
        if (!(days > 0) || !(e.ppmPerDay > 0)) continue;
        const pounds = e.ppmPerDay * gallons * 8.34 / 1e6 * days;
        total.pounds += pounds;
        total.hours += lbsPerDay > 0 ? pounds * 24 / lbsPerDay : (e.pct / 100) * e.hrs * days;
        total.runHours += e.hrs * days;
    }
    return total;
}

// The usage of the hours that start at or after `fromMs`, and the start of the first of them that the log holds.
export function cellUsageSince(hours: AutoSwgOutputHour[], fromMs: number, lbsPerDay: number): CellUsage & { firstHour?: string } {
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
