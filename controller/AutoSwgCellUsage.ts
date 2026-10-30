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
